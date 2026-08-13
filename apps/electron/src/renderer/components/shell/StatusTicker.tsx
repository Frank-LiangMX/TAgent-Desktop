/**
 * 顶栏滚动通知条
 * 放在窗口标题栏中央：不挡主内容，可拖窗（非交互空白仍是 drag region）
 */
import { useEffect, useMemo, useState } from 'react'
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
  const livePrimary = urgentNotice ? null : liveSessions[0] ?? null
  const liveStartedAt = livePrimary ? sessionRunMap[livePrimary.sessionId]?.startedAt ?? null : null
  const liveElapsedMs = useLiveElapsedMs(liveStartedAt ?? undefined, livePrimary != null, 1000)

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

  const historyPrimary = !livePrimary && !displayed && history.length > 0
  const primaryText = livePrimary
    ? `运行中 · ${livePrimary.title || '未命名会话'} · ${formatElapsedDuration(liveElapsedMs)}`
    : historyPrimary
      ? `通知历史 · ${history.length} 条已提醒`
    : displayed?.text ?? ''
  const long = primaryText.length > 42
  const extraCount = Math.max(0, liveSessions.length + queue.length + history.length - 1)

  if (!displayed && !livePrimary && !historyPrimary) {
    return <div className="status-ticker status-ticker--empty" aria-hidden />
  }

  const activateQueueItem = (item: StatusTickerItem): void => {
    item.onClick?.()
    archive(item.id)
    setInboxOpen(false)
  }

  const activatePrimary = (): void => {
    if (livePrimary) {
      onOpenSession?.(livePrimary.sessionId, livePrimary.title)
      return
    }
    if (historyPrimary) {
      setInboxOpen(true)
      return
    }
    if (displayed) activateQueueItem(displayed)
  }

  return (
    <Popover open={inboxOpen} onOpenChange={setInboxOpen}>
      <AppTooltip
        label={
          livePrimary
            ? '定位到运行中的会话'
            : historyPrimary
              ? '查看通知历史'
              : displayed?.actionLabel ?? displayed?.text
        }
        side="bottom"
        disabled={inboxOpen}
      >
        <div
          className={cn(
            'status-ticker titlebar-no-drag',
            livePrimary
              ? 'status-ticker--live'
              : historyPrimary
                ? 'status-ticker--history'
                : displayed?.tone && `status-ticker--${displayed.tone}`,
            long && 'status-ticker--marquee',
            !livePrimary && phase === 'enter' && 'status-ticker--enter',
            !livePrimary && phase === 'exit' && 'status-ticker--exit',
          )}
          role={livePrimary || historyPrimary || displayed?.onClick ? 'button' : 'status'}
          aria-live="polite"
          tabIndex={phase === 'exit' || (!livePrimary && !historyPrimary && !displayed?.onClick) ? undefined : 0}
          aria-label={
            livePrimary
              ? `打开运行中的会话：${livePrimary.title}`
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
              (!livePrimary && !historyPrimary && !displayed?.onClick) ||
              phase === 'exit' ||
              (event.key !== 'Enter' && event.key !== ' ')
            ) return
            event.preventDefault()
            activatePrimary()
          }}
        >
          {livePrimary ? <span className="status-ticker__live-dot" aria-hidden /> : null}
          <div className="status-ticker__viewport">
            <div
              key={livePrimary ? `live-${livePrimary.sessionId}` : `${displayed?.id ?? 'empty'}-${tick}`}
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
          {extraCount > 0 || historyPrimary ? (
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
          ) : null}
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
