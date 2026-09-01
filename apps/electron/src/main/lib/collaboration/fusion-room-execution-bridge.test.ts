import { describe, expect, test } from 'vitest'
import type { MemberBackendAdapter, RoomBotSeat, RoomWorkspace } from '@tagent/shared'
import { FusionRoomHost, type FusionRoomWorkspaceStore } from '@tagent/core'
import { FusionRoomExecutionBridge } from './fusion-room-execution-bridge'
import { createFusionRoomHostToolHandlerFactory } from './fusion-room-host-tools'

const workspace: RoomWorkspace = {
  id: 'rws_execution',
  roomId: 'execution-room',
  kind: 'server',
  storageKey: 'execution-room',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
}

const seat: RoomBotSeat = {
  id: 'seat-execution',
  roomId: 'execution-room',
  botProfileId: 'bot-execution',
  ownerUserId: 'owner',
  configRevisionId: 'rev-execution',
  displayNameSnapshot: '开发者',
  roleSnapshot: { displayName: '开发者', systemPrompt: '负责实现和验证。' },
  backend: 'pi',
  modelId: 'test-model',
  permissionProfile: 'read-only',
  capabilities: {
    supportsResume: false,
    supportsLiveInput: false,
    supportsToolBridge: false,
    supportsStructuredEvents: false,
  },
  status: 'idle',
  logicalSessionId: 'logical-execution',
  isCoordinator: true,
  createdAt: 1,
  updatedAt: 1,
}

const secondSeat: RoomBotSeat = {
  ...seat,
  id: 'seat-reviewer',
  botProfileId: 'bot-reviewer',
  displayNameSnapshot: '审阅者',
  roleSnapshot: { displayName: '审阅者', systemPrompt: '负责复核答案。' },
  logicalSessionId: 'logical-reviewer',
  isCoordinator: false,
}
const adapter: MemberBackendAdapter = {
  capabilities: () => ({
    supportsResume: false,
    supportsLiveInput: false,
    supportsToolBridge: false,
    supportsStructuredEvents: false,
  }),
  async runTurn(input) {
    input.onTextDelta?.('已收到')
    return {
      text: '**已完成**：这是来自成员后端的结果。',
      usage: { inputTokens: 12, outputTokens: 8, costUsd: 0.001 },
    }
  },
}

describe('FusionRoomExecutionBridge', () => {
  test('把用户消息执行为成员 turn，并通过 authority 回写消息、用量和完成状态', async () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    const deltas: string[] = []
    const bridge = new FusionRoomExecutionBridge({
      host,
      adapter,
      onTextDelta: ({ delta }) => deltas.push(delta),
    })

    const userMessage = host.dispatch('execution-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '请分析这个任务' },
    })
    bridge.handleAction('execution-room', { type: 'message' }, userMessage)
    await bridge.waitForIdle()

    const snapshot = host.getSnapshot('execution-room')
    expect(snapshot.messages.map((message) => message.authorType)).toEqual(['user', 'member'])
    expect(snapshot.messages[1]?.content).toContain('已完成')
    expect(snapshot.messages[1]?.replyToMessageId).toBe(snapshot.messages[0]?.id)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0]?.status).toBe('completed')
    expect(snapshot.usage[0]?.inputTokens).toBe(12)
    expect(snapshot.usage[0]?.outputTokens).toBe(8)
    expect(deltas).toEqual(['已收到'])
    bridge.dispose()
  })

  test('只有 wallTimeMs 的用量不写入 authority 账本（authority 不收 wallTime，normalize 后无可记账字段）', async () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    const wallAdapter: MemberBackendAdapter = {
      capabilities: adapter.capabilities,
      async runTurn() {
        return { text: '已完成', usage: { wallTimeMs: 500 } }
      },
    }
    const bridge = new FusionRoomExecutionBridge({ host, adapter: wallAdapter })
    const userMessage = host.dispatch('execution-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '跑一下' },
    })
    bridge.handleAction('execution-room', { type: 'message' }, userMessage)
    await bridge.waitForIdle()

    const snapshot = host.getSnapshot('execution-room')
    // 仅 wallTimeMs：authority 只收 inputTokens/outputTokens/costMicros，不收 wallTimeMs；
    // normalize 后三项全无 → 不写零用量记录，避免污染账本。
    expect(snapshot.usage).toHaveLength(0)
    // 成员消息与完成状态仍正常。
    expect(snapshot.runs[0]?.status).toBe('completed')
    expect(snapshot.messages.at(-1)?.content).toBe('已完成')
    bridge.dispose()
  })

  test('只有 tokens（无 costUsd）的用量写入账本，costMicros=0', async () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    const tokensAdapter: MemberBackendAdapter = {
      capabilities: adapter.capabilities,
      async runTurn() {
        return { text: '已完成', usage: { inputTokens: 5, outputTokens: 3 } }
      },
    }
    const bridge = new FusionRoomExecutionBridge({ host, adapter: tokensAdapter })
    const userMessage = host.dispatch('execution-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '跑一下' },
    })
    bridge.handleAction('execution-room', { type: 'message' }, userMessage)
    await bridge.waitForIdle()

    const snapshot = host.getSnapshot('execution-room')
    expect(snapshot.usage).toHaveLength(1)
    expect(snapshot.usage[0]?.inputTokens).toBe(5)
    expect(snapshot.usage[0]?.outputTokens).toBe(3)
    expect(snapshot.usage[0]?.costMicros).toBe(0)
    bridge.dispose()
  })

  test('normalize 过滤 NaN/非有限数：脏字段不污染账本，合法字段仍写入', async () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    const dirtyAdapter: MemberBackendAdapter = {
      capabilities: adapter.capabilities,
      async runTurn() {
        return {
          text: '已完成',
          usage: { inputTokens: Number.NaN, outputTokens: 4, costUsd: Number.NaN, wallTimeMs: Number.POSITIVE_INFINITY },
        }
      },
    }
    const bridge = new FusionRoomExecutionBridge({ host, adapter: dirtyAdapter })
    const userMessage = host.dispatch('execution-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '跑一下' },
    })
    bridge.handleAction('execution-room', { type: 'message' }, userMessage)
    await bridge.waitForIdle()

    const snapshot = host.getSnapshot('execution-room')
    // normalize 丢弃 NaN inputTokens / NaN costUsd / Infinity wallTimeMs，仅留 outputTokens=4。
    // 仍有可记账字段 → 写账本：inputTokens/costMicros 落到 0（undefined ?? 0）。
    expect(snapshot.usage).toHaveLength(1)
    expect(snapshot.usage[0]?.inputTokens).toBe(0)
    expect(snapshot.usage[0]?.outputTokens).toBe(4)
    expect(snapshot.usage[0]?.costMicros).toBe(0)
    bridge.dispose()
  })

  test('同一触发消息不会并发启动重复成员 turn', async () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    let calls = 0
    const delayedAdapter: MemberBackendAdapter = {
      capabilities: adapter.capabilities,
      async runTurn(input) {
        calls += 1
        await Promise.resolve()
        return { text: '一次回复' }
      },
    }
    const bridge = new FusionRoomExecutionBridge({ host, adapter: delayedAdapter })
    const userMessage = host.dispatch('execution-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '只执行一次' },
    })
    bridge.handleAction('execution-room', { type: 'message' }, userMessage)
    bridge.handleAction('execution-room', { type: 'message' }, userMessage)
    await bridge.waitForIdle()
    expect(calls).toBe(1)
    expect(host.getSnapshot('execution-room').messages.filter((message) => message.authorType === 'member')).toHaveLength(1)
    bridge.dispose()
  })
  test('disposeAndWait 会取消进行中的 run，并拒绝关闭后的新消息', async () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    const secondSeat: RoomBotSeat = {
  ...seat,
  id: 'seat-reviewer',
  botProfileId: 'bot-reviewer',
  displayNameSnapshot: '审阅者',
  roleSnapshot: { displayName: '审阅者', systemPrompt: '负责复核答案。' },
  logicalSessionId: 'logical-reviewer',
  isCoordinator: false,
}
const adapter: MemberBackendAdapter = {
      capabilities: () => ({
        supportsResume: false,
        supportsLiveInput: false,
        supportsToolBridge: false,
        supportsStructuredEvents: false,
      }),
      runTurn: (input) => new Promise((_, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    }
    const bridge = new FusionRoomExecutionBridge({ host, adapter })
    const userMessage = host.dispatch('execution-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '取消这个任务' },
    })
    bridge.handleAction('execution-room', { type: 'message' }, userMessage)
    await bridge.disposeAndWait()
    bridge.handleAction('execution-room', { type: 'message' }, userMessage)

    const snapshot = host.getSnapshot('execution-room')
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0]?.status).toBe('cancelled')
    expect(snapshot.messages.filter((message) => message.authorType === 'member')).toHaveLength(0)
  })

  test('默认宿主工具桥支持 A2A 提问、等待、回复和 continuation', async () => {
    const host = new FusionRoomHost()
    const workspaceStore: FusionRoomWorkspaceStore = {
      prepareCommit: () => ({ commit() {}, rollback() {} }),
    }
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat: secondSeat } })

    let aCalls = 0
    const a2aAdapter: MemberBackendAdapter = {
      capabilities: adapter.capabilities,
      async runTurn(input) {
        if (input.memberId === seat.id && aCalls++ === 0) {
          const result = await input.hostToolHandler?.({
            name: 'room_ask',
            arguments: { toMemberId: secondSeat.id, question: '请复核这个结论' },
          })
          expect(result?.awaitPeer).toBe(true)
          throw new Error('turn paused')
        }
        if (input.memberId === secondSeat.id) {
          const question = host.getSnapshot('execution-room').mailbox.find((item) => item.type === 'question')
          const result = await input.hostToolHandler?.({
            name: 'room_reply',
            arguments: { requestId: question?.requestId ?? '', answer: '复核通过' },
          })
          expect(result?.isError).not.toBe(true)
          return { text: '已回复审阅结果' }
        }
        return { text: '收到复核结果，继续完成任务。' }
      },
    }
    const bridge = new FusionRoomExecutionBridge({
      host,
      adapter: a2aAdapter,
      hostToolHandlerFactory: createFusionRoomHostToolHandlerFactory({ host, workspaceStore }),
    })
    const userMessage = host.dispatch('execution-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '开始协作' },
    })
    bridge.handleAction('execution-room', { type: 'message' }, userMessage)
    await bridge.waitForIdle()

    const snapshot = host.getSnapshot('execution-room')
    expect(snapshot.mailbox.filter((item) => item.type === 'question')).toHaveLength(1)
    expect(snapshot.mailbox.filter((item) => item.type === 'reply')).toHaveLength(1)
    expect(snapshot.runs.map((run) => run.status)).toEqual(['awaiting_peer', 'completed', 'completed'])
    const memberContents = snapshot.messages.filter((message) => message.authorType === 'member').map((message) => message.content)
    expect(memberContents).toHaveLength(2)
    expect(memberContents).toContain('已回复审阅结果')
    expect(memberContents).toContain('收到复核结果，继续完成任务。')
    bridge.dispose()
  })

  test('用户审批后恢复 Bot continuation', async () => {
    const host = new FusionRoomHost()
    const workspaceStore: FusionRoomWorkspaceStore = {
      prepareCommit: () => ({ commit() {}, rollback() {} }),
    }
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    let calls = 0
    const approvalAdapter: MemberBackendAdapter = {
      capabilities: adapter.capabilities,
      async runTurn(input) {
        if (calls++ === 0) {
          const result = await input.hostToolHandler?.({
            name: 'room_request_user',
            arguments: { question: '是否继续发布？', options: '["批准","拒绝"]' },
          })
          expect(result?.awaitPeer).toBe(true)
          throw new Error('waiting for user')
        }
        return { text: '用户已批准，继续执行。' }
      },
    }
    const bridge = new FusionRoomExecutionBridge({
      host,
      adapter: approvalAdapter,
      hostToolHandlerFactory: createFusionRoomHostToolHandlerFactory({ host, workspaceStore }),
    })
    const message = host.dispatch('execution-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '准备发布' },
    })
    bridge.handleAction('execution-room', { type: 'message' }, message)
    await bridge.waitForIdle()
    const pending = host.getSnapshot('execution-room').approvals[0]
    expect(pending?.status).toBe('pending')
    const resolved = host.dispatch('execution-room', {
      type: 'resolve-approval',
      input: {
        actorUserId: 'owner',
        roomId: 'execution-room',
        requestId: pending!.id,
        decision: 'approved',
        response: '可以继续',
      },
    })
    bridge.handleAction('execution-room', { type: 'resolve-approval' }, resolved)
    await bridge.waitForIdle()
    const snapshot = host.getSnapshot('execution-room')
    expect(snapshot.approvals[0]?.status).toBe('approved')
    expect(snapshot.runs.map((run) => run.status)).toEqual(['awaiting_user', 'completed'])
    expect(snapshot.messages.at(-1)?.content).toBe('用户已批准，继续执行。')
    bridge.dispose()
  })

  test('confirm-resume blocked run：以新 fence 拉起新 turn，旧 run 仍 blocked', async () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    const userMessage = host.dispatch('execution-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '请分析这个任务' },
    })
    const messageId = userMessage && 'id' in userMessage ? userMessage.id : ''
    // 拉起一个 running run（带 triggerMessageId）并模拟进程退出 → recover 标 blocked
    host.dispatch('execution-room', {
      type: 'start-run',
      input: { actorUserId: 'owner', seatId: seat.id, backend: 'pi', triggerMessageId: messageId, idempotencyKey: 'blk-start' },
    })
    host.recoverInterruptedRuns()
    const blockedRun = host.getSnapshot('execution-room').runs[0]!
    expect(blockedRun.status).toBe('blocked')
    const oldFence = blockedRun.fence

    const bridge = new FusionRoomExecutionBridge({ host, adapter })
    const result = host.confirmResumeContinuation({
      roomId: 'execution-room', actorUserId: 'owner',
      continuationId: blockedRun.id, kind: 'blocked_run', idempotencyKey: 'confirm-1',
    })
    expect(result.status).toBe('confirmed')
    bridge.handleAction('execution-room', { type: 'confirm-resume-continuation' }, result)
    await bridge.waitForIdle()

    const snapshot = host.getSnapshot('execution-room')
    // 旧 run 仍 blocked、同 fence（不复活旧 fence）
    const stillBlocked = snapshot.runs.find((run) => run.id === blockedRun.id)
    expect(stillBlocked?.status).toBe('blocked')
    expect(stillBlocked?.fence).toBe(oldFence)
    // 新 run 完成，fence 不同
    const resumeRun = snapshot.runs.find((run) => run.id !== blockedRun.id && run.seatId === seat.id)
    expect(resumeRun?.status).toBe('completed')
    expect(resumeRun?.fence).not.toBe(oldFence)
    // 新 turn 写入了成员消息
    const memberMessages = snapshot.messages.filter((message) => message.authorType === 'member')
    expect(memberMessages).toHaveLength(1)
    expect(memberMessages[0]?.content).toContain('已完成')
    bridge.dispose()
  })

  test('retry-run：复用原触发消息执行新 run，旧 failed run 保持不变', async () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    const userMessage = host.dispatch('execution-room', {
      type: 'message',
      input: { actorUserId: 'owner', content: '请在失败后重试' },
    })
    const messageId = userMessage && 'id' in userMessage ? userMessage.id : ''
    const started = host.dispatch('execution-room', {
      type: 'start-run',
      input: {
        actorUserId: 'owner',
        seatId: seat.id,
        backend: 'pi',
        triggerMessageId: messageId,
        idempotencyKey: 'retry-bridge-start',
      },
    })
    const oldRun = started && 'fence' in started ? started : undefined
    expect(oldRun).toBeTruthy()
    host.dispatch('execution-room', {
      type: 'finish-run',
      input: {
        actorUserId: 'owner',
        runId: oldRun!.id,
        fence: oldRun!.fence,
        status: 'failed',
        summary: '第一次失败',
      },
    })

    const bridge = new FusionRoomExecutionBridge({ host, adapter })
    const retried = host.dispatch('execution-room', {
      type: 'retry-run',
      input: {
        actorUserId: 'owner',
        runId: oldRun!.id,
        idempotencyKey: 'retry-bridge-once',
      },
    })
    bridge.handleAction('execution-room', { type: 'retry-run' }, retried)
    await bridge.waitForIdle()

    const snapshot = host.getSnapshot('execution-room')
    expect(snapshot.runs).toHaveLength(2)
    expect(snapshot.runs.find((run) => run.id === oldRun!.id)?.status).toBe('failed')
    const newRun = snapshot.runs.find((run) => run.id !== oldRun!.id)
    expect(newRun?.status).toBe('completed')
    expect(newRun?.fence).not.toBe(oldRun!.fence)
    expect(snapshot.messages.filter((message) => message.authorType === 'member')).toHaveLength(1)
    bridge.dispose()
  })

  test('confirm-resume outbox：唤醒 toMember 以新 turn 处理重投', async () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat: secondSeat } })
    const root = host.dispatch('execution-room', { type: 'message', input: { actorUserId: 'owner', content: 'root' } })
    const rootId = root && 'id' in root ? root.id : ''
    const run = host.dispatch('execution-room', {
      type: 'start-run',
      input: { actorUserId: 'owner', seatId: seat.id, backend: 'pi', idempotencyKey: 'outbox-start' },
    })
    const runId = run && 'id' in run ? run.id : ''
    const envelope = host.dispatch('execution-room', {
      type: 'send-mailbox',
      input: {
        actorUserId: 'owner', roomId: 'execution-room', fromMemberId: seat.id, toMemberId: secondSeat.id,
        runId, type: 'question', payload: '请审阅', rootMessageId: rootId, idempotencyKey: 'outbox-send',
      },
    })
    const envelopeId = envelope && 'id' in envelope ? envelope.id : ''
    expect(host.getSnapshot('execution-room').mailbox[0]?.delivery).toBe('outbox')

    const bridge = new FusionRoomExecutionBridge({ host, adapter })
    const result = host.confirmResumeContinuation({
      roomId: 'execution-room', actorUserId: 'owner',
      continuationId: envelopeId, kind: 'mailbox_outbox', idempotencyKey: 'outbox-confirm-1',
    })
    expect(result.status).toBe('confirmed')
    expect(result.delivery).toBe('dispatched')
    bridge.handleAction('execution-room', { type: 'confirm-resume-continuation' }, result)
    await bridge.waitForIdle()

    const snapshot = host.getSnapshot('execution-room')
    // toMember (secondSeat) 被唤醒，新 run 完成
    const reviewerRun = snapshot.runs.find((item) => item.seatId === secondSeat.id && item.status === 'completed')
    expect(reviewerRun).toBeTruthy()
    const memberMessages = snapshot.messages.filter((message) => message.authorType === 'member')
    expect(memberMessages).toHaveLength(1)
    bridge.dispose()
  })

  test('confirm-resume already_confirmed 不双开新 turn（幂等）', async () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: 'execution-room', ownerUserId: 'owner', workspace, now: 1 })
    host.dispatch('execution-room', { type: 'add-bot', input: { actorUserId: 'owner', seat } })
    const userMessage = host.dispatch('execution-room', { type: 'message', input: { actorUserId: 'owner', content: '请分析' } })
    const messageId = userMessage && 'id' in userMessage ? userMessage.id : ''
    host.dispatch('execution-room', {
      type: 'start-run',
      input: { actorUserId: 'owner', seatId: seat.id, backend: 'pi', triggerMessageId: messageId, idempotencyKey: 'blk-start-2' },
    })
    host.recoverInterruptedRuns()
    const blockedRun = host.getSnapshot('execution-room').runs[0]!

    const bridge = new FusionRoomExecutionBridge({ host, adapter })
    const first = host.confirmResumeContinuation({
      roomId: 'execution-room', actorUserId: 'owner',
      continuationId: blockedRun.id, kind: 'blocked_run', idempotencyKey: 'confirm-idem-1',
    })
    bridge.handleAction('execution-room', { type: 'confirm-resume-continuation' }, first)
    await bridge.waitForIdle()
    const runsAfterFirst = host.getSnapshot('execution-room').runs.length
    const memberAfterFirst = host.getSnapshot('execution-room').messages.filter((m) => m.authorType === 'member').length

    // 同 idempotencyKey 重复确认 → already_confirmed；bridge 不应再开新 turn
    const again = host.confirmResumeContinuation({
      roomId: 'execution-room', actorUserId: 'owner',
      continuationId: blockedRun.id, kind: 'blocked_run', idempotencyKey: 'confirm-idem-1',
    })
    expect(again.status).toBe('already_confirmed')
    bridge.handleAction('execution-room', { type: 'confirm-resume-continuation' }, again)
    await bridge.waitForIdle()

    const snapshot = host.getSnapshot('execution-room')
    expect(snapshot.runs.length).toBe(runsAfterFirst)
    expect(snapshot.messages.filter((m) => m.authorType === 'member').length).toBe(memberAfterFirst)
    bridge.dispose()
  })
})
