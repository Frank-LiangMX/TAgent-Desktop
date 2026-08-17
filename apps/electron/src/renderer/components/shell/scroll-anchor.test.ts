import { describe, expect, test } from 'vitest'
import { isAwayFromBottom, pinScrollerToBottom } from './scroll-anchor'

describe('scroll-anchor', () => {
  test('距底超过阈值才算离开底部', () => {
    expect(isAwayFromBottom(0, 2000, 800, 70)).toBe(true)
    expect(isAwayFromBottom(1130, 2000, 800, 70)).toBe(false)
    expect(isAwayFromBottom(1200, 2000, 800, 70)).toBe(false)
  })

  test('内容不超过一页不算离开底部', () => {
    expect(isAwayFromBottom(0, 500, 800, 70)).toBe(false)
  })

  test('钉底写到 scrollHeight - clientHeight', () => {
    const el = { scrollTop: 0, scrollHeight: 2000, clientHeight: 800 }
    pinScrollerToBottom(el as HTMLElement)
    expect(el.scrollTop).toBe(1200)
  })
})
