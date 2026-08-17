/**
 * 离开底部阅读时，内容高度变化（过程折起）不要把视口拽到底。
 * 用视口顶部碰到的消息当锚点，折完后把该元素拉回原来的屏幕位置。
 */

export const READING_AWAY_THRESHOLD_PX = 70

const ANCHOR_SELECTOR = '[data-message-id]'

export type ViewportAnchor = {
  selector: string
  offset: number
}

export function isAwayFromBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = READING_AWAY_THRESHOLD_PX,
): boolean {
  if (!Number.isFinite(scrollHeight) || scrollHeight <= 0) return false
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) return false
  return scrollHeight - scrollTop - clientHeight > threshold
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

export function pickViewportAnchor(scroller: HTMLElement): ViewportAnchor | null {
  const frame = scroller.getBoundingClientRect()
  const nodes = scroller.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    if (rect.bottom <= frame.top + 4) continue
    if (rect.top >= frame.bottom) continue
    const id = node.getAttribute('data-message-id')
    if (!id) continue
    return {
      selector: `[data-message-id="${cssEscape(id)}"]`,
      offset: rect.top - frame.top,
    }
  }
  return null
}

/** 绘制前钉在当前底部，不走弹簧。 */
export function pinScrollerToBottom(scroller: HTMLElement): void {
  scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
}

export function restoreViewportAnchor(
  scroller: HTMLElement,
  anchor: ViewportAnchor | null,
): boolean {
  if (!anchor) return false
  const target = scroller.querySelector<HTMLElement>(anchor.selector)
  if (!target) return false
  const frame = scroller.getBoundingClientRect()
  const rect = target.getBoundingClientRect()
  const delta = rect.top - frame.top - anchor.offset
  if (!Number.isFinite(delta) || Math.abs(delta) < 1) return false
  scroller.scrollTop += delta
  return true
}
