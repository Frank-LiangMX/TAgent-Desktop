/**
 * 顶栏滚动通知条
 * 放在窗口标题栏中央：不挡主内容，可拖窗（非交互空白仍是 drag region）
 */
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  archiveStatusTickerAtom,
  clearStatusTickerHistoryAtom,
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
import { AppTooltip, Popover, PopoverContent, PopoverTrigger } from '@tagent/ui'
import { LIVE_SESSION_STACK_MAX_VISIBLE, LiveSessionStack } from './LiveSessionStack'

function formatTickerTime(at: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)
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
  const clearHistory = useSetAtom(clearStatusTickerHistoryAtom)
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
    }, 170)
    return () => clearTimeout(timer)
  }, [current, displayed, phase])

  // 长文案：新通知真正挂载时触发 CSS 动画。
  useEffect(() => {
    if (!displayed) return
    setTick((n) => n + 1)
  }, [displayed?.id])

  const historyPrimary = !liveSingle && !showLiveStack && !displayed && history.length > 0
  const primaryText = liveSingle
    ? `运行中 · ${liveSingle.title || '未命名会话'} · ${formatElapsedDuration(liveElapsedMs)}`
    : historyPrimary
      ? `通知历史 · ${history.length} 条已提醒`
    : displayed?.text ?? ''
  const long = primaryText.length > 42
  const hiddenLiveCount = showLiveStack
    ? Math.max(0, liveSessions.length - LIVE_SESSION_STACK_MAX_VISIBLE)
    : Math.max(0, liveSessions.length - 1)
  const extraCount = hiddenLiveCount + queue.length + history.length

  if (!displayed && !liveSingle && !showLiveStack && !historyPrimary) {
    return <div className="status-ticker status-ticker--empty" aria-hidden />
  }

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
    extraCount > 0 || historyPrimary ? (
      <PopoverTrigger asChild>
        <button
          type="button"
          className="status-ticker__badge"
          aria-label={`查看 ${liveSessions.length} 个运行中会话和 ${queue.length + history.length} 条通知`}
          onClick={(event) => event.stopPropagation()}
        >
          {historyPrimary ? '查看' : `+${extraCount}`}
        </button>
      </PopoverTrigger>
    ) : null

  return (
    <Popover open={inboxOpen} onOpenChange={setInboxOpen}>
      <AppTooltip
        label={
          showLiveStack
            ? `${liveSessions.length} 个会话运行中 · 悬停展开`
            : liveSingle
              ? '定位到运行中的会话'
              : historyPrimary
                ? '查看通知历史'
                : displayed?.actionLabel ?? displayed?.text
        }
        side="bottom"
        disabled={inboxOpen}
      >
        <div className="status-ticker-host titlebar-no-drag" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            {showLiveStack ? (
              <motion.div
                key="live-stack"
                className="status-ticker-host__layer"
                initial={reducedMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={
                  reducedMotion
                    ? undefined
                    : { opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.14 } }
                }
                transition={
                  reducedMotion
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
                initial={reducedMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={
                  reducedMotion
                    ? undefined
                    : { opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.14 } }
                }
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 420, damping: 32 }
                }
              >
                <div
                  className={cn(
                    'status-ticker',
                    liveSingle
                      ? 'status-ticker--live'
                      : historyPrimary
                        ? 'status-ticker--history'
                        : displayed?.tone && `status-ticker--${displayed.tone}`,
                    long && 'status-ticker--marquee',
                    !liveSingle && phase === 'enter' && 'status-ticker--enter',
                    !liveSingle && phase === 'exit' && 'status-ticker--exit',
                  )}
                  role={liveSingle || historyPrimary || displayed?.onClick ? 'button' : 'status'}
                  tabIndex={
                    phase === 'exit' || (!liveSingle && !historyPrimary && !displayed?.onClick)
                      ? undefined
                      : 0
                  }
                  aria-label={
                    liveSingle
                      ? `打开运行中的会话：${liveSingle.title}`
                      : historyPrimary
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
        </div>
      </AppTooltip>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="status-ticker-inbox titlebar-no-drag"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="status-ticker-inbox__titlebar">
          <span>通知中心</span>
          {history.length > 0 ? (
            <button type="button" onClick={() => clearHistory()}>
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
          {queue.map((item) => (
            <div
              key={item.id}
              className="status-ticker-inbox__item"
              data-tone={item.tone ?? 'info'}
            >
              <button
                type="button"
                className="status-ticker-inbox__main"
                onClick={() => activateQueueItem(item)}
              >
                <span className="status-ticker-inbox__dot" aria-hidden />
                <span className="status-ticker-inbox__copy">
                  <span className="status-ticker-inbox__text">{item.text}</span>
                  <span className="status-ticker-inbox__meta">
                    {formatTickerTime(item.at)}{item.actionLabel ? ` · ${item.actionLabel}` : ''}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="status-ticker-inbox__delete"
                aria-label="删除通知"
                onClick={() => remove(item.id)}
              >
                <Trash className="size-3" weight="regular" />
              </button>
            </div>
          ))}
          {history.length > 0 ? (
            <div className="status-ticker-inbox__head status-ticker-inbox__head--notifications">
              <span>已提醒</span>
              <span>{history.length} 条</span>
            </div>
          ) : null}
          {history.map((item) => (
            <div
              key={item.id}
              className="status-ticker-inbox__item status-ticker-inbox__item--history"
              data-tone={item.tone ?? 'info'}
            >
              <button
                type="button"
                className="status-ticker-inbox__main"
                onClick={() => {
                  item.onClick?.()
                  setInboxOpen(false)
                }}
              >
                <span className="status-ticker-inbox__dot" aria-hidden />
                <span className="status-ticker-inbox__copy">
                  <span className="status-ticker-inbox__text">{item.text}</span>
                  <span className="status-ticker-inbox__meta">
                    {formatTickerTime(item.at)}{item.actionLabel ? ` · ${item.actionLabel}` : ' · 已提醒'}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="status-ticker-inbox__delete"
                aria-label="删除通知"
                onClick={() => remove(item.id)}
              >
                <Trash className="size-3" weight="regular" />
              </button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 供外部快速推送 */
export type { StatusTickerItem }
