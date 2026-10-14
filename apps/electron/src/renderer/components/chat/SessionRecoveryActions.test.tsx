// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Channel } from '@tagent/shared'
import { createStore } from 'jotai'
import { clearRecoveredSessionErrorAtom, sessionErrorMapAtom, setSessionErrorAtom } from '../../atoms/session-error-atoms'
import { SessionRecoveryActions } from './SessionRecoveryActions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
afterEach(() => { if (root) act(() => root.unmount()); container?.remove() })
const current = { runtime: 'pi' as const, channelId: 'a', modelId: 'one' }
function channel(id: string, apiProtocol: Channel['apiProtocol']): Channel {
  return { id, name: id, provider: apiProtocol === 'anthropic-messages' ? 'anthropic' : 'openai', apiProtocol, baseUrl: '', apiKey: '', models: [{ id: 'one', name: 'one', enabled: true }], enabled: true, createdAt: 1, updatedAt: 1 }
}
const channels = [channel('a', 'openai-chat'), channel('b', 'openai-responses'), channel('c', 'anthropic-messages')]
function mount(overrides: Partial<React.ComponentProps<typeof SessionRecoveryActions>> = {}) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  const onRecover = vi.fn(async () => {})
  act(() => root.render(<SessionRecoveryActions current={current} channels={channels} disabled={false} retryable onRecover={onRecover} {...overrides} />))
  return onRecover
}
function button(text: string): HTMLButtonElement { return [...container.querySelectorAll('button')].find(b => b.textContent === text)! }
function change(label: string, value: string) {
  const select = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
  act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
describe('SessionRecoveryActions', () => {
  it('continues the current binding once even on rapid clicks', async () => {
    let done!: () => void
    const onRecover = vi.fn(() => new Promise<void>(resolve => { done = resolve }))
    mount({ onRecover })
    act(() => { button('继续当前模型').click(); button('继续当前模型').click() })
    expect(onRecover).toHaveBeenCalledTimes(1)
    expect(onRecover).toHaveBeenCalledWith(current)
    expect([...container.querySelectorAll('button')].every(b => b.disabled)).toBe(true)
    await act(async () => done())
  })
  it('selects another model without switching until explicit confirmation; cancel is read-only', async () => {
    const onRecover = mount()
    act(() => button('换模型继续').click())
    expect(container.querySelector('option[value=\'["a","one"]\']')).toBeNull()
    change('恢复渠道和模型', '["b","one"]')
    expect(onRecover).not.toHaveBeenCalled()
    act(() => button('取消').click())
    expect(onRecover).not.toHaveBeenCalled()
    act(() => button('换模型继续').click())
    change('恢复渠道和模型', '["b","one"]')
    await act(async () => button('确认并继续').click())
    expect(onRecover).toHaveBeenCalledTimes(1)
    expect(onRecover).toHaveBeenCalledWith({ runtime: 'pi', channelId: 'b', modelId: 'one' })
  })
  it('offers every HTTP protocol channel for the target runtime and discloses bounded handoff', async () => {
    const onRecover = mount({ current: { ...current, runtime: 'codex' } })
    act(() => button('转为 Pi 继续').click())
    expect(container.textContent).toContain('不是完整上下文迁移')
    const select = container.querySelector('select[aria-label="恢复渠道和模型"]')!
    // 官方内核在宿主边界适配三种 HTTP 协议（ADR-0012）：chat / responses / messages 均可选
    expect(select.textContent).toContain('a / one')
    expect(select.textContent).toContain('b / one')
    expect(select.textContent).toContain('c / one')
    expect(container.querySelector('select[aria-label="目标内核"]')?.textContent).toBe('Pi')
    change('恢复渠道和模型', '["c","one"]')
    await act(async () => button('确认并继续').click())
    expect(onRecover).toHaveBeenCalledTimes(1)
    expect(onRecover).toHaveBeenCalledWith({ runtime: 'pi', channelId: 'c', modelId: 'one' })
  })
  it('keeps failures visible and allows another attempt', async () => {
    mount({ onRecover: async () => { throw new Error('目标启动失败') } })
    await act(async () => button('继续当前模型').click())
    expect(container.querySelector('[role="status"]')?.textContent).toBe('目标启动失败')
    expect(button('继续当前模型').disabled).toBe(false)
  })
  it('allows channel repair for nonretryable auth errors, but not retrying unchanged model', () => {
    mount({ retryable: false })
    expect(button('继续当前模型')).toBeUndefined()
    expect(button('换模型继续').disabled).toBe(false)
  })
  it('disables all recovery while a turn is running', () => {
    const onRecover = mount({ disabled: true })
    act(() => button('继续当前模型').click())
    expect(onRecover).not.toHaveBeenCalled()
    expect([...container.querySelectorAll('button')].every(b => b.disabled)).toBe(true)
  })
  it('does not clear a newer stream error after send acceptance', () => {
    const store = createStore()
    const previous = { title: 'old', message: '', retryable: true, at: 1 }
    const newer = { ...previous, title: 'new', at: 2 }
    store.set(setSessionErrorAtom, { sessionId: 's', error: previous })
    store.set(setSessionErrorAtom, { sessionId: 's', error: newer })
    store.set(clearRecoveredSessionErrorAtom, { sessionId: 's', error: previous })
    expect(store.get(sessionErrorMapAtom).s).toBe(newer)
    store.set(clearRecoveredSessionErrorAtom, { sessionId: 's', error: newer })
    expect(store.get(sessionErrorMapAtom).s).toBeUndefined()
  })
  it('clearing recovered session A never clears session B after navigation', () => {
    const store = createStore()
    const error = { title: 'error', message: '', retryable: true, at: 1 }
    store.set(setSessionErrorAtom, { sessionId: 'a', error })
    store.set(setSessionErrorAtom, { sessionId: 'b', error })
    store.set(clearRecoveredSessionErrorAtom, { sessionId: 'a', error })
    expect(store.get(sessionErrorMapAtom)).toEqual({ b: error })
  })
  it('explains missing compatible channels instead of choosing an incompatible fallback', () => {
    // google 原生协议渠道：官方内核（codex / claude-code）无 HTTP 协议可适配 → 无候选
    const googleChannel: Channel = {
      ...channel('g', 'openai-chat'),
      provider: 'google',
      apiProtocol: undefined,
    }
    mount({ channels: [{ ...googleChannel, provider: 'codex-internal' }] })
    act(() => button('换模型继续').click())
    expect(container.textContent).toContain('没有可选模型')
    expect(button('确认并继续').disabled).toBe(true)
  })
  it('offers no runtime switch for Pi sessions', () => {
    mount({ codexAvailable: false })
    expect(button('换内核接力')).toBeUndefined()
    expect(button('转为 Pi 继续')).toBeUndefined()
  })
})
