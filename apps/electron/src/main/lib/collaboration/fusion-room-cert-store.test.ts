import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import {
  FusionRoomCertStore,
  type FusionRoomCertRecord,
} from './fusion-room-cert-store'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createStore(dir: string, now: () => number): FusionRoomCertStore {
  return new FusionRoomCertStore({ dir, now })
}

describe('FusionRoomCertStore 证书生命周期', () => {
  test('generate 产出可被 node:crypto 解析的自签 v3 证书，元数据与指纹一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-cert-store-'))
    tempDirs.push(dir)
    let now = 1_700_000_000_000
    const store = createStore(dir, () => now)

    expect(store.resolveTlsOptions()).toBeUndefined()
    expect(store.hasActiveCert()).toBe(false)

    const record = store.generate({ commonName: 'fusion-test', validityDays: 2 })
    expect(record.status).toBe('active')
    expect(record.certId).toBeTruthy()
    expect(record.key).toContain('PRIVATE KEY')
    expect(record.cert).toContain('CERTIFICATE')

    // DER 必须可被 OpenSSL 解析：指纹与有效期与存储元数据一致。
    const x509 = new X509Certificate(record.cert)
    expect(x509.fingerprint256).toBe(record.fingerprint)
    expect(new Date(x509.validTo).getTime()).toBe(record.expiresAt)
    expect(x509.subjectAltName).toContain('localhost')
    expect(x509.subjectAltName).toContain('127.0.0.1')

    expect(store.hasActiveCert()).toBe(true)
    const tls = store.resolveTlsOptions()
    expect(tls).toBeDefined()
    expect(tls?.key).toBe(record.key)
    expect(tls?.cert).toBe(record.cert)
  })

  test('list 返回派生状态；listPublic 剥离私钥', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-cert-store-public-'))
    tempDirs.push(dir)
    const store = createStore(dir, () => 1_700_000_000_000)
    store.generate()

    const full = store.list()
    expect(full).toHaveLength(1)
    expect(full[0]?.key).toContain('PRIVATE KEY')

    const publicRecords = store.listPublic()
    expect(publicRecords).toHaveLength(1)
    expect((publicRecords[0] as { key?: string }).key).toBeUndefined()
    expect(publicRecords[0]?.cert).toContain('CERTIFICATE')
  })

  test('revoke 后 resolveTlsOptions 不可再返回该证书；幂等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-cert-store-revoke-'))
    tempDirs.push(dir)
    const store = createStore(dir, () => 1_700_000_000_000)
    const record = store.generate()
    expect(store.hasActiveCert()).toBe(true)

    const revoked = store.revoke(record.certId)
    expect(revoked?.status).toBe('revoked')
    expect(revoked?.revokedAt).toBe(1_700_000_000_000)

    expect(store.hasActiveCert()).toBe(false)
    expect(store.resolveTlsOptions()).toBeUndefined()

    // 幂等：再次 revoke 同一证书不报错，revokedAt 不变。
    const again = store.revoke(record.certId)
    expect(again?.revokedAt).toBe(1_700_000_000_000)

    // 不存在的 certId 返回 undefined，不影响其它记录。
    expect(store.revoke('nonexistent')).toBeUndefined()
  })

  test('rotate 撤销旧 active 并生成新 active；旧指纹失效、新的可用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-cert-store-rotate-'))
    tempDirs.push(dir)
    const store = createStore(dir, () => 1_700_000_000_000)
    const first = store.generate()
    const firstFingerprint = first.fingerprint

    const result = store.rotate()
    expect(result.generated.status).toBe('active')
    expect(result.revoked?.certId).toBe(first.certId)
    expect(result.revoked?.status).toBe('revoked')

    const tls = store.resolveTlsOptions()
    expect(tls?.cert).toBe(result.generated.cert)
    expect(tls?.cert).not.toBe(first.cert)

    // 旧指纹不再出现在 active 列表里；resolveTlsOptions 只返回新证书。
    const active = store.list().filter((r) => r.status === 'active')
    expect(active).toHaveLength(1)
    expect(active[0]?.fingerprint).not.toBe(firstFingerprint)
    expect(active[0]?.fingerprint).toBe(result.generated.fingerprint)
  })

  test('过期（注入 now 越过 expiresAt）视为不可用，状态派生为 expired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-cert-store-expire-'))
    tempDirs.push(dir)
    let now = 1_700_000_000_000
    const store = createStore(dir, () => now)
    const record = store.generate({ validityDays: 1 })
    expect(store.hasActiveCert()).toBe(true)

    // 推进时钟到过期之后。
    now = record.expiresAt + 1_000
    expect(store.hasActiveCert()).toBe(false)
    expect(store.resolveTlsOptions()).toBeUndefined()

    const expired = store.list().find((r) => r.certId === record.certId)
    expect(expired?.status).toBe('expired')
  })

  test('多张 active 时 resolveTlsOptions 返回最新（createdAt 最大）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-cert-store-multi-'))
    tempDirs.push(dir)
    let now = 1_700_000_000_000
    const store = createStore(dir, () => now)
    const a = store.generate()
    now += 5_000
    const b = store.generate()
    expect(store.list()).toHaveLength(2)
    const tls = store.resolveTlsOptions()
    expect(tls?.cert).toBe(b.cert)
    expect(tls?.cert).not.toBe(a.cert)
  })

  test('证书持久化：新 store 实例读取同一目录可看到已落盘证书', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-cert-store-persist-'))
    tempDirs.push(dir)
    const store = createStore(dir, () => 1_700_000_000_000)
    const record = store.generate()

    const reopened = createStore(dir, () => 1_700_000_000_000)
    const tls = reopened.resolveTlsOptions()
    expect(tls?.cert).toBe(record.cert)
    expect(reopened.list()).toHaveLength(1)
  })
})
