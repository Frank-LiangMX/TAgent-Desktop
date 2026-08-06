import { describe, expect, test } from 'bun:test'
import type { TAgentMessage } from '@tagent/shared'
import {
  buildTurnPresentation,
  dedupeAnswerTexts,
  groupItemsIntoTurns,
  isRealUserInput,
  isToolResultOnlyUser,
  summarizeProcess,
  type TurnSourceItem,
} from './session-turn-model'

const userText = (text: string): TAgentMessage => ({
  type: 'user',
  content: [{ type: 'text', text }],
})

const userToolResult = (id: string, content = 'ok'): TAgentMessage => ({
  type: 'user',
  content: [{ type: 'tool_result', toolUseId: id, content }],
})

const assistantTools = (modelId: string, tools: Array<{ id: string; name: string }>): TAgentMessage => ({
  type: 'assistant',
  modelId,
  content: tools.map((t) => ({
    type: 'tool_use' as const,
    id: t.id,
    name: t.name,
    input: {},
  })),
})

const assistantText = (modelId: string, text: string): TAgentMessage => ({
  type: 'assistant',
  modelId,
  content: [{ type: 'text', text }],
})

const assistantMixed = (
  modelId: string,
  blocks: Extract<TAgentMessage, { type: 'assistant' }>['content'],
): TAgentMessage => ({
  type: 'assistant',
  modelId,
  content: blocks,
})

describe('isRealUserInput / isToolResultOnlyUser', () => {
  test('text user is real input', () => {
    const m = userText('分析目录') as Extract<TAgentMessage, { type: 'user' }>
    expect(isRealUserInput(m)).toBe(true)
    expect(isToolResultOnlyUser(m)).toBe(false)
  })

  test('tool_result only is not real input', () => {
    const m = userToolResult('t1') as Extract<TAgentMessage, { type: 'user' }>
    expect(isRealUserInput(m)).toBe(false)
    expect(isToolResultOnlyUser(m)).toBe(true)
  })

  test('kscc interrupt sentinel is not real user input', () => {
    const m = userText('[Request interrupted by user for tool use]') as Extract<
      TAgentMessage,
      { type: 'user' }
    >
    expect(isRealUserInput(m)).toBe(false)
  })

  test('isSynthetic user is not real input', () => {
    const m = {
      ...userText('skill prompt'),
      isSynthetic: true,
    } as Extract<TAgentMessage, { type: 'user' }>
    expect(isRealUserInput(m)).toBe(false)
  })
})

describe('groupItemsIntoTurns', () => {
  test('merges multi-step tool loop into one assistant-turn with single model badge source', () => {
    const items: TurnSourceItem[] = [
      { key: 'u1', message: userText('分析') },
      { key: 'a1', message: assistantTools('deepseek-v4-flash', [{ id: 't1', name: 'Read' }]) },
      { key: 'r1', message: userToolResult('t1') },
      { key: 'a2', message: assistantTools('deepseek-v4-flash', [{ id: 't2', name: 'Bash' }, { id: 't3', name: 'Bash' }]) },
      { key: 'r2', message: userToolResult('t2') },
      { key: 'r3', message: userToolResult('t3') },
      { key: 'a3', message: assistantText('deepseek-v4-flash', '目录结构如下…') },
    ]

    const turns = groupItemsIntoTurns(items)
    expect(turns).toHaveLength(2)
    expect(turns[0]?.kind).toBe('user')
    expect(turns[1]?.kind).toBe('assistant-turn')
    if (turns[1]?.kind === 'assistant-turn') {
      expect(turns[1].items).toHaveLength(6)
      expect(turns[1].modelId).toBe('deepseek-v4-flash')
    }
  })

  test('second real user starts a new turn', () => {
    const items: TurnSourceItem[] = [
      { key: 'u1', message: userText('第一问') },
      { key: 'a1', message: assistantText('m1', '答1') },
      { key: 'u2', message: userText('第二问') },
      { key: 'a2', message: assistantText('m1', '答2') },
    ]
    const turns = groupItemsIntoTurns(items)
    expect(turns.map((t) => t.kind)).toEqual(['user', 'assistant-turn', 'user', 'assistant-turn'])
  })

  test('compact boundary stays standalone', () => {
    const items: TurnSourceItem[] = [
      { key: 'u1', message: userText('hi') },
      { key: 'c1', compactStatus: 'complete' },
      { key: 'a1', message: assistantText('m', 'after') },
    ]
    const turns = groupItemsIntoTurns(items)
    expect(turns.map((t) => t.kind)).toEqual(['user', 'standalone', 'assistant-turn'])
  })

  test('kscc interrupt does not become a user bubble', () => {
    const items: TurnSourceItem[] = [
      { key: 'u1', message: userText('分析') },
      { key: 'a1', message: assistantTools('m', [{ id: 't1', name: 'Read' }]) },
      { key: 'intr', message: userText('[Request interrupted by user for tool use]') },
    ]
    const turns = groupItemsIntoTurns(items)
    expect(turns.map((t) => t.kind)).toEqual(['user', 'assistant-turn'])
    expect(turns.some((t) => t.kind === 'user' && t.key === 'intr')).toBe(false)
  })
})

describe('buildTurnPresentation', () => {
  test('pairs tool results and keeps final text as answer; one model id', () => {
    const items: TurnSourceItem[] = [
      {
        key: 'a1',
        message: assistantMixed('deepseek-v4-flash', [
          { type: 'thinking', thinking: '先看文件' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } },
        ]),
      },
      { key: 'r1', message: userToolResult('t1', 'file content') },
      {
        key: 'a2',
        message: assistantMixed('deepseek-v4-flash', [
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: '分析完成。' },
        ]),
      },
      { key: 'r2', message: userToolResult('t2', 'ok') },
    ]
    // re-order: typically tool result comes before next assistant text; adjust for realistic order
    const realistic: TurnSourceItem[] = [
      items[0]!,
      items[1]!,
      {
        key: 'a2',
        message: assistantMixed('deepseek-v4-flash', [
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
        ]),
      },
      items[3]!,
      {
        key: 'a3',
        message: assistantText('deepseek-v4-flash', '分析完成。'),
      },
    ]

    const turns = groupItemsIntoTurns(realistic)
    const turn = turns[0]
    expect(turn?.kind).toBe('assistant-turn')
    if (turn?.kind !== 'assistant-turn') return

    const pres = buildTurnPresentation(turn)
    expect(pres.modelId).toBe('deepseek-v4-flash')
    expect(pres.answerTexts).toEqual(['分析完成。'])
    expect(pres.process.filter((p) => p.type === 'tool')).toHaveLength(2)
    expect(pres.process.filter((p) => p.type === 'thinking')).toHaveLength(1)
    const tools = pres.process.filter((p) => p.type === 'tool')
    expect(tools[0]?.type === 'tool' && tools[0].result?.content).toBe('file content')
  })

  test('summarizeProcess counts tools', () => {
    const s = summarizeProcess([
      { type: 'tool', key: '1', tool: { type: 'tool_use', id: 'a', name: 'Read', input: {} } },
      { type: 'tool', key: '2', tool: { type: 'tool_use', id: 'b', name: 'Read', input: {} } },
      { type: 'tool', key: '3', tool: { type: 'tool_use', id: 'c', name: 'Bash', input: {} } },
      { type: 'thinking', key: '4', thinking: 'x' },
    ])
    expect(s.toolCount).toBe(3)
    expect(s.toolNames).toEqual(['Read', 'Bash'])
    expect(s.label).toContain('3 次工具调用')
  })

  test('does not stack streamingText on top of finalized answer', () => {
    const items: TurnSourceItem[] = [
      {
        key: 's1',
        streaming: true,
        streamingText: '完整回答内容',
      },
      {
        key: 'a1',
        message: assistantText('m', '完整回答内容'),
      },
    ]
    const turns = groupItemsIntoTurns(items)
    const turn = turns[0]
    expect(turn?.kind).toBe('assistant-turn')
    if (turn?.kind !== 'assistant-turn') return
    const pres = buildTurnPresentation(turn)
    expect(pres.answerTexts).toEqual(['完整回答内容'])
    expect(pres.streamingText).toBeUndefined()
    expect(pres.isStreaming).toBe(false)
  })

  test('merges multi answer segments into one string', () => {
    const items: TurnSourceItem[] = [
      {
        key: 'a1',
        message: assistantMixed('m', [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ]),
      },
    ]
    const turns = groupItemsIntoTurns(items)
    const turn = turns[0]
    if (turn?.kind !== 'assistant-turn') throw new Error('expected turn')
    const pres = buildTurnPresentation(turn)
    expect(pres.answerTexts).toHaveLength(1)
    expect(pres.answerTexts[0]).toContain('第一段')
    expect(pres.answerTexts[0]).toContain('第二段')
  })
})

describe('dedupeAnswerTexts', () => {
  test('drops exact duplicates and prefixes', () => {
    expect(dedupeAnswerTexts(['你好', '你好', '你好世界'])).toEqual(['你好世界'])
    expect(dedupeAnswerTexts(['完整', '完整'])).toEqual(['完整'])
  })
})
