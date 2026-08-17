/**
 * 顶栏滚动通知条
 * 放在窗口标题栏中央：不挡主内容，可拖窗（非交互空白仍是 drag region）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  archiveStatusTickerAtom,
  dismissStatusTickerAtom,
  removeStatusTickerAtom,
  statusTickerHistoryAtom,
  statusTickerQueueAtom,
  type StatusTickerItem,
} from '../../atoms/status-ticker'
import { Trash } from '@phosphor-icons/react'
import { notificationPrefsAtom } from '../../atoms/notification-prefs'
import { sessionRunMapAtom } from '../../atoms/session-run-atoms'
import { tabsAtom } from '../../atoms/tabs'
import { formatElapsedDuration, useLiveElapsedMs } from '../../lib/time-utils'
import { cn } from '../../lib/utils'
import { AppTooltip, Popover, PopoverAnchor, PopoverContent } from '@tagent/ui'
import { LIVE_SESSION_STACK_MAX_VISIBLE, LiveSessionStack } from './LiveSessionStack'

function formatTickerTime(at: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)
}

const INBOX_ITEM_EXIT_MS = 280
const HISTORY_CLEAR_STAGGER_MS = 72
const POPOVER_CLOSE_MS = 180
const HOST_FLIP_MS = 240
const CLEAR_SEQUENCE_GAP_MS = 0
const CLEAR_EASE = [0.4, 0, 0.2, 1] as const

const inboxItemMotion = {
  initial: { opacity: 0, x: 18, height: 0, marginBottom: 0 },
  animate: { opacity: 1, x: 0, height: 'auto', marginBottom: 0 },
  exit: { opacity: 0, x: '108%', height: 0, marginBottom: 0 },
  transition: { duration: 0.26, ease: [0.32, 0.72, 0, 1] as const },
}

function InboxNotificationRow({
  item,
  historyItem = false,
  reducedMotion,
  onActivate,
  onRemove,
}: {
  item: StatusTickerItem
  historyItem?: boolean
  reducedMotion: boolean
  onActivate: () => void
  onRemove: () => void
}): JSX.Element {
  return (
    <motion.div
      layout={!reducedMotion}
      initial={reducedMotion ? false : inboxItemMotion.initial}
      animate={reducedMotion ? undefined : inboxItemMotion.animate}
      exit={reducedMotion ? undefined : inboxItemMotion.exit}
      transition={reducedMotion ? { duration: 0 } : inboxItemMotion.transition}
      className="status-ticker-inbox__item-wrap"
    >
      <div
        className={cn(
          'status-ticker-inbox__item',
          historyItem && 'status-ticker-inbox__item--history',
        )}
        data-tone={item.tone ?? 'info'}
      >
        <button type="button" className="status-ticker-inbox__main" onClick={onActivate}>
          <span className="status-ticker-inbox__dot" aria-hidden />
          <span className="status-ticker-inbox__copy">
            <span className="status-ticker-inbox__text">{item.text}</span>
            <span className="status-ticker-inbox__meta">
              {formatTickerTime(item.at)}
              {item.actionLabel ? ` · ${item.actionLabel}` : historyItem ? ' · 已提醒' : ''}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="status-ticker-inbox__delete"
          aria-label="删除通知"
          onClick={onRemove}
        >
          <Trash className="size-3" weight="regular" />
        </button>
      </div>
    </motion.div>
  )
}

export function StatusTicker({
  onOpenSession,
}: {
  onOpenSession?: (sessionId: string, title: string) => void
}): JSX.Element {
  const reducedMotion = useReducedMotion()
  const enabled = useAtomValue(notificationPrefsAtom).titlebarTicker
  const queue = useAtomValue(statusTickerQueueAtom)
  const history = useAtomValue(statusTickerHistoryAtom)
  const tabs = useAtomValue(tabsAtom)
  const sessionRunMap = useAtomValue(sessionRunMapAtom)
  const dismiss = useSetAtom(dismissStatusTickerAtom)
  const archive = useSetAtom(archiveStatusTickerAtom)
  const remove = useSetAtom(removeStatusTickerAtom)
  const clearingHistoryRef = useRef(false)
  const clearSequenceTimersRef = useRef<number[]>([])
  const [isClearingHistory, setIsClearingHistory] = useState(false)
  const [hostCollapsing, setHostCollapsing] = useState(false)
  const [heldHistoryCount, setHeldHistoryCount] = useState(0)
  const [frozenCapsule, setFrozenCapsule] = useState<{
    text: string
    historyPrimary: boolean
  } | null>(null)
  const current = enabled ? queue[0] ?? null : null
  const [tick, setTick] = useState(0)
  const [inboxOpen, setInboxOpen] = useState(false)
  // 保留上一条直到离场动画结束，避免队列切换时通知条瞬间跳没。
  const [displayed, setDisplayed] = useState<StatusTickerItem | null>(current)
  const [phase, setPhase] = useState<'enter' | 'idle' | 'exit'>(current ? 'enter' : 'idle')
  const liveSessions = useMemo(
    () =>
      enabled
        ? tabs
            .filter((tab) => sessionRunMap[tab.sessionId]?.running)
            .sort((a, b) => {
              const aStart = sessionRunMap[a.sessionId]?.startedAt ?? Number.MAX_SAFE_INTEGER
              const bStart = sessionRunMap[b.sessionId]?.startedAt ?? Number.MAX_SAFE_INTEGER
              return aStart - bStart
            })
        : [],
    [enabled, sessionRunMap, tabs],
  )
  // 需要立即处理的异常优先于常规运行态；其余时间顶栏展示全局进行中会话。
  const urgentNotice = current?.tone === 'warn' || current?.tone === 'error' ? current : null
  const showLiveStack = !urgentNotice && liveSessions.length >= 2
  const liveSingle = !urgentNotice && liveSessions.length === 1 ? liveSessions[0] : null
  const liveStartedAt = liveSingle ? sessionRunMap[liveSingle.sessionId]?.startedAt ?? null : null
  const liveElapsedMs = useLiveElapsedMs(liveStartedAt ?? undefined, liveSingle != null, 1000)
  const startedAtBySession = useMemo(
    () =>
      Object.fromEntries(
        liveSessions.map((session) => [
          session.sessionId,
          sessionRunMap[session.sessionId]?.startedAt ?? null,
        ]),
      ),
    [liveSessions, sessionRunMap],
  )

  // TTL 自动消退
  useEffect(() => {
    if (!current) return
    const ttl = current.ttlMs ?? 6000
    const t = window.setTimeout(() => dismiss(current.id), ttl)
    return () => clearTimeout(t)
  }, [current?.id, current?.ttlMs, dismiss])

  // 当前队列项变化时，先让旧项离场，再挂载新项进场。
  useEffect(() => {
    if (current?.id === displayed?.id) {
      if (phase === 'exit') setPhase('idle')
      return
    }
    if (!displayed) {
      setDisplayed(current)
      setPhase(current ? 'enter' : 'idle')
      return
    }
    setPhase('exit')
    const timer = window.setTimeout(() => {
      setDisplayed(current)
      setPhase(current ? 'enter' : 'idle')
    }, reducedMotion ? 0 : 260)
    return () => clearTimeout(timer)
  }, [current, displayed, phase, reducedMotion])

  // 长文案：新通知真正挂载时触发 CSS 动画。
  useEffect(() => {
    if (!displayed) return
    setTick((n) => n + 1)
  }, [displayed?.id])

  const historyPrimary =
    !liveSingle &&
    !showLiveStack &&
    !displayed &&
    (history.length > 0 || (hostCollapsing && heldHistoryCount > 0))
  const historyCountLabel = history.length > 0 ? history.length : heldHistoryCount
  const livePrimaryText = liveSingle
    ? `运行中 · ${liveSingle.title || '未命名会话'} · ${formatElapsedDuration(liveElapsedMs)}`
    : historyPrimary
      ? `通知历史 · ${historyCountLabel} 条已提醒`
    : displayed?.text ?? ''
  const visualHistoryPrimary = frozenCapsule?.historyPrimary ?? historyPrimary
  const primaryText = frozenCapsule?.text ?? livePrimaryText
  const long = primaryText.length > 42
  const hiddenLiveCount = showLiveStack
    ? Math.max(0, liveSessions.length - LIVE_SESSION_STACK_MAX_VISIBLE)
    : Math.max(0, liveSessions.length - 1)
  const extraCount = hiddenLiveCount + queue.length + history.length

  const hasTickerContent =
    !!displayed || !!liveSingle || showLiveStack || historyPrimary || hostCollapsing

  const finishClearSequence = useCallback(
    (willHideCapsule: boolean) => {
      setInboxOpen(false)
      const afterPopoverMs = reducedMotion ? 0 : POPOVER_CLOSE_MS
      const hideTimer = window.setTimeout(() => {
        if (willHideCapsule) {
          setHostCollapsing(false)
          const flipTimer = window.setTimeout(() => {
            setHeldHistoryCount(0)
            setFrozenCapsule(null)
            setIsClearingHistory(false)
            clearingHistoryRef.current = false
          }, reducedMotion ? 0 : HOST_FLIP_MS)
          clearSequenceTimersRef.current.push(flipTimer)
          return
        }
        setFrozenCapsule(null)
        setIsClearingHistory(false)
        clearingHistoryRef.current = false
      }, afterPopoverMs)
      clearSequenceTimersRef.current.push(hideTimer)
    },
    [reducedMotion],
  )

  const removeWithAnimation = useCallback(
    (id: string) => {
      const isLastHistoryOnly =
        history.length === 1 &&
        history[0]?.id === id &&
        !displayed &&
        !liveSingle &&
        !showLiveStack
      if (isLastHistoryOnly) {
        setHeldHistoryCount(1)
        setHostCollapsing(true)
        setIsClearingHistory(true)
        clearingHistoryRef.current = true
        setFrozenCapsule({
          text: '通知历史 · 1 条已提醒',
          historyPrimary: true,
        })
        remove(id)
        const listDoneMs = reducedMotion ? 0 : INBOX_ITEM_EXIT_MS + CLEAR_SEQUENCE_GAP_MS
        const listTimer = window.setTimeout(() => {
          finishClearSequence(true)
        }, listDoneMs)
        clearSequenceTimersRef.current.push(listTimer)
        return
      }
      remove(id)
    },
    [history, displayed, liveSingle, showLiveStack, remove, reducedMotion, finishClearSequence],
  )

  const handleClearHistory = useCallback(() => {
    if (history.length === 0 || clearingHistoryRef.current) return
    clearingHistoryRef.current = true
    setIsClearingHistory(true)
    const willHideCapsule = !displayed && !liveSingle && !showLiveStack
    if (willHideCapsule) {
      setHeldHistoryCount(history.length)
      setHostCollapsing(true)
      setFrozenCapsule({
        text: `通知历史 · ${history.length} 条已提醒`,
        historyPrimary: true,
      })
    }
    const items = [...history]
    items.forEach((item, index) => {
      const removeTimer = window.setTimeout(
        () => remove(item.id),
        reducedMotion ? 0 : index * HISTORY_CLEAR_STAGGER_MS,
      )
      clearSequenceTimersRef.current.push(removeTimer)
    })
    const listDoneMs = reducedMotion
      ? 0
      : Math.max(0, items.length - 1) * HISTORY_CLEAR_STAGGER_MS +
        INBOX_ITEM_EXIT_MS +
        CLEAR_SEQUENCE_GAP_MS
    const listTimer = window.setTimeout(() => {
      finishClearSequence(willHideCapsule)
    }, listDoneMs)
    clearSequenceTimersRef.current.push(listTimer)
  }, [
    history,
    remove,
    displayed,
    liveSingle,
    showLiveStack,
    reducedMotion,
    finishClearSequence,
  ])

  useEffect(() => {
    return () => {
      clearSequenceTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      clearSequenceTimersRef.current = []
    }
  }, [])

  useEffect(() => {
    if (!inboxOpen || isClearingHistory || hostCollapsing) return
    if (history.length === 0 && queue.length === 0 && liveSessions.length === 0) {
      setInboxOpen(false)
    }
  }, [inboxOpen, isClearingHistory, history.length, queue.length, liveSessions.length])

  const activateQueueItem = (item: StatusTickerItem): void => {
    item.onClick?.()
    archive(item.id)
    setInboxOpen(false)
  }

  const activatePrimary = (): void => {
    if (liveSingle) {
      onOpenSession?.(liveSingle.sessionId, liveSingle.title)
      return
    }
    if (historyPrimary) {
      setInboxOpen(true)
      return
    }
    if (displayed) activateQueueItem(displayed)
  }

  const inboxBadge =
      extraCount > 0 || visualHistoryPrimary ? (
      <button
        type="button"
        className="status-ticker__badge"
        aria-label={`查看 ${liveSessions.length} 个运行中会话和 ${queue.length + history.length} 条通知`}
        onClick={(event) => {
          event.stopPropagation()
          setInboxOpen(true)
        }}
      >
        {visualHistoryPrimary ? '查看' : `+${extraCount}`}
      </button>
    ) : null

  return (
    <Popover
      open={inboxOpen}
      onOpenChange={(open) => {
        if (isClearingHistory && !open) return
        setInboxOpen(open)
      }}
    >
      <AppTooltip
        label={
          showLiveStack
            ? undefined
              : liveSingle
              ? '定位到运行中的会话'
              : visualHistoryPrimary
                ? '查看通知历史'
                : displayed?.actionLabel ?? displayed?.text
        }
        side="bottom"
        disabled={inboxOpen || showLiveStack || isClearingHistory || hostCollapsing}
      >
        <PopoverAnchor asChild>
          <motion.span
            className="status-ticker-tooltip-anchor"
            layout={false}
          >
          <AnimatePresence mode="wait" initial={false}>
          {hasTickerContent ? (
            <motion.div
              key="ticker-host"
              className={cn(
                'status-ticker-host titlebar-no-drag',
                (isClearingHistory || hostCollapsing) && 'status-ticker-host--hold',
              )}
              aria-live="polite"
              layout={false}
              style={{ transformPerspective: 420, transformOrigin: '50% 0%' }}
              initial={
                reducedMotion || isClearingHistory
                  ? false
                  : { opacity: 0, y: -8, rotateX: 58 }
              }
              animate={{ opacity: 1, y: 0, rotateX: 0 }}
              exit={
                reducedMotion
                  ? undefined
                  : {
                      opacity: 0,
                      y: -10,
                      rotateX: 80,
                      transition: { duration: HOST_FLIP_MS / 1000, ease: CLEAR_EASE },
                    }
              }
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : { duration: 0.22, ease: CLEAR_EASE }
              }
            >
              <AnimatePresence mode="wait" initial={false}>
            {showLiveStack ? (
              <motion.div
                key="live-stack"
                className="status-ticker-host__layer"
                initial={reducedMotion || isClearingHistory ? false : { opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={
                  reducedMotion || isClearingHistory
                    ? undefined
                    : { opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.14 } }
                }
                transition={
                  reducedMotion || isClearingHistory
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 420, damping: 32 }
                }
              >
                <LiveSessionStack
                  sessions={liveSessions}
                  startedAtBySession={startedAtBySession}
                  onOpenSession={onOpenSession}
                />
                {inboxBadge}
              </motion.div>
            ) : (
              <motion.div
                key={liveSingle ? `live-${liveSingle.sessionId}` : displayed?.id ?? 'notice'}
                className="status-ticker-host__layer"
                initial={reducedMotion || isClearingHistory ? false : { opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={
                  reducedMotion || isClearingHistory
                    ? undefined
                    : { opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.14 } }
                }
                transition={
                  reducedMotion || isClearingHistory
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 420, damping: 32 }
                }
              >
                <div
                  className={cn(
                    'status-ticker',
                    liveSingle
                      ? 'status-ticker--live'
                      : visualHistoryPrimary
                        ? 'status-ticker--history'
                        : displayed?.tone && `status-ticker--${displayed.tone}`,
                    long && 'status-ticker--marquee',
                    !liveSingle && !hostCollapsing && phase === 'enter' && 'status-ticker--enter',
                    !liveSingle && !hostCollapsing && phase === 'exit' && 'status-ticker--exit',
                  )}
                  role={liveSingle || visualHistoryPrimary || displayed?.onClick ? 'button' : 'status'}
                  tabIndex={
                    isClearingHistory ||
                    hostCollapsing ||
                    phase === 'exit' ||
                    (!liveSingle && !visualHistoryPrimary && !displayed?.onClick)
                      ? undefined
                      : 0
                  }
                  aria-label={
                    liveSingle
                      ? `打开运行中的会话：${liveSingle.title}`
                      : visualHistoryPrimary
                        ? '查看通知历史'
                        : displayed?.actionLabel
                  }
                  onClick={() => {
                    if (phase === 'exit') return
                    activatePrimary()
                  }}
                  onKeyDown={(event) => {
                    if (
                      (!liveSingle && !historyPrimary && !displayed?.onClick) ||
                      phase === 'exit' ||
                      (event.key !== 'Enter' && event.key !== ' ')
                    ) return
                    event.preventDefault()
                    activatePrimary()
                  }}
                >
                  {liveSingle ? <span className="status-ticker__live-dot" aria-hidden /> : null}
                  <div className="status-ticker__viewport">
                    <div
                      key={
                        liveSingle
                          ? `live-${liveSingle.sessionId}`
                          : `${displayed?.id ?? 'empty'}-${tick}`
                      }
                      className={cn('status-ticker__track', long && 'status-ticker__track--marquee')}
                    >
                      <span className="status-ticker__text">{primaryText}</span>
                      {long ? (
                        <span className="status-ticker__text status-ticker__text--dup" aria-hidden>
                          {primaryText}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {inboxBadge}
                </div>
              </motion.div>
            )}
              </AnimatePresence>
            </motion.div>
          ) : (
            <motion.div
              key="ticker-empty"
              className="status-ticker status-ticker--empty"
              aria-hidden
              initial={false}
              animate={{ opacity: 1 }}
              exit={
                reducedMotion
                  ? undefined
                  : { opacity: 0, scaleX: 0.9, scaleY: 0.88, transition: { duration: 0.2 } }
              }
            />
          )}
          </AnimatePresence>
          </motion.span>
        </PopoverAnchor>
      </AppTooltip>
      <PopoverContent
        side="bottom"
        align="center"
        sideOffset={8}
        className={cn(
          'status-ticker-inbox titlebar-no-drag',
          'data-[state=open]:animate-none data-[state=closed]:animate-none',
          isClearingHistory && 'status-ticker-inbox--retract',
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="status-ticker-inbox__titlebar">
          <span>通知中心</span>
          {history.length > 0 || isClearingHistory ? (
            <button type="button" onClick={handleClearHistory} disabled={isClearingHistory}>
              清除已提醒
            </button>
          ) : null}
        </div>
        <div className="status-ticker-inbox__list">
          {liveSessions.length > 0 ? (
            <>
              <div className="status-ticker-inbox__head">
                <span>进行中</span>
                <span>{liveSessions.length} 个</span>
              </div>
              {liveSessions.map((session) => (
                <button
                  key={session.sessionId}
                  type="button"
                  className="status-ticker-inbox__item status-ticker-inbox__item--live"
                  onClick={() => {
                    onOpenSession?.(session.sessionId, session.title)
                    setInboxOpen(false)
                  }}
                >
                  <span className="status-ticker-inbox__dot" aria-hidden />
                  <span className="status-ticker-inbox__copy">
                    <span className="status-ticker-inbox__text">{session.title || '未命名会话'}</span>
                    <span className="status-ticker-inbox__meta">运行中 · 点击定位</span>
                  </span>
                </button>
              ))}
            </>
          ) : null}
          {queue.length > 0 ? (
            <div className="status-ticker-inbox__head status-ticker-inbox__head--notifications">
              <span>待提醒</span>
              <span>{queue.length} 条</span>
            </div>
          ) : null}
          <AnimatePresence initial={false}>
            {queue.map((item) => (
              <InboxNotificationRow
                key={item.id}
                item={item}
                reducedMotion={!!reducedMotion}
                onActivate={() => activateQueueItem(item)}
                onRemove={() => removeWithAnimation(item.id)}
              />
            ))}
          </AnimatePresence>
          {history.length > 0 || (isClearingHistory && frozenCapsule) ? (
            <div className="status-ticker-inbox__head status-ticker-inbox__head--notifications">
              <span>已提醒</span>
              <span>{history.length} 条</span>
            </div>
          ) : null}
          <AnimatePresence initial={false}>
            {history.map((item) => (
              <InboxNotificationRow
                key={item.id}
                item={item}
                historyItem
                reducedMotion={!!reducedMotion}
                onActivate={() => {
                  item.onClick?.()
                  setInboxOpen(false)
                }}
                onRemove={() => removeWithAnimation(item.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 供外部快速推送 */
export type { StatusTickerItem }
