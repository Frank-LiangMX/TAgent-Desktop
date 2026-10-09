// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ConciseTimelineView } from './ConciseTimelineView'
import { buildConciseTimeline, type ConciseSegment } from './concise-timeline-model'

// Keep the actual timeline and playback hook; replace only Markdown/layout primitives.
vi.mock('@tagent/ui', async () => {
  const { useSmoothStream } = await import('../../../../../../packages/ui/src/hooks/useSmoothStream')
  return {
    useSmoothStream,
    Message: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    MessageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    MessageResponse: ({ children, streaming }: { children: React.ReactNode; streaming?: boolean }) => (
      <span data-testid="body" data-streaming={streaming}>{children}</span>
    ),
    UserMessageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  vi.useRealTimers()
})

function render(element: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const rerender = (next: React.ReactNode) => act(() => root.render(next))
  rerender(element)
  return { container, rerender }
}

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

function segments(text: string, isLive: boolean, withThinking = false): ConciseSegment[] {
  return buildConciseTimeline([
    ...(withThinking ? [{ type: 'thinking' as const, key: 'think', thinking: '先检查问题并验证解决方案。' }] : []),
    { type: 'text', key: isLive ? 'stream-text' : 'committed-text', text },
  ], { isLive })
}

function displayed(container: HTMLElement): string {
  return [...container.querySelectorAll('.agent-concise-narrative [data-testid="body"]')]
    .map((node) => node.textContent).join('')
}

describe('concise playback across completion', () => {
  test.each([false, true])('progress → final preserves the prefix and displays the final snapshot next frame (thinking=%s)', (withThinking) => {
    const text = '正文'.repeat(120)
    const prefix = text.slice(0, 40)
    const view = render(<ConciseTimelineView segments={segments(prefix, true, withThinking)} isLive isLatestTurn />)
    advance(1)
    const before = displayed(view.container)
    expect(before).toBe(prefix)

    view.rerender(<ConciseTimelineView segments={segments(text, false, withThinking)} isLatestTurn />)
    expect(displayed(view.container)).toBe(before)
    expect(view.container.querySelector('.agent-concise-narrative--completion-enter')).toBeNull()
    expect(view.container.querySelector('.agent-concise-narrative--final [data-testid="body"]')?.getAttribute('data-streaming'))
      .toBe('true')
    advance(1)
    expect(displayed(view.container)).toBe(text)
    expect(view.container.querySelector('.agent-concise-narrative--final [data-testid="body"]')?.getAttribute('data-streaming'))
      .toBe('false')
  })

  test('a large final snapshot continues from the played prefix', () => {
    const prefix = '已有正文'.repeat(20)
    const text = prefix + '后续正文'.repeat(60)
    const view = render(<ConciseTimelineView segments={segments(prefix, true)} isLive isLatestTurn />)
    advance(1)
    const before = displayed(view.container)
    view.rerender(<ConciseTimelineView segments={segments(text, false)} isLatestTurn />)
    expect(displayed(view.container)).toBe(before)
    advance(1)
    expect(displayed(view.container)).toBe(text)
  })

  test('a large chunk during playback does not erase and replay the prefix', () => {
    const prefix = '已有正文'.repeat(20)
    const text = prefix + '后续正文'.repeat(60)
    const view = render(<ConciseTimelineView segments={segments(prefix, true)} isLive />)
    advance(1)
    const before = displayed(view.container)
    view.rerender(<ConciseTimelineView segments={segments(text, true)} isLive />)
    expect(displayed(view.container)).toBe(before)
    advance(1)
    expect(displayed(view.container)).toBe(text)
  })

  test('opening historical content displays it immediately', () => {
    const text = '历史回答'.repeat(100)
    const view = render(<ConciseTimelineView segments={segments(text, false)} />)
    expect(displayed(view.container)).toBe(text)
    expect(frames.size).toBe(0)
  })

  test('completion timers cannot replace a pending delivery frame', () => {
    vi.useFakeTimers()
    const text = '正文'.repeat(120)
    const view = render(<ConciseTimelineView segments={segments(text.slice(0, 40), true)} isLive />)
    advance(1)
    const before = displayed(view.container)
    view.rerender(<ConciseTimelineView segments={segments(text, false)} />)
    act(() => vi.advanceTimersByTime(400))
    expect(view.container.querySelector('.agent-concise-narrative--completion-enter')).toBeNull()
    expect(displayed(view.container)).toBe(before)
    advance(1)
    expect(displayed(view.container)).toBe(text)
  })

  test('a first answer arriving with completion appears next frame without replay', () => {
    const text = '一次性返回的回答'.repeat(30)
    const view = render(<ConciseTimelineView segments={[]} isLive />)
    view.rerender(<ConciseTimelineView segments={segments(text, false)} />)
    expect(displayed(view.container)).toBe('')
    advance(1)
    expect(displayed(view.container)).toBe(text)
  })

  test('completion keeps the latest process open; a new turn folds it without a height animation', () => {
    vi.useFakeTimers()
    const text = '正在输出的正文'.repeat(30)
    const view = render(<ConciseTimelineView segments={segments(text, true, true)} isLive isLatestTurn />)
    const head = view.container.querySelector('.agent-concise-run__head')!
    expect(head.getAttribute('aria-expanded')).toBe('true')
    advance(20)
    view.rerender(<ConciseTimelineView segments={segments(text, false, true)} isLatestTurn />)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    act(() => vi.advanceTimersByTime(400))
    expect(head.getAttribute('aria-expanded')).toBe('true')

    view.rerender(<ConciseTimelineView segments={segments(text, false, true)} />)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('.agent-concise-run__panel')?.classList.contains('is-instant')).toBe(true)
  })
})
