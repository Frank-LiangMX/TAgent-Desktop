import { describe, expect, test } from 'vitest'
import {
  groupCollaborationTimelineItems,
  type CollaborationMember,
  type CollaborationMessage,
  type CollaborationRun,
} from './collaboration-room'

function mkMember(id: string, displayName: string): CollaborationMember {
  return {
    id,
    roomId: 'cr_x',
    displayName,
    roleSnapshot: { displayName },
    backend: 'channel',
    logicalSessionId: 'ls_' + id,
    permissionProfile: 'read-only',
    capabilities: {
      supportsResume: false,
      supportsLiveInput: false,
      supportsToolBridge: false,
      supportsStructuredEvents: false,
    },
    status: 'idle',
    isCoordinator: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function mkMsg(id: string, overrides: Partial<CollaborationMessage>): CollaborationMessage {
  return {
    id,
    roomId: 'cr_x',
    authorType: 'user',
    authorId: 'user',
    kind: 'chat',
    content: '',
    visibility: 'room',
    targetMemberIds: [],
    rootMessageId: id,
    depth: 0,
    createdAt: 0,
    ...overrides,
  }
}

function mkRun(id: string, overrides: Partial<CollaborationRun> = {}): CollaborationRun {
  return {
    id,
    roomId: 'cr_x',
    memberId: 'cm_a',
    triggerMessageId: 'm0',
    idempotencyKey: `${id}:cm_a`,
    status: 'running',
    attempt: 0,
    createdAt: 0,
    ...overrides,
  }
}

describe('groupCollaborationTimelineItems（S3.5-c H3，04 §8.4）', () => {
  test('成员 chat 按 runId 收进 run 卡，乱序消息不散落', () => {
    const run = mkRun('run_1', { status: 'done', startedAt: 10, createdAt: 10 })
    const messages = [
      mkMsg('m3', {
        authorType: 'member',
        authorId: 'cm_a',
        runId: 'run_1',
        content: '第二步',
        createdAt: 12,
      }),
      mkMsg('m1', {
        authorType: 'member',
        authorId: 'cm_a',
        runId: 'run_1',
        content: '第一步',
        createdAt: 11,
      }),
    ]
    const items = groupCollaborationTimelineItems(messages, [run])
    expect(items).toHaveLength(1)
    expect(items[0]!.type).toBe('run')
    if (items[0]!.type === 'run') {
      expect(items[0]!.messages.map((m) => m.content)).toEqual(['第一步', '第二步'])
      expect(items[0]!.run.id).toBe('run_1')
    }
  })

  test('用户消息保持独立条目', () => {
    const run = mkRun('run_1', { status: 'running', startedAt: 10 })
    const messages = [
      mkMsg('m1', { authorType: 'user', content: '你好', createdAt: 5 }),
    ]
    const items = groupCollaborationTimelineItems(messages, [run])
    expect(items.filter((i) => i.type === 'user')).toHaveLength(1)
  })

  test('warning / system 不进 run 卡，独立呈现', () => {
    const run = mkRun('run_1', { status: 'failed', startedAt: 10 })
    const messages = [
      mkMsg('m1', {
        kind: 'warning',
        authorType: 'system',
        authorId: 'system',
        content: '运行被中断',
        createdAt: 11,
      }),
    ]
    const items = groupCollaborationTimelineItems(messages, [run])
    expect(items.find((i) => i.type === 'system')).toBeDefined()
    const runItem = items.find((i) => i.type === 'run')
    expect(runItem && runItem.type === 'run' ? runItem.messages : []).toEqual([])
  })

  test('进行中的 run 无消息也出卡（排队/思考中）', () => {
    const run = mkRun('run_1', { status: 'queued', startedAt: 10 })
    const items = groupCollaborationTimelineItems([], [run])
    expect(items).toHaveLength(1)
    expect(items[0]!.type).toBe('run')
  })

  test('排序：run 按 startedAt 主键，其次 run.id；消息按 createdAt', () => {
    const runA = mkRun('run_b', { status: 'running', startedAt: 20, createdAt: 20 })
    const runB = mkRun('run_a', { status: 'running', startedAt: 10, createdAt: 10 })
    const user1 = mkMsg('m1', { authorType: 'user', content: '先发的用户消息', createdAt: 15 })
    const items = groupCollaborationTimelineItems([user1], [runA, runB])
    expect(items.map((i) => (i.type === 'run' ? i.run.id : i.message.id))).toEqual([
      'run_a',
      'm1',
      'run_b',
    ])
  })

  test('无 run 的成员消息退化为独立 member 条目', () => {
    const messages = [
      mkMsg('m1', { authorType: 'member', authorId: 'cm_a', content: '老数据', createdAt: 5 }),
    ]
    const items = groupCollaborationTimelineItems(messages, [])
    expect(items[0]!.type).toBe('member')
  })

  test('A2A 提问/回复是独立摘要条目，不收进 run 卡', () => {
    const run = mkRun('run_1', { status: 'running', startedAt: 10 })
    const messages = [
      mkMsg('m1', {
        kind: 'a2a_request',
        authorType: 'member',
        authorId: 'cm_a',
        runId: 'run_1',
        content: '接口契约是什么？',
        targetMemberIds: ['cm_b'],
        createdAt: 11,
      }),
    ]
    const items = groupCollaborationTimelineItems(messages, [run])
    expect(items.find((i) => i.type === 'a2a')).toBeDefined()
    const runItem = items.find((i) => i.type === 'run')
    expect(runItem && runItem.type === 'run' ? runItem.messages : []).toEqual([])
  })
})
