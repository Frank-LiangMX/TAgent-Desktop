import React, { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSmoothStream } from './useSmoothStream'

let frames: Map<number, FrameRequestCallback>
let now: number
let nextId: number

beforeEach(() => {
  frames = new Map()
  now = 0
  nextId = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++nextId, cb)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => vi.unstubAllGlobals())

function advance(count: number, frameMs = 1000 / 60): void {
  for (let i = 0; i < count; i++) {
    act(() => {
      now += frameMs
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((cb) => cb(now))
    })
  }
}

describe('useSmoothStream progressive delivery', () => {
  test('a live first chunk starts progressively; history is immediately readable', () => {
    const text = '回答正文'.repeat(60)
    const live = renderHook(() => useSmoothStream({ content: text, isStreaming: true }))
    expect(live.result.current.displayedContent).toBe('')
    advance(1)
    expect(live.result.current.displayedContent.length).toBeGreaterThan(0)
    expect(live.result.current.displayedContent.length).toBeLessThan(text.length / 10)
    const history = renderHook(() => useSmoothStream({ content: text, isStreaming: false }))
    expect(history.result.current.displayedContent).toBe(text)
  })

  test('a large batch advances at a steady rate and catches up within a second', () => {
    const text = '字'.repeat(600)
    const { result, rerender } = renderHook(useSmoothStream, { initialProps: { content: '', isStreaming: true } })
    rerender({ content: text, isStreaming: true })
    const steps: number[] = []
    for (let i = 0; i < 20; i++) {
      const before = result.current.displayedContent.length
      advance(1)
      steps.push(result.current.displayedContent.length - before)
    }
    expect(Math.min(...steps)).toBeGreaterThan(0)
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThanOrEqual(1)
    expect(result.current.displayedContent.length).toBeLessThan(text.length)
    advance(40)
    expect(result.current.displayedContent).toBe(text)
    expect(frames.size).toBe(0)
  })

  test('completion drains the tail instead of dumping the final snapshot', () => {
    const prefix = '前文'.repeat(40)
    const text = prefix + '后续'.repeat(100)
    const { result, rerender } = renderHook(useSmoothStream, { initialProps: { content: prefix, isStreaming: true } })
    advance(10)
    const before = result.current.displayedContent
    rerender({ content: text, isStreaming: false })
    expect(result.current.displayedContent).toBe(before)
    advance(1)
    expect(result.current.displayedContent.startsWith(before)).toBe(true)
    expect(result.current.displayedContent.length).toBeLessThan(text.length)
    advance(60)
    expect(result.current.displayedContent).toBe(text)
  })

  test('another batch never erases or replays the displayed prefix', () => {
    const prefix = '已有正文'.repeat(80)
    const text = prefix + '补充'.repeat(500)
    const { result, rerender } = renderHook(useSmoothStream, { initialProps: { content: prefix, isStreaming: true } })
    advance(12)
    let previous = result.current.displayedContent
    rerender({ content: text, isStreaming: true })
    for (let i = 0; i < 60; i++) {
      advance(1)
      expect(result.current.displayedContent.startsWith(previous)).toBe(true)
      previous = result.current.displayedContent
    }
    expect(previous).toBe(text)
  })

  test('an old streaming prefix is ignored; the same prefix is accepted when authoritative', () => {
    const { result, rerender } = renderHook(useSmoothStream, { initialProps: { content: '完整文字', isStreaming: true } })
    advance(60)
    rerender({ content: '完整', isStreaming: true })
    advance(1)
    expect(result.current.displayedContent).toBe('完整文字')
    rerender({ content: '完整', isStreaming: false })
    advance(1)
    expect(result.current.displayedContent).toBe('完整')
  })

  test('replacement and clearing cancel any obsolete tail', () => {
    const { result, rerender } = renderHook(useSmoothStream, { initialProps: { content: '旧文字'.repeat(300), isStreaming: true } })
    advance(5)
    rerender({ content: '新回答', isStreaming: false })
    advance(1)
    expect(result.current.displayedContent).toBe('新回答')
    advance(60)
    expect(result.current.displayedContent).toBe('新回答')
    rerender({ content: '', isStreaming: false })
    advance(1)
    expect(result.current.displayedContent).toBe('')
    expect(frames.size).toBe(0)
  })

  test('emoji and combining characters are revealed as whole graphemes', () => {
    const text = '中👨‍👩‍👧‍👦e\u0301🇨🇳'.repeat(20)
    const allowed = new Set([''])
    for (const { index, segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      allowed.add(text.slice(0, index + segment.length))
    }
    const { result } = renderHook(() => useSmoothStream({ content: text, isStreaming: true }))
    for (let i = 0; i < 60; i++) {
      advance(1)
      expect(allowed.has(result.current.displayedContent)).toBe(true)
    }
    expect(result.current.displayedContent).toBe(text)
  })

  test('StrictMode resumes the queue and unmount cancels its frame', () => {
    const { result, unmount } = renderHook(() => useSmoothStream({ content: '正文'.repeat(300), isStreaming: true }), {
      wrapper: ({ children }) => React.createElement(StrictMode, null, children),
    })
    advance(1)
    expect(result.current.displayedContent.length).toBeGreaterThan(0)
    expect(frames.size).toBe(1)
    unmount()
    expect(frames.size).toBe(0)
  })

  test('reduced motion bypasses progressive playback', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const text = '直接显示'.repeat(100)
    const { result } = renderHook(() => useSmoothStream({ content: text, isStreaming: true }))
    advance(1)
    expect(result.current.displayedContent).toBe(text)
    expect(frames.size).toBe(0)
  })

  test('a remounted row keeps its visible prefix and only animates the remaining suffix', () => {
    const prefix = '已经显示的内容。'
    const text = prefix + '待显示正文。'.repeat(80)
    const { result } = renderHook(() => useSmoothStream({
      content: text, isStreaming: false, initialContent: prefix,
    }))
    expect(result.current.displayedContent).toBe(prefix)
    advance(1)
    expect(result.current.displayedContent.startsWith(prefix)).toBe(true)
    expect(result.current.displayedContent.length).toBeLessThan(text.length)
    advance(60)
    expect(result.current.displayedContent).toBe(text)
  })

  test('the playback pace is based on elapsed time, not display refresh rate', () => {
    const text = '正文'.repeat(300)
    const slow = renderHook(() => useSmoothStream({ content: text, isStreaming: true }))
    advance(18, 1000 / 60)
    const at60Hz = slow.result.current.displayedContent.length
    slow.unmount()
    const fast = renderHook(() => useSmoothStream({ content: text, isStreaming: true }))
    advance(36, 1000 / 120)
    const at120Hz = fast.result.current.displayedContent.length
    expect(Math.abs(at60Hz - at120Hz)).toBeLessThan(10)
    expect(at120Hz).toBeLessThan(text.length)
  })

  test('50ms upstream batches become smaller visible steps between batches', () => {
    const { result, rerender } = renderHook(useSmoothStream, { initialProps: { content: '', isStreaming: true } })
    let previous = ''
    let progressedFrames = 0
    let received = ''
    for (let batch = 1; batch <= 20; batch++) {
      received += '一批返回的文字内容。'
      rerender({ content: received, isStreaming: true })
      for (let frame = 0; frame < 3; frame++) {
        advance(1)
        const shown = result.current.displayedContent
        expect(shown.startsWith(previous)).toBe(true)
        expect(received.startsWith(shown)).toBe(true)
        if (shown.length > previous.length) progressedFrames++
        previous = shown
      }
    }
    expect(progressedFrames).toBeGreaterThan(50)
    rerender({ content: received, isStreaming: false })
    advance(60)
    expect(result.current.displayedContent).toBe(received)
    expect(frames.size).toBe(0)
  })
})
