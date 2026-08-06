/**
 * kscc 软重置最小轮次守卫 + tool_result 限速测试
 *
 * 验证修复：
 * - 1 轮对话（turnCount=1）即使 token 估算超过阈值，也不触发影子压缩
 * - 2 轮对话（turnCount=2）且 token 超阈值，正常触发影子压缩
 * - 旧会话无 turnCount 字段（undefined）不触发压缩
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionMeta, SDKMessage } from '@tagent/shared'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const mocks = vi.hoisted(() => ({
  getSessionMeta: vi.fn<(id: string) => AgentSessionMeta | undefined>(),
  readSdkMessages: vi.fn<(ws: string | undefined, id: string) => unknown[]>(),
  updateSessionMeta: vi.fn<(id: string, patch: Partial<AgentSessionMeta>) => void>(),
  resolveSafe: vi.fn<(ch: unknown, mid: string | undefined, l?: number) => number>(),
}))

vi.mock('./session-store', () => ({
  getSessionMeta: (id: string) => mocks.getSessionMeta(id),
  readSdkMessages: (ws: string | undefined, id: string) => mocks.readSdkMessages(ws, id),
  updateSessionMeta: (id: string, patch: Partial<AgentSessionMeta>) => mocks.updateSessionMeta(id, patch),
  writeSdkMessages: vi.fn(),
  appendSdkMessages: vi.fn(),
}))

vi.mock('../config/config-paths', () => ({
  getProjectSessionPath: vi.fn(() => '/tmp/mock'),
  getAgentSessionMessagesPath: vi.fn(() => '/tmp/mock'),
}))

vi.mock('../memory/agent-session-compactor', () => ({
  planDropOldToolResults: vi.fn((msgs: unknown[]) => ({ dropped: [], kept: msgs })),
}))

vi.mock('../memory/memory-evidence-sink', () => ({
  memoryEvidenceSink: { writeSessionEvidence: vi.fn() },
}))

vi.mock('../channel/model-window', () => ({
  resolveModelSafeContextLimit: (ch: unknown, mid: string | undefined, l?: number) =>
    mocks.resolveSafe(ch, mid, l),
}))

vi.mock('../channel/channel-store', () => ({
  getChannel: vi.fn(() => undefined),
}))

vi.mock('../memory/context-limits-store', () => ({
  getLearnedSafeContextLimit: vi.fn(() => undefined),
  recordBurstAndLearn: vi.fn(() => 10000),
}))

vi.mock('../memory/compaction-prompt', () => ({
  buildCompactionSplitUserPrompt: vi.fn(() => 'prompt'),
  COMPACTION_SPLIT_SYSTEM: 'system',
  parseCompactionSplitResult: vi.fn(() => ({ summary: 's', facts: [] })),
}))

vi.mock('../memory/memory-llm-client', () => ({
  completeMemoryLlm: vi.fn(async () => 'SUMMARY\n---\n[]'),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  renameSync: vi.fn(),
}))

function makeUserMsg(text: string): SDKMessage {
  return {
    type: 'user',
    uuid: `u-${text.slice(0, 4)}`,
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function makeToolResultMsg(output: string): SDKMessage {
  return {
    type: 'user',
    uuid: `tr-${output.length}`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: output }] }],
    },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function makeAssistantMsg(text: string): SDKMessage {
  return {
    type: 'assistant',
    uuid: `a-${text.slice(0, 4)}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

describe('kscc 软重置最小轮次守卫', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveSafe.mockReturnValue(500)
  })

  it('1 轮（turnCount=1）即使 token 超阈值也不触发影子压缩', async () => {
    const bigToolResult = 'X'.repeat(30_000)
    mocks.readSdkMessages.mockReturnValue([
      makeUserMsg('读大文件'),
      makeAssistantMsg('调用工具'),
      makeToolResultMsg(bigToolResult),
      makeAssistantMsg('结果是'),
    ])
    mocks.getSessionMeta.mockReturnValue({
      id: 's1',
      workspaceId: 'ws1',
      modelId: 'glm-5.1',
      channelId: 'ch1',
      turnCount: 1,
      shadowState: 'idle',
    } as unknown as AgentSessionMeta)

    const { ksccSoftReset } = await import('./kscc-soft-reset')
    ksccSoftReset.setHooks({ onStatus: vi.fn() })

    await ksccSoftReset.onTurnResult({ sessionId: 's1', inputTokens: undefined })

    const compactingCall = mocks.updateSessionMeta.mock.calls.find(
      ([, patch]) => patch.shadowState === 'compacting',
    )
    expect(compactingCall).toBeUndefined()
  })

  it('2 轮（turnCount=2）且 token 超阈值正常触发影子压缩', async () => {
    const bigToolResult = 'X'.repeat(30_000)
    mocks.readSdkMessages.mockReturnValue([
      makeUserMsg('第一轮'),
      makeAssistantMsg('回复1'),
      makeUserMsg('第二轮'),
      makeToolResultMsg(bigToolResult),
      makeAssistantMsg('回复2'),
    ])
    mocks.getSessionMeta.mockReturnValue({
      id: 's2',
      workspaceId: 'ws2',
      modelId: 'glm-5.1',
      channelId: 'ch1',
      turnCount: 2,
      shadowState: 'idle',
    } as unknown as AgentSessionMeta)

    const { ksccSoftReset } = await import('./kscc-soft-reset')
    ksccSoftReset.setHooks({ onStatus: vi.fn() })

    await ksccSoftReset.onTurnResult({ sessionId: 's2', inputTokens: undefined })

    await vi.waitFor(() => {
      expect(mocks.updateSessionMeta).toHaveBeenCalledWith(
        's2',
        expect.objectContaining({ shadowState: 'compacting' }),
      )
    })
  })

  it('旧会话无 turnCount 字段（undefined）不触发压缩', async () => {
    mocks.readSdkMessages.mockReturnValue([
      makeUserMsg('旧消息'),
      makeAssistantMsg('旧回复'),
    ])
    mocks.getSessionMeta.mockReturnValue({
      id: 's3',
      workspaceId: 'ws3',
      modelId: 'glm-5.1',
      channelId: 'ch1',
      turnCount: undefined,
      shadowState: 'idle',
    } as unknown as AgentSessionMeta)

    const { ksccSoftReset } = await import('./kscc-soft-reset')
    ksccSoftReset.setHooks({ onStatus: vi.fn() })

    await ksccSoftReset.onTurnResult({ sessionId: 's3', inputTokens: undefined })

    const compactingCall = mocks.updateSessionMeta.mock.calls.find(
      ([, patch]) => patch.shadowState === 'compacting',
    )
    expect(compactingCall).toBeUndefined()
  })
})
