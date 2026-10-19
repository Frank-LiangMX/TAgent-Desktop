// @vitest-environment jsdom
import React, { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStreamState } from './use-session-stream-state'
import {
  applyTextDelta, applyThinkingDeltaToState, clearSessionStreamState,
  commitStreamTextToLastAssistant, commitStreamThinkingToLastAssistant,
  type StreamItemLike,
} from './stream-item-model'

const cleanups: Array<() => void> = []
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()
})

function mount() {
  let stream!: ReturnType<typeof useSessionStreamState>
  function Harness() {
    stream = useSessionStreamState()
    return <div>{stream[0].text}|{stream[0].thinking}</div>
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<StrictMode><Harness /></StrictMode>))
  cleanups.push(() => { act(() => root.unmount()); container.remove() })
  return { get stream() { return stream }, container }
}

describe('stream ingestion does not wait for React to render', () => {
  it('text delta immediately followed by tool_start/result preserves the entire text', () => {
    const view = mount()
    let items: StreamItemLike[] = [{ key: 'a', message: { type: 'assistant', uuid: 'a', content: [] } }]
    act(() => {
      const [, set, ref] = view.stream
      set((previous) => applyTextDelta(previous, '正在检查'))
      set((previous) => applyTextDelta(previous, '文件。'))
      items = commitStreamTextToLastAssistant(items, ref.current.text)
      set(clearSessionStreamState())
    })
    expect(items[0]?.message?.content).toContainEqual({ type: 'text', text: '正在检查文件。' })
    expect(view.stream[0].text).toBe('')
  })

  it('a flushed thinking batch followed by completion cannot lose its last tokens', () => {
    const view = mount()
    let items: StreamItemLike[] = [{ key: 'a', message: { type: 'assistant', uuid: 'a', content: [] } }]
    act(() => {
      const [, set, ref] = view.stream
      set((previous) => applyThinkingDeltaToState(previous, '先检查，再验证。'))
      items = commitStreamThinkingToLastAssistant(items, ref.current.thinking)
      set(clearSessionStreamState())
    })
    expect(items[0]?.message?.content).toContainEqual({ type: 'thinking', thinking: '先检查，再验证。' })
  })

  it('reset then next segment in the same batch cannot resurrect old content', () => {
    const view = mount()
    act(() => view.stream[1]((previous) => applyTextDelta(previous, '旧阶段')))
    act(() => {
      const [, set, ref] = view.stream
      set(clearSessionStreamState())
      expect(ref.current.text).toBe('')
      set((previous) => applyTextDelta(previous, '新阶段'))
      expect(ref.current.text).toBe('新阶段')
    })
    expect(view.container.textContent).toBe('新阶段|')
  })
})
