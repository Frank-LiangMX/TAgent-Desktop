/**
 * 会话滚动位置：同步钉底 / 中间位恢复 / 顶部补页补偿。
 *
 * use-stick-to-bottom 的 scrollToBottom('instant') 会等 rAF，
 * 首帧仍停在 scrollTop=0，超过一页的会话会闪一下旧内容。
 */

/** 距底小于该值视为「在底部」，不按中间位恢复 */
export const MID_SCROLL_THRESHOLD_PX = 5

export function hasSavedMidPosition(savedDistance: number | null | undefined): boolean {
  return savedDistance != null && savedDistance > MID_SCROLL_THRESHOLD_PX
}

/** 绘制前应写入的 scrollTop：有中间位则还原，否则钉底 */
export function targetScrollTop(
  scrollHeight: number,
  clientHeight: number,
  savedDistance?: number | null,
): number {
  if (hasSavedMidPosition(savedDistance)) {
    return Math.max(0, scrollHeight - clientHeight - savedDistance!)
  }
  return Math.max(0, scrollHeight - clientHeight)
}

/**
 * 内容从顶部长高（虚拟化往前补旧消息）时，把 scrollTop 顺延同一差值，
 * 视口里看到的内容不变。
 */
export function compensateScrollForHeightDelta(
  scrollTop: number,
  prevHeight: number,
  nextHeight: number,
): number {
  const delta = nextHeight - prevHeight
  if (delta <= 0) return scrollTop
  return scrollTop + delta
}
