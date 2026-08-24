/**
 * 输入框左上活动浮岛（Cursor「1 Terminal」）。
 *
 * 只列主会话时间线里没有的后台任务：Bash / 单独拉起的 CLI 工人。
 * 主线子代理走消息流入口 + 右上角摘要，不进这里。
 * 收起 pill 贴在运行计时胶囊右侧；点开列出命令与耗时，进程行可停。
 */
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Stop, TerminalWindow } from '@phosphor-icons/react'
import { AppTooltip } from '@tagent/ui'
import { formatElapsedDuration, useLiveElapsedMs } from '../../lib/time-utils'
import { summarizeComposerActivity, type ComposerActivityItem } from './composer-activity-model'

function ItemElapsed({ startedAt }: { startedAt: number }): JSX.Element {
  const live = startedAt > 0
  const ms = useLiveElapsedMs(live ? startedAt : undefined, live, 1000)
  if (!live) return <></>
  return <span className="composer-activity-island__elapsed">{formatElapsedDuration(ms)}</span>
}

export function ComposerActivityIsland({
  items,
  pillLabel,
  headerLabel,
  onStopProcess,
}: {
  items: ComposerActivityItem[]
  pillLabel: string
  headerLabel: string
  onStopProcess?: (processId: string) => void
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dismissedProcessIds, setDismissedProcessIds] = useState<Set<string>>(
    () => new Set(),
  )
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (items.length === 0) setOpen(false)
  }, [items.length])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const el = rootRef.current
      if (el && !el.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const visibleItems = items.filter((item) => !dismissedProcessIds.has(item.id))
  useEffect(() => {
    if (visibleItems.length === 0) setOpen(false)
  }, [visibleItems.length])

  if (visibleItems.length === 0) return null

  const visibleSummary = summarizeComposerActivity(visibleItems)

  const stop = async (processId: string, itemId: string): Promise<void> => {
    if (!onStopProcess || busyId) return
    setBusyId(processId)
    try {
      await onStopProcess(processId)
      setDismissedProcessIds((current) => {
        const next = new Set(current)
        next.add(itemId)
        return next
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`composer-activity-island${open ? ' is-open' : ''}`}
    >
      {open ? (
        <div className="composer-activity-island__panel" role="dialog" aria-label={visibleSummary.headerLabel || headerLabel}>
          <div className="composer-activity-island__head">
            <span className="composer-activity-island__head-title">{visibleSummary.headerLabel || headerLabel}</span>
            <button
              type="button"
              className="composer-activity-island__close"
              aria-label="收起"
              onClick={() => setOpen(false)}
            >
              <X className="size-3.5" />
            </button>
          </div>
          <ul className="composer-activity-island__list">
            {visibleItems.map((it) => (
              <li key={it.id} className="composer-activity-island__row">
                <span className="composer-activity-island__prompt" aria-hidden>
                  <TerminalWindow className="size-3.5" weight="bold" />
                  <span className="composer-activity-island__chevron">&gt;</span>
                </span>
                <span className="composer-activity-island__title" title={it.title}>
                  {it.title}
                </span>
                <ItemElapsed startedAt={it.startedAt} />
                {it.processId && onStopProcess ? (
                  <AppTooltip label={`停止 ${it.title}`}>
                    <button
                      type="button"
                      className="composer-activity-island__stop"
                      disabled={busyId === it.processId}
                      aria-label={`停止 ${it.title}`}
                      onClick={() => void stop(it.processId, it.id)}
                    >
                      <Stop className="size-3" weight="fill" />
                    </button>
                  </AppTooltip>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <button
          type="button"
          className="composer-activity-island__pill"
          aria-expanded={false}
          aria-label={`${visibleSummary.pillLabel || pillLabel}，展开查看`}
          onClick={() => setOpen(true)}
        >
          {visibleSummary.pillLabel || pillLabel}
        </button>
      )}
    </div>
  )
}
