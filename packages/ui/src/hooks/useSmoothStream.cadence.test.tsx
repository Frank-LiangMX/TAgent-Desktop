import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSmoothStream } from './useSmoothStream'

let frames: Map<number, FrameRequestCallback>
let nextId: number

beforeEach(() => {
  frames = new Map()
  nextId = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++nextId, cb)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})

afterEach(() => vi.unstubAllGlobals())

function frame(time: number) {
  act(() => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((cb) => cb(time))
  })
}

describe('帧合并不按正文长度或完成状态限速', () => {
  test('40K 正文和它的后续更新都在下一帧完整显示', () => {
    const view = renderHook(
      ({ content }) => useSmoothStream({ content, isStreaming: true }),
      { initialProps: { content: '' } },
    )
    const big = 'x'.repeat(40000)
    view.rerender({ content: big })
    frame(16)
    expect(view.result.current.displayedContent).toBe(big)
    view.rerender({ content: big + '新增正文' })
    frame(32)
    expect(view.result.current.displayedContent).toBe(big + '新增正文')
    expect(frames.size).toBe(0)
  })

  test('最终快照替换待显示内容，完成状态不取消它的绘制', () => {
    const view = renderHook(
      ({ content, isStreaming }) => useSmoothStream({ content, isStreaming }),
      { initialProps: { content: '', isStreaming: true } },
    )
    view.rerender({ content: '中间快照', isStreaming: true })
    view.rerender({ content: '最终快照'.repeat(10000), isStreaming: false })
    expect(frames.size).toBe(1)
    frame(16)
    expect(view.result.current.displayedContent).toBe('最终快照'.repeat(10000))
    expect(frames.size).toBe(0)
  })

  test('卸载取消待绘制任务', () => {
    const view = renderHook(
      ({ content }) => useSmoothStream({ content, isStreaming: true }),
      { initialProps: { content: '' } },
    )
    view.rerender({ content: '正文' })
    expect(frames.size).toBe(1)
    view.unmount()
    expect(frames.size).toBe(0)
  })

  test('StrictMode 下仍在一帧内跟上内容', () => {
    const view = renderHook(
      ({ content }) => useSmoothStream({ content, isStreaming: true }),
      { initialProps: { content: '' }, wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode> },
    )
    view.rerender({ content: '正文'.repeat(1000) })
    frame(16)
    expect(view.result.current.displayedContent).toBe('正文'.repeat(1000))
    expect(frames.size).toBe(0)
  })
})
