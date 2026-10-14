import { describe, expect, it, vi } from 'vitest'
import { WpsTurnCompletion } from './wps-turn-completion'

describe('WPS report completion', () => {
  it('waits until native success, ignoring another session', async () => {
    const tracker = new WpsTurnCompletion()
    const run = tracker.wait('session')
    const finished = vi.fn()
    void run.promise.then(finished)
    tracker.settle('other', true)
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    tracker.settle('session', true)
    await run.promise
    expect(finished).toHaveBeenCalledTimes(1)
  })
  it('rejects errors and stops instead of recording a completed report', async () => {
    const tracker = new WpsTurnCompletion(), run = tracker.wait('session')
    tracker.settle('session', false)
    await expect(run.promise).rejects.toThrow('未标记完成')
    tracker.settle('session', true)
  })
  it('cleans up a timed-out waiter and allows a fresh run', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new WpsTurnCompletion(), run = tracker.wait('session', 100)
      await vi.advanceTimersByTimeAsync(100)
      await expect(run.promise).rejects.toThrow('超时')
      const retry = tracker.wait('session')
      tracker.settle('session', true)
      await retry.promise
    } finally { vi.useRealTimers() }
  })
})
