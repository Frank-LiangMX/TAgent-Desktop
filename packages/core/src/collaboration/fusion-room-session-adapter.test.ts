import { describe, expect, test, vi } from 'vitest'
import type { FusionRoomAuthoritySnapshot } from './fusion-room-authority'
import type { FusionRoomHttpClient } from './fusion-room-http-client'
import { FusionRoomSessionAdapter } from './fusion-room-session-adapter'

const snapshot = (roomId: string, sequence: number): FusionRoomAuthoritySnapshot => ({
  roomId,
  ownerUserId: 'owner',
  status: 'active',
  humanMembers: [],
  botSeats: [],
  botOwnerConsents: {},
  workspace: { id: 'workspace', roomId, kind: 'server', status: 'active', createdAt: 1, updatedAt: 1 },
  messages: [],
  events: [{ sequence } as FusionRoomAuthoritySnapshot['events'][number]],
  usage: [],
  files: [],
  locks: [],
  runs: [],
  tasks: [],
  artifacts: [],
  approvals: [],
  mailbox: [],
})

describe('FusionRoomSessionAdapter', () => {
  test('拥有快照、action 更新和 event cursor，不把 HTTP 细节泄漏给消费者', async () => {
    let current = snapshot('room-adapter', 1)
    const dispatch = vi.fn(async () => {
      current = snapshot('room-adapter', 2)
      return { result: { ok: true }, snapshot: current }
    })
    const client = {
      getSnapshot: vi.fn(async () => current),
      dispatch,
      subscribe: vi.fn(async () => ({ close: vi.fn(), done: Promise.resolve() })),
    } as unknown as FusionRoomHttpClient
    const observed: number[] = []
    const adapter = new FusionRoomSessionAdapter({
      client,
      roomId: 'room-adapter',
      onSnapshot: (next) => observed.push(next.events.at(-1)?.sequence ?? 0),
    })

    await adapter.load()
    await adapter.dispatch({ type: 'message', input: { content: 'hello' } } as never)

    expect(dispatch).toHaveBeenCalledOnce()
    expect(adapter.eventCursor).toBe(2)
    expect(adapter.currentSnapshot?.roomId).toBe('room-adapter')
    expect(observed).toEqual([1, 2])
  })

  test('连接时带 cursor，notification 更新快照，关闭后不再接受事件', async () => {
    let onEvent: ((event: unknown) => void) | undefined
    const client = {
      getSnapshot: vi.fn(async () => snapshot('room-stream', 4)),
      dispatch: vi.fn(),
      subscribe: vi.fn(async (_roomId: string, options: { onEvent: (event: unknown) => void }) => {
        onEvent = options.onEvent
        return { close: vi.fn(), done: Promise.resolve() }
      }),
    } as unknown as FusionRoomHttpClient
    const observed: number[] = []
    const adapter = new FusionRoomSessionAdapter({
      client,
      roomId: 'room-stream',
      onSnapshot: (next) => observed.push(next.events.at(-1)?.sequence ?? 0),
    })

    await adapter.connect()
    expect(adapter.eventCursor).toBe(4)
    onEvent?.({ kind: 'notification', roomId: 'room-stream', cursor: 5, snapshot: snapshot('room-stream', 5) })
    expect(adapter.currentSnapshot?.events.at(-1)?.sequence).toBe(5)
    await adapter.close()
    onEvent?.({ kind: 'notification', roomId: 'room-stream', cursor: 6, snapshot: snapshot('room-stream', 6) })
    expect(adapter.eventCursor).toBe(5)
    expect(observed).toEqual([4, 5])
  })
  test('建连尚未返回时 close 会等待并回收迟到的 subscription', async () => {
    let releaseSubscribe: (() => void) | undefined
    let markSubscribeStarted: (() => void) | undefined
    const subscribeStarted = new Promise<void>((resolve) => { markSubscribeStarted = resolve })
    let closeCalls = 0
    const client = {
      getSnapshot: vi.fn(async () => snapshot('room-race', 1)),
      dispatch: vi.fn(),
      subscribe: vi.fn(async () => {
        markSubscribeStarted?.()
        await new Promise<void>((resolve) => { releaseSubscribe = resolve })
        return {
          close: () => { closeCalls += 1 },
          done: Promise.resolve(),
        }
      }),
    } as unknown as FusionRoomHttpClient
    const adapter = new FusionRoomSessionAdapter({ client, roomId: 'room-race' })
    const connectPromise = adapter.connect()
    await subscribeStarted
    const closePromise = adapter.close()
    releaseSubscribe?.()
    await Promise.all([connectPromise, closePromise])
    expect(closeCalls).toBe(1)
  })

  test('subscribeSnapshot 立即以独立副本通知已有快照，applySnapshot 后通知全部订阅者，且不暴露内部可变对象', async () => {
    let current = snapshot('room-sub', 1)
    const dispatch = vi.fn(async () => {
      current = snapshot('room-sub', 2)
      return { result: { ok: true }, snapshot: current }
    })
    const client = {
      getSnapshot: vi.fn(async () => current),
      dispatch,
      subscribe: vi.fn(async () => ({ close: vi.fn(), done: Promise.resolve() })),
    } as unknown as FusionRoomHttpClient
    const adapter = new FusionRoomSessionAdapter({ client, roomId: 'room-sub' })

    // 订阅时尚无快照：不立即通知
    const firstReceived: FusionRoomAuthoritySnapshot[] = []
    const unsubscribe = adapter.subscribeSnapshot((next) => firstReceived.push(next))
    expect(firstReceived).toHaveLength(0)

    // load() 触发 applySnapshot，订阅者收到独立副本
    await adapter.load()
    expect(firstReceived).toHaveLength(1)
    expect(firstReceived[0].events.at(-1)?.sequence).toBe(1)
    // 修改收到的副本不应影响内部可变对象
    firstReceived[0].events[0]!.sequence = 999
    firstReceived[0].status = 'paused'
    expect(adapter.currentSnapshot?.events[0]?.sequence).toBe(1)
    expect(adapter.currentSnapshot?.status).toBe('active')

    // 订阅时已有快照：立即以 structuredClone 副本同步通知
    const secondReceived: FusionRoomAuthoritySnapshot[] = []
    const unsubscribeSecond = adapter.subscribeSnapshot((next) => secondReceived.push(next))
    expect(secondReceived).toHaveLength(1)
    expect(secondReceived[0].events.at(-1)?.sequence).toBe(1)
    // 两个订阅者拿到的副本相互独立
    secondReceived[0].events[0]!.sequence = 888
    expect(firstReceived[0].events[0]?.sequence).toBe(999)

    // dispatch 再次 applySnapshot：两个订阅者都收到新副本
    await adapter.dispatch({ type: 'message', input: { content: 'hi' } } as never)
    expect(firstReceived).toHaveLength(2)
    expect(secondReceived).toHaveLength(2)
    expect(firstReceived[1].events.at(-1)?.sequence).toBe(2)
    expect(secondReceived[1].events.at(-1)?.sequence).toBe(2)

    // 取消订阅后不再通知
    unsubscribe()
    unsubscribeSecond()
    const next3 = snapshot('room-sub', 3)
    dispatch.mockImplementation(async () => ({ result: { ok: true }, snapshot: next3 }))
    await adapter.dispatch({ type: 'message', input: { content: 'again' } } as never)
    expect(firstReceived).toHaveLength(2)
    expect(secondReceived).toHaveLength(2)
  })
})