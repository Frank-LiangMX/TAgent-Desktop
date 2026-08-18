/**
 * ScrollPositionManager — 切换会话时保存/恢复滚动位置
 *
 * 解决 StickToBottom 的 spring 动画导致的可见滚动过程 + 强行滚底打断查历史。
 *
 * 原理：
 * - scroll 事件持续保存 distanceFromBottom 到模块级 Map（仅恢复后才开始记，防初始化污染）
 * - useLayoutEffect（绘制前）直接设 scrollTop，不走 scrollToBottom('instant')
 *   （后者内部 requestAnimationFrame，首帧会停在顶部，超过一页就闪）
 * - 有保存的中间位 → 等 restoreReady（虚拟化全挂完）再还原
 * - 无保存 / 本就在底部 → ready 即可钉底，不等全挂
 * - 虚拟化往前补页时按 scrollHeight 差值补偿 scrollTop，避免视口被顶上去
 *
 * 必须放在 <Conversation>（StickToBottom）内部使用。
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import {
  compensateScrollForHeightDelta,
  hasSavedMidPosition,
  shouldRepinScrollerToBottom,
  targetScrollTop,
} from './scroll-position'

/** 模块级缓存：会话 ID → 距底部像素距离 */
const scrollPositionCache = new Map<string, number>()

export function ScrollPositionManager({
  id,
  ready,
  restoreReady = true,
  layoutKey = 0,
  onSettled,
}: {
  id: string
  ready: boolean
  /** 中间位恢复要等内容全挂完；钉底只等 ready */
  restoreReady?: boolean
  /** 虚拟化可见条数变化时触发顶部补页补偿 */
  layoutKey?: number
  /** 首次钉底/还原并再吃两帧布局后回调。供打开会话时等钉住再淡入，避免先露出顶部再跳底。 */
  onSettled?: () => void
}): null {
  const { scrollRef, stopScroll, scrollToBottom } = useStickToBottomContext()
  const restoredRef = useRef(false)
  const settledRef = useRef(false)
  const prevIdRef = useRef(id)
  const prevScrollHeightRef = useRef<number | null>(null)
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled
  const scrollToBottomRef = useRef(scrollToBottom)
  scrollToBottomRef.current = scrollToBottom

  // 持续保存滚动位置（仅在恢复完成后才注册，防止初始化/恢复前的自动滚动污染缓存）
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !restoredRef.current) return

    const savePosition = (): void => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      scrollPositionCache.set(id, distanceFromBottom)
    }
    el.addEventListener('scroll', savePosition, { passive: true })
    return () => el.removeEventListener('scroll', savePosition)
  }, [scrollRef, id, ready, restoreReady])

  // id 变化时重置恢复标记
  useEffect(() => {
    if (id !== prevIdRef.current) {
      prevIdRef.current = id
      restoredRef.current = false
      settledRef.current = false
      prevScrollHeightRef.current = null
    }
  }, [id])

  const pinIfAtBottomIntent = (): void => {
    const el = scrollRef.current
    if (!el) return
    if (hasSavedMidPosition(scrollPositionCache.get(id))) return
    const top = targetScrollTop(el.scrollHeight, el.clientHeight)
    if (Math.abs(el.scrollTop - top) < 2) return
    el.scrollTop = top
  }

  const markPending = (): void => {
    scrollRef.current?.setAttribute('data-chat-scroll-pending', '')
  }

  const reveal = (): void => {
    if (settledRef.current) return
    settledRef.current = true
    scrollRef.current?.removeAttribute('data-chat-scroll-pending')
    if (!hasSavedMidPosition(scrollPositionCache.get(id))) {
      void scrollToBottomRef.current('instant')
    }
    onSettledRef.current?.()
  }

  // ready 后恢复位置 — 绘制前同步写 scrollTop，避免首帧停在顶部
  useLayoutEffect(() => {
    if (!ready || restoredRef.current) return

    const el = scrollRef.current
    if (!el) {
      const failOpen = window.setTimeout(reveal, 120)
      return () => window.clearTimeout(failOpen)
    }

    const savedDistance = scrollPositionCache.get(id)
    if (hasSavedMidPosition(savedDistance) && !restoreReady) return

    restoredRef.current = true
    prevScrollHeightRef.current = el.scrollHeight
    markPending()

    const top = targetScrollTop(el.scrollHeight, el.clientHeight, savedDistance)
    if (hasSavedMidPosition(savedDistance)) {
      stopScroll()
      el.scrollTop = top
      requestAnimationFrame(() => {
        el.scrollTop = targetScrollTop(el.scrollHeight, el.clientHeight, savedDistance)
        reveal()
      })
    } else {
      el.scrollTop = top
      // Dock 首帧 clientHeight 常为 0；藏着再钉两帧，避免先露出顶部。
      // 不把 rAF 绑在 effect cleanup：restoreReady 变化会重跑并因 restoredRef 直接 return。
      // scrollToBottom 只在揭开时调一次：RO / rAF 里反复调会 setIsAtBottom 打转。
      let frames = 0
      const tick = (): void => {
        if (prevIdRef.current !== id) return
        pinIfAtBottomIntent()
        frames += 1
        if (frames < 3) {
          requestAnimationFrame(tick)
          return
        }
        reveal()
      }
      requestAnimationFrame(tick)
    }
    // 无论 rAF 是否被掐，最多 120ms 必须揭开，避免再出现空白会话。
    const failOpen = window.setTimeout(reveal, 120)
    return () => window.clearTimeout(failOpen)
  }, [ready, restoreReady, id, scrollRef, stopScroll])

  // 打开当帧：滚动容器自己从 0 高变成实际高度时内容 ResizeObserver 不响，必须盯 scroller。
  // 揭开后立刻停手——再调 pin / scrollToBottom 会和 RO 互推，触发 Maximum update depth。
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !ready) return
    const ro = new ResizeObserver(() => {
      const scroller = scrollRef.current
      if (!scroller) return
      if (
        !shouldRepinScrollerToBottom({
          restored: restoredRef.current,
          settled: settledRef.current,
          hasMidPosition: hasSavedMidPosition(scrollPositionCache.get(id)),
          distanceFromBottom:
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        })
      ) {
        return
      }
      pinIfAtBottomIntent()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready, id, scrollRef])

  // 虚拟化往前补页：内容从顶部长高，绘制前把 scrollTop 顺延，视口不跳
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !restoredRef.current || restoreReady) return

    const height = el.scrollHeight
    const prev = prevScrollHeightRef.current
    if (prev == null) {
      prevScrollHeightRef.current = height
      return
    }
    el.scrollTop = compensateScrollForHeightDelta(el.scrollTop, prev, height)
    prevScrollHeightRef.current = height
  }, [layoutKey, restoreReady, scrollRef])

  return null
}
