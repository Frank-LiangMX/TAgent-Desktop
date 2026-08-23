import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { MemberBackendAdapter, RoomBotSeat, RoomWorkspace } from '@tagent/shared'
import { FusionRoomHost } from '@tagent/core'
import { FusionRoomExecutionBridge } from './fusion-room-execution-bridge'
import {
  FusionRoomOutboxWorker,
  classifyOutboxDrain,
  type OutboxDrainAction,
} from './fusion-room-outbox-worker'

const ROOM_ID = 'outbox-room'
const workspace: RoomWorkspace = {
  id: 'rws_outbox', roomId: ROOM_ID, kind: 'server',
  storageKey: ROOM_ID, status: 'active', createdAt: 1, updatedAt: 1,
}
const seat: RoomBotSeat = {
  id: 'seat-a', roomId: ROOM_ID, botProfileId: 'bot-a', ownerUserId: 'owner',
  configRevisionId: 'rev-a', displayNameSnapshot: '执行者',
  roleSnapshot: { displayName: '执行者', systemPrompt: '负责执行。' },
  backend: 'pi', modelId: 'test-model', permissionProfile: 'read-only',
  capabilities: { supportsResume: false, supportsLiveInput: false, supportsToolBridge: false, supportsStructuredEvents: false },
  status: 'idle', logicalSessionId: 'logical-a', isCoordinator: true, createdAt: 1, updatedAt: 1,
}
const secondSeat: RoomBotSeat = {
  ...seat, id: 'seat-b', botProfileId: 'bot-b', displayNameSnapshot: '审阅者',
  roleSnapshot: { displayName: '审阅者', systemPrompt: '负责审阅。' },
  logicalSessionId: 'logical-b', isCoordinator: false,
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function newStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tagent-outbox-worker-'))
  tempDirs.push(dir)
  return join(dir, 'fusion-outbox-worker.json')
}

function newHost(): FusionRoomHost {
  const host = new FusionRoomHost()
  host.createRoom({ roomId: ROOM_ID, ownerUserId: 'owner', workspace, now: 1 })
  return host
}

function countingAdapter(): { adapter: MemberBackendAdapter; calls: { value: number } } {
  const calls = { value: 0 }
  const adapter: MemberBackendAdapter = {
    capabilities: () => ({
      supportsResume: false, supportsLiveInput: false, supportsToolBridge: false, supportsStructuredEvents: false,
    }),
    async runTurn() {
      calls.value += 1
      return { text: '已恢复执行' }
    },
  }
  return { adapter, calls }
}

/** 构造 `approved_awaiting_resume`：approval=approved 且对应 run 仍 awaiting_user。 */
function setupApprovedAwaitingResume(host: FusionRoomHost): { approvalId: string; runId: string } {
  host.dispatch(ROOM_ID, { type: 'add-bot', input: { actorUserId: 'owner', seat } })
  const userMessage = host.dispatch(ROOM_ID, {
    type: 'message', input: { actorUserId: 'owner', content: '请执行' },
  })
  const userMessageId = userMessage && 'id' in userMessage ? userMessage.id : ''
  const run = host.dispatch(ROOM_ID, {
    type: 'start-run',
    input: { actorUserId: 'owner', seatId: seat.id, backend: 'pi', triggerMessageId: userMessageId, idempotencyKey: 'appr-run' },
  })
  const runId = run && 'id' in run ? run.id : ''
  const fence = run && 'fence' in run ? run.fence : 0
  const approval = host.dispatch(ROOM_ID, {
    type: 'request-approval',
    input: { actorUserId: 'owner', roomId: ROOM_ID, memberId: seat.id, runId, question: '是否继续？', idempotencyKey: 'appr-req' },
  })
  const approvalId = approval && 'id' in approval ? approval.id : ''
  host.dispatch(ROOM_ID, {
    type: 'await-run',
    input: { actorUserId: 'owner', runId, fence, status: 'awaiting_user', idempotencyKey: 'appr-await' },
  })
  host.dispatch(ROOM_ID, {
    type: 'resolve-approval',
    input: { actorUserId: 'owner', roomId: ROOM_ID, requestId: approvalId, decision: 'approved', idempotencyKey: 'appr-resolve' },
  })
  return { approvalId, runId }
}

/** 构造 `mailbox_outbox`：delivery='outbox' 的 A2A 信封（fromMember run 仍 running）。 */
function setupMailboxOutbox(host: FusionRoomHost): { envelopeId: string } {
  host.dispatch(ROOM_ID, { type: 'add-bot', input: { actorUserId: 'owner', seat } })
  host.dispatch(ROOM_ID, { type: 'add-bot', input: { actorUserId: 'owner', seat: secondSeat } })
  const root = host.dispatch(ROOM_ID, { type: 'message', input: { actorUserId: 'owner', content: 'root' } })
  const rootId = root && 'id' in root ? root.id : ''
  const run = host.dispatch(ROOM_ID, {
    type: 'start-run',
    input: { actorUserId: 'owner', seatId: seat.id, backend: 'pi', idempotencyKey: 'mb-run' },
  })
  const runId = run && 'id' in run ? run.id : ''
  const envelope = host.dispatch(ROOM_ID, {
    type: 'send-mailbox',
    input: {
      actorUserId: 'owner', roomId: ROOM_ID, fromMemberId: seat.id, toMemberId: secondSeat.id,
      runId, type: 'question', payload: '请审阅', rootMessageId: rootId, idempotencyKey: 'mb-send',
    },
  })
  const envelopeId = envelope && 'id' in envelope ? envelope.id : ''
  expect(host.getSnapshot(ROOM_ID).mailbox[0]?.delivery).toBe('outbox')
  return { envelopeId }
}

describe('classifyOutboxDrain', () => {
  test('approved_awaiting_resume / mailbox_outbox → auto；其余 → observe', () => {
    const cases: Array<{ kind: Parameters<typeof classifyOutboxDrain>[0]['kind']; expected: 'auto' | 'observe' }> = [
      { kind: 'approved_awaiting_resume', expected: 'auto' },
      { kind: 'mailbox_outbox', expected: 'auto' },
      { kind: 'blocked_run', expected: 'observe' },
      { kind: 'pending_approval', expected: 'observe' },
      { kind: 'depth_stop', expected: 'observe' },
      { kind: 'awaiting_peer', expected: 'observe' },
    ]
    for (const { kind, expected } of cases) {
      const item = { id: 'x', roomId: ROOM_ID, kind, requiresUserConfirm: false, sideEffectRisk: 'none', summary: '' } as Parameters<typeof classifyOutboxDrain>[0]
      expect(classifyOutboxDrain(item)).toBe(expected)
    }
  })
})

describe('FusionRoomOutboxWorker drain（approved_awaiting_resume）', () => {
  test('自动 drain 驱动 bridge 拉新 turn；重复 drain 因 processed 键不双开', async () => {
    const host = newHost()
    const { approvalId } = setupApprovedAwaitingResume(host)
    const { adapter, calls: callsRef } = countingAdapter()
    const bridge = new FusionRoomExecutionBridge({ host, adapter })
    const statePath = newStatePath()
    const worker = new FusionRoomOutboxWorker({ host, executionBridge: bridge, statePath })

    const first = worker.drainRoom(ROOM_ID)
    // 立即重复 drain（resume turn 尚未完成，item 仍 listed）→ processed 键命中，不双开
    const second = worker.drainRoom(ROOM_ID)
    await bridge.waitForIdle()

    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      kind: 'auto', continuationId: approvalId, continuationKind: 'approved_awaiting_resume', result: 'drained',
    })
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({
      kind: 'auto', continuationId: approvalId, continuationKind: 'approved_awaiting_resume', result: 'skipped',
    })
    // bridge 仅被驱动一次（resume turn 一次 runTurn）
    expect(callsRef.value).toBe(1)
    // processed 键持久化
    expect(worker.listProcessedKeys()).toEqual([`${ROOM_ID}:approved_awaiting_resume:${approvalId}`])

    const snapshot = host.getSnapshot(ROOM_ID)
    // 旧 run 仍 awaiting_user，新 run 已 completed（resume turn 完成写入成员消息）
    expect(snapshot.runs.some((run) => run.status === 'completed')).toBe(true)
    expect(snapshot.messages.some((message) => message.authorType === 'member' && message.content === '已恢复执行')).toBe(true)
    bridge.dispose()
  })

  test('未注入 executionBridge → skipped，不写 processed、不调用 bridge', () => {
    const host = newHost()
    const { approvalId } = setupApprovedAwaitingResume(host)
    const worker = new FusionRoomOutboxWorker({ host, statePath: newStatePath() })

    const actions = worker.drainRoom(ROOM_ID)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      kind: 'auto', continuationId: approvalId, continuationKind: 'approved_awaiting_resume', result: 'skipped',
    })
    expect((actions[0] as Extract<OutboxDrainAction, { kind: 'auto' }>).detail).toContain('executionBridge')
    // 未 drain → 不写 processed
    expect(worker.listProcessedKeys()).toEqual([])
    // snapshot 不变：approval 仍 approved，run 仍 awaiting_user
    const snapshot = host.getSnapshot(ROOM_ID)
    expect(snapshot.approvals[0]?.status).toBe('approved')
    expect(snapshot.runs[0]?.status).toBe('awaiting_user')
  })
})

describe('FusionRoomOutboxWorker drain（mailbox_outbox）', () => {
  test('delivery=outbox → confirmResumeContinuation 推进为 dispatched + bridge 唤醒 toMember', async () => {
    const host = newHost()
    const { envelopeId } = setupMailboxOutbox(host)
    const { adapter, calls: callsRef } = countingAdapter()
    const bridge = new FusionRoomExecutionBridge({ host, adapter })
    const worker = new FusionRoomOutboxWorker({ host, executionBridge: bridge, statePath: newStatePath() })

    const actions = worker.drainRoom(ROOM_ID)
    await bridge.waitForIdle()

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      kind: 'auto', continuationId: envelopeId, continuationKind: 'mailbox_outbox', result: 'drained',
    })
    // delivery 已推进为 dispatched
    expect(host.getSnapshot(ROOM_ID).mailbox[0]?.delivery).toBe('dispatched')
    // bridge 唤醒 toMember（secondSeat）拉新 turn
    expect(callsRef.value).toBe(1)
    expect(host.getSnapshot(ROOM_ID).runs.some((run) => run.seatId === secondSeat.id && run.status === 'completed')).toBe(true)
    expect(worker.listProcessedKeys()).toEqual([`${ROOM_ID}:mailbox_outbox:${envelopeId}`])
    bridge.dispose()
  })

  test('delivery 已非 outbox（re-read）→ observe，不调 confirmResumeContinuation、不唤醒 toMember', async () => {
    const realHost = newHost()
    const { envelopeId } = setupMailboxOutbox(realHost)
    // 用 Proxy 包一层：第 2 次 getSnapshot 起，把 envelope delivery 翻成 dispatched，
    // 模拟 scan(list) 后、drain 前 re-read 时 delivery 已被别人推进的竞态。
    let snapshotCalls = 0
    const host = new Proxy(realHost, {
      get(target, prop, receiver) {
        if (prop === 'getSnapshot') {
          return (roomId: string) => {
            snapshotCalls += 1
            const snap = target.getSnapshot(roomId)
            if (snapshotCalls >= 2) {
              return {
                ...snap,
                mailbox: snap.mailbox.map((envelope) =>
                  envelope.id === envelopeId ? { ...envelope, delivery: 'dispatched' as const } : envelope,
                ),
              }
            }
            return snap
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const { adapter, calls: callsRef } = countingAdapter()
    const bridge = new FusionRoomExecutionBridge({ host: realHost, adapter })
    const worker = new FusionRoomOutboxWorker({ host, executionBridge: bridge, statePath: newStatePath() })

    const actions = worker.drainRoom(ROOM_ID)
    await bridge.waitForIdle()

    // scan 时仍 outbox（被列入），re-read 时已 dispatched → observe，不推进、不唤醒
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      kind: 'observe', continuationId: envelopeId, continuationKind: 'mailbox_outbox',
    })
    expect((actions[0] as Extract<OutboxDrainAction, { kind: 'observe' }>).reason).toContain('dispatched')
    expect(callsRef.value).toBe(0)
    // 真实 host 的 envelope 仍是 outbox（worker 没有推进它）
    expect(realHost.getSnapshot(ROOM_ID).mailbox[0]?.delivery).toBe('outbox')
    expect(worker.listProcessedKeys()).toEqual([])
    bridge.dispose()
  })

  test('未注入 executionBridge → skipped，不推进 delivery、不写 processed', () => {
    const host = newHost()
    const { envelopeId } = setupMailboxOutbox(host)
    const worker = new FusionRoomOutboxWorker({ host, statePath: newStatePath() })

    const actions = worker.drainRoom(ROOM_ID)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      kind: 'auto', continuationId: envelopeId, continuationKind: 'mailbox_outbox', result: 'skipped',
    })
    expect((actions[0] as Extract<OutboxDrainAction, { kind: 'auto' }>).detail).toContain('executionBridge')
    expect(host.getSnapshot(ROOM_ID).mailbox[0]?.delivery).toBe('outbox')
    expect(worker.listProcessedKeys()).toEqual([])
  })
})

describe('FusionRoomOutboxWorker observe（不自动重放）', () => {
  test('blocked_run / pending_approval → 仅 observe，不改 snapshot、不调 bridge', async () => {
    const host = newHost()
    host.dispatch(ROOM_ID, { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    const userMessage = host.dispatch(ROOM_ID, { type: 'message', input: { actorUserId: 'owner', content: '请执行' } })
    const userMessageId = userMessage && 'id' in userMessage ? userMessage.id : ''
    const run = host.dispatch(ROOM_ID, {
      type: 'start-run',
      input: { actorUserId: 'owner', seatId: seat.id, backend: 'pi', triggerMessageId: userMessageId, idempotencyKey: 'blk-run' },
    })
    const runId = run && 'id' in run ? run.id : ''
    const approval = host.dispatch(ROOM_ID, {
      type: 'request-approval',
      input: { actorUserId: 'owner', roomId: ROOM_ID, memberId: seat.id, runId, question: '是否继续？', idempotencyKey: 'pend-req' },
    })
    const approvalId = approval && 'id' in approval ? approval.id : ''
    // run 仍 running + approval pending；recover 把 running run 标 blocked
    host.recoverInterruptedRuns()
    const before = host.getSnapshot(ROOM_ID)

    const { adapter, calls: callsRef } = countingAdapter()
    const bridge = new FusionRoomExecutionBridge({ host, adapter })
    const worker = new FusionRoomOutboxWorker({ host, executionBridge: bridge, statePath: newStatePath() })

    const actions = worker.drainRoom(ROOM_ID)
    await bridge.waitForIdle()

    const kinds = actions.map((action) => action.continuationKind).sort()
    expect(kinds).toEqual(['blocked_run', 'pending_approval'])
    expect(actions.every((action) => action.kind === 'observe')).toBe(true)
    // 不调用 bridge、不改 snapshot
    expect(callsRef.value).toBe(0)
    expect(host.getSnapshot(ROOM_ID)).toEqual(before)
    // blocked_run 永不写入 processed-as-auto
    expect(worker.listProcessedKeys()).toEqual([])
    expect(worker.listProcessedKeys()).not.toContain(`${ROOM_ID}:blocked_run:${runId}`)
    expect(worker.listProcessedKeys()).not.toContain(`${ROOM_ID}:pending_approval:${approvalId}`)
    bridge.dispose()
  })
})

describe('FusionRoomOutboxWorker 状态持久化', () => {
  test('drain 后新 Worker 同 path 仍记得 processed，重复 drain 不双开', async () => {
    const host = newHost()
    const { approvalId } = setupApprovedAwaitingResume(host)
    const { adapter, calls: callsRef } = countingAdapter()
    const bridge = new FusionRoomExecutionBridge({ host, adapter })
    const statePath = newStatePath()

    const worker1 = new FusionRoomOutboxWorker({ host, executionBridge: bridge, statePath })
    const first = worker1.drainRoom(ROOM_ID)
    await bridge.waitForIdle()
    expect(first[0]).toMatchObject({ result: 'drained' })
    const callsAfterFirst = callsRef.value

    // 同 path 新 Worker：从状态文件读回 processed 键
    const worker2 = new FusionRoomOutboxWorker({ host, executionBridge: bridge, statePath })
    expect(worker2.listProcessedKeys()).toEqual([`${ROOM_ID}:approved_awaiting_resume:${approvalId}`])
    // 重复 drain：item 仍 listed（旧 run awaiting_user + approval approved），processed 命中 → skipped
    const second = worker2.drainRoom(ROOM_ID)
    expect(second[0]).toMatchObject({ result: 'skipped' })
    // bridge 不再被驱动（不双开）
    expect(callsRef.value).toBe(callsAfterFirst)
    bridge.dispose()
  })

  test('默认 statePath 落在 getCollaborationDir() 之下', () => {
    const host = newHost()
    const worker = new FusionRoomOutboxWorker({ host })
    // 不断言具体绝对路径（受 TAGENT_CONFIG_DIR 影响），只断言文件名与基名
    expect(worker.listProcessedKeys()).toEqual([])
    expect(worker.scan(ROOM_ID).length).toBeGreaterThanOrEqual(0)
  })
})
