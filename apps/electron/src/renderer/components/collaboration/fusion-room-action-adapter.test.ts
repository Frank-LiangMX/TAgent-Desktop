import { describe, expect, test, vi } from 'vitest'
import type {
  FusionRoomActionResponse,
  FusionRoomAuthoritySnapshot,
  FusionRoomGatewayAction,
  FusionRoomSessionAdapter,
  FusionRoomSnapshotListener,
} from '@tagent/core'
import {
  FusionRoomActionAdapter,
} from './fusion-room-action-adapter'
import {
  FusionRoomViewModelController,
  type FusionRoomSessionAdapterLike,
} from './fusion-room-view-model'

const snapshot = (sequence = 1): FusionRoomAuthoritySnapshot => ({
  roomId: 'room-action', ownerUserId: 'owner', status: 'active', humanMembers: [], botSeats: [],
  botOwnerConsents: {},
  workspace: { id: 'workspace', roomId: 'room-action', kind: 'server', status: 'active', createdAt: 1, updatedAt: 1 },
  messages: [], events: [{ sequence } as FusionRoomAuthoritySnapshot['events'][number]], usage: [], files: [], locks: [], runs: [],
  tasks: [],
  artifacts: [],
  approvals: [],
  mailbox: [],
})

function fakeAdapter() {
  let current = snapshot()
  const listeners = new Set<(next: FusionRoomAuthoritySnapshot) => void>()
  const actions: FusionRoomGatewayAction[] = []
  const adapter: FusionRoomSessionAdapterLike = {
    subscribeSnapshot: (listener: FusionRoomSnapshotListener) => {
      listeners.add(listener)
      listener(current)
      return () => listeners.delete(listener)
    },
    load: vi.fn(async () => current),
    dispatch: vi.fn(async (action: FusionRoomGatewayAction) => {
      actions.push(action)
      current = snapshot((current.events[0]?.sequence ?? 0) + 1)
      for (const listener of listeners) listener(current)
      return { result: { ok: true }, snapshot: current } as FusionRoomActionResponse
    }),
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as FusionRoomSessionAdapter
  return { adapter, actions }
}

describe('FusionRoomActionAdapter', () => {
  test('maps page actions without accepting actorUserId', async () => {
    const fake = fakeAdapter()
    const controller = new FusionRoomViewModelController(fake.adapter)
    const actions = new FusionRoomActionAdapter(controller)

    await actions.sendMessage({ content: 'hello', targetSeatIds: ['seat-a'], idempotencyKey: 'm1' })
    await actions.inviteHuman({ userId: 'user-b', displayName: 'B' })
    await actions.acceptInvitation()
    await actions.leaveHuman()
    await actions.removeHuman('user-b')
    await actions.setPresence('offline')
    await actions.setBotConsent('seat-a', true)
    await actions.removeBot('seat-a')
    await actions.setStatus('paused')
    await actions.createTask({ roomId: 'room-action', task: { title: 'task' } })
    await actions.updateTask({ roomId: 'room-action', taskId: 'crt-1', status: 'in_progress', expectedVersion: 1 })
    await actions.publishArtifact({ roomId: 'room-action', memberId: 'seat-a', relativePath: 'out.txt', content: 'x' })

    expect(actions).toBeDefined()
    expect(fake.actions).toEqual([
      { type: 'message', input: { content: 'hello', targetSeatIds: ['seat-a'], idempotencyKey: 'm1' } },
      { type: 'invite-human', userId: 'user-b', displayName: 'B' },
      { type: 'accept-invitation' },
      { type: 'leave-human' },
      { type: 'remove-human', userId: 'user-b' },
      { type: 'presence', status: 'offline' },
      { type: 'bot-consent', seatId: 'seat-a', consent: true },
      { type: 'remove-bot', seatId: 'seat-a' },
      { type: 'status', status: 'paused' },
      { type: 'create-task', input: { roomId: 'room-action', task: { title: 'task' } } },
      { type: 'update-task', input: { roomId: 'room-action', taskId: 'crt-1', status: 'in_progress', expectedVersion: 1 } },
      { type: 'publish-artifact', input: { roomId: 'room-action', memberId: 'seat-a', relativePath: 'out.txt', content: 'x' } },
    ])
    expect(fake.actions.every((action) => !('actorUserId' in action))).toBe(true)
  })

  test('supports addBot, connect and idempotent close', async () => {
    const fake = fakeAdapter()
    const controller = new FusionRoomViewModelController(fake.adapter)
    const actions = new FusionRoomActionAdapter(controller)
    const seat = { id: 'seat-a', roomId: 'room-action', ownerUserId: 'owner' } as never

    await actions.addBot({ seat, ownerConsent: false })
    await actions.connect()
    await actions.close()
    await actions.close()

    expect(fake.actions[0]).toEqual({ type: 'add-bot', input: { seat, ownerConsent: false } })
    expect(fake.adapter.connect).toHaveBeenCalledOnce()
    expect(fake.adapter.close).toHaveBeenCalledOnce()
  })

  test('maps workspace and run actions without accepting actorUserId', async () => {
    const fake = fakeAdapter()
    const controller = new FusionRoomViewModelController(fake.adapter)
    const actions = new FusionRoomActionAdapter(controller)

    await actions.acquireWorkspaceLock({ relativePath: 'a.txt' })
    await actions.commitFile({ lockId: 'lock-1', relativePath: 'a.txt', content: 'hi' })
    await actions.commitFiles({ files: [{ lockId: 'lock-1', relativePath: 'a.txt', content: 'hi' }] })
    await actions.recordUsage({ seatId: 'seat-a', inputTokens: 10, outputTokens: 20, costMicros: 30 })
    await actions.startRun({ seatId: 'seat-a', backend: 'kscc' })
    await actions.finishRun({ runId: 'run-1', fence: 1, status: 'completed' })

    expect(fake.actions).toEqual([
      { type: 'lock', input: { relativePath: 'a.txt' } },
      { type: 'commit-file', input: { lockId: 'lock-1', relativePath: 'a.txt', content: 'hi' } },
      { type: 'commit-files', input: { files: [{ lockId: 'lock-1', relativePath: 'a.txt', content: 'hi' }] } },
      { type: 'usage', input: { seatId: 'seat-a', inputTokens: 10, outputTokens: 20, costMicros: 30 } },
      { type: 'start-run', input: { seatId: 'seat-a', backend: 'kscc' } },
      { type: 'finish-run', input: { runId: 'run-1', fence: 1, status: 'completed' } },
    ])
    expect(fake.actions.every((action) => !('actorUserId' in action))).toBe(true)
  })

  test('fails closed when controller has no snapshot', async () => {
    const fake = fakeAdapter()
    const noInitial = { ...fake.adapter, subscribeSnapshot: () => () => undefined } as FusionRoomSessionAdapterLike
    const actions = new FusionRoomActionAdapter(new FusionRoomViewModelController(noInitial))
    await expect(actions.sendMessage({ content: 'hello' })).rejects.toThrow(/尚未加载/)
  })

  test('confirmResumeContinuation injects roomId from view and never accepts actorUserId', async () => {
    const fake = fakeAdapter()
    const controller = new FusionRoomViewModelController(fake.adapter)
    const actions = new FusionRoomActionAdapter(controller)
    // currentView 已在构造时由 subscribeSnapshot 立即投影像快照建立，roomId='room-action'

    await actions.confirmResumeContinuation({ continuationId: 'run-blk', kind: 'blocked_run', idempotencyKey: 'r1' })
    await actions.confirmResumeContinuation({ continuationId: 'env-out', kind: 'mailbox_outbox' })

    expect(fake.actions.at(-2)).toEqual({
      type: 'confirm-resume-continuation',
      input: { continuationId: 'run-blk', kind: 'blocked_run', idempotencyKey: 'r1', roomId: 'room-action' },
    })
    expect(fake.actions.at(-1)).toEqual({
      type: 'confirm-resume-continuation',
      input: { continuationId: 'env-out', kind: 'mailbox_outbox', roomId: 'room-action' },
    })
    // wire payload 绝不含 actorUserId（顶层 action 与 input 都不带）
    const resumeActions = fake.actions.filter((action) => action.type === 'confirm-resume-continuation')
    expect(resumeActions).toHaveLength(2)
    expect(resumeActions.every((action) => {
      const input = (action as { input: Record<string, unknown> }).input
      return !('actorUserId' in action) && !('actorUserId' in input)
    })).toBe(true)
  })

  test('updateMetadata dispatches update-metadata with caller-supplied roomId and never accepts actorUserId', async () => {
    const fake = fakeAdapter()
    const controller = new FusionRoomViewModelController(fake.adapter)
    const actions = new FusionRoomActionAdapter(controller)

    await actions.updateMetadata({ roomId: 'room-action', title: '新标题', goal: '新目标' })
    await actions.updateMetadata({ roomId: 'room-action', goal: '' })
    await actions.updateMetadata({ roomId: 'room-action', title: '仅改标题' })

    const metaActions = fake.actions.filter((action) => action.type === 'update-metadata')
    expect(metaActions).toHaveLength(3)
    expect(metaActions[0]).toEqual({
      type: 'update-metadata',
      input: { roomId: 'room-action', title: '新标题', goal: '新目标' },
    })
    expect(metaActions[1]).toEqual({
      type: 'update-metadata',
      input: { roomId: 'room-action', goal: '' },
    })
    expect(metaActions[2]).toEqual({
      type: 'update-metadata',
      input: { roomId: 'room-action', title: '仅改标题' },
    })
    // wire payload 绝不含 actorUserId（顶层 action 与 input 都不带，actor 由 gateway 注入）
    expect(metaActions.every((action) => {
      const input = (action as { input: Record<string, unknown> }).input
      return !('actorUserId' in action) && !('actorUserId' in input)
    })).toBe(true)
  })
})
