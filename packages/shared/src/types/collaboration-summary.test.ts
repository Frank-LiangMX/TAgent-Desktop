import { describe, expect, test } from 'vitest'
import type {
  CollaborationMember,
  CollaborationMessage,
  CollaborationRoom,
} from './collaboration-room'
import {
  COLLABORATION_SUMMARY_MAX_INPUT_CHARS,
  COLLABORATION_SUMMARY_SYSTEM_PROMPT,
  buildCollaborationSummaryModelRequest,
  collaborationSummaryCASKey,
  countCollaborationEffectiveUtterances,
  extractCollaborationSummaryBatch,
  isCollaborationEffectiveUtterance,
  latestCollaborationRoomSummaryText,
  type CollaborationRoomSummary,
} from './collaboration-summary'

function mkMessage(id: string, overrides: Partial<CollaborationMessage>): CollaborationMessage {
  return {
    id,
    roomId: 'cr_x',
    authorType: 'user',
    authorId: 'user',
    kind: 'chat',
    content: '正文',
    visibility: 'room',
    targetMemberIds: [],
    rootMessageId: id,
    depth: 0,
    createdAt: 0,
    ...overrides,
  }
}

const MEMBER: CollaborationMember = {
  id: 'cm_a',
  roomId: 'cr_x',
  displayName: '分析师',
  roleSnapshot: { displayName: '分析师' },
  backend: 'channel',
  logicalSessionId: 'ls_a',
  permissionProfile: 'read-only',
  capabilities: {
    supportsResume: false,
    supportsLiveInput: false,
    supportsToolBridge: false,
    supportsStructuredEvents: false,
  },
  status: 'idle',
  isCoordinator: true,
  createdAt: 0,
  updatedAt: 0,
}

const ROOM: Pick<CollaborationRoom, 'title' | 'goal'> = {
  title: '测试室',
  goal: '完成协作测试',
}

describe('isCollaborationEffectiveUtterance（04 §6.3）', () => {
  test('S3 规则：chat + user/member + room + 非空正文 → 有效', () => {
    expect(
      isCollaborationEffectiveUtterance(mkMessage('m1', { authorType: 'user', content: '开始' })),
    ).toBe(true)
    expect(
      isCollaborationEffectiveUtterance(
        mkMessage('m2', { authorType: 'member', authorId: 'cm_a', content: '我上' }),
      ),
    ).toBe(true)
  })

  test('不计入：a2a_* / warning / artifact / task_event / 空内容 / 私有信箱', () => {
    expect(
      isCollaborationEffectiveUtterance(mkMessage('m1', { kind: 'a2a_reply', authorType: 'member' })),
    ).toBe(false)
    expect(
      isCollaborationEffectiveUtterance(mkMessage('m2', { kind: 'a2a_request', authorType: 'member' })),
    ).toBe(false)
    expect(isCollaborationEffectiveUtterance(mkMessage('m3', { kind: 'warning' }))).toBe(false)
    expect(isCollaborationEffectiveUtterance(mkMessage('m4', { kind: 'artifact' }))).toBe(false)
    expect(isCollaborationEffectiveUtterance(mkMessage('m5', { kind: 'task_event' }))).toBe(false)
    expect(isCollaborationEffectiveUtterance(mkMessage('m6', { content: '  ' }))).toBe(false)
    // member 私有信箱（非 room 可见度）
    expect(
      isCollaborationEffectiveUtterance(mkMessage('m7', { kind: 'chat', visibility: 'participants' })),
    ).toBe(false)
  })

  test('不计入：纯工具轨迹 `[Calling tool:` / `[Tool result:` 开头（防洪水饿死摘要）', () => {
    expect(
      isCollaborationEffectiveUtterance(mkMessage('m1', { content: '[Calling tool: read_file]' })),
    ).toBe(false)
    expect(
      isCollaborationEffectiveUtterance(mkMessage('m2', { content: '[Tool result: ok]' })),
    ).toBe(false)
    // 正文前有内容的行不算纯轨迹
    expect(
      isCollaborationEffectiveUtterance(
        mkMessage('m3', { content: '步骤说明\n[Tool result: ok]' }),
      ),
    ).toBe(true)
  })
})

describe('countCollaborationEffectiveUtterances（04 §6.3）', () => {
  test('无锚点 → 全部有效发言', () => {
    const msgs = [
      mkMessage('m1', { authorType: 'user', content: 'a' }),
      mkMessage('m2', { kind: 'warning', content: 'w' }),
      mkMessage('m3', { authorType: 'member', content: 'b' }),
    ]
    expect(countCollaborationEffectiveUtterances(msgs, null)).toBe(2)
  })

  test('锚点之后计数（S1/S2 阈值判定）', () => {
    const msgs = Array.from({ length: 8 }, (_, i) =>
      mkMessage(`m${i}`, { authorType: 'user', content: `x${i}`, createdAt: i }),
    )
    // 锚点 = 第 7 条（index 6）→ 之后只剩 1 条
    expect(countCollaborationEffectiveUtterances(msgs, 'm6')).toBe(1)
    // 锚点为列表尾声 → 0
    expect(countCollaborationEffectiveUtterances(msgs, 'm7')).toBe(0)
    // 锚点不存在 → 全部
    expect(countCollaborationEffectiveUtterances(msgs, 'nope')).toBe(8)
  })
})

describe('extractCollaborationSummaryBatch（04 §6.3）', () => {
  test('锚点之后按时间取前缀，一批最多 20 条', () => {
    const msgs = Array.from({ length: 30 }, (_, i) =>
      mkMessage(`m${i}`, { authorType: 'user', content: `x${i}`, createdAt: i }),
    )
    const batch = extractCollaborationSummaryBatch(msgs, 'm7', 20)
    expect(batch).toHaveLength(20)
    expect(batch[0]!.id).toBe('m8')
    expect(batch[19]!.id).toBe('m27')
  })

  test('无锚点 → 从第一条有效发言开始', () => {
    const msgs = [
      mkMessage('m0', { kind: 'warning' }),
      mkMessage('m1', { authorType: 'user', content: 'a' }),
      mkMessage('m2', { authorType: 'member', content: 'b' }),
    ]
    const batch = extractCollaborationSummaryBatch(msgs, null, 20)
    expect(batch.map((m) => m.id)).toEqual(['m1', 'm2'])
  })
})

describe('collaborationSummaryCASKey（04 §6.2）', () => {
  test('键 = generation:version:锚点', () => {
    expect(
      collaborationSummaryCASKey({ generation: 1, version: 3, summaryThroughMessageId: 'm9' }),
    ).toBe('1:3:m9')
  })
})

describe('latestCollaborationRoomSummaryText（04 §6.2）', () => {
  test('仅 success 空摘要返回 null；文本存在即返回（summarizing/failed 期间保留上一份 success）', () => {
    expect(latestCollaborationRoomSummaryText(undefined)).toBeNull()
    expect(
      latestCollaborationRoomSummaryText({ ...mkSummary(), summary: '   ' }),
    ).toBeNull()
    expect(
      latestCollaborationRoomSummaryText({ ...mkSummary(), summary: '六段状态' }),
    ).toBe('六段状态')
  })
})

describe('buildCollaborationSummaryModelRequest（04 §6.5/§6.4）', () => {
  test('systemPrompt 与共享六段契约逐字一致，userPrompt 为 <summary_data> JSON', () => {
    const { systemPrompt, userPrompt } = buildCollaborationSummaryModelRequest({
      room: ROOM,
      members: [MEMBER],
      previousSummary: '旧基线',
      batchMessages: [mkMessage('m1', { authorType: 'user', content: 'xx', createdAt: 1 })],
    })
    expect(systemPrompt).toBe(COLLABORATION_SUMMARY_SYSTEM_PROMPT)
    // 六段标题齐全（§6.5 契约）
    const headings = [
      '## 当前目标与阶段',
      '## 已确认决定',
      '## 硬约束与验收标准',
      '## 已完成工作与验证结果',
      '## 关键上下文、参与者与引用',
      '## 待办、阻塞与未决问题',
    ]
    for (const h of headings) {
      expect(systemPrompt).toContain(h)
    }
    expect(userPrompt).toContain('<summary_data>')
    expect(userPrompt).toContain('旧基线')
    expect(userPrompt).toContain('xx')
    expect(userPrompt).not.toContain('## 当前目标')
  })

  test('装配后总长在预算内（§6.4 常数）', () => {
    const { systemPrompt, userPrompt } = buildCollaborationSummaryModelRequest({
      room: ROOM,
      members: [MEMBER],
      previousSummary: '旧基线',
      batchMessages: [mkMessage('m1', { authorType: 'user', content: 'xx' })],
    })
    expect(systemPrompt.length + userPrompt.length).toBeLessThan(
      COLLABORATION_SUMMARY_MAX_INPUT_CHARS,
    )
  })
})

function mkSummary(): CollaborationRoomSummary {
  return {
    roomId: 'cr_x',
    summary: '',
    summaryThroughMessageId: '',
    summarizedUtteranceCount: 0,
    version: 0,
    generation: 0,
    status: 'idle',
    updatedAt: 0,
    lastError: null,
  }
}