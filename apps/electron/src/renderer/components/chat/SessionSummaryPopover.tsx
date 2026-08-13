/**
 * 会话摘要 — 本场时间线里的会诊 / 圆桌 / 班组 / 子代理目录。
 * 只索引已出现的块；当前会话没有就不显示。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  ChatsCircle,
  ListMagnifyingGlass,
  Pulse,
  Robot,
  SquaresFour,
  Stop,
  TerminalWindow,
  UsersThree,
} from '@phosphor-icons/react'
import type { SessionBackgroundProcess } from '@tagent/shared'
import {
  AppTooltip,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@tagent/ui'
import { cn } from '../../lib/utils'
import {
  COLLAB_KIND_LABEL,
  collectSessionCollabOutline,
  groupCollabItems,
  runningCollabItems,
  type CollabSourceItem,
  type SessionCollabItem,
  type SessionCollabKind,
  type SessionCollabStatus,
} from './session-collab-outline'

const SECTION_CAP = 5

const KIND_ICON: Record<SessionCollabKind, typeof UsersThree> = {
  consult: UsersThree,
  discussion: ChatsCircle,
  crew: SquaresFour,
  subagent: Robot,
}

interface SessionSummaryPopoverProps {
  sessionId: string
  /** Chat 已抽出的时间线目录 */
  timelineItems?: SessionCollabItem[]
  /** 原始 DisplayItem；未传 timelineItems 时就地收集 */
  items?: CollabSourceItem[]
  compact?: boolean
  /** tab：标签栏右侧轻图标 */
  placement?: 'composer' | 'tab'
  processes?: SessionBackgroundProcess[]
  onSelect: (item: SessionCollabItem) => void
}

function statusTone(status: SessionCollabStatus): string {
  switch (status) {
    case 'running':
      return 'text-primary'
    case 'done':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'error':
      return 'text-destructive'
    case 'cancelled':
      return 'text-muted-foreground/80'
    default:
      return 'text-muted-foreground'
  }
}

function StatusDot({ status }: { status: SessionCollabStatus }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'session-summary-dot',
        status === 'running' && 'is-running',
        status === 'done' && 'is-done',
        status === 'error' && 'is-error',
        status === 'cancelled' && 'is-cancelled',
        status === 'idle' && 'is-idle',
      )}
    />
  )
}

export function SessionSummaryPopover({
  items,
  timelineItems,
  sessionId,
  compact = false,
  placement = 'composer',
  processes = [],
  onSelect,
}: SessionSummaryPopoverProps): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<SessionCollabKind | 'all'>('all')
  const [expanded, setExpanded] = useState<Partial<Record<SessionCollabKind | 'running', boolean>>>({})
  const isTab = placement === 'tab'

  const outline = useMemo(() => {
    if (timelineItems) {
      const counts = { consult: 0, discussion: 0, crew: 0, subagent: 0 }
      let runningCount = 0
      for (const it of timelineItems) {
        counts[it.kind] += 1
        if (it.status === 'running') runningCount += 1
      }
      return { items: timelineItems, counts, runningCount }
    }
    return collectSessionCollabOutline(items ?? [])
  }, [items, timelineItems])

  const visible = outline.items.length > 0 || processes.length > 0
  const running = useMemo(() => runningCollabItems(outline.items), [outline.items])
  const groups = useMemo(() => groupCollabItems(outline.items, filter), [outline.items, filter])

  const chips = useMemo(() => {
    const kinds: SessionCollabKind[] = ['consult', 'discussion', 'crew', 'subagent']
    return kinds
      .filter((k) => outline.counts[k] > 0)
      .map((k) => ({ kind: k, count: outline.counts[k] }))
  }, [outline.counts])

  useEffect(() => {
    setFilter('all')
    setExpanded({})
  }, [sessionId])

  if (!visible && !open) return null

  const handlePick = (item: SessionCollabItem): void => {
    setOpen(false)
    onSelect(item)
  }

  const total = outline.items.length
  const runningCount = outline.runningCount

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AppTooltip
        label={
          runningCount > 0
            ? `本场摘要 · ${runningCount} 项进行中`
            : total > 0
              ? `本场摘要 · ${total} 项协作`
              : '本场摘要'
        }
        disabled={open}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              isTab
                ? 'tab-summary-btn titlebar-no-drag inline-flex shrink-0 items-center justify-center'
                : 'composer-summary-btn inline-flex h-7 shrink-0 items-center justify-center rounded-lg transition-colors',
              !isTab && (compact ? 'w-7 px-0' : 'gap-1 px-2'),
              !isTab &&
                (open
                  ? 'bg-primary/12 text-primary'
                  : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground'),
            )}
            aria-label="打开会话摘要"
            aria-expanded={open}
          >
            <ListMagnifyingGlass
              className={isTab ? 'size-3.5' : 'size-3.5 shrink-0'}
              weight={isTab ? 'regular' : 'bold'}
            />
            {!isTab && !compact ? (
              <span className="tab-summary-btn__label text-[11px] font-semibold">摘要</span>
            ) : null}
            {isTab && (runningCount > 0 || processes.length > 0) ? (
              <span className="tab-summary-btn__dot" aria-hidden />
            ) : runningCount > 0 ? (
              <span className="session-summary-badge" aria-hidden>
                {runningCount}
              </span>
            ) : total > 0 && compact && !isTab ? (
              <span className="session-summary-badge is-idle" aria-hidden>
                {total > 9 ? '9+' : total}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        collisionPadding={12}
        className="session-summary-popover w-[320px] max-w-[calc(100vw-24px)] p-0"
      >
        <div className="session-summary-head">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold tracking-tight">本场摘要</div>
            <div className="truncate text-[10.5px] text-muted-foreground">
              {processes.length > 0
                ? `${processes.length} 个后台进程${total > 0 ? ` · ${total} 项协作` : ''}`
                : total === 0
                  ? '会诊、圆桌、班组会汇总在这里'
                  : runningCount > 0
                    ? `${runningCount} 项进行中 · 共 ${total} 项`
                    : `共 ${total} 项协作`}
            </div>
          </div>
        </div>

        {chips.length > 1 ? (
          <div className="session-summary-chips" role="tablist" aria-label="按类型筛选">
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'all'}
              className={cn('session-summary-chip', filter === 'all' && 'is-active')}
              onClick={() => setFilter('all')}
            >
              全部
            </button>
            {chips.map((chip) => (
              <button
                key={chip.kind}
                type="button"
                role="tab"
                aria-selected={filter === chip.kind}
                className={cn('session-summary-chip', filter === chip.kind && 'is-active')}
                onClick={() => setFilter(chip.kind)}
              >
                {COLLAB_KIND_LABEL[chip.kind]} {chip.count}
              </button>
            ))}
          </div>
        ) : null}

        <div className="session-summary-body">
          {processes.length > 0 && (filter === 'all') ? (
            <ProcessSection sessionId={sessionId} processes={processes} />
          ) : null}
          {outline.items.length === 0 && groups.length === 0 && processes.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">
              本场还没有会诊、圆桌或班组
            </div>
          ) : outline.items.length === 0 && processes.length > 0 ? null : (
            <>
              {filter === 'all' && running.length > 0 ? (
                <Section
                  kindLabel="进行中"
                  icon={Pulse}
                  items={running}
                  expanded={Boolean(expanded.running)}
                  onToggle={() =>
                    setExpanded((prev) => ({ ...prev, running: !prev.running }))
                  }
                  onPick={handlePick}
                />
              ) : null}
              {groups.map((group) => {
                const Icon = KIND_ICON[group.kind]
                return (
                  <Section
                    key={group.kind}
                    kindLabel={COLLAB_KIND_LABEL[group.kind]}
                    icon={Icon}
                    items={group.items}
                    expanded={Boolean(expanded[group.kind])}
                    onToggle={() =>
                      setExpanded((prev) => ({ ...prev, [group.kind]: !prev[group.kind] }))
                    }
                    onPick={handlePick}
                  />
                )
              })}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Section({
  kindLabel,
  icon: Icon,
  items,
  expanded,
  onToggle,
  onPick,
}: {
  kindLabel: string
  icon: typeof UsersThree
  items: SessionCollabItem[]
  expanded: boolean
  onToggle: () => void
  onPick: (item: SessionCollabItem) => void
}): JSX.Element {
  const visible = expanded ? items : items.slice(0, SECTION_CAP)
  const hidden = Math.max(0, items.length - visible.length)
  return (
    <section className="session-summary-section">
      <div className="session-summary-section__head">
        <Icon className="size-3 shrink-0" weight="bold" />
        <span className="flex-1 truncate">{kindLabel}</span>
        <span className="tabular-nums text-muted-foreground/70">{items.length}</span>
      </div>
      <div className="flex flex-col">
        {visible.map((item) => (
          <button
            key={item.id}
            type="button"
            className="session-summary-row"
            onClick={() => onPick(item)}
          >
            <StatusDot status={item.status} />
            <span className="min-w-0 flex-1">
              <span className="session-summary-row__title">{item.title}</span>
              {item.subtitle ? (
                <span className="session-summary-row__sub">{item.subtitle}</span>
              ) : null}
            </span>
            <span className={cn('session-summary-row__status', statusTone(item.status))}>
              {item.statusLabel}
            </span>
          </button>
        ))}
        {hidden > 0 ? (
          <button type="button" className="session-summary-more" onClick={onToggle}>
            再显示 {hidden} 个
          </button>
        ) : null}
      </div>
    </section>
  )
}

function ProcessSection({
  sessionId,
  processes,
}: {
  sessionId: string
  processes: SessionBackgroundProcess[]
}): JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)
  const visible = expanded ? processes : processes.slice(0, 0)

  const stop = async (id: string): Promise<void> => {
    if (busyId) return
    setBusyId(id)
    try {
      await window.electronAPI.killSessionProcess?.(sessionId, id)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="session-summary-section">
      <div className="session-summary-section__head">
        <TerminalWindow className="size-3 shrink-0" weight="bold" />
        <span className="flex-1 truncate">后台进程</span>
        <span className="tabular-nums text-muted-foreground/70">{processes.length}</span>
      </div>
      <div className="flex flex-col">
        {visible.map((proc) => (
          <div key={proc.id} className="session-summary-proc">
            <StatusDot status="running" />
            <span className="session-summary-proc__cmd" title={proc.command}>
              {proc.command}
            </span>
            <button
              type="button"
              className="session-summary-proc__stop"
              disabled={busyId === proc.id}
              onClick={() => void stop(proc.id)}
              aria-label={`停止 ${proc.command}`}
            >
              <Stop className="size-3" weight="fill" />
            </button>
          </div>
        ))}
        {processes.length > 0 ? (
          <button
            type="button"
            className="session-summary-more"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? '收起' : `展开 ${processes.length} 个`}
          </button>
        ) : null}
      </div>
    </section>
  )
}
