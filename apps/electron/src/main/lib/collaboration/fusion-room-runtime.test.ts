import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server as HttpServer } from 'node:http'
import { Server as HttpsServer } from 'node:https'
import { afterEach, describe, expect, test } from 'vitest'
import type { MemberBackendAdapter, RoomBotSeat, RoomWorkspace } from '@tagent/shared'
import { FusionRoomHttpClient } from '@tagent/core'
import type { FusionRoomTlsOptions } from './fusion-room-http-server'
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

function createRuntime(memberAdapter?: MemberBackendAdapter, tls?: FusionRoomTlsOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'tagent-fusion-runtime-'))
  tempDirs.push(dir)
  const runtime = createFusionRoomTransportRuntime({
    snapshotPath: join(dir, 'snapshots.json'),
    inviteTokenPath: join(dir, 'invite-tokens.json'),
    ...(memberAdapter ? { memberAdapter } : {}),
    ...(tls ? { tls } : {}),
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

describe('FusionRoom transport TLS 选项', () => {
  test('未提供 tls 构造 HTTP server，提供 tls 构造 HTTPS server（无需真实证书）', () => {
    const httpRuntime = createRuntime()
    expect(httpRuntime.server).toBeInstanceOf(HttpServer)
    expect(httpRuntime.server).not.toBeInstanceOf(HttpsServer)

    const httpsRuntime = createRuntime(undefined, {})
    expect(httpsRuntime.server).toBeInstanceOf(HttpsServer)
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
