/**
 * useSmoothStream — 用短显示缓冲平滑批量到达的流式文本。
 *
 * 同一批文字按时间匀速展开；新批次积压时加速，正常帧率下约 650ms 内追齐。
 * 完成事件继续排完已收到的尾文；历史直接显示，权威替换取消旧尾文。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseSmoothStreamOptions {
  /** 每次推送累积后的完整内容 */
  content: string
  /** 流式期间忽略短暂的旧前缀快照，避免内容回退 */
  isStreaming: boolean
  /** 仅挂载时使用：跨布局重挂载保留已显示前缀，展开思考可直接展示已有内容。 */
  initialContent?: string
}

interface UseSmoothStreamReturn {
  displayedContent: string
}

const MIN_GRAPHEMES_PER_SECOND = 60
const CATCH_UP_SECONDS = 0.65
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function advanceGraphemes(text: string, offset: number, count: number): number {
  if (count <= 0) return offset
  let end = offset
  for (const { index, segment } of segmenter.segment(text.slice(offset))) {
    end = offset + index + segment.length
    if (--count === 0) break
  }
  return end
}

export function useSmoothStream({
  content,
  isStreaming,
  initialContent,
}: UseSmoothStreamOptions): UseSmoothStreamReturn {
  const [displayedContent, setDisplayedContent] = useState(
    () => initialContent ?? (isStreaming ? '' : content),
  )
  const displayedRef = useRef(displayedContent)
  const pendingContentRef = useRef(displayedContent)
  const rafRef = useRef<number | null>(null)
  const wasLiveRef = useRef(isStreaming || (initialContent !== undefined && initialContent !== content))
  const animateRef = useRef(false)
  const speedRef = useRef(0)
  const creditRef = useRef(0)
  const lastFrameRef = useRef<number | null>(null)

  const tick = useCallback(function tick(now: number) {
    rafRef.current = null
    const target = pendingContentRef.current
    let next = target
    if (animateRef.current && target.startsWith(displayedRef.current)) {
      // Do not dump a large chunk after a suspended/slow frame. Use elapsed time
      // rather than characters per frame so 60/120Hz displays have the same pace.
      const dt = lastFrameRef.current === null ? 1000 / 60 : Math.min(50, Math.max(0, now - lastFrameRef.current))
      lastFrameRef.current = now
      creditRef.current += speedRef.current * dt / 1000
      const count = Math.floor(creditRef.current)
      creditRef.current -= count
      const end = advanceGraphemes(target, displayedRef.current.length, count)
      next = target.slice(0, end)
    }
    if (next !== displayedRef.current) {
      displayedRef.current = next
      setDisplayedContent(next)
    }
    if (next !== target) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      lastFrameRef.current = null
      speedRef.current = 0
      creditRef.current = 0
    }
  }, [])

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  useEffect(() => {
    if (isStreaming) wasLiveRef.current = true
    const previous = pendingContentRef.current
    if (content === previous) return
    // 双源流式快照可能短暂回缩。完成后的权威快照和清空仍正常更新。
    if (isStreaming && content.length > 0 && previous.startsWith(content)) return
    pendingContentRef.current = content
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    animateRef.current = wasLiveRef.current && content.startsWith(previous) &&
      content.startsWith(displayedRef.current) && !reducedMotion
    if (animateRef.current) {
      // Never ease out the last few characters. Keep the burst's rate steady;
      // only accelerate if another batch would otherwise create a long tail.
      speedRef.current = Math.max(speedRef.current, MIN_GRAPHEMES_PER_SECOND,
        (content.length - displayedRef.current.length) / CATCH_UP_SECONDS)
    } else {
      speedRef.current = 0
      creditRef.current = 0
      lastFrameRef.current = null
    }
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
