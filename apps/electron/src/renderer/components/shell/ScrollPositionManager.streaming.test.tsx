// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ScrollPositionManager } from './ScrollPositionManager'

const context = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('use-stick-to-bottom', () => ({ useStickToBottomContext: () => context.value }))

let frames: Map<number, FrameRequestCallback>
let observers: Map<Element, ResizeObserverCallback>
let nextId: number
let roots: Root[]
let sessionSeq = 0

beforeEach(() => {
  frames = new Map()
  observers = new Map()
  nextId = 0
  roots = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++nextId, cb)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class {
    private targets: Element[] = []
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { observers.set(target, this.callback); this.targets.push(target) }
    disconnect() { this.targets.forEach((target) => observers.delete(target)) }
  })
})

afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()))
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function advance(count: number) {
  for (let i = 0; i < count; i++) {
    act(() => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((cb) => cb((i + 1) * 16))
    })
  }
}

function mount() {
  const scroller = document.createElement('div')
  const content = document.createElement('div')
  scroller.append(content)
  document.body.append(scroller)
  let height = 1000
  Object.defineProperty(scroller, 'scrollHeight', { get: () => height })
  Object.defineProperty(content, 'scrollHeight', { get: () => height })
  Object.defineProperty(scroller, 'clientHeight', { get: () => 500 })
  const scrollToBottom = vi.fn()
  context.value = {
    scrollRef: { current: scroller }, contentRef: { current: content },
    stopScroll: vi.fn(), scrollToBottom,
    state: { resizeObserver: { disconnect: vi.fn() } },
  }
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  act(() => root.render(<ScrollPositionManager id={`stream-${++sessionSeq}`} ready live />))
  advance(3)
  scrollToBottom.mockClear()
  function grow(pixels: number) {
    height += pixels
    act(() => observers.get(content)?.([], {} as ResizeObserver))
  }
  return { scroller, grow, scrollToBottom }
}

describe('live scroll follows visible output', () => {
  test('each new line reaches the viewport on the next frame without a 180ms wait', () => {
    const view = mount()
    expect(view.scroller.scrollTop).toBe(500)
    for (let i = 1; i <= 4; i++) {
      view.grow(24)
      advance(1)
      expect(view.scroller.scrollTop).toBe(500 + i * 24)
    }
    expect(view.scrollToBottom).not.toHaveBeenCalled()
  })

  test('multiple changes in a frame coalesce into one pin at the latest height', () => {
    const view = mount()
    view.grow(24)
    view.grow(24)
    advance(1)
    expect(view.scroller.scrollTop).toBe(548)
    expect(view.scrollToBottom).not.toHaveBeenCalled()
  })

  test('scrolling up before a pending frame cancels following', () => {
    const view = mount()
    view.grow(24)
    act(() => {
      view.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -80 }))
      view.scroller.scrollTop = 420
      view.scroller.dispatchEvent(new Event('scroll'))
    })
    advance(1)
    expect(view.scroller.scrollTop).toBe(420)
    view.grow(24)
    advance(1)
    expect(view.scroller.scrollTop).toBe(420)
  })
})
