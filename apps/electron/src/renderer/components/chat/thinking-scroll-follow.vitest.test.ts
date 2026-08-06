/**
 * REGRESS-D §A 回归（Vitest）— ThinkingFold 流式「距底跟随」纯函数
 *
 * 规格：docs/dev/core-loop/REGRESS-D-thinking-fold-brief.md §A
 * 对照：docs/dev/core-loop/REGRESS-D-FINDINGS.md
 *
 * isNearBottom 决定流式追加时是否把 scrollTop 钉到 scrollHeight：
 *  - 距底 ≤ 阈值 → 贴底，跟随最新字；
 *  - 用户上滚离开底部（距底 > 阈值）→ 暂停跟随，回到底部恢复。
 */
import { describe, expect, it } from 'vitest'
import { isNearBottom, STICK_THRESHOLD } from './thinking-scroll-follow'

describe('isNearBottom（流式距底跟随）', () => {
  it('贴底（distance ≤ 阈值）→ true，可跟随', () => {
    // scrollHeight 400 / clientHeight 300 / scrollTop 100 → 距底 0
    expect(isNearBottom(100, 400, 300)).toBe(true)
    // 距底 20px（< 40）→ 仍贴底
    expect(isNearBottom(80, 400, 300)).toBe(true)
    // 距底正好 40px（= 阈值）→ 贴底（含等号）
    expect(isNearBottom(60, 400, 300)).toBe(true)
  })

  it('用户上滚离开底部（distance > 阈值）→ false，暂停跟随', () => {
    // 距底 100px
    expect(isNearBottom(0, 400, 300)).toBe(false)
    // 距底 61px（> 40）
    expect(isNearBottom(39, 400, 300)).toBe(false)
  })

  it('内容未超可视区（无可滚动 / 负距底）→ 视为贴底', () => {
    // scrollHeight < clientHeight → 距底为负
    expect(isNearBottom(0, 200, 300)).toBe(true)
    // scrollHeight 为 0
    expect(isNearBottom(0, 0, 300)).toBe(true)
    // clientHeight 非正 → 视为贴底（钉底无副作用）
    expect(isNearBottom(0, 400, 0)).toBe(true)
  })

  it('自定义阈值生效', () => {
    // 距底 50px：阈值 60 → 贴底；阈值 40 → 不贴底
    expect(isNearBottom(50, 400, 300, 60)).toBe(true)
    expect(isNearBottom(50, 400, 300, 40)).toBe(false)
  })

  it('默认阈值 = 40', () => {
    expect(STICK_THRESHOLD).toBe(40)
  })
})
