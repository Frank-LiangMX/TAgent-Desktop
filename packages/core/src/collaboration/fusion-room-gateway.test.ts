import { describe, expect, test } from 'vitest'
import type { RoomWorkspace } from '@tagent/shared'
import { FusionRoomAuthorityError } from './fusion-room-authority'
import { FusionRoomGateway } from './fusion-room-gateway'
import { FusionRoomHost } from './fusion-room-host'
import type { FusionResumeContinuationResult } from './fusion-room-continuation'

const workspace: RoomWorkspace = {
  id: 'rws_gateway',
  roomId: 'gateway-room',
  kind: 'server',
  storageKey: 'gateway-room',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
}

function setup() {
  const host = new FusionRoomHost()
  host.createRoom({
    roomId: 'gateway-room',
    ownerUserId: 'owner',
    workspace,
    now: 1,
  })
  const gateway = new FusionRoomGateway(host)
  return { host, gateway }
}

describe('FusionRoomGateway', () => {
  test('认证 principal 注入 actor，wire payload 不能冒充其他用户', () => {
    const { gateway } = setup()
    const owner = gateway.connect({ userId: 'owner' })
    const member = gateway.connect({ userId: 'user-b' })

    gateway.dispatch(owner, 'gateway-room', {
      type: 'invite-human',
      userId: 'user-b',
      displayName: 'B',
    })
    expect(gateway.getSnapshot(member, 'gateway-room').humanMembers.find((item) => item.userId === 'user-b')?.status).toBe('invited')
    gateway.dispatch(member, 'gateway-room', { type: 'accept-invitation' })

    const message = gateway.dispatch(member, 'gateway-room', {
      type: 'message',
      input: {
        content: '真实作者应当是 B',
        actorUserId: 'owner',
      } as never,
    })
    expect(message && 'authorId' in message ? message.authorId : '').toBe('user-b')
    expect(gateway.getSnapshot(owner, 'gateway-room').messages[0]?.authorId).toBe('user-b')
  })

  test('只有房间成员可以读取和订阅，事件只推送给已授权连接', () => {
    const { gateway } = setup()
    const owner = gateway.connect({ userId: 'owner' })
    const outsider = gateway.connect({ userId: 'outsider' })
    const events: string[] = []

    expect(() => gateway.getSnapshot(outsider, 'gateway-room')).toThrow(
      FusionRoomAuthorityError,
    )
    expect(() => gateway.subscribe(outsider, 'gateway-room', () => undefined)).toThrow(
      FusionRoomAuthorityError,
    )

    gateway.dispatch(owner, 'gateway-room', {
      type: 'invite-human',
      userId: 'user-b',
      displayName: 'B',
    })
    expect(gateway.listAccessibleRoomIds(outsider)).toEqual([])
    expect(gateway.listAccessibleRoomIds(owner)).toEqual(['gateway-room'])

    const stop = gateway.subscribe(owner, 'gateway-room', (notification) => {
      events.push(...notification.events.map((event) => event.type))
    })
    gateway.dispatch(owner, 'gateway-room', {
      type: 'status',
      status: 'paused',
    })
    expect(events).toEqual(['room.updated'])
    stop()
    gateway.disconnect(outsider)
    expect(() => gateway.getSnapshot(outsider, 'gateway-room')).toThrow(
      FusionRoomAuthorityError,
    )
  })

  test('幂等 key 按用户和动作隔离', () => {
    const { gateway } = setup()
    const owner = gateway.connect({ userId: 'owner' })
    const member = gateway.connect({ userId: 'user-b' })
    gateway.dispatch(owner, 'gateway-room', {
      type: 'invite-human',
      userId: 'user-b',
      displayName: 'B',
    })
    gateway.dispatch(member, 'gateway-room', { type: 'accept-invitation' })
    gateway.dispatch(owner, 'gateway-room', {
      type: 'message',
      input: { content: 'owner', idempotencyKey: 'same-key' },
    })
    gateway.dispatch(member, 'gateway-room', {
      type: 'message',
      input: { content: 'member', idempotencyKey: 'same-key' },
    })
    expect(gateway.getSnapshot(owner, 'gateway-room').messages.map((item) => item.content)).toEqual(['owner', 'member'])
  })

  test('带 room scope 的 principal 不能跨房间访问', () => {
    const { host, gateway } = setup()
    host.createRoom({
      roomId: 'other-room',
      ownerUserId: 'owner',
      workspace: { ...workspace, id: 'rws_other', roomId: 'other-room', storageKey: 'other-room' },
      now: 1,
    })
    const scoped = gateway.connect({ userId: 'owner', roomId: 'gateway-room' })
    expect(gateway.getSnapshot(scoped, 'gateway-room').roomId).toBe('gateway-room')
    expect(() => gateway.getSnapshot(scoped, 'other-room')).toThrow(FusionRoomAuthorityError)
  })
  test('worker principal 委托 ACL 协议判定：房主放行、非房主拒绝', () => {
    const { gateway } = setup()
    const workerOwner = gateway.connect({ userId: 'owner', kind: 'worker' })
    // worker = 房主 → defaultAuthorize 委托 decideRoomAccess 放行
    expect(gateway.getSnapshot(workerOwner, 'gateway-room').ownerUserId).toBe('owner')

    // 房主先邀请一个真实人类成员，worker principal 复用其 userId 但 kind=worker
    const owner = gateway.connect({ userId: 'owner' })
    gateway.dispatch(owner, 'gateway-room', {
      type: 'invite-human',
      userId: 'user-b',
      displayName: 'B',
    })
    gateway.dispatch(gateway.connect({ userId: 'user-b' }), 'gateway-room', { type: 'accept-invitation' })
    const workerMember = gateway.connect({ userId: 'user-b', kind: 'worker' })
    // worker 不是房主，即便 userId 是活跃成员也拒绝（委托 ACL 的 worker 语义）
    expect(() => gateway.getSnapshot(workerMember, 'gateway-room')).toThrow(
      FusionRoomAuthorityError,
    )
    expect(gateway.listAccessibleRoomIds(workerMember)).toEqual([])
  })
  test('成员退出和房主移除通过 Gateway 注入真实 actor', () => {
    const { gateway } = setup()
    const owner = gateway.connect({ userId: 'owner' })
    const member = gateway.connect({ userId: 'user-b' })
    gateway.dispatch(owner, 'gateway-room', {
      type: 'invite-human',
      userId: 'user-b',
      displayName: 'B',
    })
    gateway.dispatch(member, 'gateway-room', { type: 'accept-invitation' })
    gateway.dispatch(member, 'gateway-room', { type: 'leave-human' })
    expect(gateway.getSnapshot(owner, 'gateway-room').humanMembers.find((item) => item.userId === 'user-b')?.status).toBe('left')
    gateway.dispatch(owner, 'gateway-room', {
      type: 'invite-human',
      userId: 'user-b',
      displayName: 'B',
    })
    gateway.dispatch(member, 'gateway-room', { type: 'accept-invitation' })
    gateway.dispatch(owner, 'gateway-room', { type: 'remove-human', userId: 'user-b' })
    expect(gateway.getSnapshot(owner, 'gateway-room').humanMembers.find((item) => item.userId === 'user-b')?.status).toBe('removed')
  })
  test('断线清理订阅，幂等消息仍由权威层处理', () => {
    const { gateway } = setup()
    const owner = gateway.connect({ userId: 'owner' })
    const messages: string[] = []
    const stop = gateway.subscribe(owner, 'gateway-room', (notification) => {
      messages.push(...notification.events.map((event) => event.type))
    })

    gateway.dispatch(owner, 'gateway-room', {
      type: 'message',
      input: { content: '一次消息', idempotencyKey: 'gateway-message-1' },
    })
    gateway.dispatch(owner, 'gateway-room', {
      type: 'message',
      input: { content: '一次消息', idempotencyKey: 'gateway-message-1' },
    })
    expect(gateway.getSnapshot(owner, 'gateway-room').messages).toHaveLength(1)
    expect(messages).toEqual(['message.appended'])
    stop()
    gateway.disconnect(owner)
  })

  test('event cursor 只返回授权房间的增量并拒绝非法游标', () => {
    const { gateway } = setup()
    const owner = gateway.connect({ userId: 'owner' })
    const outsider = gateway.connect({ userId: 'outsider' })

    const before = gateway.listEvents(owner, 'gateway-room', 0)
    expect(before.map((event) => event.sequence)).toEqual([1])

    gateway.dispatch(owner, 'gateway-room', {
      type: 'message',
      input: { content: '增量消息', idempotencyKey: 'cursor-message' },
    })
    const after = gateway.listEvents(owner, 'gateway-room', before.at(-1)?.sequence ?? 0)
    expect(after).toHaveLength(1)
    expect(after[0]?.type).toBe('message.appended')
    expect(after[0]?.sequence).toBe(2)

    expect(() => gateway.listEvents(outsider, 'gateway-room', 0)).toThrow(
      FusionRoomAuthorityError,
    )
    expect(() => gateway.listEvents(owner, 'gateway-room', -1)).toThrow(
      FusionRoomAuthorityError,
    )
  })
  test('task actions inject the authenticated actor and persist the projection', () => {
    const { gateway } = setup()
    const owner = gateway.connect({ userId: 'owner' })
    gateway.dispatch(owner, 'gateway-room', {
      type: 'create-task',
      input: {
        roomId: 'gateway-room',
        task: { title: 'remote task' },
        actorUserId: 'spoofed',
      } as never,
    })
    const created = gateway.getSnapshot(owner, 'gateway-room').tasks[0]
    expect(created?.title).toBe('remote task')
    expect(created?.version).toBe(1)
    gateway.dispatch(owner, 'gateway-room', {
      type: 'update-task',
      input: {
        roomId: 'gateway-room',
        taskId: created!.id,
        status: 'in_progress',
        expectedVersion: 1,
        actorUserId: 'spoofed',
      } as never,
    })
    const updated = gateway.getSnapshot(owner, 'gateway-room').tasks[0]
    expect(updated?.status).toBe('in_progress')
    expect(updated?.version).toBe(2)
  })
  test('approval and mailbox actions inject the authenticated actor', () => {
    const { gateway } = setup()
    const owner = gateway.connect({ userId: 'owner' })
    const bot = (id: string) => ({
      id, roomId: 'gateway-room', botProfileId: id, ownerUserId: 'owner',
      configRevisionId: 'rev-' + id, displayNameSnapshot: id, roleSnapshot: { displayName: id },
      backend: 'pi', modelId: 'test-model', permissionProfile: 'workspace-write',
      capabilities: {}, status: 'idle', logicalSessionId: 'session-' + id,
      isCoordinator: false, createdAt: 1, updatedAt: 1,
    })
    gateway.dispatch(owner, 'gateway-room', { type: 'add-bot', input: { seat: bot('a'), actorUserId: 'spoofed' } as never })
    gateway.dispatch(owner, 'gateway-room', { type: 'add-bot', input: { seat: bot('b'), actorUserId: 'spoofed' } as never })
    const snapshot = gateway.getSnapshot(owner, 'gateway-room')
    const first = snapshot.botSeats[0]!
    const second = snapshot.botSeats[1]!
    const firstRun = gateway.dispatch(owner, 'gateway-room', { type: 'start-run', input: { seatId: first.id, backend: 'pi', actorUserId: 'spoofed' } as never }) as { id: string }
    const secondRun = gateway.dispatch(owner, 'gateway-room', { type: 'start-run', input: { seatId: second.id, backend: 'pi', actorUserId: 'spoofed' } as never }) as { id: string }
    const root = gateway.dispatch(owner, 'gateway-room', { type: 'message', input: { content: 'root' } }) as { id: string }
    gateway.dispatch(owner, 'gateway-room', {
      type: 'request-approval',
      input: { roomId: 'gateway-room', memberId: first.id, runId: firstRun.id, question: 'continue?', actorUserId: 'spoofed' } as never,
    })
    const approval = gateway.getSnapshot(owner, 'gateway-room').approvals[0]
    expect(approval?.status).toBe('pending')
    gateway.dispatch(owner, 'gateway-room', {
      type: 'resolve-approval',
      input: { roomId: 'gateway-room', requestId: approval!.id, decision: 'approved', actorUserId: 'spoofed' } as never,
    })
    const sent = gateway.dispatch(owner, 'gateway-room', {
      type: 'send-mailbox',
      input: {
        roomId: 'gateway-room', fromMemberId: first.id, toMemberId: second.id,
        runId: firstRun.id, type: 'question', payload: 'review', rootMessageId: root.id,
        actorUserId: 'spoofed',
      } as never,
    }) as { id: string }
    expect(gateway.getSnapshot(owner, 'gateway-room').mailbox.find((item) => item.id === sent.id)?.fromMemberId).toBe(first.id)
    gateway.dispatch(owner, 'gateway-room', {
      type: 'reply-mailbox',
      input: { roomId: 'gateway-room', requestId: gateway.getSnapshot(owner, 'gateway-room').mailbox.find((item) => item.id === sent.id)?.requestId, runId: secondRun.id, answer: 'ok', actorUserId: 'spoofed' } as never,
    })
    expect(gateway.getSnapshot(owner, 'gateway-room').mailbox.filter((item) => item.state === 'answered')).toHaveLength(2)
  })

  test('confirm-resume-continuation 注入 principal actor，忽略 wire 的 actorUserId，旧 run 不复活', () => {
    const { host, gateway } = setup()
    const owner = gateway.connect({ userId: 'owner' })
    const bot = (id: string) => ({
      id, roomId: 'gateway-room', botProfileId: id, ownerUserId: 'owner',
      configRevisionId: 'rev-' + id, displayNameSnapshot: id, roleSnapshot: { displayName: id },
      backend: 'pi', modelId: 'test-model', permissionProfile: 'workspace-write',
      capabilities: {}, status: 'idle', logicalSessionId: 'session-' + id,
      isCoordinator: false, createdAt: 1, updatedAt: 1,
    })
    gateway.dispatch(owner, 'gateway-room', { type: 'add-bot', input: { seat: bot('a'), actorUserId: 'spoofed' } as never })
    gateway.dispatch(owner, 'gateway-room', { type: 'start-run', input: { seatId: 'a', backend: 'pi', actorUserId: 'spoofed' } as never })
    // 模拟进程退出：recover 把 running run 标 blocked
    host.recoverInterruptedRuns()
    const runId = host.getSnapshot('gateway-room').runs[0]!.id
    expect(host.getSnapshot('gateway-room').runs[0]?.status).toBe('blocked')

    // wire payload 试图冒充 actorUserId:'spoofed'；gateway 应注入 principal 'owner'
    const result = gateway.dispatch(owner, 'gateway-room', {
      type: 'confirm-resume-continuation',
      input: { roomId: 'gateway-room', continuationId: runId, kind: 'blocked_run', actorUserId: 'spoofed' } as never,
    }) as FusionResumeContinuationResult
    expect(result.status).toBe('confirmed')
    expect(result.kind).toBe('blocked_run')
    expect(result.event.type).toBe('run.resume_confirmed')
    expect(result.event.actorUserId).toBe('owner')
    // 旧 run 仍是 blocked，confirm 不复活旧 fence
    expect(host.getSnapshot('gateway-room').runs[0]?.status).toBe('blocked')

    // 同 idempotencyKey 经 gateway 幂等作用域隔离后重复确认 → already_confirmed
    const again = gateway.dispatch(owner, 'gateway-room', {
      type: 'confirm-resume-continuation',
      input: { roomId: 'gateway-room', continuationId: runId, kind: 'blocked_run', idempotencyKey: 'gw-confirm-1', actorUserId: 'spoofed' } as never,
    }) as FusionResumeContinuationResult
    expect(again.status).toBe('confirmed')
    const onceMore = gateway.dispatch(owner, 'gateway-room', {
      type: 'confirm-resume-continuation',
      input: { roomId: 'gateway-room', continuationId: runId, kind: 'blocked_run', idempotencyKey: 'gw-confirm-1', actorUserId: 'spoofed' } as never,
    }) as FusionResumeContinuationResult
    expect(onceMore.status).toBe('already_confirmed')
    expect(onceMore.event.id).toBe(again.event.id)
  })
})
