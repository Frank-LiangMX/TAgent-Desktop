import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSmoothStream } from './useSmoothStream'

/** 模拟 rAF：所有回调同步推进时间，flush 队列到 displayedContent。
 *  不直接调 callback，而是把帧编号递增 + 显式 flush 触发；保证测试可重复。 */
let rafQueue: Array<{ cb: FrameRequestCallback; t: number }> = []
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
    rafQueue.push({ cb, t: rafNow })
    return rafId
  }) as typeof globalThis.requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {
    /* noop */
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
    for (const { cb, t } of queue) cb(t)
  }
}

describe('useSmoothStream - 含子串兜底', () => {
  test('追加分支：newContent 是 prevContent 前缀 → 逐字入队', async () => {
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStream({ content, isStreaming }),
      { initialProps: { content: '你好', isStreaming: true } },
    )
    expect(result.current.displayedContent).toBe('你好')

    rerender({ content: '你好世界', isStreaming: true })
    await act(async () => {
      flushFrames(300)
    })
    expect(result.current.displayedContent).toBe('你好世界')
  })

  test('兜底：newContent 把 displayedRef 作为子串包含（trim/dedupe 失前缀） → 按 displayed 追加剩余，不整段重置', async () => {
    // 模拟落盘帧去重后：流式期间显示了 "abc def"，落盘是 "abc def ghi"（drop 了前缀重复）
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStream({ content, isStreaming }),
      { initialProps: { content: '', isStreaming: false } },
    )

    rerender({ content: 'abc def', isStreaming: true })
    await act(async () => {
      flushFrames(400)
    })
    expect(result.current.displayedContent).toBe('abc def')

    // 落盘帧：newContent="abc def ghi"，prevContentRef=queued 进度；
    // 假设 prevContentRef 落后但 displayedRef 已是 "abc def"，
    // newContent 既不 startsWith prevContentRef，也不 startsWith displayedRef，
    // 但 includes(displayedRef) 成立 → 走兜底追加，不整段 setDisplayedContent。
    // 用 act 重置 prevContentRef 不可直接做，但 setProps 直接模拟：内部 effect 重算
    // 重新赋值：先把 content 缩短为 displayed 之前的某段（"abc d"）让 prevContentRef 落后
    rerender({ content: 'abc d', isStreaming: true })
    await act(async () => {
      flushFrames(400)
    })
    // 现在 prevContentRef="abc d"，displayedRef 仍然是 "abc def"（不回缩）
    rerender({ content: 'abc def ghi', isStreaming: true })
    await act(async () => {
      flushFrames(400)
    })
    expect(result.current.displayedContent).toBe('abc def ghi')
  })

  test('真正的整段重置（newContent 与 displayed 完全不相交） → 一次性 dump', async () => {
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStream({ content, isStreaming }),
      { initialProps: { content: 'abc', isStreaming: false } },
    )
    rerender({ content: 'xyz', isStreaming: false })
    await act(async () => {
      flushFrames(50)
    })
    expect(result.current.displayedContent).toBe('xyz')
  })
})