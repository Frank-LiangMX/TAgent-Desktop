import { describe, expect, it } from 'vitest'
import type { TAgentMessage } from '@tagent/shared'
import { discardReconnectPartial } from './reconnect-partial'
import { collectPendingToolUseIds } from '../../lib/session-run-inflight'

describe('discardReconnectPartial', () => {
  it('removes failed partial tool parameters without deleting completed tools, results or other output', () => {
    const items: Array<{ message: TAgentMessage }> = [
      { message: { type: 'assistant', uuid: 'done', content: [{ type: 'tool_use', id: 'executed', name: 'Write', input: {} }] } },
      { message: { type: 'user', content: [{ type: 'tool_result', toolUseId: 'executed', content: 'ok' }] } },
      { message: { type: 'assistant', uuid: 'failed', _partial: true, content: [{ type: 'tool_use', id: 'unfinished', name: 'Write', input: {} }] } },
      { message: { type: 'assistant', uuid: 'other', _partial: true, content: [] } },
      { message: { type: 'assistant', uuid: 'failed', parentToolUseId: 'subagent', _partial: true, content: [] } },
    ]
    const next = discardReconnectPartial(items, 'failed')
    expect(next).toEqual([items[0], items[1], items[3], items[4]])
    expect(collectPendingToolUseIds(next).size).toBe(0)
    expect(items).toHaveLength(5)
    expect(discardReconnectPartial(items, 'done')).toEqual(items)
  })
})
