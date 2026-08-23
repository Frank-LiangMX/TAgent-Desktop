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
})