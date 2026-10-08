// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@tagent/ui'
import { SessionErrorBanner } from './SessionErrorBanner'
import { sessionErrorMapAtom, setSessionErrorAtom } from '../../atoms/session-error-atoms'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
afterEach(() => { if (root) act(() => root.unmount()); container?.remove() })

describe('SessionErrorBanner recovery slot', () => {
  it('preserves errors when recovery starts and isolates dismiss to the current session', () => {
    const store = createStore()
    const error = { title: '连接中断', message: '自动重连已耗尽', retryable: true, at: 1 }
    store.set(setSessionErrorAtom, { sessionId: 'a', error })
    store.set(setSessionErrorAtom, { sessionId: 'b', error })
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    act(() => root.render(<Provider store={store}><TooltipProvider>
      <SessionErrorBanner sessionId="a" recovery={retryable => <button type="button">{retryable ? '继续' : '选其他渠道'}</button>} />
    </TooltipProvider></Provider>))
    act(() => [...container.querySelectorAll('button')].find(b => b.textContent === '继续')!.click())
    expect(store.get(sessionErrorMapAtom).a).toBe(error)
    expect(container.textContent).toContain('自动重连已耗尽')
    expect(container.textContent).not.toContain('重发上一条')
    act(() => (container.querySelector('[aria-label="关闭错误"]') as HTMLButtonElement).click())
    expect(store.get(sessionErrorMapAtom)).toEqual({ b: error })
    expect(container.textContent).toBe('')
  })
  it('does not expose recovery as a bypass for Chat mode tool restrictions', () => {
    const store = createStore()
    store.set(setSessionErrorAtom, { sessionId: 'a', error: { title: 'Chat 模式限制', message: '', retryable: false, code: 'chat_mode_blocked', at: 1 } })
    container = document.createElement('div'); root = createRoot(container)
    act(() => root.render(<Provider store={store}><TooltipProvider>
      <SessionErrorBanner sessionId="a" recovery={() => <button>不应显示的恢复</button>} />
    </TooltipProvider></Provider>))
    expect(container.textContent).not.toContain('不应显示的恢复')
  })
})
