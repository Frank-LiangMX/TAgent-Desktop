/**
 * 顶栏滚动通知条
 * 放在窗口标题栏中央：不挡主内容，可拖窗（非交互空白仍是 drag region）
 */
import { useEffect, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  dismissStatusTickerAtom,
  statusTickerQueueAtom,
  type StatusTickerItem,
} from '../../atoms/status-ticker'
import { notificationPrefsAtom } from '../../atoms/notification-prefs'
import { cn } from '../../lib/utils'

export function StatusTicker(): JSX.Element {
  const enabled = useAtomValue(notificationPrefsAtom).titlebarTicker
  const queue = useAtomValue(statusTickerQueueAtom)
  const dismiss = useSetAtom(dismissStatusTickerAtom)
  const current = enabled ? queue[0] ?? null : null
  const [tick, setTick] = useState(0)

  // TTL 自动消退
  useEffect(() => {
    if (!current) return
    const ttl = current.ttlMs ?? 6000
    const t = window.setTimeout(() => dismiss(current.id), ttl)
    return () => clearTimeout(t)
  }, [current?.id, current?.ttlMs, dismiss])

  // 长文案：定时触发 CSS 重启动画
  useEffect(() => {
    if (!current) return
    setTick((n) => n + 1)
  }, [current?.id])

  const long = useMemo(() => (current?.text.length ?? 0) > 42, [current?.text])

  if (!current) {
    return <div className="status-ticker status-ticker--empty" aria-hidden />
  }

  return (
    <div
      className={cn(
        'status-ticker titlebar-no-drag',
        current.tone && `status-ticker--${current.tone}`,
      )}
      role="status"
      aria-live="polite"
      title={current.text}
      onClick={() => dismiss(current.id)}
    >
      <div className="status-ticker__viewport">
        <div
          key={`${current.id}-${tick}`}
          className={cn('status-ticker__track', long && 'status-ticker__track--marquee')}
        >
          <span className="status-ticker__text">{current.text}</span>
          {long ? (
            <span className="status-ticker__text status-ticker__text--dup" aria-hidden>
              {current.text}
            </span>
          ) : null}
        </div>
      </div>
      {queue.length > 1 ? (
        <span className="status-ticker__badge">+{queue.length - 1}</span>
      ) : null}
    </div>
  )
}

/** 供外部快速推送 */
export type { StatusTickerItem }
