import { describe, expect, it } from 'vitest'
import { createStore } from 'jotai/vanilla'
import {
  receiveSessionReconnectAtom, sessionReconnectMapAtom, sessionRunMapAtom,
  softStopSessionRunAtom, startSessionRunAtom, stopSessionRunAtom,
} from './session-run-atoms'

const reconnect = (attempt = 1) => ({ type: 'model_reconnecting', attempt, maxAttempts: 5, delayMs: 1000 })

describe('model reconnect run state', () => {
  it('updates a single status without resetting elapsed time or permitting soft stop', () => {
    const store = createStore()
    store.set(startSessionRunAtom, { id: 'a', startedAt: 123 })
    store.set(softStopSessionRunAtom, 'a')
    store.set(receiveSessionReconnectAtom, { id: 'a', event: reconnect() })
    store.set(softStopSessionRunAtom, 'a')
    store.set(receiveSessionReconnectAtom, { id: 'a', event: reconnect(2) })
    expect(store.get(sessionRunMapAtom).a).toEqual({ running: true, startedAt: 123 })
    expect(store.get(sessionReconnectMapAtom)).toEqual({ a: { attempt: 2, maxAttempts: 5, delayMs: 1000 } })
  })

  it('recovery clears only the status, preserving the run and other sessions', () => {
    const store = createStore()
    for (const id of ['a', 'b']) {
      store.set(startSessionRunAtom, { id, startedAt: 123 })
      store.set(receiveSessionReconnectAtom, { id, event: reconnect() })
    }
    store.set(receiveSessionReconnectAtom, { id: 'a', event: { type: 'model_reconnect_cleared' } })
    expect(store.get(sessionReconnectMapAtom).a).toBeUndefined()
    expect(store.get(sessionReconnectMapAtom).b).toBeDefined()
    expect(store.get(sessionRunMapAtom).a?.running).toBe(true)
  })

  it('hard stop removes status and ignores late retry events', () => {
    const store = createStore()
    store.set(startSessionRunAtom, { id: 'a', startedAt: 123 })
    store.set(receiveSessionReconnectAtom, { id: 'a', event: reconnect() })
    store.set(stopSessionRunAtom, 'a')
    store.set(receiveSessionReconnectAtom, { id: 'a', event: reconnect(2) })
    expect(store.get(sessionReconnectMapAtom)).toEqual({})
    expect(store.get(sessionRunMapAtom).a).toEqual({ running: false, startedAt: null })
  })

  it('new explicit send clears previous retry status', () => {
    const store = createStore()
    store.set(startSessionRunAtom, { id: 'a', startedAt: 123 })
    store.set(receiveSessionReconnectAtom, { id: 'a', event: reconnect() })
    store.set(startSessionRunAtom, { id: 'a', startedAt: 456 })
    expect(store.get(sessionReconnectMapAtom)).toEqual({})
  })

  it.each([
    { attempt: 0 }, { attempt: 6 }, { attempt: '1' }, { attempt: 1.5 },
    { maxAttempts: Infinity }, { delayMs: -1 }, { delayMs: NaN },
  ])('ignores malformed wire data %j', (invalid) => {
    const store = createStore()
    store.set(startSessionRunAtom, { id: 'a', startedAt: 123 })
    store.set(receiveSessionReconnectAtom, { id: 'a', event: { ...reconnect(), ...invalid } })
    expect(store.get(sessionReconnectMapAtom)).toEqual({})
  })
})
