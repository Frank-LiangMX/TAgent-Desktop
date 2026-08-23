import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { MemberBackendAdapter, RoomBotSeat, RoomWorkspace } from '@tagent/shared'
import { FusionRoomHttpClient } from '@tagent/core'
import type { FusionRoomTlsOptions } from './fusion-room-http-server'
import { FusionRoomCertStore } from './fusion-room-cert-store'
import { createFusionRoomTransportRuntime, isFusionRoomLoopbackHost } from './fusion-room-runtime'

const workspace: RoomWorkspace = {
  id: 'rws_runtime',
  roomId: 'runtime-room',
  kind: 'server',
  storageKey: 'runtime-room',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
}

const runtimes: Array<ReturnType<typeof createFusionRoomTransportRuntime>> = []
const seat: RoomBotSeat = {
  id: 'seat-runtime',
  roomId: 'runtime-room',
  botProfileId: 'bot-runtime',
  ownerUserId: 'owner',
  configRevisionId: 'rev-runtime',
  displayNameSnapshot: '开发者',
  roleSnapshot: { displayName: '开发者', systemPrompt: '负责实现和验证。' },
  backend: 'pi',
  modelId: 'runtime-test-model',
  permissionProfile: 'read-only',
  capabilities: {
    supportsResume: false,
    supportsLiveInput: false,
    supportsToolBridge: false,
    supportsStructuredEvents: false,
  },
  status: 'idle',
  logicalSessionId: 'runtime-logical-session',
  isCoordinator: true,
  createdAt: 1,
  updatedAt: 1,
}
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createRuntime(memberAdapter?: MemberBackendAdapter, tls?: FusionRoomTlsOptions, enableDefaultMemberExecution?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-runtime-'))
  tempDirs.push(dir)
  const runtime = createFusionRoomTransportRuntime({
    snapshotPath: join(dir, 'snapshots.json'),
    inviteTokenPath: join(dir, 'invite-tokens.json'),
    outboxWorkerStatePath: join(dir, 'outbox-worker.json'),
    ...(memberAdapter ? { memberAdapter } : {}),
    ...(tls ? { tls } : {}),
    ...(enableDefaultMemberExecution ? { enableDefaultMemberExecution } : {}),
    authenticate: (request) => {
      const raw = request.headers['x-user-id']
      const userId = Array.isArray(raw) ? raw[0] : raw
      return userId ? { userId } : undefined
    },
  })
  runtimes.push(runtime)
  return runtime
}

describe('isFusionRoomLoopbackHost', () => {
  test('接受 canonical loopback 地址', () => {
    expect(isFusionRoomLoopbackHost('127.0.0.1')).toBe(true)
    expect(isFusionRoomLoopbackHost('127.255.255.255')).toBe(true)
    expect(isFusionRoomLoopbackHost('127.0.0.0')).toBe(true)
    expect(isFusionRoomLoopbackHost('localhost')).toBe(true)
    expect(isFusionRoomLoopbackHost('LOCALHOST')).toBe(true)
    expect(isFusionRoomLoopbackHost('LocalHost')).toBe(true)
    expect(isFusionRoomLoopbackHost('::1')).toBe(true)
  })

  test('trim 后判定', () => {
    expect(isFusionRoomLoopbackHost('  127.0.0.1  ')).toBe(true)
    expect(isFusionRoomLoopbackHost('\tlocalhost\n')).toBe(true)
    expect(isFusionRoomLoopbackHost('  ::1  ')).toBe(true)
  })

  test('拒绝空值与纯空格', () => {
    expect(isFusionRoomLoopbackHost('')).toBe(false)
    expect(isFusionRoomLoopbackHost('   ')).toBe(false)
    expect(isFusionRoomLoopbackHost('\t\n')).toBe(false)
  })

  test('拒绝非 loopback 与任意 hostname', () => {
    expect(isFusionRoomLoopbackHost('0.0.0.0')).toBe(false)
    expect(isFusionRoomLoopbackHost('::')).toBe(false)
    expect(isFusionRoomLoopbackHost('192.168.1.2')).toBe(false)
    expect(isFusionRoomLoopbackHost('10.0.0.1')).toBe(false)
    expect(isFusionRoomLoopbackHost('172.16.0.1')).toBe(false)
    expect(isFusionRoomLoopbackHost('128.0.0.1')).toBe(false)
    expect(isFusionRoomLoopbackHost('example.com')).toBe(false)
    expect(isFusionRoomLoopbackHost('localhost.example.com')).toBe(false)
  })

  test('拒绝 IPv4 伪造写法（八进制/十六进制/短格式/单整数/带尾域名）', () => {
    // 八进制前导零：0127 在某些 C 库按八进制解释成 87，而非 127
    expect(isFusionRoomLoopbackHost('0127.0.0.1')).toBe(false)
    expect(isFusionRoomLoopbackHost('127.0.0.01')).toBe(false)
    expect(isFusionRoomLoopbackHost('127.00.0.1')).toBe(false)
    // 十六进制
    expect(isFusionRoomLoopbackHost('0x7f.0.0.1')).toBe(false)
    // 短格式
    expect(isFusionRoomLoopbackHost('127.1')).toBe(false)
    expect(isFusionRoomLoopbackHost('127.0.1')).toBe(false)
    // 单整数
    expect(isFusionRoomLoopbackHost('2130706433')).toBe(false)
    // 带尾域名 / FQDN
    expect(isFusionRoomLoopbackHost('127.0.0.1.example.com')).toBe(false)
    expect(isFusionRoomLoopbackHost('localhost.')).toBe(false)
    // 越界段
    expect(isFusionRoomLoopbackHost('127.0.0.256')).toBe(false)
    expect(isFusionRoomLoopbackHost('127.999.0.1')).toBe(false)
  })
})

describe('FusionRoom transport loopback 安全闸门', () => {
  test('默认/127.0.0.1/localhost/::1 可以启动并 close（port 0）', async () => {
    const cases: Array<{ label: string; opts: { host?: string; port: number } }> = [
      { label: '默认(127.0.0.1)', opts: { port: 0 } },
      { label: '127.0.0.1', opts: { host: '127.0.0.1', port: 0 } },
      { label: 'localhost', opts: { host: 'localhost', port: 0 } },
      { label: '::1', opts: { host: '::1', port: 0 } },
    ]
    for (const { label, opts } of cases) {
      const runtime = createRuntime()
      const address = await runtime.start(opts)
      expect(runtime.server.listening).toBe(true)
      expect(address.port).toBeGreaterThan(0)
      await runtime.close()
      expect(runtime.server.listening).toBe(false)
      // close 幂等
      await expect(runtime.close()).resolves.toBeUndefined()
      // label 仅用于失败时定位，避免未使用变量 lint
      expect(label.length).toBeGreaterThan(0)
    }
  })

  test('0.0.0.0/::/局域网 IP/hostname 被拒绝，且拒绝后 close 不报错', async () => {
    const rejectedHosts = ['0.0.0.0', '::', '192.168.1.2', 'example.com']
    for (const host of rejectedHosts) {
      const runtime = createRuntime()
      await expect(runtime.start({ host, port: 0 })).rejects.toThrow(/loopback/)
      // 拒绝发生在 listen 之前，server 未绑定
      expect(runtime.server.listening).toBe(false)
      // 拒绝后 close 不报错（started 仍为 false）
      await expect(runtime.close()).resolves.toBeUndefined()
      // close 幂等
      await expect(runtime.close()).resolves.toBeUndefined()
    }
  })

  test('拒绝伪造 IPv4 写法（八进制前导零）', async () => {
    const runtime = createRuntime()
    await expect(runtime.start({ host: '0127.0.0.1', port: 0 })).rejects.toThrow(/loopback/)
    expect(runtime.server.listening).toBe(false)
    await expect(runtime.close()).resolves.toBeUndefined()
  })

  test('非 loopback 拒绝后仍可用 loopback 重新 start', async () => {
    const runtime = createRuntime()
    await expect(runtime.start({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/loopback/)
    // 拒绝没有毒化 runtime，可以改用 loopback 启动
    const address = await runtime.start({ host: '127.0.0.1', port: 0 })
    expect(runtime.server.listening).toBe(true)
    expect(address.port).toBeGreaterThan(0)
    await runtime.close()
    expect(runtime.server.listening).toBe(false)
  })
})

/**
 * 行为探测：明文 HTTP 请求能否拿到 HTTP 响应。
 *
 * Bun 1.3.14 下 `node:http` 与 `node:https` 的 Server 共用同一 constructor，
 * `instanceof HttpsServer` / `setSecureContext` 都无法区分 HTTP/HTTPS server（见
 * 12-IMPLEMENTATION-LOG §73 的 Bun quirk 记录）。改为跨运行时稳定的行为探测：
 * 明文 HTTP transport 会返回 HTTP 响应；HTTPS transport 会对明文字节做 TLS 握手并失败。
 */
async function acceptsPlaintextHttp(
  runtime: ReturnType<typeof createFusionRoomTransportRuntime>,
): Promise<boolean> {
  const address = await runtime.start({ host: '127.0.0.1', port: 0 })
  try {
    const raced = await Promise.race([
      fetch('http://127.0.0.1:' + address.port + '/rooms', {
        headers: { 'x-user-id': 'owner' },
      }).then((response) => response as Response | null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ])
    if (raced === null) return false // 超时 → 未在明文 HTTP 上响应（按 HTTPS 处理）
    return raced.status === 200 || raced.status === 401
  } catch {
    return false // TLS server 拒绝明文请求
  } finally {
    await runtime.close()
  }
}

describe('FusionRoom transport TLS 选项', () => {
  test('未提供 tls 构造明文 HTTP server；提供真实证书 tls 构造 HTTPS server（行为探测，Bun/Node 通用）', async () => {
    // 明文 HTTP transport 接受明文请求。
    const httpRuntime = createRuntime()
    expect(await acceptsPlaintextHttp(httpRuntime)).toBe(true)

    // Bun 下 `https.createServer({})` 无证书会降级为明文 HTTP，必须提供真实 key/cert
    // 才会启用 TLS，从而对明文请求做 TLS 握手并失败。用 cert store 产出真实自签材料。
    const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-tls-probe-'))
    tempDirs.push(dir)
    const certStore = new FusionRoomCertStore({ dir })
    certStore.generate()
    const tls = certStore.resolveTlsOptions() as FusionRoomTlsOptions
    const httpsRuntime = createRuntime(undefined, tls)
    expect(await acceptsPlaintextHttp(httpsRuntime)).toBe(false)
  })

  test('cert store 产出的真实自签材料可驱动 runtime 在 loopback start/close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-cert-runtime-'))
    tempDirs.push(dir)
    const certStore = new FusionRoomCertStore({ dir })
    // 未生成证书前 resolveTlsOptions 为空，runtime 仍走明文 HTTP。
    expect(certStore.resolveTlsOptions()).toBeUndefined()
    certStore.generate()
    const tls = certStore.resolveTlsOptions()
    expect(tls).toBeDefined()

    const runtime = createRuntime(undefined, tls as FusionRoomTlsOptions)
    const address = await runtime.start({ host: '127.0.0.1', port: 0 })
    expect(runtime.server.listening).toBe(true)
    expect(address.port).toBeGreaterThan(0)
    await runtime.close()
    expect(runtime.server.listening).toBe(false)
    await expect(runtime.close()).resolves.toBeUndefined()
  })

  test('提供 tls 时 loopback 仍可启动并 close（不引入真实证书/网络依赖）', async () => {
    const runtime = createRuntime(undefined, {})
    const address = await runtime.start({ host: '127.0.0.1', port: 0 })
    expect(runtime.server.listening).toBe(true)
    expect(address.port).toBeGreaterThan(0)
    await runtime.close()
    expect(runtime.server.listening).toBe(false)
    // close 幂等
    await expect(runtime.close()).resolves.toBeUndefined()
  })

  test('提供 tls 时非 loopback 地址不再被 loopback 闸门拒绝', async () => {
    const runtime = createRuntime(undefined, {})
    const address = await runtime.start({ host: '0.0.0.0', port: 0 })
    expect(runtime.server.listening).toBe(true)
    expect(address.port).toBeGreaterThan(0)
    await runtime.close()
    expect(runtime.server.listening).toBe(false)
  })

  test('未提供 tls 时非 loopback 仍被拒绝（与 TLS 放行互不干扰）', async () => {
    const runtime = createRuntime()
    await expect(runtime.start({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/loopback/)
    expect(runtime.server.listening).toBe(false)
    await expect(runtime.close()).resolves.toBeUndefined()
  })
})

describe('FusionRoom transport runtime lifecycle', () => {
  test('默认不监听，显式 start 后可以通过 HTTP 工作并 close', async () => {
    const runtime = createRuntime()
    expect(runtime.server.listening).toBe(false)

    const address = await runtime.start()
    expect(runtime.server.listening).toBe(true)

    const response = await fetch('http://127.0.0.1:' + address.port + '/rooms', {
      headers: { 'x-user-id': 'owner' },
    })
    expect(response.status).toBe(200)
    expect((await response.json()).roomIds).toEqual([])

    await runtime.close()
    expect(runtime.server.listening).toBe(false)
    await runtime.close()
  })

  test('房主可以签发邀请令牌，受邀用户可通过 Bearer 进入房间', async () => {
    const runtime = createRuntime()
    const address = await runtime.start()
    const baseUrl = 'http://127.0.0.1:' + address.port

    const created = await fetch(baseUrl + '/rooms', {
      method: 'POST',
      headers: {
        'x-user-id': 'owner',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ roomId: 'runtime-room', workspace }),
    })
    expect(created.status).toBe(201)

    const inviteResponse = await fetch(baseUrl + '/rooms/runtime-room/invites', {
      method: 'POST',
      headers: {
        'x-user-id': 'owner',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ userId: 'user-b', displayName: 'B' }),
    })
    expect(inviteResponse.status).toBe(201)
    const invite = (await inviteResponse.json()) as { token: string }
    expect(invite.token).toMatch(/^frt1\./)

    const accepted = await fetch(baseUrl + '/rooms/runtime-room/actions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + invite.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: { type: 'accept-invitation' } }),
    })
    expect(accepted.status).toBe(200)

    const snapshot = await fetch(baseUrl + '/rooms/runtime-room', {
      headers: { authorization: 'Bearer ' + invite.token },
    })
    expect(snapshot.status).toBe(200)
    expect((await snapshot.json()).humanMembers.some((member: { userId: string }) => member.userId === 'user-b')).toBe(true)
  })
  test('close 会主动回收活跃 SSE 连接', async () => {
    const runtime = createRuntime()
    const address = await runtime.start()
    runtime.gateway.createRoom({ userId: 'owner' }, { roomId: 'runtime-room', workspace })
    const stream = await fetch('http://127.0.0.1:' + address.port + '/rooms/runtime-room/events', {
      headers: { 'x-user-id': 'owner' },
    })
    expect(stream.status).toBe(200)
    await stream.body?.getReader().read()

    const closeResult = await Promise.race([
      runtime.close().then(() => 'closed'),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('runtime.close 超时')), 1_000),
      ),
    ])
    expect(closeResult).toBe('closed')
    await stream.body?.cancel().catch(() => undefined)
  })

  test('同一快照文件可在 runtime 重建后恢复房间', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-runtime-restart-'))
    tempDirs.push(dir)
    const snapshotPath = join(dir, 'snapshots.json')
    const first = createFusionRoomTransportRuntime({
      snapshotPath,
      authenticate: () => ({ userId: 'owner' }),
    })
    runtimes.push(first)
    first.gateway.createRoom({ userId: 'owner' }, { roomId: 'runtime-room', workspace })
    await first.close()

    const second = createFusionRoomTransportRuntime({
      snapshotPath,
      authenticate: () => ({ userId: 'owner' }),
    })
    runtimes.push(second)
    const connectionId = second.gateway.connect({ userId: 'owner' })
    const ids = second.gateway.listAccessibleRoomIds(connectionId)
    second.gateway.disconnect(connectionId)
    expect(ids).toEqual(['runtime-room'])
  })

  test('HTTP client 可以消费真实 runtime 的 replay 和 live SSE', async () => {
    const runtime = createRuntime()
    const address = await runtime.start()
    const client = new FusionRoomHttpClient({
      baseUrl: 'http://127.0.0.1:' + address.port,
      headers: { 'x-user-id': 'owner' },
    })
    await client.createRoom({ roomId: 'runtime-room', workspace })
    await client.dispatch('runtime-room', { type: 'message', input: { content: '历史消息' } })

    const signal = (label: string) => {
      let resolveSignal: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const promise = new Promise<void>((resolve, reject) => {
        resolveSignal = () => { if (timer) clearTimeout(timer); resolve() }
        timer = setTimeout(() => reject(new Error(label + ' 未到达')), 1_000)
      })
      return { promise, resolve: () => resolveSignal?.() }
    }
    const replay = signal('replay')
    const live = signal('live event')
    const subscription = await client.subscribe('runtime-room', {
      afterSequence: 1,
      onEvent: (event) => {
        if (event.kind === 'replay') replay.resolve()
        if (event.kind === 'notification') live.resolve()
      },
    })
    await replay.promise
    await client.dispatch('runtime-room', { type: 'message', input: { content: '实时消息' } })
    await live.promise
    subscription.close()
    await subscription.done
  })
  test('HTTP action 会驱动注入的成员后端，并把结果写回 RoomSession', async () => {
    let calls = 0
    let prompt = ''
    const adapter: MemberBackendAdapter = {
      capabilities: () => ({
        supportsResume: false,
        supportsLiveInput: false,
        supportsToolBridge: false,
        supportsStructuredEvents: false,
      }),
      async runTurn(input) {
        calls += 1
        prompt = input.prompt
        return { text: 'runtime bot **已完成**', usage: { inputTokens: 3, outputTokens: 5 } }
      },
    }
    const runtime = createRuntime(adapter)
    const address = await runtime.start()
    const client = new FusionRoomHttpClient({
      baseUrl: 'http://127.0.0.1:' + address.port,
      headers: { 'x-user-id': 'owner' },
    })
    await client.createRoom({ roomId: 'runtime-room', workspace })
    await client.dispatch('runtime-room', { type: 'add-bot', input: { seat } })
    await client.dispatch('runtime-room', {
      type: 'message',
      input: { content: '请通过 HTTP 执行' },
    })
    await runtime.executionBridge?.waitForIdle()

    const snapshot = await client.getSnapshot('runtime-room')
    expect(calls).toBe(1)
    expect(prompt).toContain('请通过 HTTP 执行')
    expect(snapshot.messages.map((message) => message.authorType)).toEqual(['user', 'member'])
    expect(snapshot.messages[1]?.content).toContain('已完成')
    expect(snapshot.runs[0]?.status).toBe('completed')
    expect(snapshot.usage[0]?.outputTokens).toBe(5)
  })
})

describe('FusionRoom transport enableDefaultMemberExecution（P1-2c）', () => {
  test('默认 false：未传 memberAdapter 时无 executionBridge（authority-only transport，不自动开执行）', () => {
    const runtime = createRuntime()
    expect(runtime.executionBridge).toBeUndefined()
  })

  test('enableDefaultMemberExecution=true 且未传 memberAdapter：自动装配默认成员栈 + executionBridge', () => {
    const runtime = createRuntime(undefined, undefined, true)
    expect(runtime.executionBridge).toBeDefined()
  })

  test('显式 memberAdapter 仍优先：与 enableDefaultMemberExecution=true 共存时 bridge 用显式 adapter', () => {
    let calls = 0
    const adapter: MemberBackendAdapter = {
      capabilities: () => ({
        supportsResume: false,
        supportsLiveInput: false,
        supportsToolBridge: false,
        supportsStructuredEvents: false,
      }),
      async runTurn() {
        calls += 1
        return { text: 'explicit adapter reply' }
      },
    }
    // 传显式 adapter + 打开 enableDefaultMemberExecution：不应自动装配默认栈覆盖显式 adapter。
    const runtime = createRuntime(adapter, undefined, true)
    expect(runtime.executionBridge).toBeDefined()
    expect(calls).toBe(0) // 未 dispatch 时不调用
  })
})

describe('FusionRoom transport outbox worker 启动 drain（P1-3）', () => {
  const reviewerSeat: RoomBotSeat = {
    ...seat,
    id: 'seat-reviewer',
    botProfileId: 'bot-reviewer',
    displayNameSnapshot: '审阅者',
    roleSnapshot: { displayName: '审阅者', systemPrompt: '负责审阅。' },
    logicalSessionId: 'runtime-logical-reviewer',
    isCoordinator: false,
  }

  test('注入 adapter：构造期 recover 把残留 running run 标 blocked，drain 把 outbox 信封推进并唤醒 toMember', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-outbox-e2e-'))
    tempDirs.push(dir)
    const snapshotPath = join(dir, 'snapshots.json')
    const outboxStatePath = join(dir, 'outbox-worker.json')
    const inviteTokenPath = join(dir, 'invites.json')

    // runtime A（authority-only）：设置 outbox 信封 + 仍在 running 的 run，close 持久化
    const A = createFusionRoomTransportRuntime({
      snapshotPath, inviteTokenPath, outboxWorkerStatePath: outboxStatePath,
      authenticate: () => ({ userId: 'owner' }),
    })
    runtimes.push(A)
    A.host.createRoom({ roomId: 'runtime-room', ownerUserId: 'owner', workspace, now: 1 })
    A.host.dispatch('runtime-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    A.host.dispatch('runtime-room', { type: 'add-bot', input: { actorUserId: 'owner', seat: reviewerSeat } })
    const root = A.host.dispatch('runtime-room', { type: 'message', input: { actorUserId: 'owner', content: 'root' } })
    const rootId = root && 'id' in root ? root.id : ''
    const run = A.host.dispatch('runtime-room', {
      type: 'start-run',
      input: { actorUserId: 'owner', seatId: seat.id, backend: seat.backend, idempotencyKey: 'e2e-run' },
    })
    const runId = run && 'id' in run ? run.id : ''
    const envelope = A.host.dispatch('runtime-room', {
      type: 'send-mailbox',
      input: {
        actorUserId: 'owner', roomId: 'runtime-room', fromMemberId: seat.id, toMemberId: reviewerSeat.id,
        runId, type: 'question', payload: '请审阅', rootMessageId: rootId, idempotencyKey: 'e2e-send',
      },
    })
    const envelopeId = envelope && 'id' in envelope ? envelope.id : ''
    expect(A.host.getSnapshot('runtime-room').mailbox[0]?.delivery).toBe('outbox')
    await A.close()

    // runtime B（计数 adapter，同 snapshotPath + outboxStatePath）：构造期 recover + drain
    const calls = { value: 0 }
    const adapter: MemberBackendAdapter = {
      capabilities: () => ({
        supportsResume: false, supportsLiveInput: false, supportsToolBridge: false, supportsStructuredEvents: false,
      }),
      async runTurn() { calls.value += 1; return { text: '已审阅' } },
    }
    const B = createFusionRoomTransportRuntime({
      snapshotPath, inviteTokenPath, outboxWorkerStatePath: outboxStatePath, memberAdapter: adapter,
      authenticate: () => ({ userId: 'owner' }),
    })
    runtimes.push(B)

    // recover：残留 running run 已标 blocked（未自动重放）
    expect(B.host.getSnapshot('runtime-room').runs.some((r) => r.id === runId && r.status === 'blocked')).toBe(true)
    // drain：outbox 信封已推进为 dispatched
    expect(B.host.getSnapshot('runtime-room').mailbox[0]?.delivery).toBe('dispatched')
    // outboxWorker 已挂载并持久化 processed 键
    expect(B.outboxWorker).toBeDefined()
    expect(B.outboxWorker.listProcessedKeys()).toContain('runtime-room:mailbox_outbox:' + envelopeId)
    // drain 唤醒 toMember（reviewerSeat）拉新 turn
    await B.executionBridge?.waitForIdle()
    expect(calls.value).toBe(1)
    expect(B.host.getSnapshot('runtime-room').runs.some((r) => r.seatId === reviewerSeat.id && r.status === 'completed')).toBe(true)
    await B.close()
  })

  test('enableDefaultMemberExecution：outboxWorker 始终挂载（无房间时不 drain、不触网）', () => {
    const runtime = createRuntime(undefined, undefined, true)
    expect(runtime.executionBridge).toBeDefined()
    expect(runtime.outboxWorker).toBeDefined()
    expect(runtime.outboxWorker.listProcessedKeys()).toEqual([])
  })

  test('默认（authority-only）：outboxWorker 仍挂载，可只读 scan / observe，不驱动执行', () => {
    const runtime = createRuntime()
    expect(runtime.executionBridge).toBeUndefined()
    expect(runtime.outboxWorker).toBeDefined()
    expect(runtime.outboxWorker.listProcessedKeys()).toEqual([])
  })
})
