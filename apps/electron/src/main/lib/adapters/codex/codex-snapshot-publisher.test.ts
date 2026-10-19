import { afterEach, expect, it, vi } from 'vitest'
import type { TAgentDesktopStreamPayload } from '@tagent/shared'
import { CodexSnapshotPublisher } from './codex-snapshot-publisher'

afterEach(() => vi.useRealTimers())
function partial(uuid: string, text: string): TAgentDesktopStreamPayload {
  return { kind: 'sdk_message', message: { type: 'assistant', uuid, _partial: true, _contentSnapshot: true, content: [{ type: 'text', text }] } }
}
it('coalesces a token burst without losing interleaved item identity or order', () => {
  vi.useFakeTimers()
  const emit = vi.fn()
  const publisher = new CodexSnapshotPublisher(emit)
  for (let n = 1; n <= 100; n++) publisher.publish(partial('a', 'x'.repeat(n)))
  publisher.publish(partial('b', 'second'))
  publisher.publish(partial('a', 'complete burst'))
  expect(emit).not.toHaveBeenCalled()
  vi.advanceTimersByTime(50)
  expect(emit.mock.calls.map(([p]) => p)).toEqual([partial('a', 'complete burst'), partial('b', 'second')])
  publisher.dispose()
})
it('flushes pending content before a terminal event without waiting for the timer', () => {
  vi.useFakeTimers()
  const emit = vi.fn()
  const publisher = new CodexSnapshotPublisher(emit)
  publisher.publish(partial('a', 'received text'))
  publisher.publish({ kind: 'result', subtype: 'interrupted' })
  vi.advanceTimersByTime(100)
  expect(emit.mock.calls.map(([p]) => p)).toEqual([partial('a', 'received text'), { kind: 'result', subtype: 'interrupted' }])
  publisher.dispose()
})
it('does not emit a delayed snapshot after disposal', () => {
  vi.useFakeTimers()
  const emit = vi.fn()
  const publisher = new CodexSnapshotPublisher(emit)
  publisher.publish(partial('a', 'pending'))
  publisher.dispose()
  vi.advanceTimersByTime(100)
  publisher.publish(partial('a', 'late'))
  expect(emit).not.toHaveBeenCalled()
})
