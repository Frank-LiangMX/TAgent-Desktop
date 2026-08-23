/**
 * RoomSession 服务端 TLS 证书生命周期本地存储（P0-3 A）。
 *
 * 用 Node 内置 `node:crypto` 生成自签 X.509 v3 证书（RSA 2048 + SHA256），
 * 不引入任何外部 CA 库；ASN.1 DER 编码器是本文件内联的少量纯函数，
 * SubjectPublicKeyInfo 直接用 `publicKey.export({ type: 'spki', format: 'der' })`
 * 取得，签名用 `crypto.createSign`，证书指纹用 `crypto.X509Certificate.fingerprint256`。
 *
 * 磁盘只存必要 PEM + 元数据：certId / createdAt / expiresAt / revokedAt /
 * fingerprint / status / commonName + key/cert PEM。写入走 `atomic-json` 三步原子写，
 * 损坏自愈读 `.bak`，权限/目录沿用现有 `getCollaborationDir()` 惯例。
 *
 * 状态派生（不依赖显式落盘的状态字段，避免过期证书仍被当成 active）：
 *   revoked（revokedAt 已设） > expired（expiresAt <= now） > active。
 *
 * 安全约束：
 *   - 撤销 / 过期的证书不得再用于 `resolveTlsOptions()`（即 `start({ host: 非 loopback })`）。
 *   - 本模块不改变 `fusion-room-runtime.ts` 的 loopback 明文拒绝语义；它只是产出可喂给
 *     `FusionRoomTlsOptions` 的材料，是否放行非 loopback 仍由 runtime + 显式闸门决定。
 *   - 不存在 `allowInsecureNetwork` / 明文公网监听开关。
 *
 * 单测用临时目录 + 可注入 `now()`，不写用户真实 config。
 */
import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import type { FusionRoomTlsOptions } from './fusion-room-http-server'

export type FusionRoomCertStatus = 'active' | 'revoked' | 'expired'

/** 完整证书记录（含私钥 PEM，仅主进程内使用，不回传渲染层）。 */
export interface FusionRoomCertRecord {
  certId: string
  /** PKCS#8 PEM 私钥；只在主进程内用于 https.createServer，绝不回传渲染层。 */
  key: string
  /** PEM 证书。 */
  cert: string
  /** 证书 sha256 指纹（colon-hex，取自 X509Certificate.fingerprint256）。 */
  fingerprint: string
  createdAt: number
  /** 证书过期时间（ms epoch）。 */
  expiresAt: number
  /** 撤销时间（ms epoch）；未撤销为 undefined。 */
  revokedAt?: number
  /** 派生状态：active | revoked | expired。读取时按 revokedAt / expiresAt 重新计算。 */
  status: FusionRoomCertStatus
  commonName: string
}

/** 渲染层可见的证书记录（剥离私钥）。 */
export type FusionRoomPublicCertRecord = Omit<FusionRoomCertRecord, 'key'>

interface FusionRoomCertStoreFile {
  version: 1
  certs: FusionRoomCertRecord[]
}

export interface FusionRoomCertStoreOptions {
  /** 证书存储目录；证书索引文件落在 `<dir>/fusion-room-certs.json`。 */
  dir: string
  /** 可注入的当前时间（ms epoch），默认 `Date.now`；单测用过期判定。 */
  now?: () => number
}

export interface FusionRoomCertGenerateInput {
  /** 证书 CommonName；默认 `tagent-fusion-room`。 */
  commonName?: string
  /** 有效期天数；默认 365。 */
  validityDays?: number
}

export interface FusionRoomCertRotateResult {
  /** 新激活的证书（active）。 */
  generated: FusionRoomCertRecord
  /** 本次轮换中被撤销的旧证书；无旧 active 证书时为 undefined。 */
  revoked: FusionRoomPublicCertRecord | undefined
}

// ===== ASN.1 DER 编码器（仅覆盖自签 v3 证书所需结构） =====

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  if (n < 0x100) return Buffer.from([0x81, n])
  if (n < 0x10000) return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff])
  if (n < 0x1000000) return Buffer.from([0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
  return Buffer.from([0x84, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
}

function wrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content])
}

function seq(...parts: Buffer[]): Buffer {
  return wrap(0x30, Buffer.concat(parts))
}

function set(...parts: Buffer[]): Buffer {
  return wrap(0x31, Buffer.concat(parts))
}

function derOid(bytes: number[]): Buffer {
  return wrap(0x06, Buffer.from(bytes))
}

function derInteger(bytes: Buffer | number[]): Buffer {
  const buf = Buffer.from(bytes)
  const first = buf[0]
  const prefix = first !== undefined && (first & 0x80) !== 0 ? Buffer.from([0x00]) : Buffer.alloc(0)
  return wrap(0x02, Buffer.concat([prefix, buf]))
}

function derBitString(bytes: Buffer): Buffer {
  return wrap(0x03, Buffer.concat([Buffer.from([0x00]), bytes]))
}

function derOctetString(bytes: Buffer): Buffer {
  return wrap(0x04, bytes)
}

function derUtf8(s: string): Buffer {
  return wrap(0x0c, Buffer.from(s, 'utf8'))
}

function derExplicit(tagNum: number, content: Buffer): Buffer {
  return wrap(0xa0 | tagNum, content)
}

/** 上下文隐式标签（用于 SAN 的 GeneralName：[2] DNS / [7] IPv4）。 */
function derContextImplicit(tagNum: number, bytes: Buffer): Buffer {
  return wrap(0x80 | tagNum, bytes)
}

function derNull(): Buffer {
  return wrap(0x05, Buffer.alloc(0))
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

/** Validity 时间编码：1950-2049 用 UTCTime，否则 GeneralizedTime（RFC 5280 §4.1.2.5.1）。 */
function derTime(date: Date): Buffer {
  const y = date.getUTCFullYear()
  const body =
    (y >= 1950 && y <= 2049 ? pad2(y).slice(-2) : String(y)) +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    'Z'
  return wrap(y >= 1950 && y <= 2049 ? 0x17 : 0x18, Buffer.from(body, 'ascii'))
}

function derToPem(der: Buffer, label: string): string {
  const lines = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`
}

// OID 字节（已编码，去首字节 0x06 + 长度）
const OID_SHA256_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b] // 1.2.840.113549.1.1.11
const OID_CN = [0x55, 0x04, 0x03] // 2.5.4.3
const OID_SAN = [0x55, 0x1d, 0x11] // 2.5.29.17

interface SelfSignedMaterial {
  key: string
  cert: string
  certDer: Buffer
}

/**
 * 生成自签 X.509 v3 证书（RSA 2048 / SHA256），SAN 含 DNS:localhost + IP:127.0.0.1，
 * 便于 loopback / 局域网开发联调。纯计算、无 I/O、无网络。
 */
function generateSelfSignedCert(input: {
  commonName: string
  notBefore: Date
  notAfter: Date
}): SelfSignedMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer

  const algorithm = seq(derOid(OID_SHA256_RSA), derNull())
  const name = seq(set(seq(derOid(OID_CN), derUtf8(input.commonName))))
  const validity = seq(derTime(input.notBefore), derTime(input.notAfter))

  // subjectAltName：DNS:localhost + IP:127.0.0.1（非 critical，subject 已有 CN）。
  const sanValue = seq(
    derContextImplicit(2, Buffer.from('localhost', 'ascii')),
    derContextImplicit(7, Buffer.from([127, 0, 0, 1])),
  )
  const extensions = derExplicit(3, seq(seq(derOid(OID_SAN), derOctetString(sanValue))))

  const serial = randomBytes(16)
  serial[0] = (serial[0] ?? 0) & 0x7f // 保证 serial 为正整数

  const tbsCertificate = seq(
    derExplicit(0, derInteger([2])), // version v3
    derInteger(serial),
    algorithm,
    name, // issuer
    validity,
    name, // subject（自签 → 与 issuer 一致）
    spkiDer, // subjectPublicKeyInfo（直接用导出的 SPKI DER）
    extensions,
  )

  const signature = createSign('sha256').update(tbsCertificate).sign(privateKey as KeyObject)
  const certDer = seq(tbsCertificate, algorithm, derBitString(signature))
  const certPem = derToPem(certDer, 'CERTIFICATE')
  return { key: keyPem, cert: certPem, certDer }
}

// ===== 存储 =====

const CERTS_FILENAME = 'fusion-room-certs.json'
const DEFAULT_COMMON_NAME = 'tagent-fusion-room'
const DEFAULT_VALIDITY_DAYS = 365

export class FusionRoomCertStore {
  private readonly dir: string
  private readonly now: () => number
  private readonly file: string

  constructor(options: FusionRoomCertStoreOptions) {
    this.dir = options.dir
    this.now = options.now ?? (() => Date.now())
    this.file = join(options.dir, CERTS_FILENAME)
  }

  /** 生成一张新的 active 自签证书；不主动撤销已有 active 证书（rotate 才撤销旧）。 */
  generate(input: FusionRoomCertGenerateInput = {}): FusionRoomCertRecord {
    const commonName = input.commonName ?? DEFAULT_COMMON_NAME
    const validityDays = input.validityDays ?? DEFAULT_VALIDITY_DAYS
    const now = this.now()
    const notBefore = new Date(now - 60_000) // 容忍小幅时钟回拨
    const notAfter = new Date(now + validityDays * 86_400_000)
    const material = generateSelfSignedCert({ commonName, notBefore, notAfter })
    const x509 = new X509Certificate(material.cert)
    const record: FusionRoomCertRecord = {
      certId: randomUUID(),
      key: material.key,
      cert: material.cert,
      fingerprint: x509.fingerprint256,
      createdAt: now,
      expiresAt: notAfter.getTime(),
      status: 'active',
      commonName,
    }
    const records = this.readRaw()
    records.push(record)
    this.write(records)
    return { ...record }
  }

  /** 列出全部证书记录（含私钥），状态按当前 `now()` 派生。 */
  list(): FusionRoomCertRecord[] {
    return this.readRaw().map((record) => ({ ...record, status: this.deriveStatus(record) }))
  }

  /** 列出渲染层可见的证书记录（剥离私钥）。 */
  listPublic(): FusionRoomPublicCertRecord[] {
    return this.list().map(({ key: _key, ...rest }) => rest)
  }

  /** 撤销指定证书；幂等（已撤销保持原 revokedAt）。返回更新后的公开记录，不存在返回 undefined。 */
  revoke(certId: string): FusionRoomPublicCertRecord | undefined {
    const records = this.readRaw()
    const target = records.find((record) => record.certId === certId)
    if (!target) return undefined
    if (target.revokedAt === undefined) {
      target.revokedAt = this.now()
      target.status = 'revoked'
      this.write(records)
    }
    const { key: _key, ...rest } = target
    return { ...rest, status: 'revoked' }
  }

  /**
   * 轮换：撤销当前 active 证书（若有）并生成新 active 证书。
   * 返回新激活证书与被撤销的旧证书（无旧 active 时 revoked 为 undefined）。
   */
  rotate(input: FusionRoomCertGenerateInput = {}): FusionRoomCertRotateResult {
    const records = this.readRaw()
    const current = this.pickActive(records)
    let revoked: FusionRoomPublicCertRecord | undefined
    if (current) {
      current.revokedAt = this.now()
      current.status = 'revoked'
      // 剥离私钥再返回，避免把 key PEM 透出给调用方 / 渲染层。
      const { key: _unusedKey, ...rest } = current
      revoked = { ...rest, status: 'revoked' }
      this.write(records)
    }
    const generated = this.generate(input)
    return { generated, revoked }
  }

  /** 解析当前可用的 active 且未过期证书为 `FusionRoomTlsOptions`；无可用证书返回 undefined。 */
  resolveTlsOptions(): FusionRoomTlsOptions | undefined {
    const active = this.pickActive(this.readRaw())
    if (!active) return undefined
    return { key: active.key, cert: active.cert }
  }

  /** 是否存在 active 且未过期的证书（用于显式闸门 `enableNetworkListen` 判定）。 */
  hasActiveCert(): boolean {
    return this.pickActive(this.readRaw()) !== undefined
  }

  // ----- 内部 -----

  private deriveStatus(record: FusionRoomCertRecord): FusionRoomCertStatus {
    if (record.revokedAt !== undefined) return 'revoked'
    if (record.expiresAt <= this.now()) return 'expired'
    return 'active'
  }

  /** 选出最新的 active（未撤销、未过期）证书；按 createdAt 降序取首条。 */
  private pickActive(records: FusionRoomCertRecord[]): FusionRoomCertRecord | undefined {
    const now = this.now()
    return records
      .filter((record) => record.revokedAt === undefined && record.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  private readRaw(): FusionRoomCertRecord[] {
    const data = readJsonSafe<FusionRoomCertStoreFile>(this.file, { version: 1, certs: [] })
    return Array.isArray(data?.certs) ? (data.certs as FusionRoomCertRecord[]) : []
  }

  private write(records: FusionRoomCertRecord[]): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    writeJsonAtomic(this.file, { version: 1, certs: records } satisfies FusionRoomCertStoreFile)
  }
}
