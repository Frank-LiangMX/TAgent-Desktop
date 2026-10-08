// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { getDefaultStore } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGlobalSessionRunSync } from './useGlobalSessionRunSync'
import {
  sessionReconnectMapAtom, sessionRunMapAtom, startSessionRunAtom, stopSessionRunAtom,
} from '../atoms/session-run-atoms'

vi.mock('../atoms/notification-prefs', () => ({ getNotificationPrefsSnapshot: () => ({ titlebarTicker: false }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const store = getDefaultStore()
afterEach(() => {
  store.set(stopSessionRunAtom, 'reconnect-wire')
  vi.unstubAllGlobals()
})

describe('global reconnect IPC subscription', () => {
  it.each(['result', 'session_error', 'model_reconnect_cleared'])('processes reconnect and clears on %s without a mounted Chat', (terminal) => {
    let listener!: (packet: unknown) => void
    const off = vi.fn()
    vi.stubGlobal('electronAPI', {
      onStreamEvent: (callback: typeof listener) => { listener = callback; return off },
    })
    function Probe() { useGlobalSessionRunSync(); return null }
    const root = createRoot(document.createElement('div'))
    try {
      act(() => root.render(<Probe />))
      act(() => store.set(startSessionRunAtom, { id: 'reconnect-wire', startedAt: 123 }))
      act(() => listener({ sessionId: 'reconnect-wire', payload: {
        kind: 'tagent_event', event: { type: 'model_reconnecting', attempt: 1, maxAttempts: 5, delayMs: 1000 },
      } }))
      expect(store.get(sessionReconnectMapAtom)['reconnect-wire']?.attempt).toBe(1)
      expect(store.get(sessionRunMapAtom)['reconnect-wire']).toEqual({ running: true, startedAt: 123 })
      act(() => listener({ sessionId: 'reconnect-wire', payload: terminal === 'result'
        ? { kind: 'result', subtype: 'success' }
        : { kind: 'tagent_event', event: { type: terminal } },
      }))
      expect(store.get(sessionReconnectMapAtom)['reconnect-wire']).toBeUndefined()
      expect(store.get(sessionRunMapAtom)['reconnect-wire']?.running).toBe(terminal === 'model_reconnect_cleared')
    } finally { act(() => root.unmount()) }
    expect(off).toHaveBeenCalledTimes(1)
  })
})
