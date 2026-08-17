/**
 * 跑完 / 过程折起时的滚动收口：
 * - 已上滑：按视口锚点留在原处，不要拽到底
 * - 一直贴底：瞬间钉在新底部，杀掉 StickToBottom 弹簧，避免再从头扫一遍
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import {
  isAwayFromBottom,
  pickViewportAnchor,
  pinScrollerToBottom,
  restoreViewportAnchor,
  type ViewportAnchor,
} from './scroll-anchor'

export function ReadingScrollGuard({ live = false }: { live?: boolean }): null {
  const { scrollRef, contentRef, stopScroll, scrollToBottom, state } = useStickToBottomContext()
  const prevHeightRef = useRef(0)
  const prevScrollTopRef = useRef(0)
  const anchorRef = useRef<ViewportAnchor | null>(null)
  const wasLiveRef = useRef(live)

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
    if (isAwayFromBottom(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight)) {
      stopScroll()
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

    const rememberReading = (): void => {
      prevScrollTopRef.current = scroller.scrollTop
      if (
        !isAwayFromBottom(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight)
      ) {
        return
      }
      const next = pickViewportAnchor(scroller)
      if (next) anchorRef.current = next
    }

    const onResize = (): void => {
      const nextHeight = content.scrollHeight
      const prevHeight = prevHeightRef.current
      const shrunk = prevHeight > 0 && nextHeight < prevHeight - 1
      const wasAway = isAwayFromBottom(
        prevScrollTopRef.current,
        prevHeight,
        scroller.clientHeight,
      )
      if (shrunk && wasAway) {
        stopScroll()
        restoreViewportAnchor(scroller, anchorRef.current)
      } else if (shrunk && !wasAway) {
        pinRef.current()
      }
      snapshotHeight()
      rememberReading()
      if (
        !isAwayFromBottom(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight)
      ) {
        anchorRef.current = null
      }
    }

    snapshotHeight()
    rememberReading()
    const observer = new ResizeObserver(onResize)
    observer.observe(content)
    scroller.addEventListener('scroll', rememberReading, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', rememberReading)
    }
  }, [scrollRef, contentRef, stopScroll])

  return null
}
