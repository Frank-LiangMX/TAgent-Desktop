/**
 * 跑完 / 过程折起时的滚动收口。
 *
 * 是否「在看历史」只认 StickToBottom 的 escapedFromLock（用户主动上滑）。
 * 不能用距底像素：流式贴底时弹簧会落后，距底很大，误判成上滑，
 * 跑完再按旧锚点一补，视口就会跳回上面。
 *
 * - 已上滑：按视口锚点留在原处
 * - 未上滑（含贴底跟随）：瞬间钉在新底部，杀掉弹簧，避免再扫一遍
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import {
  pickViewportAnchor,
  pinScrollerToBottom,
  restoreViewportAnchor,
  type ViewportAnchor,
} from './scroll-anchor'

export function ReadingScrollGuard({ live = false }: { live?: boolean }): null {
  const {
    scrollRef,
    contentRef,
    stopScroll,
    scrollToBottom,
    escapedFromLock,
    state,
  } = useStickToBottomContext()
  const prevHeightRef = useRef(0)
  const anchorRef = useRef<ViewportAnchor | null>(null)
  const wasLiveRef = useRef(live)
  const escapedRef = useRef(escapedFromLock)
  escapedRef.current = escapedFromLock

  const pinRef = useRef((): void => {})
  pinRef.current = (): void => {
    const scroller = scrollRef.current
    if (!scroller) return
    if (state) {
      state.animation = undefined
      state.velocity = 0
      state.accumulated = 0
    }
    pinScrollerToBottom(scroller)
    void scrollToBottom('instant')
  }

  useLayoutEffect(() => {
    const wasLive = wasLiveRef.current
    wasLiveRef.current = live
    if (!wasLive || live) return
    const scroller = scrollRef.current
    if (!scroller) return
    if (escapedRef.current) {
      stopScroll()
      restoreViewportAnchor(scroller, anchorRef.current)
      return
    }
    pinRef.current()
  }, [live, scrollRef, stopScroll])

  useEffect(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content) return

    const snapshotHeight = (): void => {
      prevHeightRef.current = content.scrollHeight
    }

    const rememberAnchor = (): void => {
      if (!escapedRef.current) {
        anchorRef.current = null
        return
      }
      const next = pickViewportAnchor(scroller)
      if (next) anchorRef.current = next
    }

    const onResize = (): void => {
      const nextHeight = content.scrollHeight
      const prevHeight = prevHeightRef.current
      const shrunk = prevHeight > 0 && nextHeight < prevHeight - 1
      if (shrunk) {
        if (escapedRef.current) {
          stopScroll()
          restoreViewportAnchor(scroller, anchorRef.current)
        } else {
          pinRef.current()
        }
      }
      snapshotHeight()
      rememberAnchor()
    }

    snapshotHeight()
    rememberAnchor()
    const observer = new ResizeObserver(onResize)
    observer.observe(content)
    scroller.addEventListener('scroll', rememberAnchor, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', rememberAnchor)
    }
  }, [scrollRef, contentRef, stopScroll])

  return null
}
