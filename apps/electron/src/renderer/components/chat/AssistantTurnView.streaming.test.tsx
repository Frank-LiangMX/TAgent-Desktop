// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createStore, Provider } from 'jotai'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AssistantTurnView } from './AssistantTurnView'
import { chatProcessDisplayModeAtom, type ChatProcessDisplayMode } from '../../atoms/chat-display-prefs'
import type { SessionRenderTurn } from './session-turn-model'

vi.mock('../../lib/model-logo', () => ({ getModelLogo: () => undefined }))

// Exercise both real turn renderers and their real playback queue.
vi.mock('@tagent/ui', async () => {
  const { useSmoothStream } = await import('../../../../../../packages/ui/src/hooks/useSmoothStream')
  return {
    useSmoothStream,
    AppTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Message: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    MessageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    MessageResponse: ({ children }: { children: React.ReactNode }) => <span data-testid="body">{children}</span>,
    UserMessageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    MessageLoading: () => <span>加载中</span>,
  }
})

let frames: Map<number, FrameRequestCallback>
let now: number
let nextId: number
let roots: Root[]

beforeEach(() => {
  frames = new Map()
  now = 0
  nextId = 0
  roots = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++nextId, cb)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})

afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()))
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function advance(count: number): void {
  for (let i = 0; i < count; i++) {
    act(() => {
      now += 1000 / 60
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((cb) => cb(now))
    })
  }
}

function mount(mode: ChatProcessDisplayMode, text = '', live = true) {
  const store = createStore()
  store.set(chatProcessDisplayModeAtom, mode)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const update = (text: string, live: boolean, endedBy: 'complete' | 'stopped' | 'error' = 'complete') => {
    const turn: Extract<SessionRenderTurn, { kind: 'assistant-turn' }> = {
      kind: 'assistant-turn', key: 'turn', isStreaming: live,
      items: [{ key: 'answer', streaming: live, message: {
        type: 'assistant', createdAt: 1000, content: [{ type: 'text', text }],
      } }],
    }
    act(() => root.render(<Provider store={store}><AssistantTurnView
      turn={turn} isLiveTurn={live} isLatestAssistantTurn
      completedDuration={live ? undefined : { ms: 1000, endedBy }} onOpenSubagent={() => {}}
    /></Provider>))
  }
  update(text, live)
  const displayed = () => [...container.querySelectorAll('[data-testid="body"]')].map((node) => node.textContent).join('')
  const outcome = () => container.querySelector('.agent-turn-outcome__label')?.textContent
  return { container, update, displayed, outcome }
}

describe.each(['concise', 'full'] as const)('%s completion follows playback', (mode) => {
  test('completion waits for the final delivery frame without a playback tail', () => {
    const text = '这是回答正文。'.repeat(40)
    const prefix = text.slice(0, 40)
    const view = mount(mode)
    view.update(prefix, true)
    advance(1)
    const before = view.displayed()
    expect(before).toBe(prefix)
    view.update(text, false)
    expect(view.displayed()).toBe(before)
    expect(view.outcome()).toBeUndefined()
    advance(1)
    expect(view.displayed()).toBe(text)
    expect(view.outcome()).toBe('完成')
    expect(view.container.querySelectorAll('.agent-turn-outcome')).toHaveLength(1)
  })

  test('a larger completed snapshot hides completion again until its tail is played', () => {
    const text = '这是回答正文。'.repeat(20)
    const view = mount(mode)
    view.update(text, false)
    advance(1)
    expect(view.outcome()).toBe('完成')
    const next = text + '最后补充。'.repeat(40)
    view.update(next, false)
    expect(view.outcome()).toBeUndefined()
    advance(1)
    expect(view.displayed()).toBe(next)
    expect(view.outcome()).toBe('完成')
  })

  test('historical answers show completion immediately', () => {
    const text = '历史正文'.repeat(40)
    const view = mount(mode, text, false)
    expect(view.displayed()).toBe(text)
    expect(view.outcome()).toBe('完成')
  })

  test.each(['stopped', 'error'] as const)('%s is reported immediately while remaining received text plays', (endedBy) => {
    const view = mount(mode)
    view.update('已经收到的正文'.repeat(40), true)
    advance(10)
    view.update('已经收到的正文'.repeat(40), false, endedBy)
    expect(view.outcome()).toBe(endedBy === 'stopped' ? '已中断' : '出错')
  })
})
