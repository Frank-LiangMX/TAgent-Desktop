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
  targetScrollTop,
} from './scroll-position'

/** 模块级缓存：会话 ID → 距底部像素距离 */
const scrollPositionCache = new Map<string, number>()

export function ScrollPositionManager({
  id,
  ready,
  restoreReady = true,
  layoutKey = 0,
}: {
  id: string
  ready: boolean
  /** 中间位恢复要等内容全挂完；钉底只等 ready */
  restoreReady?: boolean
  /** 虚拟化可见条数变化时触发顶部补页补偿 */
  layoutKey?: number
}): null {
  const { scrollRef, stopScroll, scrollToBottom } = useStickToBottomContext()
  const restoredRef = useRef(false)
  const prevIdRef = useRef(id)
  const prevScrollHeightRef = useRef<number | null>(null)

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
      prevScrollHeightRef.current = null
    }
  }, [id])

  // ready 后恢复位置 — 绘制前同步写 scrollTop，避免首帧停在顶部
  useLayoutEffect(() => {
    if (!ready || restoredRef.current) return

    const el = scrollRef.current
    if (!el) return

    const savedDistance = scrollPositionCache.get(id)
    if (hasSavedMidPosition(savedDistance) && !restoreReady) return

    restoredRef.current = true
    prevScrollHeightRef.current = el.scrollHeight

    const top = targetScrollTop(el.scrollHeight, el.clientHeight, savedDistance)
    if (hasSavedMidPosition(savedDistance)) {
      stopScroll()
      el.scrollTop = top
      requestAnimationFrame(() => {
        el.scrollTop = targetScrollTop(el.scrollHeight, el.clientHeight, savedDistance)
      })
    } else {
      el.scrollTop = top
      requestAnimationFrame(() => {
        el.scrollTop = targetScrollTop(el.scrollHeight, el.clientHeight)
      })
      // 同步库的 isAtBottom，后续 StickToBottom 仍按钉底处理
      void scrollToBottom('instant')
    }
  }, [ready, restoreReady, id, scrollRef, stopScroll, scrollToBottom])

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
