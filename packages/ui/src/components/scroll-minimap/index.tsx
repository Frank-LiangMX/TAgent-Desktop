/**
 * ScrollMinimap — 消息导航刻度 + 滚动 thumb +（可选）迷你地图面板
 *
 * 会话区左侧刻度（Codex 式）：
 * 1. 一刻度 = 一轮对话；hover 鱼眼 + 预览用户/助手摘要（截断）
 * 2. 点击刻度跳转到该轮用户消息
 * 3. 轨顶小圆按钮 / Ctrl+Cmd+F 打开完整 minimap 面板
 *
 * 右侧保留可拖拽滚动 thumb（滚动/悬停时显现）。
 * 必须放在 StickToBottom（Conversation）内部使用。
 */

import * as React from 'react'
import { ListTree } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStickToBottomContext } from 'use-stick-to-bottom'

import { SearchInput } from '../search-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip'
import { cn } from '../../lib/utils'

export interface MinimapItem {
  id: string
  role: 'user' | 'assistant' | 'status'
  /** 用户侧摘要（一轮一刻度时为主标题） */
  preview: string
  /** 助手侧摘要（截断，Codex 式 peep 副文） */
  replyPreview?: string
  /** 该轮附件文件名（peep chips） */
  attachments?: Array<{ name: string }>
  avatar?: string
  model?: string
}

interface ScrollMinimapProps {
  items: MinimapItem[]
  /** 快捷键打开面板的回调（应用层注入） */
  onShortcutOpen?: () => void
  /** 获取模型 logo URL（应用层注入） */
  getModelLogo?: (model: string) => string | null
}

const MIN_ITEMS = 1
const MAX_BARS = 20
/** 每条刻度槽位高度（含间距）— 鱼眼时槽位固定，避免整列跳动 */
const BAR_SLOT = 8
/** 纵向细条：高度压薄；横向可略长 */
const BAR_HEIGHT_BASE = 1.5
const BAR_WIDTH_BASE = 10
/** 鱼眼最大宽/高（主要拉宽，高度只轻微抬一点） */
const BAR_WIDTH_FOCUS = 18
const BAR_HEIGHT_FOCUS = 2.5
const OPEN_BTN_SIZE = 16
const RAIL_HEAD_OFFSET = 20

const PREVIEW_REMARK_PLUGINS = [remarkGfm]

const PREVIEW_MD_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="text-[11px] opacity-70 truncate">{children}</pre>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="text-[11px] bg-muted/50 px-0.5 rounded-md">{children}</code>
  ),
  img: () => null as unknown as React.ReactElement,
  a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
} as const

interface NavBar {
  index: number
  start: number
  end: number
  isVisible: boolean
  hasUser: boolean
  hasStatus: boolean
  /** 该刻度代表的一轮（取组内首条） */
  turn: MinimapItem | null
}

function getOffsetTopRelativeTo(node: HTMLElement, container: HTMLElement): number {
  let top = 0
  let el: HTMLElement | null = node
  while (el && el !== container) {
    top += el.offsetTop
    el = el.offsetParent as HTMLElement | null
  }
  return top
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 鱼眼：距离 hover 越远越短；高度始终保持细线 */
function fisheyeSize(distance: number): { width: number; height: number } {
  if (distance <= 0) return { width: BAR_WIDTH_FOCUS, height: BAR_HEIGHT_FOCUS }
  if (distance === 1) return { width: 14, height: 2 }
  if (distance === 2) return { width: 12, height: 1.75 }
  return { width: BAR_WIDTH_BASE, height: BAR_HEIGHT_BASE }
}

export function ScrollMinimap({
  items,
  onShortcutOpen,
}: ScrollMinimapProps): React.ReactElement | null {
  const { scrollRef, stopScroll, state: stickyState } = useStickToBottomContext()
  const [panelOpen, setPanelOpen] = React.useState(false)
  const [isLeaving, setIsLeaving] = React.useState(false)
  const [peekIndex, setPeekIndex] = React.useState<number | null>(null)
  const [visibleIds, setVisibleIds] = React.useState<Set<string>>(new Set())
  const [centerVisibleId, setCenterVisibleId] = React.useState<string | undefined>(undefined)
  const [canScroll, setCanScroll] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [isDragging, setIsDragging] = React.useState(false)
  const [isScrollActive, setIsScrollActive] = React.useState(false)
  const [isThumbColumnHovered, setIsThumbColumnHovered] = React.useState(false)
  const [scrollMetrics, setScrollMetrics] = React.useState({
    scrollTop: 0,
    scrollHeight: 1,
    clientHeight: 1,
  })

  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const scrollActiveTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const focusSearchOnOpenRef = React.useRef(false)
  const trackRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
      if (scrollActiveTimerRef.current) clearTimeout(scrollActiveTimerRef.current)
    }
  }, [])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const showScrollControls = (): void => {
      setIsScrollActive(true)
      if (scrollActiveTimerRef.current) clearTimeout(scrollActiveTimerRef.current)
      scrollActiveTimerRef.current = setTimeout(() => {
        setIsScrollActive(false)
      }, 900)
    }

    const update = (activate = false): void => {
      const { scrollTop, scrollHeight, clientHeight } = el
      setCanScroll(scrollHeight > clientHeight + 10)
      setScrollMetrics({ scrollTop, scrollHeight, clientHeight })
      if (activate) showScrollControls()
      if (scrollHeight <= 0) return

      const viewportCenter = scrollTop + clientHeight / 2
      const nodes = el.querySelectorAll<HTMLElement>('[data-message-id]')
      const ids = new Set<string>()
      let centerId: string | undefined
      for (const node of nodes) {
        const top = getOffsetTopRelativeTo(node, el)
        const bottom = top + node.offsetHeight
        const id = node.getAttribute('data-message-id')
        if (bottom > scrollTop && top < scrollTop + clientHeight) {
          if (id) ids.add(id)
        }
        if (centerId === undefined && top <= viewportCenter && bottom > viewportCenter) {
          centerId = id ?? undefined
        }
      }
      setVisibleIds(ids)
      setCenterVisibleId(centerId)
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
  }, [scrollRef])

  React.useEffect(() => {
    if (panelOpen && focusSearchOnOpenRef.current && searchInputRef.current) {
      focusSearchOnOpenRef.current = false
      const timer = setTimeout(() => searchInputRef.current?.focus(), 80)
      return () => clearTimeout(timer)
    }
  }, [panelOpen])

  React.useEffect(() => {
    if (!panelOpen) return
    const timer = setTimeout(() => {
      const list = listRef.current
      if (!list) return
      const target = list.querySelector<HTMLElement>('[data-minimap-visible="true"]')
      if (!target) return
      const listRect = list.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const offsetInList = targetRect.top - listRect.top + list.scrollTop
      const offset = offsetInList - (list.clientHeight - target.offsetHeight) / 2
      list.scrollTo({ top: Math.max(0, offset), behavior: 'auto' })
    }, 0)
    return () => clearTimeout(timer)
  }, [panelOpen])

  React.useEffect(() => {
    if (!panelOpen) setSearchQuery('')
  }, [panelOpen])

  const openPanel = React.useCallback(
    (focusSearch = false) => {
      focusSearchOnOpenRef.current = focusSearch
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
      setIsLeaving(false)
      setPeekIndex(null)
      setPanelOpen(true)
      if (focusSearch && panelOpen) {
        requestAnimationFrame(() => searchInputRef.current?.focus())
      }
    },
    [panelOpen]
  )

  const closePanelNow = React.useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsLeaving(false)
    setPanelOpen(false)
  }, [])

  const togglePanel = React.useCallback(() => {
    if (panelOpen) closePanelNow()
    else openPanel(false)
  }, [panelOpen, closePanelNow, openPanel])

  const handleShortcutOpen = React.useCallback(
    (focusSearch = false) => {
      openPanel(focusSearch)
    },
    [openPanel]
  )

  // 点击面板外关闭（轨顶按钮切换打开时不靠 mouseleave）
  React.useEffect(() => {
    if (!panelOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.message-nav-popover, .message-nav-open-btn')) return
      closePanelNow()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [panelOpen, closePanelNow])

  React.useEffect(() => {
    if (onShortcutOpen && items.length >= MIN_ITEMS && canScroll) {
      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
          e.preventDefault()
          onShortcutOpen()
          handleShortcutOpen(true)
        }
      }
      document.addEventListener('keydown', handler)
      return () => document.removeEventListener('keydown', handler)
    }
  }, [onShortcutOpen, items.length, canScroll, handleShortcutOpen])

  const scrollToMessage = React.useCallback(
    (id: string) => {
      const el = scrollRef.current
      if (!el) return
      const target = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        (node) => node.getAttribute('data-message-id') === id
      )
      if (!target) return
      stopScroll()
      stickyState.animation = undefined
      stickyState.velocity = 0
      stickyState.accumulated = 0
      const offsetTop = getOffsetTopRelativeTo(target, el)
      const targetHeight = target.offsetHeight
      const viewportHeight = el.clientHeight
      const scrollTarget =
        targetHeight < viewportHeight
          ? offsetTop - (viewportHeight - targetHeight) / 2
          : offsetTop - 32
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      el.scrollTo({
        top: Math.max(0, scrollTarget),
        behavior: reducedMotion ? 'auto' : 'smooth',
      })
      setPanelOpen(false)
      setPeekIndex(null)
    },
    [scrollRef, stopScroll, stickyState]
  )

  const scrollToGroup = React.useCallback(
    (start: number) => {
      const item = items[start]
      if (item) scrollToMessage(item.id)
    },
    [items, scrollToMessage]
  )

  const filteredItems = React.useMemo(() => {
    if (!searchQuery.trim()) return items
    const q = searchQuery.toLowerCase()
    return items.filter(
      (item) =>
        item.preview.toLowerCase().includes(q) ||
        (item.replyPreview?.toLowerCase().includes(q) ?? false) ||
        (item.attachments?.some((a) => a.name.toLowerCase().includes(q)) ?? false)
    )
  }, [items, searchQuery])

  const anchorId = React.useMemo(() => {
    if (centerVisibleId && filteredItems.some((item) => item.id === centerVisibleId)) {
      return centerVisibleId
    }
    return filteredItems.find((item) => visibleIds.has(item.id))?.id
  }, [centerVisibleId, filteredItems, visibleIds])

  const handleThumbMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const el = scrollRef.current
      const track = trackRef.current
      if (!el || !track) return
      stopScroll()
      stickyState.animation = undefined
      stickyState.velocity = 0
      stickyState.accumulated = 0
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
    },
    [scrollRef, stopScroll, stickyState]
  )

  const handleTrackMouseDown = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return
      const track = trackRef.current
      const el = scrollRef.current
      if (!track || !el) return
      stopScroll()
      stickyState.animation = undefined
      stickyState.velocity = 0
      stickyState.accumulated = 0
      const rect = track.getBoundingClientRect()
      const clickRatio = (e.clientY - rect.top) / rect.height
      const { scrollHeight, clientHeight } = el
      const targetTop = clickRatio * (scrollHeight - clientHeight)
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      el.scrollTo({
        top: Math.max(0, targetTop),
        behavior: reducedMotion ? 'auto' : 'smooth',
      })
    },
    [scrollRef, stopScroll, stickyState]
  )

  const bars = React.useMemo((): NavBar[] => {
    if (items.length < MIN_ITEMS) return []
    const barCount = Math.min(items.length, MAX_BARS)
    return Array.from({ length: barCount }, (_, i) => {
      const start = Math.floor((i * items.length) / barCount)
      const end = Math.floor(((i + 1) * items.length) / barCount)
      const group = items.slice(start, end)
      return {
        index: i,
        start,
        end,
        isVisible: group.some((it) => visibleIds.has(it.id)),
        hasUser: group.some((it) => it.role === 'user'),
        hasStatus: group.some((it) => it.role === 'status'),
        turn: group[0] ?? null,
      }
    })
  }, [items, visibleIds])

  if (items.length < MIN_ITEMS || !canScroll) return null

  const { scrollTop, scrollHeight, clientHeight } = scrollMetrics
  const scrollRange = scrollHeight - clientHeight
  const thumbRatio = scrollHeight > 0 ? Math.min(clientHeight / scrollHeight, 1) : 1
  const thumbHeightPct = Math.max(10, thumbRatio * 100)
  const thumbTopPct = scrollRange > 0 ? (scrollTop / scrollRange) * (100 - thumbHeightPct) : 0
  const thumbVisible = panelOpen || isDragging || isScrollActive || isThumbColumnHovered

  const peekBar = peekIndex !== null ? (bars[peekIndex] ?? null) : null
  const peekItem = peekBar?.turn ?? null
  const peekTop = peekBar ? RAIL_HEAD_OFFSET + peekBar.index * BAR_SLOT : 0

  const handleTrackKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const el = scrollRef.current
    if (!el) return
    const page = Math.max(40, el.clientHeight * 0.82)
    let next = el.scrollTop
    if (event.key === 'ArrowUp') next -= 48
    else if (event.key === 'ArrowDown') next += 48
    else if (event.key === 'PageUp') next -= page
    else if (event.key === 'PageDown') next += page
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = scrollRange
    else return
    event.preventDefault()
    stopScroll()
    el.scrollTo({ top: Math.max(0, Math.min(scrollRange, next)), behavior: 'auto' })
  }

  return (
    <div className="message-nav-shell pointer-events-none absolute inset-0 z-30">
      {/* 左侧刻度：鱼眼 + hover 用户轮次预览 */}
      <div
        className="message-nav-rail absolute left-2.5 top-0 bottom-0 flex w-7 items-start justify-start pt-1 pl-0.5 pointer-events-none"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setPanelOpen(false)
            setIsLeaving(false)
            setPeekIndex(null)
          }
        }}
      >
        <div
          className="relative flex flex-col pointer-events-auto"
          style={{ width: BAR_WIDTH_FOCUS }}
          onMouseLeave={() => setPeekIndex(null)}
        >
          {/* Rail open button: center on resting tick width */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'message-nav-open-btn mb-1 flex shrink-0 items-center justify-center rounded-full border-0',
                  'text-foreground/50 transition-colors duration-150',
                  'hover:bg-foreground/[0.06] hover:text-foreground/80',
                  panelOpen && 'message-nav-open-btn--active bg-primary/10 text-primary'
                )}
                style={{
                  width: OPEN_BTN_SIZE,
                  height: OPEN_BTN_SIZE,
                  marginLeft: (BAR_WIDTH_BASE - OPEN_BTN_SIZE) / 2,
                }}
                aria-label="消息导航"
                aria-pressed={panelOpen}
                onClick={(event) => {
                  event.stopPropagation()
                  togglePanel()
                }}
              >
                <ListTree size={10} strokeWidth={1.75} aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              <div className="font-medium">消息导航</div>
              <div className="text-muted-foreground">查看完整时间线</div>
            </TooltipContent>
          </Tooltip>

          {/* 完整 minimap 面板 */}
          {panelOpen && (
            <div
              className={cn(
                'message-nav-float message-nav-popover absolute left-[22px] top-0 z-20 ml-1.5 w-[300px] origin-top-left flex flex-col overflow-hidden pointer-events-auto',
                isLeaving ? 'message-nav-popover-exit' : 'message-nav-popover-enter'
              )}
              style={{ maxHeight: 'min(460px, 64vh)' }}
              onMouseEnter={() => {
                if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
                if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
                setIsLeaving(false)
              }}
            >
              <div className="message-nav-popover-header relative z-10 shrink-0 px-3 pt-2.5 pb-2">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-[11px] font-medium tracking-wide">消息导航</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {visibleIds.size} / {items.length}
                  </span>
                </div>
                <SearchInput
                  ref={searchInputRef}
                  variant="plain"
                  size="sm"
                  containerClassName="app-search-shell app-search-shell--compact message-nav-search"
                  placeholder="搜索消息…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={() => {
                    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
                    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
                    setIsLeaving(false)
                  }}
                />
              </div>

              <div
                ref={listRef}
                className="message-nav-popover-list overflow-y-auto flex-1 px-2.5 pb-2.5 pt-0.5 scrollbar-thin"
              >
                {filteredItems.length === 0 ? (
                  <div className="py-10 text-center text-[11px] md-text-faint">未找到匹配消息</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {filteredItems.map((item) => {
                      const isAnchor = item.id === anchorId
                      const isInView = visibleIds.has(item.id)
                      const isStatus = item.role === 'status'
                      return (
                        <div
                          key={item.id}
                          data-minimap-visible={isAnchor ? 'true' : undefined}
                          className="flex flex-col gap-1"
                        >
                          {/* 用户：右对齐 */}
                          <button
                            type="button"
                            className="message-nav-row flex w-full justify-end border-0 bg-transparent p-0"
                            onClick={() => scrollToMessage(item.id)}
                          >
                            <span
                              className={cn(
                                'message-nav-bubble message-nav-bubble-user max-w-[88%] px-2.5 py-1.5 text-left transition-[background,box-shadow,filter] duration-150',
                                isStatus && 'message-nav-bubble-status',
                                isAnchor && 'message-nav-bubble-anchor',
                                !isAnchor && isInView && 'message-nav-bubble-inview'
                              )}
                            >
                              <HighlightedPreview text={item.preview} query={searchQuery} />
                            </span>
                          </button>
                          {/* 助手：左对齐（有回复时） */}
                          {item.replyPreview ? (
                            <button
                              type="button"
                              className="message-nav-row flex w-full justify-start border-0 bg-transparent p-0"
                              onClick={() => scrollToMessage(item.id)}
                            >
                              <span
                                className={cn(
                                  'message-nav-bubble message-nav-bubble-assistant max-w-[88%] px-2.5 py-1.5 text-left transition-[background,box-shadow,filter] duration-150',
                                  isAnchor && 'message-nav-bubble-anchor',
                                  !isAnchor && isInView && 'message-nav-bubble-inview'
                                )}
                              >
                                <HighlightedPreview text={item.replyPreview} query={searchQuery} />
                              </span>
                            </button>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* hover 一轮轻量预览：用户摘要 + 助手摘要（截断）+ 附件 chips */}
          {peekItem && !panelOpen && (
            <button
              type="button"
              className="message-nav-float message-nav-peek absolute left-[20px] z-20 ml-1.5 w-[260px] p-0 text-left pointer-events-auto message-nav-peek-enter"
              style={{ top: Math.max(0, peekTop - 4) }}
              onClick={() => {
                if (peekItem) scrollToMessage(peekItem.id)
              }}
              onMouseEnter={() => {
                if (peekBar) setPeekIndex(peekBar.index)
              }}
            >
              <div className="relative z-10 px-3 py-2.5 space-y-1.5">
                <div className="text-xs font-medium leading-4 line-clamp-2">
                  {peekItem.preview || '(空消息)'}
                </div>
                {peekItem.replyPreview ? (
                  <div className="text-[11px] leading-4 opacity-70 line-clamp-3">
                    {peekItem.replyPreview}
                  </div>
                ) : null}
                {peekItem.attachments && peekItem.attachments.length > 0 ? (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {peekItem.attachments.slice(0, 3).map((file) => (
                      <span
                        key={file.name}
                        className="message-nav-peek-chip inline-flex max-w-[46%] items-center truncate rounded-md px-1.5 py-0.5 text-[10px]"
                        title={file.name}
                      >
                        {file.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </button>
          )}

          {/* 鱼眼胶囊刻度 */}
          <div
            className="message-nav-bars relative flex-shrink-0"
            style={{ width: BAR_WIDTH_FOCUS, height: bars.length * BAR_SLOT }}
          >
            {bars.map((bar) => {
              const distance = peekIndex === null ? 99 : Math.abs(bar.index - peekIndex)
              const { width, height } = fisheyeSize(distance)
              const focused = distance === 0
              return (
                <button
                  key={bar.index}
                  type="button"
                  aria-label={`跳转到消息组 ${bar.start + 1}`}
                  className={cn(
                    'message-nav-bar absolute left-0 rounded-full border-0 p-0 cursor-pointer',
                    'transition-[width,height,background-color,opacity,box-shadow] duration-150 ease-out',
                    bar.isVisible && 'message-nav-bar-visible',
                    bar.hasStatus && !bar.isVisible && 'message-nav-bar-status',
                    bar.hasUser && !bar.isVisible && !bar.hasStatus && 'message-nav-bar-user',
                    !bar.isVisible && !bar.hasUser && !bar.hasStatus && 'message-nav-bar-assistant',
                    focused && 'message-nav-bar-focused'
                  )}
                  style={{
                    top: bar.index * BAR_SLOT + (BAR_SLOT - height) / 2,
                    width,
                    height,
                    borderRadius: height,
                  }}
                  onMouseEnter={() => setPeekIndex(bar.index)}
                  onFocus={() => setPeekIndex(bar.index)}
                  onClick={() => scrollToGroup(bar.start)}
                />
              )
            })}
          </div>
        </div>
      </div>

      {/* 右侧滚动 thumb */}
      <div
        className={cn(
          'message-nav-scroll absolute right-0 top-0 bottom-0 flex justify-end py-1 pr-px pointer-events-auto transition-opacity duration-200',
          thumbVisible ? 'opacity-100' : 'opacity-0'
        )}
        style={{ width: 10 }}
        onMouseEnter={() => setIsThumbColumnHovered(true)}
        onMouseLeave={() => setIsThumbColumnHovered(false)}
      >
        <div
          ref={trackRef}
          className="relative h-full w-[5px] rounded-full cursor-pointer"
          role="scrollbar"
          tabIndex={0}
          aria-label="会话滚动位置"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.round(scrollRange))}
          aria-valuenow={Math.max(0, Math.round(scrollTop))}
          onMouseDown={handleTrackMouseDown}
          onKeyDown={handleTrackKeyDown}
        >
          <div
            className={cn(
              'absolute left-0 right-0 rounded-full transition-colors duration-100 scroll-progress-thumb',
              isDragging
                ? 'scroll-progress-thumb-active cursor-grabbing'
                : thumbVisible
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
    </div>
  )
}

function HighlightedPreview({ text, query }: { text: string; query: string }): React.ReactElement {
  if (!text) {
    return <span className="text-[11px] leading-4 md-text-faint">(空消息)</span>
  }

  if (query.trim()) {
    const escaped = escapeRegExp(query)
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
    return (
      <span className="text-[11px] leading-4 md-text line-clamp-2">
        {parts.map((part, i) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <mark key={i} className="bg-primary/15 text-primary rounded-sm px-0.5">
              {part}
            </mark>
          ) : (
            part
          )
        )}
      </span>
    )
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-[11px] leading-4 md-text-variant prose-p:my-0 prose-headings:my-0.5 prose-headings:text-[11px] prose-li:my-0 prose-pre:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 line-clamp-2 overflow-hidden">
      <Markdown remarkPlugins={PREVIEW_REMARK_PLUGINS} components={PREVIEW_MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}
