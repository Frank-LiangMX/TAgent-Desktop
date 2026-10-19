import { describe, expect, it } from 'vitest'
import type { TAgentMessage, TAgentAssistantMessage } from '@tagent/shared'
import { buildTurnPresentation, type TurnSourceItem } from './session-turn-model'
import {
  applySdkMessageToItems,
  compactAssistantMessageForDisplay,
  type StreamItemLike,
} from './stream-item-model'

const assistant = (uuid: string, text: string, final = false): TAgentAssistantMessage => ({
  type: 'assistant', uuid,
  ...(final ? { stop_reason: 'end_turn' } : { _partial: true }),
  content: [{ type: 'text', text }],
})

describe('stream identity and block order', () => {
  it('authoritative final may remove or shorten blocks without retaining stale draft content', () => {
    const draft: TAgentMessage = { ...assistant('authoritative', '待核对的长草稿'), _contentSnapshot: true,
      content: [{ type: 'thinking', thinking: 'draft reasoning' }, { type: 'text', text: '待核对的长草稿' }] }
    const final: TAgentMessage = { ...assistant('authoritative', '待核对', true), _contentSnapshot: true }
    const live = applySdkMessageToItems<StreamItemLike>([], draft, () => 'stable')
    const done = applySdkMessageToItems(live, final, () => 'unused')
    expect(done[0]?.key).toBe('stable')
    expect(done[0]?.message).toEqual(compactAssistantMessageForDisplay(final))
    expect(applySdkMessageToItems(done, draft, () => 'unused')).toBe(done)
  })
  it.each([false, true])('a distinct UUID never replaces an unfinished message (final=%s)', (final) => {
    let id = 0
    const alloc = () => `item-${id++}`
    const first = applySdkMessageToItems<StreamItemLike>([], assistant('a', '第一阶段'), alloc)
    const next = applySdkMessageToItems(first, assistant('b', '第二阶段', final), alloc)
    expect(next).toHaveLength(2)
    expect(next[0]).toBe(first[0])
    expect(next[1]?.message).toMatchObject({ uuid: 'b', content: [{ type: 'text', text: '第二阶段' }] })
    const completed = applySdkMessageToItems(next, assistant('a', '第一阶段完成', true), alloc)
    expect(completed).toHaveLength(2)
    expect(completed[0]?.key).toBe(first[0]?.key)
    expect(completed[1]).toBe(next[1])
  })

  it('different UUIDs cannot alias through the same tool id', () => {
    const tool = { type: 'tool_use' as const, id: 'tool-1', name: 'Read', input: {} }
    const first = applySdkMessageToItems<StreamItemLike>([], { ...assistant('a', ''), content: [tool] }, () => 'a')
    const next = applySdkMessageToItems(first, { ...assistant('b', ''), content: [tool] }, () => 'b')
    expect(next).toHaveLength(2)
    expect(next[0]).toBe(first[0])
  })

  it('display normalization preserves block indices, reasoning text and chronological order', () => {
    const message: TAgentMessage = {
      type: 'assistant', uuid: 'a', _partial: true,
      content: [
        { type: 'thinking', thinking: '先检查。'.repeat(300) },
        { type: 'text', text: '正在检查文件。' },
        { type: 'tool_use', id: 'read-1', name: 'Read', input: {} },
        { type: 'thinking', thinking: '工具返回之后再判断。' },
        { type: 'text', text: '检查完成。' },
      ],
    }
    const display = compactAssistantMessageForDisplay(message)
    expect(display.content).toEqual(message.content)
    const updated = compactAssistantMessageForDisplay({
      ...message, content: [...message.content, { type: 'thinking', thinking: '继续验证。' }],
    })
    expect(updated.content.slice(0, message.content.length)).toEqual(display.content)
  })

  it('partial → final → history keeps reasoning around the tool in place with stable keys', () => {
    const content: TAgentAssistantMessage['content'] = [
      { type: 'thinking', thinking: '先检查。'.repeat(300) },
      { type: 'text', text: '开始读取。' },
      { type: 'tool_use', id: 'read-1', name: 'Read', input: {} },
      { type: 'thinking', thinking: '读取后再判断。' },
    ]
    const partial: TAgentMessage = { type: 'assistant', uuid: 'a', _partial: true, content }
    const final: TAgentMessage = { type: 'assistant', uuid: 'a', stop_reason: 'end_turn', content }
    const live = applySdkMessageToItems<TurnSourceItem>([], partial, () => 'a')
    const completed = applySdkMessageToItems(live, final, () => 'unexpected')
    const history = [{ key: 'history-a', message: compactAssistantMessageForDisplay(final) }]
    for (const [items, isLive] of [[live, true], [completed, false], [history, false]] as const) {
      const presentation = buildTurnPresentation(
        { kind: 'assistant-turn', key: 'turn', items, isStreaming: isLive },
        { isLiveTurn: isLive, displayMode: 'concise' },
      )
      expect(presentation.process.map((entry) => [entry.type, entry.key])).toEqual([
        ['thinking', 'think-a-0'], ['text', 'text-a-1'],
        ['tool', 'tool-read-1'], ['thinking', 'think-a-3'],
      ])
      expect(presentation.process.filter((entry) => entry.type === 'thinking').map((entry) => entry.thinking))
        .toEqual(['先检查。'.repeat(300), '读取后再判断。'])
    }
  })

  it('restores a legacy single-block display summary without spreading it across multiple blocks', () => {
    const legacy = {
      type: 'assistant' as const, uuid: 'legacy', __fullThinking: '完整思考',
      content: [{ type: 'thinking' as const, thinking: '摘要' }],
    }
    expect(compactAssistantMessageForDisplay(legacy)).toEqual({
      type: 'assistant', uuid: 'legacy', content: [{ type: 'thinking', thinking: '完整思考' }],
    })
  })
})
