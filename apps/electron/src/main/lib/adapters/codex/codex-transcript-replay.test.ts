/** Synthetic App Server notifications, production normalizer/reducer/presentation.
 * No model or App Server process is mocked as a successful real runtime run. */
import { describe, expect, it } from 'vitest'
import type { TAgentMessage } from '@tagent/shared'
import { CodexEventNormalizer } from './codex-event-normalizer'
import { applySdkMessageToItems } from '../../../../renderer/components/chat/stream-item-model'
import { buildTurnPresentation, type TurnSourceItem } from '../../../../renderer/components/chat/session-turn-model'

function harness() {
  const normalizer = new CodexEventNormalizer('fixture-model')
  let items: TurnSourceItem[] = []
  const persisted: TAgentMessage[] = []
  let seq = 0
  function feed(method: string, params: Record<string, unknown>) {
    const payloads = normalizer.feed({ method, params: { threadId: 'thread', turnId: 'turn', ...params }, threadId: 'thread', tagentSessionId: 'session' })
    for (const p of payloads) {
      if (p.kind !== 'sdk_message') continue
      items = applySdkMessageToItems(items, p.message, () => `item-${seq++}`)
      if (p.message.type !== 'assistant' || !p.message._partial) persisted.push(structuredClone(p.message))
    }
    return payloads
  }
  return { feed, normalizer, items: () => items, persisted,
    history: () => persisted.map((m, i) => ({ key: `history-${i}`, message: JSON.parse(JSON.stringify(m)) as TAgentMessage })) }
}

const presentation = (items: TurnSourceItem[]) => buildTurnPresentation(
  { kind: 'assistant-turn', key: 'turn', items, isStreaming: false },
  { isLiveTurn: false, displayMode: 'full' },
)

describe('Codex protocol → live items → persisted history', () => {
  it('streams separate item identities, then replaces each draft with its complete snapshot', () => {
    const h = harness()
    h.feed('item/agentMessage/delta', { itemId: 'a', delta: '第一段' })
    h.feed('item/agentMessage/delta', { itemId: 'b', delta: '第二段草稿' })
    expect(h.items().map(i => i.message?.uuid)).toEqual(['a', 'b'])
    const keys = h.items().map(i => i.key)
    h.feed('item/completed', { item: { id: 'a', type: 'agentMessage', text: '第一段' } })
    h.feed('item/completed', { item: { id: 'b', type: 'agentMessage', text: '第二段' } })
    expect(h.items().map(i => i.key)).toEqual(keys)
    expect(h.items().every(i => !i.streaming)).toBe(true)
    expect(h.items().map(i => i.message)).toEqual(h.history().map(i => i.message))
    expect(presentation(h.items())).toEqual(presentation(h.history()))
    expect(presentation(h.items()).answerTexts.join('')).not.toContain('草稿')
  })

  it('uses reasoning summary when present, without concatenating raw reasoning or answer text', () => {
    const h = harness()
    h.feed('item/reasoning/textDelta', { itemId: 'r', contentIndex: 0, delta: 'raw reasoning' })
    h.feed('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 1, delta: '检查测试' })
    h.feed('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: '检查入口' })
    h.feed('item/completed', { item: { id: 'r', type: 'reasoning', summary: ['检查入口', '检查测试'], content: ['raw reasoning'] } })
    h.feed('item/completed', { item: { id: 'a', type: 'agentMessage', text: '结论' } })
    expect(h.items()[0]?.message?.content).toEqual([{ type: 'thinking', thinking: '检查入口\n\n检查测试' }])
    expect(presentation(h.items()).answerTexts.join('')).toBe('结论')
    expect(presentation(h.items())).toEqual(presentation(h.history()))
  })

  it.each(['completed', 'interrupted', 'failed'])('%s seals unfinished text before the turn result and ignores late events', (status) => {
    const h = harness()
    h.feed('item/agentMessage/delta', { itemId: 'a', delta: '已经确认的内容' })
    const end = { turn: { id: 'turn', status, ...(status === 'failed' ? { error: { message: 'fixture network error' } } : {}) } }
    const output = h.feed('turn/completed', end)
    expect(output.at(-1)).toMatchObject({ kind: 'result', subtype: status })
    expect(h.persisted).toHaveLength(1)
    expect(h.items()[0]?.streaming).toBe(false)
    expect(h.items().map(i => i.message)).toEqual(h.history().map(i => i.message))
    expect(h.feed('item/agentMessage/delta', { itemId: 'a', delta: '迟到文本' })).toEqual([])
    expect(h.feed('item/started', { item: { id: 'tool', type: 'commandExecution', command: 'echo late' } })).toEqual([])
    expect(h.feed('turn/completed', end)).toEqual([])
    h.feed('item/agentMessage/delta', { turnId: 'next', itemId: 'next-a', delta: '下一轮' })
    expect(h.items()).toHaveLength(2)
  })

  it('does not revive a completed tool or duplicate persisted results', () => {
    const h = harness()
    const item = { id: 'cmd', type: 'commandExecution', command: 'fixture', status: 'failed', exitCode: 1, aggregatedOutput: 'failed fixture' }
    h.feed('item/started', { item })
    h.feed('item/completed', { item })
    const before = structuredClone(h.items())
    expect(h.feed('item/started', { item })).toEqual([])
    expect(h.feed('item/completed', { item })).toEqual([])
    expect(h.items()).toEqual(before)
    expect(h.persisted).toHaveLength(2)
    expect(h.persisted[1]?.content[0]).toMatchObject({ type: 'tool_result', isError: true })
  })
})
