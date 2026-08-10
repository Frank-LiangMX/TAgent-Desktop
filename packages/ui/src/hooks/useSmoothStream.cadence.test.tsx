import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSmoothStream, resolveFlushDelay } from './useSmoothStream'

/** 模拟 rAF：flushFrames 推进 N 帧，每帧 +20ms，执行当前已排队回调。 */
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

function flushFrames(count = 400): void {
  for (let i = 0; i < count; i++) {
    if (rafQueue.length === 0) return
    rafNow += 20
    const queue = rafQueue
    rafQueue = []
    for (const { cb, t } of queue) cb(t)
  }
}

describe('D: resolveFlushDelay — size-aware cadence（render 次数受控的机制）', () => {
  test('小内容（≤ 8KB）用 minDelay（丝滑逐字，不降级）', () => {
    expect(resolveFlushDelay(0, 10)).toBe(10)
    expect(resolveFlushDelay(8192, 10)).toBe(10)
  })

  test('大内容按长度线性放宽 flush 间隔：每超 512 字符 +1ms', () => {
    expect(resolveFlushDelay(8192 + 512, 10)).toBe(11)
    expect(resolveFlushDelay(8192 + 512 * 10, 10)).toBe(20)
  })

  test('40K reasoning → cadence ~74ms（render 上限 ~13fps，明显实时且不逐帧）', () => {
    const d = resolveFlushDelay(40000, 10)
    expect(d).toBe(Math.min(80, 10 + Math.floor((40000 - 8192) / 512)))
    expect(d).toBeGreaterThan(20) // 远大于单帧 16ms → 不再逐帧 flush
  })

  test('上限 80ms（极大内容也 ~12.5fps，仍明显实时）', () => {
    expect(resolveFlushDelay(200000, 10)).toBe(80)
    expect(resolveFlushDelay(40000, 16)).toBeLessThanOrEqual(80)
  })
})

describe('D: useSmoothStream — cadence 不丢字、最终追上完整内容', () => {
  test('40K 大段 reasoning：节流 cadence 下仍完整追上（无丢字）', async () => {
    const big = 'x'.repeat(40000)
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStream({ content, isStreaming }),
      { initialProps: { content: '', isStreaming: false } },
    )
    rerender({ content: big, isStreaming: true })
    await act(async () => {
      flushFrames(2000)
    })
    expect(result.current.displayedContent).toBe(big)
  })

  test('小内容：cadence=minDelay，快速追上', async () => {
    const small = 'x'.repeat(200)
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStream({ content, isStreaming }),
      { initialProps: { content: '', isStreaming: false } },
    )
    rerender({ content: small, isStreaming: true })
    await act(async () => {
      flushFrames(100)
    })
    expect(result.current.displayedContent).toBe(small)
  })

  test('流式结束后 isStreaming=false：最终同步完整内容', async () => {
    const big = 'y'.repeat(40000)
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: { content: string; isStreaming: boolean }) =>
        useSmoothStream({ content, isStreaming }),
      { initialProps: { content: '', isStreaming: false } },
    )
    rerender({ content: big, isStreaming: true })
    await act(async () => {
      flushFrames(100)
    })
    // 中途未追上时切 idle：非流式 effect 同步最终内容
    rerender({ content: big, isStreaming: false })
    await act(async () => {
      flushFrames(50)
    })
    expect(result.current.displayedContent).toBe(big)
  })
})
