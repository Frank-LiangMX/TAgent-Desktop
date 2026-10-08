import { describe, expect, it } from 'vitest'
import { extractAssistantText, runTurn, validateInput } from './official-runtime-live-worker'

const marker = 'test-exact-marker'
function adapter(events: Record<string, unknown>[]) {
  return { async *query() { yield* events }, abort() {}, dispose() {} }
}
const turn = (events: Record<string, unknown>[]) => runTurn(adapter(events), { sessionId: 'fixture' }, marker, Date.now() + 1000)
const success = { kind: 'result', subtype: 'completed' }

describe('live acceptance must not produce false-positive recall', () => {
  it('joins assistant deltas and requires both exact codes plus a successful terminal', async () => {
    expect(await turn([
      { kind: 'stream_text_delta', text: 'test-exact-' },
      { kind: 'stream_text_delta', text: 'marker NO_' },
      { kind: 'stream_text_delta', text: 'WRITE' }, success,
    ])).toMatchObject({ markerSeen: true, resultSeen: true })
  })
  it('does not count user prompt echo as assistant recall', async () => {
    expect(await turn([{ kind: 'sdk_message', message: { type: 'user', content: [{ type: 'text', text: `${marker} NO_WRITE` }] } }, success]))
      .toMatchObject({ markerSeen: false, resultSeen: true })
  })
  it('requires the exact random code, not a similarly shaped one', async () => {
    expect(await turn([{ kind: 'stream_text_delta', text: 'test-other-marker NO_WRITE' }, success])).toMatchObject({ markerSeen: false })
  })
  it('does not accept content without a terminal', async () => {
    expect(await turn([{ kind: 'stream_text_delta', text: `${marker} NO_WRITE` }])).toMatchObject({ markerSeen: true, resultSeen: false })
  })
  it.each([
    { ...success, subtype: 'interrupted' },
    { ...success, is_error: true },
    { ...success, isError: true },
    { ...success, error: { message: 'fixture error' } },
    { ...success, errors: ['fixture error'] },
  ])('rejects a failed terminal even if text looks correct', async terminal => {
    await expect(turn([{ kind: 'stream_text_delta', text: `${marker} NO_WRITE` }, terminal])).rejects.toThrow('non-success')
  })
  it('reads official SDK assistant content but not reasoning', () => {
    expect(extractAssistantText({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: marker }, { type: 'text', text: 'answer' }] } })).toBe('answer')
  })
  it('rejects a real-user directory even when all connection fields are present', () => {
    expect(() => validateInput({ runtime: 'codex', model: 'fixture', connection: { channelId: 'test', baseUrl: 'http://127.0.0.1', apiKey: 'fake' }, configRoot: 'F:/TAgent-Desktop', cwd: 'F:/TAgent-Desktop' })).toThrow('isolated')
  })
})
