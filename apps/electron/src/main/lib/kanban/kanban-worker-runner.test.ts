import { describe, expect, test } from 'vitest'
import {
  extractAssistantText,
  extractToolName,
  isBlockedWorkerTool,
  mergeAssistantTextChunks,
  resolveWorkerTerminal,
} from './kanban-worker-runner'

describe('kanban-worker-runner helpers', () => {
  test('extractAssistantText IR 形态', () => {
    const text = extractAssistantText({
      type: 'assistant',
      content: [
        { type: 'text', text: '你好' },
        { type: 'tool_use', name: 'Read' },
        { type: 'text', text: '世界' },
      ],
    })
    expect(text).toBe('你好世界')
  })

  test('extractAssistantText SDK message 形态', () => {
    const text = extractAssistantText({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'done' }],
      },
    })
    expect(text).toBe('done')
  })

  test('extractAssistantText Pi sdk_message 包裹', () => {
    const text = extractAssistantText({
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        content: [{ type: 'text', text: '包裹正文' }],
      },
    })
    expect(text).toBe('包裹正文')
  })

  test('extractAssistantText result', () => {
    expect(extractAssistantText({ type: 'result', result: '摘要' })).toBe('摘要')
  })

  test('mergeAssistantTextChunks 累积全文不重复', () => {
    expect(mergeAssistantTextChunks(['你', '你好', '你好世界'])).toBe('你好世界')
  })

  test('mergeAssistantTextChunks 真增量拼接', () => {
    expect(mergeAssistantTextChunks(['甲', '乙', '丙'])).toBe('甲乙丙')
  })

  test('extractToolName', () => {
    expect(
      extractToolName({
        type: 'assistant',
        content: [{ type: 'tool_use', name: 'Write', id: '1' }],
      }),
    ).toBe('Write')
  })

  test('非 assistant 返回空', () => {
    expect(extractAssistantText({ type: 'user', content: [] })).toBe('')
    expect(extractAssistantText(null)).toBe('')
  })
})

describe('isBlockedWorkerTool', () => {
  test('禁止建板 / 加任务', () => {
    expect(isBlockedWorkerTool('kanban_create_board')).toMatch(/禁止/)
    expect(isBlockedWorkerTool('kanban_add_task')).toMatch(/禁止/)
  })

  test('禁止 Task / Agent 递归派工（含 MCP 前缀）', () => {
    expect(isBlockedWorkerTool('Task')).toMatch(/递归/)
    expect(isBlockedWorkerTool('Agent')).toMatch(/递归/)
    expect(isBlockedWorkerTool('mcp__delegation__Task')).toMatch(/递归/)
    expect(isBlockedWorkerTool('subagent_spawn')).toMatch(/递归/)
  })

  test('禁止交互式工具', () => {
    expect(isBlockedWorkerTool('AskUserQuestion')).toMatch(/无人值守/)
    expect(isBlockedWorkerTool('ExitPlanMode')).toMatch(/无人值守/)
    expect(isBlockedWorkerTool('RequestPermission')).toMatch(/无人值守/)
    expect(isBlockedWorkerTool('user_confirm')).toMatch(/无人值守/)
  })

  test('禁止 Browser_*', () => {
    expect(isBlockedWorkerTool('Browser_navigate')).toMatch(/Browser/)
    expect(isBlockedWorkerTool('browser_click')).toMatch(/Browser/)
  })

  test('允许普通工具', () => {
    expect(isBlockedWorkerTool('Read')).toBeNull()
    expect(isBlockedWorkerTool('Write')).toBeNull()
    expect(isBlockedWorkerTool('Bash')).toBeNull()
    expect(isBlockedWorkerTool('kanban_list_boards')).toBeNull()
  })
})

describe('resolveWorkerTerminal', () => {
  test('只把显式 success/completed 视为成功', () => {
    expect(resolveWorkerTerminal({ subtype: 'success' })).toEqual({ finalStatus: 'done' })
    expect(resolveWorkerTerminal({ subtype: 'completed' })).toEqual({ finalStatus: 'done' })
    expect(resolveWorkerTerminal({ subtype: 'error_max_turns' }).finalStatus).toBe('failed')
    expect(resolveWorkerTerminal(undefined).finalStatus).toBe('failed')
  })

  test('保留终态错误而不合成成功摘要', () => {
    expect(resolveWorkerTerminal({ subtype: 'error_during_execution', errors: ['API failed'] })).toEqual({
      finalStatus: 'failed',
      error: 'API failed',
    })
  })

  test('错误证据优先于 success/completed subtype', () => {
    expect(resolveWorkerTerminal({ subtype: 'success', is_error: true })).toMatchObject({
      finalStatus: 'failed',
    })
    expect(resolveWorkerTerminal({ subtype: 'completed', isError: true, error: 'transport failed' })).toEqual({
      finalStatus: 'failed',
      error: 'transport failed',
    })
    expect(resolveWorkerTerminal({ subtype: 'success', errors: ['provider failed'] })).toEqual({
      finalStatus: 'failed',
      error: 'provider failed',
    })
  })
})
