/**
 * ScrollProgressContainer — 无原生滚动条 + 右侧自定义滑块
 *
 * 与会话区 Conversation + ScrollMinimap 同款交互：隐藏系统滚动条（含上下箭头），
 * 悬停/滚动时显示可拖拽细滑块。
 */

import * as React from 'react'

import { cn } from '@/lib/utils'

interface ScrollProgressContainerProps {
  className?: string
  contentClassName?: string
  children: React.ReactNode
}

export function ScrollProgressContainer({
  className,
  contentClassName,
  children,
}: ScrollProgressContainerProps): React.ReactElement {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const trackRef = React.useRef<HTMLDivElement>(null)
  const scrollActiveTimerRef = React.useRef<number>()
  const [canScroll, setCanScroll] = React.useState(false)
  const [isDragging, setIsDragging] = React.useState(false)
  const [isScrollActive, setIsScrollActive] = React.useState(false)
  const [isHovered, setIsHovered] = React.useState(false)
  const [scrollMetrics, setScrollMetrics] = React.useState({
    scrollTop: 0,
    scrollHeight: 1,
    clientHeight: 1,
  })

  React.useEffect(() => {
    return () => {
      if (scrollActiveTimerRef.current != null) {
        window.clearTimeout(scrollActiveTimerRef.current)
      }
    }
  }, [])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const showScrollControls = (): void => {
      setIsScrollActive(true)
      if (scrollActiveTimerRef.current != null) {
        window.clearTimeout(scrollActiveTimerRef.current)
      }
      scrollActiveTimerRef.current = window.setTimeout(() => {
        setIsScrollActive(false)
      }, 900)
    }

    const update = (activate = false): void => {
      const { scrollTop, scrollHeight, clientHeight } = el
      setCanScroll(scrollHeight > clientHeight + 10)
      setScrollMetrics({ scrollTop, scrollHeight, clientHeight })
      if (activate) showScrollControls()
    }

    update()
    setIsScrollActive(false)

    const handleScroll = (): void => update(true)
    el.addEventListener('scroll', handleScroll, { passive: true })
    el.addEventListener('wheel', showScrollControls, { passive: true })

    const observer = new ResizeObserver(() => update())
    observer.observe(el)

    return () => {
      el.removeEventListener('scroll', handleScroll)
      el.removeEventListener('wheel', showScrollControls)
      observer.disconnect()
    }
  }, [])

  const handleThumbMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const el = scrollRef.current
    const track = trackRef.current
    if (!el || !track) return

    setIsDragging(true)
    const startY = e.clientY
    const startScrollTop = el.scrollTop
    const trackHeight = track.clientHeight
    const { scrollHeight, clientHeight } = el
    const scrollRange = scrollHeight - clientHeight
    const thumbHeight = Math.max(trackHeight * 0.1, (clientHeight / scrollHeight) * trackHeight)
    const scrollableTrack = trackHeight - thumbHeight

    const onMouseMove = (ev: MouseEvent): void => {
      ev.preventDefault()
      const delta = ev.clientY - startY
      const scrollDelta = scrollableTrack > 0 ? (delta / scrollableTrack) * scrollRange : 0
      el.scrollTop = Math.max(0, Math.min(scrollRange, startScrollTop + scrollDelta))
    }

    const onMouseUp = (): void => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const handleTrackMouseDown = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return

    const track = trackRef.current
    const el = scrollRef.current
    if (!track || !el) return

    const rect = track.getBoundingClientRect()
    const clickRatio = (e.clientY - rect.top) / rect.height
    const { scrollHeight, clientHeight } = el
    const targetTop = clickRatio * (scrollHeight - clientHeight)
    el.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
  }, [])

  const { scrollTop, scrollHeight, clientHeight } = scrollMetrics
  const scrollRange = scrollHeight - clientHeight
  const thumbRatio = scrollHeight > 0 ? Math.min(clientHeight / scrollHeight, 1) : 1
  const thumbHeightPct = Math.max(10, thumbRatio * 100)
  const thumbTopPct = scrollRange > 0 ? (scrollTop / scrollRange) * (100 - thumbHeightPct) : 0
  const controlsVisible = isHovered || isDragging || isScrollActive

  return (
    <div
      className={cn('relative min-h-0', className)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        ref={scrollRef}
        className={cn(
          'scroll-progress-container scrollbar-none h-full overflow-y-auto overflow-x-hidden',
          contentClassName
        )}
      >
        {children}
      </div>

      {canScroll ? (
        <div
          className={cn(
            'pointer-events-auto absolute bottom-0 right-1 top-0 z-10 ml-[4px] w-[7px] flex-shrink-0 py-3 transition-opacity duration-200',
            controlsVisible ? 'opacity-100' : 'opacity-0'
          )}
        >
          <div
            ref={trackRef}
            className="relative h-full cursor-pointer rounded-full"
            onMouseDown={handleTrackMouseDown}
          >
            <div
              className={cn(
                'scroll-progress-thumb absolute left-0 right-0 rounded-full transition-colors duration-100',
                isDragging
                  ? 'scroll-progress-thumb-active cursor-grabbing'
                  : controlsVisible
                    ? 'scroll-progress-thumb-visible cursor-grab'
                    : 'cursor-grab'
              )}
              style={{
                height: `${thumbHeightPct}%`,
                top: `${thumbTopPct}%`,
              }}
              onMouseDown={handleThumbMouseDown}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
