/**
 * useSmoothStream — 将同一绘制帧内的流式更新合并为最新快照。
 *
 * 显示速度跟随实际收到的内容，不拆字限速，不制造补播队列。
 * 已完成的历史内容在挂载时直接显示；后续内容在下一帧完整更新。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseSmoothStreamOptions {
  /** 每次推送累积后的完整内容 */
  content: string
  /** 流式期间忽略短暂的旧前缀快照，避免内容回退 */
  isStreaming: boolean
}

interface UseSmoothStreamReturn {
  displayedContent: string
}

export function useSmoothStream({
  content,
  isStreaming,
}: UseSmoothStreamOptions): UseSmoothStreamReturn {
  const [displayedContent, setDisplayedContent] = useState(content)
  const displayedRef = useRef(content)
  const pendingContentRef = useRef(content)
  const rafRef = useRef<number | null>(null)

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const latest = pendingContentRef.current
      displayedRef.current = latest
      setDisplayedContent(latest)
    })
  }, [])

  useEffect(() => {
    const previous = pendingContentRef.current
    if (content === previous) return
    // 双源流式快照可能短暂回缩。完成后的权威快照和清空仍正常更新。
    if (isStreaming && content.length > 0 && previous.startsWith(content)) return
    pendingContentRef.current = content
    scheduleFlush()
  }, [content, isStreaming, scheduleFlush])

  useEffect(() => {
    // StrictMode 重放 effect 时，恢复被 cleanup 取消的待绘制快照。
    if (pendingContentRef.current !== displayedRef.current) scheduleFlush()
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [scheduleFlush])

  return { displayedContent }
}
