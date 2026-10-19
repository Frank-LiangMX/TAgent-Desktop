/** SDK fixture → real Claude adapter → production conversion/persistence/reducer.
 * The SDK generator is substituted; this is not a real model acceptance test. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { sdkMessageToIR, type SDKMessage } from '@tagent/shared'
import { createStreamPersistGateState, feedStreamPersistGate, flushStreamPersistGate } from '../../agent/stream-persist-gate'
import { applySdkMessageToItems } from '../../../../renderer/components/chat/stream-item-model'
import { buildTurnPresentation, type TurnSourceItem } from '../../../../renderer/components/chat/session-turn-model'
import { reduceTaskEvent, type TaskCardCarrier, type TaskCardEvent } from '../../../../renderer/components/chat/subagent-ui-model'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }))
import { ClaudeAgentAdapter } from './claude-agent-adapter'

const root = mkdtempSync(join(tmpdir(), 'tagent-claude-replay-'))
const oldRoot = process.env.TAGENT_CONFIG_DIR
process.env.TAGENT_CONFIG_DIR = root
afterAll(() => {
  if (oldRoot === undefined) delete process.env.TAGENT_CONFIG_DIR
  else process.env.TAGENT_CONFIG_DIR = oldRoot
  rmSync(root, { force: true, recursive: true })
})

const assistant = (uuid: string, content: unknown[], parent: string | null = null) => ({
  type: 'assistant', uuid, session_id: 'native', parent_tool_use_id: parent, createdAt: 1,
  message: { id: `api-${uuid}`, role: 'assistant', model: 'fixture-model', stop_reason: null, content },
})

describe('Claude SDK → live/history contract', () => {
  it.each(['success', 'error_during_execution'])('%s preserves complete SDK messages even with null stop_reason', async (subtype) => {
    const source = [
      { type: 'stream_event', uuid: 'event-1', session_id: 'native', parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '检查入口' } } },
      assistant('thought', [{ type: 'thinking', thinking: '检查入口' }]),
      assistant('child', [{ type: 'text', text: 'child-only-result' }], 'task-child'),
      assistant('tool', [{ type: 'text', text: '正在检查。' }, { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'fixture.ts' } }]),
      { type: 'user', uuid: 'result-1', session_id: 'native', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'fixture content', is_error: false }] } },
      assistant('answer', [{ type: 'text', text: '结论：入口正常。' }]),
      { type: 'result', subtype, errors: subtype === 'success' ? [] : ['fixture service error'], usage: {} },
    ]
    mocks.query.mockImplementation(() => (async function* () { for (const m of source) yield m })())
    const adapter = new ClaudeAgentAdapter()
    const gate = createStreamPersistGateState()
    const persisted: unknown[] = []
    let live: TurnSourceItem[] = []
    let count = 0
    const controls: unknown[] = []
    try {
      for await (const raw of adapter.query({ sessionId: `replay-${subtype}`, prompt: 'fixture',
        sdkPermissionMode: 'default', allowDangerouslySkipPermissions: false, systemPrompt: 'fixture',
        apiConnection: { channelId: 'fixture', baseUrl: 'https://fixture.invalid', apiKey: 'fixture-only' } })) {
        const { message, event } = sdkMessageToIR(raw)
        if (message) {
          if (message.type === 'assistant') {
            expect(message._partial).not.toBe(true)
            expect(message._contentSnapshot).toBe(true)
            expect(message.stop_reason).toBeTruthy()
          }
          live = applySdkMessageToItems(live, message, () => `live-${count++}`)
          persisted.push(...feedStreamPersistGate(gate, raw))
        }
        if (event) controls.push(event)
        if (raw.type === 'result') persisted.push(...flushStreamPersistGate(gate))
      }
      const history: TurnSourceItem[] = persisted.map((raw, index) => ({ key: `history-${index}`,
        message: sdkMessageToIR(JSON.parse(JSON.stringify(raw)) as SDKMessage).message }))
      expect(live.every(item => !item.streaming)).toBe(true)
      expect(live.map(i => i.message)).toEqual(history.map(i => i.message))
      const present = (items: TurnSourceItem[]) => buildTurnPresentation({ kind: 'assistant-turn', key: 'turn', items, isStreaming: false }, { isLiveTurn: false, displayMode: 'full' })
      expect(present(live)).toEqual(present(history))
      expect(present(live).answerTexts.join('')).toContain('入口正常')
      expect(present(live).answerTexts.join('')).not.toContain('检查入口')
      expect(present(live).answerTexts.join('')).not.toContain('child-only-result')
      if (subtype !== 'success') expect(controls.at(-1)).toMatchObject({ errors: ['fixture service error'] })
      const final = live.at(-1)!.message!
      expect(applySdkMessageToItems(live, { ...final, _partial: true, stop_reason: undefined, content: [] } as typeof final, () => 'late')).toEqual(live)
    } finally { adapter.dispose() }
  })

  it.each(['completed', 'failed', 'stopped'])('child %s remains terminal after late started/progress', (status) => {
    let cards: TaskCardCarrier[] = []
    for (const raw of [
      { subtype: 'task_started', task_id: 'child', tool_use_id: 'task-tool', task_type: 'local_agent', description: 'fixture child' },
      { subtype: 'task_notification', task_id: 'child', tool_use_id: 'task-tool', status, summary: 'fixture outcome' },
      { subtype: 'task_started', task_id: 'child', tool_use_id: 'task-tool', task_type: 'local_agent', description: 'late' },
      { subtype: 'task_progress', task_id: 'child', tool_use_id: 'task-tool', last_tool_name: 'Read' },
    ]) {
      const { event } = sdkMessageToIR({ type: 'system', ...raw } as SDKMessage)
      expect(event?.kind).toBe('tagent_event')
      if (event?.kind === 'tagent_event') cards = reduceTaskEvent(cards, event.event as TaskCardEvent, (existing, card) => ({ ...existing, key: 'card', taskCard: card }))
    }
    expect(cards).toHaveLength(1)
    expect(cards[0]?.taskCard).toMatchObject({ status, summary: 'fixture outcome' })
  })
})
