/**
 * ScrollPositionManager — 切换会话时保存/恢复滚动位置（对齐 TAgent_General useScrollPositionMemory）
 *
 * 解决 StickToBottom 的 spring 动画导致的可见滚动过程 + 强行滚底打断查历史。
 *
 * 原理（对齐旧版）：
 * - scroll 事件持续保存 distanceFromBottom 到模块级 Map（仅恢复后才开始记，防初始化污染）
 * - useLayoutEffect（绘制前执行）+ stopScroll() 停掉 StickToBottom 自动滚动 + 直接设 scrollTop（无动画）
 * - 有保存位置 → 恢复到中间；无保存 → scrollToBottom('instant')
 *
 * 必须放在 <Conversation>（StickToBottom）内部使用。
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'

/** 模块级缓存：会话 ID → 距底部像素距离 */
const scrollPositionCache = new Map<string, number>()

export function ScrollPositionManager({
  id,
  ready,
}: {
  id: string
  ready: boolean
}): null {
  const { scrollRef, stopScroll, scrollToBottom } = useStickToBottomContext()
  const restoredRef = useRef(false)
  const prevIdRef = useRef(id)

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
  }, [scrollRef, id, ready])

  // id 变化时重置恢复标记
  useEffect(() => {
    if (id !== prevIdRef.current) {
      prevIdRef.current = id
      restoredRef.current = false
    }
  }, [id])

  // ready 后恢复位置 — useLayoutEffect 在浏览器绘制前执行，无闪烁、无可见滚动过程
  useLayoutEffect(() => {
    if (!ready || restoredRef.current) return
    restoredRef.current = true

    const el = scrollRef.current
    if (!el) return

    const savedDistance = scrollPositionCache.get(id)
    if (savedDistance != null && savedDistance > 5) {
      // 有保存的非底部位置：停 StickToBottom 自动滚动，直接设 scrollTop（无动画）
      stopScroll()
      const targetScrollTop = el.scrollHeight - el.clientHeight - savedDistance
      el.scrollTop = Math.max(0, targetScrollTop)
      // 巩固：下一帧再设一次，对抗 ResizeObserver 竞争
      requestAnimationFrame(() => {
        const t = el.scrollHeight - el.clientHeight - savedDistance
        el.scrollTop = Math.max(0, t)
      })
    } else {
      // 无保存位置或在底部：直接跳到底部（无动画）
      scrollToBottom('instant')
    }
  }, [ready, id, scrollRef, stopScroll, scrollToBottom])

  return null
}
