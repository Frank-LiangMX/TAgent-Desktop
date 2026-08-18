import { describe, expect, test } from 'vitest'
import {
  compensateScrollForHeightDelta,
  hasSavedMidPosition,
  shouldRepinScrollerToBottom,
  targetScrollTop,
} from './scroll-position'

describe('scroll-position', () => {
  test('距底 ≤5px 不算中间位，应钉底', () => {
    expect(hasSavedMidPosition(undefined)).toBe(false)
    expect(hasSavedMidPosition(null)).toBe(false)
    expect(hasSavedMidPosition(0)).toBe(false)
    expect(hasSavedMidPosition(5)).toBe(false)
    expect(hasSavedMidPosition(6)).toBe(true)
  })

  test('无保存位置时钉在最后一页', () => {
    expect(targetScrollTop(2000, 800)).toBe(1200)
    expect(targetScrollTop(500, 800)).toBe(0)
  })

  test('有中间位时按距底还原', () => {
    expect(targetScrollTop(2000, 800, 400)).toBe(800)
  })

  test('顶部补页：scrollTop 加上新增高度', () => {
    expect(compensateScrollForHeightDelta(1200, 2000, 2800)).toBe(2000)
  })

  test('高度未增或缩短时不改 scrollTop', () => {
    expect(compensateScrollForHeightDelta(1200, 2000, 2000)).toBe(1200)
    expect(compensateScrollForHeightDelta(1200, 2000, 1600)).toBe(1200)
  })

  test('scroller RO：只在尚未揭开且明显不在底时再钉', () => {
    expect(
      shouldRepinScrollerToBottom({
        restored: true,
        settled: false,
        hasMidPosition: false,
        distanceFromBottom: 80,
      }),
    ).toBe(true)
    expect(
      shouldRepinScrollerToBottom({
        restored: true,
        settled: false,
        hasMidPosition: false,
        distanceFromBottom: 1,
      }),
    ).toBe(false)
    expect(
      shouldRepinScrollerToBottom({
        restored: true,
        settled: true,
        hasMidPosition: false,
        distanceFromBottom: 8,
      }),
    ).toBe(false)
    expect(
      shouldRepinScrollerToBottom({
        restored: false,
        settled: false,
        hasMidPosition: false,
        distanceFromBottom: 80,
      }),
    ).toBe(false)
    expect(
      shouldRepinScrollerToBottom({
        restored: true,
        settled: false,
        hasMidPosition: true,
        distanceFromBottom: 80,
      }),
    ).toBe(false)
  })
})
