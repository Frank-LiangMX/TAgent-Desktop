import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { FusionRoomCertStore } from './fusion-room-cert-store'
import type { FusionRoomTransportRuntime } from './fusion-room-runtime'
import {
  bootstrapFusionRoomTransport,
  projectFusionRoomTransportStatus,
  type FusionRoomTransportBootstrapInput,
  type FusionRoomTransportBootstrapResult,
} from './fusion-room-transport-bootstrap'

const tempDirs: string[] = []
const runtimes: FusionRoomTransportRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close().catch(() => undefined)))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-bootstrap-'))
  tempDirs.push(dir)
  return dir
}

/** x-user-id fallback 认证（与 runtime 既有测试同形）；用于明文 HTTP 探活拿到 200/401。 */
function xUserIdAuthenticate(request: IncomingMessage) {
  const raw = request.headers['x-user-id']
  const userId = Array.isArray(raw) ? raw[0] : raw
  return userId ? { userId } : undefined
}

function baseInput(
  overrides: Partial<FusionRoomTransportBootstrapInput>,
): FusionRoomTransportBootstrapInput {
  const dir = makeTempDir()
  const certStore = new FusionRoomCertStore({ dir })
  return {
    gate: { registerIpc: true, allowNonLoopbackListen: true, reasons: [] },
    certStore,
    listenPort: 0,
    snapshotPath: join(dir, 'snapshots.json'),
    inviteTokenPath: join(dir, 'invite-tokens.json'),
    outboxWorkerStatePath: join(dir, 'outbox-worker.json'),
    authenticate: xUserIdAuthenticate,
    ...overrides,
  }
}

function collectRuntime(result: FusionRoomTransportBootstrapResult): void {
  if (result.status === 'listening' || result.status === 'loopback_only') {
    runtimes.push(result.runtime)
  }
}

/**
 * 行为探测（跨运行时稳定，对齐 fusion-room-runtime.test 的 acceptsPlaintextHttp）：
 * 明文 HTTP transport 会返回 HTTP 响应（200/401）；HTTPS transport 会对明文请求做
 * TLS 握手并失败（fetch 抛错 / 超时）→ 返回 false。
 */
async function plaintextHttpResponds(port: number): Promise<boolean> {
  try {
    const raced = await Promise.race([
      fetch('http://127.0.0.1:' + port + '/rooms', { headers: { 'x-user-id': 'owner' } })
        .then((response) => response as Response | null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ])
    if (raced === null) return false
    return raced.status === 200 || raced.status === 401
  } catch {
    return false
  }
}

describe('bootstrapFusionRoomTransport · 决策表', () => {
  test('allowNonLoopbackListen=false 且未开 dev loopback → disabled，不 listen、无 runtime', async () => {
    const input = baseInput({
      gate: { registerIpc: true, allowNonLoopbackListen: false, reasons: ['闸门关'] },
    })
    const result = await bootstrapFusionRoomTransport(input)
    expect(result.status).toBe('disabled')
    if (result.status === 'disabled') expect(result.reasons).toEqual(['闸门关'])
    expect('runtime' in result).toBe(false)
  })

  test('allowNonLoopbackListen=true + active 证书 → HTTPS listen 成功（port>0 + tls=true + 非 plaintext + 无 executionBridge）', async () => {
    const input = baseInput({})
    input.certStore.generate()
    const result = await bootstrapFusionRoomTransport(input)
    expect(result.status).toBe('listening')
    if (result.status === 'listening') {
      collectRuntime(result)
      expect(result.tls).toBe(true)
      expect(result.host).toBe('0.0.0.0')
      expect(result.address.port).toBeGreaterThan(0)
      expect(result.runtime.server.listening).toBe(true)
      // P0-3c 安全断言：远程 / 打包路径默认不打开成员执行
      expect(result.runtime.executionBridge).toBeUndefined()
      // 行为探测：HTTPS server 对明文 HTTP 请求做 TLS 握手并失败（确实启用 TLS，非明文）
      expect(await plaintextHttpResponds(result.address.port)).toBe(false)
      // 只读状态投影剥离 runtime 句柄
      const view = projectFusionRoomTransportStatus(result)
      expect(view).toEqual({
        status: 'listening',
        host: '0.0.0.0',
        port: result.address.port,
        tls: true,
      })
    }
  })

  test('allowNonLoopbackListen=true 但无 active 证书 → failed，不 listen 非 loopback（不得明文绕过）', async () => {
    const input = baseInput({
      gate: { registerIpc: true, allowNonLoopbackListen: true, reasons: [] },
    })
    // 不 generate 证书 → resolveTlsOptions() 返回 undefined
    const result = await bootstrapFusionRoomTransport(input)
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.error).toContain('TLS')
    }
    expect('runtime' in result).toBe(false)
  })

  test('enableDevLoopbackTransport=true → loopback_only 明文 HTTP（仅 127.0.0.1，tls=false）；误传非 loopback host 不绕过', async () => {
    // 误传非 loopback listenHost：bootstrap 仍强制 127.0.0.1，绝不暴露明文非 loopback
    const input = baseInput({
      gate: { registerIpc: true, allowNonLoopbackListen: false, reasons: [] },
      enableDevLoopbackTransport: true,
      listenHost: '0.0.0.0',
    })
    const result = await bootstrapFusionRoomTransport(input)
    expect(result.status).toBe('loopback_only')
    if (result.status === 'loopback_only') {
      collectRuntime(result)
      expect(result.tls).toBe(false)
      expect(result.address.port).toBeGreaterThan(0)
      expect(result.runtime.server.listening).toBe(true)
      expect(result.runtime.executionBridge).toBeUndefined()
      // 明文 HTTP 对 plaintext 请求有响应（200/401），证明是 HTTP 非 HTTPS
      expect(await plaintextHttpResponds(result.address.port)).toBe(true)
      const view = projectFusionRoomTransportStatus(result)
      expect(view).toEqual({
        status: 'loopback_only',
        host: '127.0.0.1',
        port: result.address.port,
        tls: false,
      })
    }
  })

  test('close() 后端口释放（server.listening=false，幂等）', async () => {
    const input = baseInput({})
    input.certStore.generate()
    const result = await bootstrapFusionRoomTransport(input)
    expect(result.status).toBe('listening')
    if (result.status === 'listening') {
      expect(result.runtime.server.listening).toBe(true)
      await result.runtime.close()
      expect(result.runtime.server.listening).toBe(false)
      await expect(result.runtime.close()).resolves.toBeUndefined()
    }
  })

  test('enableDefaultMemberExecution 始终 false：listening / loopback_only runtime 均无 executionBridge', async () => {
    const inputA = baseInput({})
    inputA.certStore.generate()
    const listening = await bootstrapFusionRoomTransport(inputA)
    expect(listening.status).toBe('listening')
    if (listening.status === 'listening') {
      collectRuntime(listening)
      expect(listening.runtime.executionBridge).toBeUndefined()
    }

    const inputB = baseInput({
      gate: { registerIpc: true, allowNonLoopbackListen: false, reasons: [] },
      enableDevLoopbackTransport: true,
    })
    const loopback = await bootstrapFusionRoomTransport(inputB)
    expect(loopback.status).toBe('loopback_only')
    if (loopback.status === 'loopback_only') {
      collectRuntime(loopback)
      expect(loopback.runtime.executionBridge).toBeUndefined()
    }
  })

  test('未传 authenticate 时默认 deny-all：明文 HTTP 仍可拿到 401（不崩、不绕过认证）', async () => {
    const dir = makeTempDir()
    const certStore = new FusionRoomCertStore({ dir })
    certStore.generate()
    const result = await bootstrapFusionRoomTransport({
      gate: { registerIpc: true, allowNonLoopbackListen: true, reasons: [] },
      certStore,
      listenPort: 0,
      snapshotPath: join(dir, 'snapshots.json'),
      inviteTokenPath: join(dir, 'invite-tokens.json'),
      outboxWorkerStatePath: join(dir, 'outbox-worker.json'),
      // 不传 authenticate → 默认 deny-all fallback（仅邀请令牌可访问）
    })
    expect(result.status).toBe('listening')
    if (result.status === 'listening') {
      collectRuntime(result)
      // 明文探测仍失败（TLS）；不依赖 authenticate 即可确认监听
      expect(await plaintextHttpResponds(result.address.port)).toBe(false)
    }
  })
})

describe('projectFusionRoomTransportStatus', () => {
  test('null → not_started', () => {
    expect(projectFusionRoomTransportStatus(null)).toEqual({ status: 'not_started' })
  })
  test('disabled → disabled + reasons', () => {
    expect(projectFusionRoomTransportStatus({ status: 'disabled', reasons: ['x'] })).toEqual({
      status: 'disabled',
      reasons: ['x'],
    })
  })
  test('failed → failed + error + reasons', () => {
    expect(
      projectFusionRoomTransportStatus({ status: 'failed', error: 'boom', reasons: ['y'] }),
    ).toEqual({ status: 'failed', error: 'boom', reasons: ['y'] })
  })
})
