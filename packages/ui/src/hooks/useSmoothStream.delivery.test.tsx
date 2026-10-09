import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSmoothStream } from './useSmoothStream'

let frames: Map<number, FrameRequestCallback>
let now: number
let nextId: number
let originalRaf: typeof requestAnimationFrame
let originalCancel: typeof cancelAnimationFrame

beforeEach(() => {
  frames = new Map()
  now = 0
  nextId = 0
  originalRaf = globalThis.requestAnimationFrame
  originalCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (cb) => {
    frames.set(++nextId, cb)
    return nextId
  }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
})

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf
  globalThis.cancelAnimationFrame = originalCancel
})

function advance(frameMs = 1000 / 60): void {
  act(() => {
    now += frameMs
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((cb) => cb(now))
  })
}

function mount() {
  return renderHook(
    ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
      useSmoothStream({ content, isStreaming }),
    { initialProps: { content: '', isStreaming: true } },
  )
}

describe('显示跟随模型实际输出速度', () => {
  test('快模型每帧收到的大块内容全部显示，不积压到后续帧', () => {
    const { result, rerender } = mount()
    for (let i = 1; i <= 10; i++) {
      const target = '字'.repeat(i * 1000)
      rerender({ content: target, isStreaming: true })
      advance()
      expect(result.current.displayedContent).toBe(target)
      expect(frames.size).toBe(0)
    }
  })

  test('慢模型有新字才更新，等待期间不安排空转或补播', () => {
    const { result, rerender } = mount()
    expect(frames.size).toBe(0)
    for (const target of ['你', '你好', '你好呀']) {
      rerender({ content: target, isStreaming: true })
      advance()
      expect(result.current.displayedContent).toBe(target)
      expect(frames.size).toBe(0)
      advance(1000)
      expect(result.current.displayedContent).toBe(target)
    }
  })

  test('同一帧内的多次推送合并显示最新全文', () => {
    const { result, rerender } = mount()
    for (let i = 1; i <= 100; i++) {
      rerender({ content: '字'.repeat(i * 100), isStreaming: true })
    }
    expect(result.current.displayedContent).toBe('')
    expect(frames.size).toBe(1)
    advance()
    expect(result.current.displayedContent).toBe('字'.repeat(10000))
    expect(frames.size).toBe(0)
  })

  test('结束信号与最后一块同帧到达，下帧显示全部，不额外补播', () => {
    const { result, rerender } = mount()
    rerender({ content: '已有正文', isStreaming: true })
    advance()
    const target = '已有正文' + '尾段'.repeat(500)
    rerender({ content: target, isStreaming: true })
    rerender({ content: target, isStreaming: false })
    expect(result.current.displayedContent).toBe('已有正文')
    advance()
    expect(result.current.displayedContent).toBe(target)
    expect(frames.size).toBe(0)
  })

  test.each([1000 / 60, 1000 / 120, 5000])('不同帧间隔 %sms 都在下一帧跟上最新内容', (frameMs) => {
    const { result, rerender } = mount()
    const target = '👩‍💻你好🌈'.repeat(1000)
    rerender({ content: target, isStreaming: true })
    advance(frameMs)
    expect(result.current.displayedContent).toBe(target)
    expect(frames.size).toBe(0)
  })
})
