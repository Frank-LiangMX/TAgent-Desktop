/**
 * 班组右栏（Phase D 布局）
 *
 * 主区对话 | 右栏班组 — 不做输入框上方窄条。
 * - 全高面板，任务列表可滚
 * - 点任务进入详情（同栏返回），工人输出内嵌
 * - 进行中 / 历史
 * - 无板时不占位；有板时右侧 edge 或工具栏可开关
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaretLeft,
  CaretRight,
  UsersThree,
  X,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { formatMessageTime } from '../../lib/time-utils'

interface BoardRow {
  id: string
  title?: string
  rootGoal?: string
  status?: string
  paused?: boolean
  parentSessionId?: string
  updatedAt?: number
  createdAt?: number
}

interface ProgressLogEntry {
  text: string
  status?: string
  lastToolName?: string
  ts: number
}

interface BlackboardComment {
  comment: string
  author: string
  ts: number
}

interface TaskRow {
  id: string
  title: string
  body?: string
  status: string
  roleId?: string
  modelId?: string
  channelId?: string
  resultSummary?: string
  error?: string
  blockedReason?: string
  assigneeSessionId?: string
  startedAt?: number
  finishedAt?: number
  createdAt?: number
  blockers?: string[]
  dependsOnTaskIds?: string[]
  metadata?: {
    progressLogs?: ProgressLogEntry[]
    blackboard?: BlackboardComment[]
    blockedApprovals?: Array<{ tool?: string; reason?: string; timestamp?: number }>
  }
}

type BoardScope = 'active' | 'history'

const STATUS_LABEL: Record<string, string> = {
  running: '执行中',
  ready: '排队',
  pending: '等待',
  blocked: '阻塞',
  review: '待验收',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-primary animate-pulse'
    case 'done':
      return 'bg-emerald-500'
    case 'failed':
      return 'bg-destructive'
    case 'ready':
      return 'bg-sky-500/70'
    case 'blocked':
      return 'bg-amber-500'
    case 'pending':
      return 'bg-muted-foreground/45'
    default:
      return 'bg-muted-foreground/30'
  }
}

function countByStatus(tasks: TaskRow[], status: string): number {
  return tasks.filter((t) => t.status === status).length
}

function workerSessionIdOf(task: TaskRow): string {
  return task.assigneeSessionId?.trim() || `kw_${task.id}`
}

function belongsToSession(b: BoardRow, sessionId: string, boardId?: string | null): boolean {
  if (boardId && b.id === boardId) return true
  if (b.parentSessionId && b.parentSessionId === sessionId) return true
  return false
}

function extractTranscriptLines(rawList: unknown[]): string[] {
  const lines: string[] = []
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    if (m.type === 'assistant' && Array.isArray(m.content)) {
      const text = (m.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c?.type === 'text' && c.text)
        .map((c) => c.text as string)
        .join('')
        .trim()
      if (text) lines.push(text)
      continue
    }
    if (m.type === 'assistant' && m.message && typeof m.message === 'object') {
      const content = (m.message as { content?: unknown }).content
      if (Array.isArray(content)) {
        const text = (content as Array<{ type?: string; text?: string }>)
          .filter((c) => c?.type === 'text' && c.text)
          .map((c) => c.text as string)
          .join('')
          .trim()
        if (text) lines.push(text)
      }
    }
  }
  return lines
}

export interface KanbanCrewPanelProps {
  sessionId: string
  boardId?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 是否有任意板（给外部 edge/按钮显示用） */
  onPresenceChange?: (hasBoards: boolean) => void
  /** 面板宽度（px，可拖宽；不传则用 CSS 默认） */
  width?: number
  /** 拖拽手柄回调（已 clamp 由父组件负责） */
  onWidthChange?: (width: number) => void
  /** 嵌入 Dockview pane 时 true：隐藏内部 X 关闭键（关走 Dockview tab ×） */
  embedded?: boolean
}

export function KanbanCrewPanel({
  sessionId,
  boardId,
  open,
  onOpenChange,
  onPresenceChange,
  width,
  onWidthChange,
  embedded = false,
}: KanbanCrewPanelProps): JSX.Element | null {
  const [activeBoards, setActiveBoards] = useState<BoardRow[]>([])
  const [historyBoards, setHistoryBoards] = useState<BoardRow[]>([])
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [scope, setScope] = useState<BoardScope>('active')
  const [viewBoardId, setViewBoardId] = useState<string | null>(boardId ?? null)
  const [detailTask, setDetailTask] = useState<TaskRow | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [workerTranscript, setWorkerTranscript] = useState<string[]>([])
  const [workerLoading, setWorkerLoading] = useState(false)

  /** 左缘拖拽调宽（pointer capture，拖出面板外仍生效） */
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!onWidthChange) return
      e.preventDefault()
      const parent = e.currentTarget.parentElement
      dragRef.current = {
        startX: e.clientX,
        startWidth: parent?.getBoundingClientRect().width ?? width ?? 380,
      }
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    },
    [onWidthChange, width],
  )
  const onResizeMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current
      if (!d || !onWidthChange) return
      // 左缘向左拖 → 面板变宽
      onWidthChange(d.startWidth + (d.startX - e.clientX))
    },
    [onWidthChange],
  )
  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }, [])

  const reload = useCallback(async () => {
    try {
      const all = (await window.electronAPI.kanbanListBoards?.({})) as BoardRow[]
      const list = Array.isArray(all) ? all : []
      const mine = list.filter((b) => belongsToSession(b, sessionId, boardId))
      const active = mine
        .filter((b) => b.status === 'active')
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      const history = mine
        .filter((b) => b.status === 'completed' || b.status === 'cancelled')
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      setActiveBoards(active)
      setHistoryBoards(history)
      onPresenceChange?.(active.length + history.length > 0)

      setViewBoardId((prev) => {
        const pool = scope === 'history' ? history : active
        if (prev && pool.some((b) => b.id === prev)) return prev
        if (scope === 'active' && boardId && active.some((b) => b.id === boardId)) return boardId
        return pool[0]?.id ?? null
      })
    } catch {
      setActiveBoards([])
      setHistoryBoards([])
      onPresenceChange?.(false)
    }
  }, [boardId, sessionId, scope, onPresenceChange])

  useEffect(() => {
    void reload()
  }, [reload, sessionId])

  useEffect(() => {
    const off1 = window.electronAPI.onKanbanChanged?.(() => {
      void reload()
    })
    const off2 = window.electronAPI.onKanbanBoardCompleted?.(() => {
      void reload()
    })
    return () => {
      off1?.()
      off2?.()
    }
  }, [reload])

  useEffect(() => {
    if (!viewBoardId) {
      setTasks([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const t = (await window.electronAPI.kanbanListTasks?.(viewBoardId)) as TaskRow[]
        if (!cancelled) setTasks(Array.isArray(t) ? t : [])
      } catch {
        if (!cancelled) setTasks([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [viewBoardId])

  useEffect(() => {
    if (activeBoards.length === 0 && historyBoards.length > 0 && scope === 'active') {
      setScope('history')
    }
  }, [activeBoards.length, historyBoards.length, scope])

  // 本会话首次出现进行中的板时自动打开右栏；用户关掉后不强制再开
  const userClosedRef = useRef(false)
  const hadActiveRef = useRef(false)
  useEffect(() => {
    if (activeBoards.length === 0) {
      hadActiveRef.current = false
      return
    }
    if (!hadActiveRef.current && !userClosedRef.current) {
      onOpenChange(true)
    }
    hadActiveRef.current = true
  }, [activeBoards.length, onOpenChange])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      userClosedRef.current = !next
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const openDetail = useCallback(async (t: TaskRow) => {
    setDetailTask(t)
    setWorkerTranscript([])
    try {
      const full = (await window.electronAPI.kanbanGetTask?.(t.id)) as TaskRow | null
      if (full?.id === t.id) setDetailTask({ ...t, ...full })
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (!detailTask) {
      setWorkerTranscript([])
      return
    }
    let cancelled = false
    const sid = workerSessionIdOf(detailTask)
    const load = async (): Promise<void> => {
      setWorkerLoading(true)
      try {
        const history = (await window.electronAPI.getMessages(sid)) as unknown[]
        if (!cancelled) {
          setWorkerTranscript(extractTranscriptLines(Array.isArray(history) ? history : []))
        }
      } catch {
        if (!cancelled) setWorkerTranscript([])
      } finally {
        if (!cancelled) setWorkerLoading(false)
      }
    }
    void load()
    const timer =
      detailTask.status === 'running'
        ? window.setInterval(() => {
            void load()
          }, 2500)
        : 0
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [detailTask?.id, detailTask?.status, detailTask?.assigneeSessionId])

  useEffect(() => {
    if (!detailTask) return
    const next = tasks.find((t) => t.id === detailTask.id)
    if (!next) return
    setDetailTask((prev) =>
      prev && prev.id === next.id
        ? {
            ...next,
            body: prev.body ?? next.body,
            metadata: next.metadata ?? prev.metadata,
            resultSummary: next.resultSummary ?? prev.resultSummary,
          }
        : next,
    )
  }, [tasks, detailTask?.id])

  const counts = useMemo(
    () => ({
      running: countByStatus(tasks, 'running'),
      ready: countByStatus(tasks, 'ready'),
      pending: countByStatus(tasks, 'pending'),
      blocked: countByStatus(tasks, 'blocked'),
      done: countByStatus(tasks, 'done'),
      failed: countByStatus(tasks, 'failed'),
    }),
    [tasks],
  )

  const taskTitleById = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of tasks) m.set(t.id, t.title)
    return m
  }, [tasks])

  const hasAny = activeBoards.length > 0 || historyBoards.length > 0
  if (!hasAny) return null

  // 关闭时只渲染 edge 入口由 Chat 负责；面板本体不挂载占宽
  if (!open) return null

  const scopeBoards = scope === 'history' ? historyBoards : activeBoards
  const board = scopeBoards.find((b) => b.id === viewBoardId) ?? scopeBoards[0] ?? null
  const isHistoryScope = scope === 'history'
  const blockerIds = detailTask?.blockers ?? detailTask?.dependsOnTaskIds ?? []
  const progressLogs = detailTask?.metadata?.progressLogs ?? []
  const blackboard = detailTask?.metadata?.blackboard ?? []
  const blockedApprovals = detailTask?.metadata?.blockedApprovals ?? []

  const switchScope = (next: BoardScope): void => {
    setScope(next)
    setDetailTask(null)
    const pool = next === 'history' ? historyBoards : activeBoards
    setViewBoardId(pool[0]?.id ?? null)
  }

  const onUnblock = async (): Promise<void> => {
    if (!detailTask || actionBusy || isHistoryScope) return
    setActionBusy(true)
    try {
      await window.electronAPI.kanbanUnblockTask?.(detailTask.id)
      await reload()
    } finally {
      setActionBusy(false)
    }
  }

  const onRetry = async (): Promise<void> => {
    if (!detailTask || actionBusy || isHistoryScope) return
    setActionBusy(true)
    try {
      await window.electronAPI.kanbanRetryTask?.(detailTask.id)
      await reload()
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <aside
      className={cn('kanban-crew-panel', embedded && 'is-embedded')}
      aria-label="班组面板"
      style={width ? { width: `${width}px`, flexBasis: `${width}px` } : undefined}
    >
      {/* 左缘拖拽调宽手柄 */}
      {onWidthChange ? (
        <div
          className="kanban-crew-panel__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整班组面板宽度"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        />
      ) : null}

      {/* 顶栏 */}
      <header className="kanban-crew-panel__header">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <UsersThree className="size-3.5 shrink-0 text-primary" weight="bold" />
          <div className="min-w-0 flex-1">
            <div className="kanban-crew-panel__title">
              {detailTask ? detailTask.title : '班组'}
            </div>
            {!detailTask && board ? (
              <div className="kanban-crew-panel__subtitle">
                {board.title || board.rootGoal || board.id}
              </div>
            ) : null}
          </div>
        </div>
        {embedded ? null : (
          <button
            type="button"
            className="kanban-crew-panel__icon-btn"
            onClick={() => handleOpenChange(false)}
            aria-label="关闭班组面板"
          >
            <X className="size-3.5" weight="bold" />
          </button>
        )}
      </header>

      {/* 进行中 / 历史 */}
      {!detailTask ? (
        <div className="kanban-crew-panel__tabs">
          <button
            type="button"
            className={cn('kanban-crew-panel__tab', scope === 'active' && 'is-active')}
            onClick={() => switchScope('active')}
          >
            进行中
            {activeBoards.length > 0 ? (
              <span className="kanban-crew-panel__tab-count">{activeBoards.length}</span>
            ) : null}
          </button>
          <button
            type="button"
            className={cn('kanban-crew-panel__tab', scope === 'history' && 'is-active')}
            onClick={() => switchScope('history')}
            disabled={historyBoards.length === 0 && activeBoards.length > 0}
          >
            历史
            {historyBoards.length > 0 ? (
              <span className="kanban-crew-panel__tab-count">{historyBoards.length}</span>
            ) : null}
          </button>
        </div>
      ) : (
        <div className="kanban-crew-panel__subhead">
          <button
            type="button"
            className="kanban-crew-panel__back"
            onClick={() => setDetailTask(null)}
          >
            <CaretLeft className="size-3" weight="bold" />
            返回任务列表
          </button>
        </div>
      )}

      {/* 多板芯片 */}
      {!detailTask && scopeBoards.length > 1 ? (
        <div className="kanban-crew-panel__boards">
          {scopeBoards.map((b) => (
            <button
              key={b.id}
              type="button"
              className={cn(
                'kanban-crew-panel__board-chip',
                viewBoardId === b.id && 'is-active',
              )}
              onClick={() => {
                setViewBoardId(b.id)
                setDetailTask(null)
              }}
            >
              {(b.title || b.rootGoal || b.id).slice(0, 20)}
              {b.status === 'completed' ? ' · 完' : b.status === 'cancelled' ? ' · 消' : ''}
            </button>
          ))}
        </div>
      ) : null}

      {/* 统计条 */}
      {!detailTask && tasks.length > 0 ? (
        <div className="kanban-crew-panel__stats">
          <span>
            {counts.done}/{tasks.length} 完成
          </span>
          {counts.running > 0 ? <span className="text-primary">{counts.running} 执行中</span> : null}
          {counts.ready + counts.pending > 0 ? (
            <span>
              {counts.ready + counts.pending} 排队
            </span>
          ) : null}
          {counts.failed > 0 ? (
            <span className="text-destructive">{counts.failed} 失败</span>
          ) : null}
          {counts.blocked > 0 ? (
            <span className="text-amber-600 dark:text-amber-400">{counts.blocked} 阻塞</span>
          ) : null}
        </div>
      ) : null}

      {/* 主体：列表 or 详情 */}
      <div className="kanban-crew-panel__body">
        {!detailTask ? (
          !board ? (
            <div className="kanban-crew-panel__empty">
              {isHistoryScope ? '本会话暂无已完成班组' : '暂无进行中的班组'}
              <p className="kanban-crew-panel__empty-hint">
                在 Work 模式下让助手建板并添加任务后，进度会出现在这里。
              </p>
            </div>
          ) : tasks.length === 0 ? (
            <div className="kanban-crew-panel__empty">该板暂无任务</div>
          ) : (
            <ul className="kanban-crew-panel__list">
              {tasks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="kanban-crew-panel__task"
                    onClick={() => void openDetail(t)}
                  >
                    <span
                      className={cn('kanban-crew-panel__dot', statusDotClass(t.status))}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="kanban-crew-panel__task-title">{t.title}</span>
                      <span className="kanban-crew-panel__task-meta">
                        {STATUS_LABEL[t.status] ?? t.status}
                        {t.roleId ? ` · ${t.roleId}` : ''}
                      </span>
                      {t.resultSummary ? (
                        <span className="kanban-crew-panel__task-summary">
                          {t.resultSummary.replace(/\s+/g, ' ')}
                        </span>
                      ) : null}
                      {t.error ? (
                        <span className="kanban-crew-panel__task-error">{t.error}</span>
                      ) : null}
                    </span>
                    <CaretRight className="size-3 shrink-0 opacity-35" />
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="kanban-crew-panel__detail">
            <div className="kanban-crew-panel__detail-meta">
              <span className="kanban-crew-panel__status-chip">
                <span className={cn('size-1.5 rounded-full', statusDotClass(detailTask.status))} />
                {STATUS_LABEL[detailTask.status] ?? detailTask.status}
              </span>
              {detailTask.roleId ? (
                <span className="kanban-crew-panel__task-meta">{detailTask.roleId}</span>
              ) : null}
              {detailTask.modelId ? (
                <span className="kanban-crew-panel__task-meta font-mono opacity-80">
                  {detailTask.modelId}
                </span>
              ) : null}
            </div>

            {(detailTask.startedAt || detailTask.finishedAt) && (
              <div className="grid grid-cols-2 gap-1.5">
                {detailTask.startedAt ? (
                  <div className="kanban-crew-panel__task-meta">
                    开始{' '}
                    <span className="tabular-nums text-foreground/80">
                      {formatMessageTime(detailTask.startedAt)}
                    </span>
                  </div>
                ) : null}
                {detailTask.finishedAt ? (
                  <div className="kanban-crew-panel__task-meta">
                    结束{' '}
                    <span className="tabular-nums text-foreground/80">
                      {formatMessageTime(detailTask.finishedAt)}
                    </span>
                  </div>
                ) : null}
              </div>
            )}

            {detailTask.body ? (
              <section>
                <h4 className="kanban-crew-panel__h">任务说明</h4>
                <pre className="kanban-crew-panel__pre">{detailTask.body}</pre>
              </section>
            ) : null}

            {detailTask.resultSummary ? (
              <section>
                <h4 className="kanban-crew-panel__h">结果摘要</h4>
                <pre className="kanban-crew-panel__pre kanban-crew-panel__pre--result">
                  {detailTask.resultSummary}
                </pre>
              </section>
            ) : null}

            {detailTask.error ? (
              <section>
                <h4 className="kanban-crew-panel__h text-destructive">错误</h4>
                <p className="kanban-crew-panel__callout kanban-crew-panel__callout--danger">
                  {detailTask.error}
                </p>
              </section>
            ) : null}

            {detailTask.blockedReason ? (
              <section>
                <h4 className="kanban-crew-panel__h text-amber-700 dark:text-amber-400">
                  阻塞原因
                </h4>
                <p className="kanban-crew-panel__callout kanban-crew-panel__callout--warn">
                  {detailTask.blockedReason}
                </p>
              </section>
            ) : null}

            {progressLogs.length > 0 ? (
              <section>
                <h4 className="kanban-crew-panel__h">进度日志</h4>
                <ul className="space-y-1.5">
                  {progressLogs.map((log, i) => (
                    <li key={`${log.ts}-${i}`} className="kanban-crew-panel__body-text">
                      <span className="mr-1.5 tabular-nums text-muted-foreground/70">
                        {formatMessageTime(log.ts)}
                      </span>
                      {log.text}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section>
              <h4 className="kanban-crew-panel__h">
                工人输出
                {workerLoading ? (
                  <span className="ml-1.5 font-normal text-muted-foreground">加载中…</span>
                ) : null}
              </h4>
              {workerTranscript.length > 0 ? (
                <div className="kanban-crew-panel__transcript">
                  {workerTranscript.map((line, i) => (
                    <p key={i} className="whitespace-pre-wrap break-words">
                      {line}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="kanban-crew-panel__body-text">
                  {detailTask.status === 'running'
                    ? '执行中，输出将在此刷新（不进侧栏会话列表）。'
                    : detailTask.resultSummary
                      ? '过程日志为空；见上方结果摘要。'
                      : '暂无工人输出。'}
                </p>
              )}
            </section>

            {blackboard.length > 0 ? (
              <section>
                <h4 className="kanban-crew-panel__h">交接备注</h4>
                <ul className="space-y-1.5">
                  {blackboard.map((c, i) => (
                    <li key={`${c.ts}-${i}`} className="kanban-crew-panel__note">
                      <div className="kanban-crew-panel__note-meta">
                        {c.author} · {formatMessageTime(c.ts)}
                      </div>
                      <div className="mt-0.5">{c.comment}</div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {blockedApprovals.length > 0 ? (
              <section>
                <h4 className="kanban-crew-panel__h">自动拒绝的审批</h4>
                <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
                  {blockedApprovals.slice(-10).map((a, i) => (
                    <li key={i}>
                      {a.tool ?? 'tool'}
                      {a.reason ? ` — ${a.reason}` : ''}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {blockerIds.length > 0 ? (
              <section>
                <h4 className="kanban-crew-panel__h">前置任务</h4>
                <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
                  {blockerIds.map((id) => (
                    <li key={id}>{taskTitleById.get(id) ?? id}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {!isHistoryScope && (detailTask.status === 'blocked' || detailTask.status === 'failed') ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {detailTask.status === 'blocked' ? (
                  <button
                    type="button"
                    disabled={actionBusy}
                    className="kanban-crew-panel__action kanban-crew-panel__action--warn"
                    onClick={() => void onUnblock()}
                  >
                    {actionBusy ? '处理中…' : '解除阻塞'}
                  </button>
                ) : null}
                {detailTask.status === 'failed' ? (
                  <button
                    type="button"
                    disabled={actionBusy}
                    className="kanban-crew-panel__action kanban-crew-panel__action--primary"
                    onClick={() => void onRetry()}
                  >
                    {actionBusy ? '处理中…' : '重试'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  )
}
