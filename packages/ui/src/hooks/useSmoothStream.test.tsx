import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSmoothStream } from './useSmoothStream'

/** 模拟 rAF：所有回调同步推进时间，flush 队列到 displayedContent。
 *  不直接调 callback，而是把帧编号递增 + 显式 flush 触发；保证测试可重复。 */
let rafQueue: Array<{ cb: FrameRequestCallback; id: number }> = []
let rafNow = 0
let rafId = 0
let gRaf: typeof globalThis.requestAnimationFrame
let gCaf: typeof globalThis.cancelAnimationFrame

beforeEach(() => {
  rafQueue = []
  rafNow = 0
  rafId = 0
  gRaf = globalThis.requestAnimationFrame
  gCaf = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafId += 1
    rafQueue.push({ cb, id: rafId })
    return rafId
  }) as typeof globalThis.requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafQueue = rafQueue.filter((frame) => frame.id !== id)
  }) as typeof globalThis.cancelAnimationFrame
})

afterEach(() => {
  globalThis.requestAnimationFrame = gRaf
  globalThis.cancelAnimationFrame = gCaf
})

function flushFrames(count = 200): void {
  for (let i = 0; i < count; i++) {
    if (rafQueue.length === 0) return
    rafNow += 20
    const queue = rafQueue
    rafQueue = []
    for (const { cb } of queue) cb(rafNow)
  }
}

describe('useSmoothStream - 快照与回缩', () => {
  test('收到追加内容后下一帧完整显示', async () => {
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStream({ content, isStreaming }),
      { initialProps: { content: '你好', isStreaming: true } },
    )
    expect(result.current.displayedContent).toBe('你好')

    rerender({ content: '你好世界', isStreaming: true })
    await act(async () => {
      flushFrames(1)
    })
    expect(result.current.displayedContent).toBe('你好世界')
  })

  test('流式旧前缀快照不回退，后续快照仍下一帧更新', async () => {
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStream({ content, isStreaming }),
      { initialProps: { content: '', isStreaming: false } },
    )

    rerender({ content: 'abc def', isStreaming: true })
    await act(async () => {
      flushFrames(1)
    })
    expect(result.current.displayedContent).toBe('abc def')

    rerender({ content: 'abc d', isStreaming: true })
    await act(async () => {
      flushFrames(1)
    })
    expect(result.current.displayedContent).toBe('abc def')
    rerender({ content: 'abc def ghi', isStreaming: true })
    await act(async () => {
      flushFrames(1)
    })
    expect(result.current.displayedContent).toBe('abc def ghi')
  })

  test('真正的内容重置在下一帧使用新快照', async () => {
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStream({ content, isStreaming }),
      { initialProps: { content: 'abc', isStreaming: false } },
    )
    rerender({ content: 'xyz', isStreaming: false })
    await act(async () => {
      flushFrames(1)
    })
    expect(result.current.displayedContent).toBe('xyz')
  })
})
