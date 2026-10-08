// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { describe, expect, it } from 'vitest'
import { SessionReconnectStatus } from './SessionReconnectStatus'
import { receiveSessionReconnectAtom, startSessionRunAtom, stopSessionRunAtom } from '../../atoms/session-run-atoms'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SessionReconnectStatus', () => {
  it('shows one accessible status, updates attempts, survives remount, clears on stop', () => {
    const store = createStore()
    const container = document.createElement('div')
    const root = createRoot(container)
    const mount = (sessionId: string) => act(() => root.render(
      <Provider store={store}><SessionReconnectStatus key={sessionId} sessionId={sessionId} /></Provider>,
    ))
    try {
      mount('a')
      expect(container.textContent).toBe('')
      act(() => {
        store.set(startSessionRunAtom, { id: 'a', startedAt: 10 })
        store.set(receiveSessionReconnectAtom, { id: 'a', event: {
          type: 'model_reconnecting', attempt: 1, maxAttempts: 5, delayMs: 1000,
        } })
      })
      expect(container.textContent).toContain('正在重新连接 1/5')
      expect(container.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite')
      act(() => store.set(receiveSessionReconnectAtom, { id: 'a', event: {
        type: 'model_reconnecting', attempt: 2, maxAttempts: 5, delayMs: 2000,
      } }))
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
      expect(container.textContent).toContain('正在重新连接 2/5')
      mount('b')
      expect(container.textContent).toBe('')
      mount('a')
      expect(container.textContent).toContain('正在重新连接 2/5')
      act(() => store.set(stopSessionRunAtom, 'a'))
      expect(container.textContent).toBe('')
    } finally {
      act(() => root.unmount())
    }
  })
})
