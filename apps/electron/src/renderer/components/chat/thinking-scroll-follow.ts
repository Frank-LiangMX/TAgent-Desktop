/**
 * ThinkingFold 流式滚动跟随 — 纯函数（无 DOM / React 依赖，可单测）
 *
 * 规则：流式往 fold body 追加文字时，若用户停在底部（距底 ≤ 阈值）则 scrollTop 钉到
 * scrollHeight 跟随最新字；用户主动上滚离开底部 → 暂停跟随；回到底部恢复。
 * 对照：docs/dev/core-loop/REGRESS-D-thinking-fold-brief.md §A
 */

/** 距底阈值（px）：在此范围内视为「贴底」，可自动跟随。 */
export const STICK_THRESHOLD = 40

/**
 * 判断滚动容器是否停在底部（距底 ≤ threshold）。
 *
 * - 无可滚动内容（scrollHeight / clientHeight 非正）→ 视为贴底（钉底无副作用）。
 * - distance = scrollHeight - scrollTop - clientHeight；负值（内容短于视口）也算贴底。
 *
 * 用于流式追加时决定是否 `scrollTop = scrollHeight` 钉底跟随。
 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = STICK_THRESHOLD,
): boolean {
  if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) return true
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) return true
  const distance = scrollHeight - scrollTop - clientHeight
  return distance <= threshold
}
