/**
 * 班组进度条：主会话底部简报
 *
 * - 折叠/展开时通知 Chat 重测滚动箭头锚点
 * - 任务详情：状态 + 说明 + 过程 + 结果；工人 transcript 内嵌，**不**打开侧栏会话
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CaretDown, CaretUp, UsersThree } from '@phosphor-icons/react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@tagent/ui'
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

type BoardScope = 'active' | 'history'

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
    case 'review':
      return 'bg-violet-500/80'
    case 'cancelled':
      return 'bg-muted-foreground/30'
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

/** 从 getMessages 原始条目抽可读文本行 */
function extractTranscriptLines(rawList: unknown[]): string[] {
  const lines: string[] = []
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    // IR assistant
    if (m.type === 'assistant' && Array.isArray(m.content)) {
      const text = (m.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c?.type === 'text' && c.text)
        .map((c) => c.text as string)
        .join('')
        .trim()
      if (text) lines.push(text)
      continue
    }
    // SDK assistant
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
      continue
    }
    // IR user
    if (m.type === 'user' && Array.isArray(m.content)) {
      const text = (m.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c?.type === 'text' && c.text)
        .map((c) => c.text as string)
        .join('')
        .trim()
      if (text && !text.startsWith('#')) lines.push(`› ${text.slice(0, 200)}`)
    }
  }
  return lines
}

function notifyComposerRemeasure(): void {
  window.dispatchEvent(new CustomEvent('tagent:composer-top-remeasure'))
  // 多帧兜底（列表展开动画 / 字体布局）
  requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent('tagent:composer-top-remeasure'))
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('tagent:composer-top-remeasure'))
    })
  })
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('tagent:composer-top-remeasure'))
  }, 80)
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('tagent:composer-top-remeasure'))
  }, 200)
}

/** 本会话相关的板：绑定 boardId、或 parentSessionId=当前会话 */
function belongsToSession(b: BoardRow, sessionId: string, boardId?: string | null): boolean {
  if (boardId && b.id === boardId) return true
  if (b.parentSessionId && b.parentSessionId === sessionId) return true
  return false
}

export function KanbanCrewStrip({
  sessionId,
  boardId,
}: {
  sessionId: string
  boardId?: string | null
}): JSX.Element | null {
  const [activeBoards, setActiveBoards] = useState<BoardRow[]>([])
  const [historyBoards, setHistoryBoards] = useState<BoardRow[]>([])
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [open, setOpen] = useState(false)
  /** 进行中 | 历史：完成后可回看 */
  const [scope, setScope] = useState<BoardScope>('active')
  const [viewBoardId, setViewBoardId] = useState<string | null>(boardId ?? null)
  const [detailTask, setDetailTask] = useState<TaskRow | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [workerTranscript, setWorkerTranscript] = useState<string[]>([])
  const [workerLoading, setWorkerLoading] = useState(false)

  const reload = useCallback(async () => {
    try {
      // 一次拉全量，再按会话 + 状态拆分（历史可回看）
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

      // 选中板：优先当前 scope 下的 viewBoardId，否则 scope 列表首项
      setViewBoardId((prev) => {
        const pool = scope === 'history' ? history : active
        if (prev && pool.some((b) => b.id === prev)) return prev
        if (scope === 'active' && boardId && active.some((b) => b.id === boardId)) {
          return boardId
        }
        return pool[0]?.id ?? null
      })
    } catch {
      setActiveBoards([])
      setHistoryBoards([])
    }
  }, [boardId, sessionId, scope])

  // 选中板变化 → 拉任务
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

  // 无进行中、有历史 → 自动切到历史（方便回看）
  useEffect(() => {
    if (activeBoards.length === 0 && historyBoards.length > 0 && scope === 'active') {
      setScope('history')
    }
  }, [activeBoards.length, historyBoards.length, scope])

  // 展开/折叠 / 切 scope → 立刻重测下箭头
  useEffect(() => {
    notifyComposerRemeasure()
  }, [open, tasks.length, activeBoards.length, historyBoards.length, scope])

  const openDetail = useCallback(async (t: TaskRow) => {
    setDetailTask(t)
    setWorkerTranscript([])
    try {
      const full = (await window.electronAPI.kanbanGetTask?.(t.id)) as TaskRow | null
      if (full && full.id === t.id) {
        setDetailTask({ ...t, ...full })
      }
    } catch {
      /* 列表兜底 */
    }
  }, [])

  // 详情内嵌加载工人 transcript（不进侧栏）
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
        if (cancelled) return
        setWorkerTranscript(extractTranscriptLines(Array.isArray(history) ? history : []))
      } catch {
        if (!cancelled) setWorkerTranscript([])
      } finally {
        if (!cancelled) setWorkerLoading(false)
      }
    }
    void load()
    // running 时轮询
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

  const scopeBoards = scope === 'history' ? historyBoards : activeBoards
  const hasAny = activeBoards.length > 0 || historyBoards.length > 0
  if (!hasAny) return null

  const board =
    scopeBoards.find((b) => b.id === viewBoardId) ?? scopeBoards[0] ?? null
  const isHistoryScope = scope === 'history'
  const blockerIds = detailTask?.blockers ?? detailTask?.dependsOnTaskIds ?? []
  const progressLogs = detailTask?.metadata?.progressLogs ?? []
  const blackboard = detailTask?.metadata?.blackboard ?? []
  const blockedApprovals = detailTask?.metadata?.blockedApprovals ?? []

  const switchScope = (next: BoardScope): void => {
    setScope(next)
    const pool = next === 'history' ? historyBoards : activeBoards
    setViewBoardId(pool[0]?.id ?? null)
    setOpen(true)
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
    <div className="kanban-crew-strip pointer-events-auto mx-3 mb-2 overflow-hidden rounded-xl border border-border/50 bg-background/80 shadow-sm backdrop-blur-md">
      <div className="flex w-full items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs hover:bg-foreground/5"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? '收起班组' : '展开班组'}
        >
          <UsersThree className="size-3.5 shrink-0 text-primary" weight="bold" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {isHistoryScope ? '历史班组' : '班组'}
            {board ? ` · ${board.title || board.rootGoal || board.id}` : ''}
          </span>
          <span className="kanban-crew-counts shrink-0 tabular-nums text-muted-foreground">
            {tasks.length > 0 ? (
              <>
                {counts.done}/{tasks.length}
                {!isHistoryScope && counts.running > 0 ? ` · ${counts.running} 执行中` : ''}
                {!isHistoryScope && counts.ready > 0 ? ` · ${counts.ready} 排队` : ''}
                {counts.failed > 0 ? ` · ${counts.failed} 失败` : ''}
              </>
            ) : (
              isHistoryScope ? `${historyBoards.length} 个` : '暂无'
            )}
          </span>
          {open ? (
            <CaretUp className="size-3.5 shrink-0 opacity-60" aria-hidden />
          ) : (
            <CaretDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
          )}
        </button>
        {/* 进行中 / 历史 切换 */}
        <div className="kanban-crew-scope flex shrink-0 items-center rounded-lg border border-border/50 p-0.5">
          <button
            type="button"
            className={cn(
              'rounded-md px-2 py-1 text-[10px] font-semibold transition-colors',
              scope === 'active'
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => switchScope('active')}
            aria-pressed={scope === 'active'}
          >
            进行中{activeBoards.length > 0 ? ` ${activeBoards.length}` : ''}
          </button>
          <button
            type="button"
            className={cn(
              'rounded-md px-2 py-1 text-[10px] font-semibold transition-colors',
              scope === 'history'
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => switchScope('history')}
            aria-pressed={scope === 'history'}
            disabled={historyBoards.length === 0 && activeBoards.length > 0}
          >
            历史{historyBoards.length > 0 ? ` ${historyBoards.length}` : ''}
          </button>
        </div>
      </div>

      {open ? (
        <div className="border-t border-border/40">
          {/* 多板时可选板 */}
          {scopeBoards.length > 1 ? (
            <div className="flex gap-1 overflow-x-auto px-2 pt-1.5">
              {scopeBoards.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={cn(
                    'shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors',
                    viewBoardId === b.id
                      ? 'bg-primary/15 text-primary'
                      : 'bg-foreground/5 text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setViewBoardId(b.id)}
                >
                  {(b.title || b.rootGoal || b.id).slice(0, 16)}
                  {b.status === 'completed' ? ' · 完' : b.status === 'cancelled' ? ' · 消' : ''}
                </button>
              ))}
            </div>
          ) : null}

          <ul className="kanban-crew-list max-h-44 space-y-0.5 overflow-auto px-2 py-1.5">
            {!board ? (
              <li className="px-1 py-1 text-[11px] text-muted-foreground">
                {isHistoryScope ? '本会话暂无已完成班组' : '暂无进行中的班组'}
              </li>
            ) : tasks.length === 0 ? (
              <li className="px-1 py-1 text-[11px] text-muted-foreground">该板暂无任务</li>
            ) : (
              tasks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="kanban-crew-task-row flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left text-[11px] leading-snug text-muted-foreground hover:bg-foreground/5"
                    onClick={() => void openDetail(t)}
                    aria-label={`查看任务：${t.title}`}
                  >
                    <span
                      className={cn(
                        'mt-0.5 size-1.5 shrink-0 rounded-full',
                        statusDotClass(t.status),
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-foreground/90">{t.title}</span>
                      <span className="ml-1 opacity-70">
                        {STATUS_LABEL[t.status] ?? t.status}
                        {t.roleId ? ` · ${t.roleId}` : ''}
                      </span>
                      {t.status === 'done' && t.resultSummary ? (
                        <span className="mt-0.5 block truncate opacity-75">
                          {t.resultSummary.replace(/\s+/g, ' ').slice(0, 100)}
                        </span>
                      ) : null}
                      {t.status === 'blocked' && t.blockedReason ? (
                        <span className="mt-0.5 block truncate text-amber-600/90 dark:text-amber-400/90">
                          {t.blockedReason}
                        </span>
                      ) : null}
                      {t.status === 'failed' && t.error ? (
                        <span className="mt-0.5 block truncate text-destructive/90">{t.error}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      <Dialog
        open={detailTask != null}
        onOpenChange={(next) => {
          if (!next) setDetailTask(null)
        }}
      >
        <DialogContent className="kanban-crew-detail session-glass-modal max-h-[min(82vh,600px)] w-[min(460px,calc(100vw-2rem))] gap-0 overflow-hidden p-0 sm:max-w-md">
          {detailTask ? (
            <>
              <div className="border-b border-border/50 px-4 py-3">
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      statusDotClass(detailTask.status),
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <DialogTitle className="text-sm font-semibold tracking-tight">
                      {detailTask.title}
                    </DialogTitle>
                    <DialogDescription className="mt-0.5 text-[11px] text-muted-foreground">
                      {STATUS_LABEL[detailTask.status] ?? detailTask.status}
                      {detailTask.roleId ? ` · ${detailTask.roleId}` : ''}
                      {detailTask.modelId ? ` · ${detailTask.modelId}` : ''}
                    </DialogDescription>
                  </div>
                </div>
              </div>

              <div className="kanban-crew-detail__body space-y-3 overflow-y-auto px-4 py-3 text-[12px]">
                <div className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1.5">
                  <span className="text-muted-foreground">状态</span>
                  <span className="font-medium text-foreground">
                    {STATUS_LABEL[detailTask.status] ?? detailTask.status}
                  </span>
                  {detailTask.startedAt ? (
                    <>
                      <span className="text-muted-foreground">开始</span>
                      <span className="tabular-nums text-[11px]">
                        {formatMessageTime(detailTask.startedAt)}
                      </span>
                    </>
                  ) : null}
                  {detailTask.finishedAt ? (
                    <>
                      <span className="text-muted-foreground">结束</span>
                      <span className="tabular-nums text-[11px]">
                        {formatMessageTime(detailTask.finishedAt)}
                      </span>
                    </>
                  ) : null}
                </div>

                {detailTask.body ? (
                  <div>
                    <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                      任务说明
                    </div>
                    <pre className="kanban-crew-detail__summary max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-foreground/[0.04] px-2.5 py-1.5 font-sans text-[11.5px] leading-relaxed text-foreground/90">
                      {detailTask.body}
                    </pre>
                  </div>
                ) : null}

                {/* 结果优先展示 */}
                {detailTask.resultSummary ? (
                  <div>
                    <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                      结果摘要
                    </div>
                    <pre className="kanban-crew-detail__summary max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5 font-sans text-[11.5px] leading-relaxed text-foreground/90">
                      {detailTask.resultSummary}
                    </pre>
                  </div>
                ) : null}

                {detailTask.error ? (
                  <div>
                    <div className="mb-0.5 text-[11px] font-medium text-destructive">错误</div>
                    <p className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-destructive/95">
                      {detailTask.error}
                    </p>
                  </div>
                ) : null}

                {detailTask.blockedReason ? (
                  <div>
                    <div className="mb-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                      阻塞原因
                    </div>
                    <p className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] leading-relaxed">
                      {detailTask.blockedReason}
                    </p>
                  </div>
                ) : null}

                {progressLogs.length > 0 ? (
                  <div>
                    <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                      进度日志
                    </div>
                    <ul className="kanban-crew-detail__log space-y-1.5 rounded-lg bg-foreground/[0.03] px-2.5 py-2">
                      {progressLogs.map((log, i) => (
                        <li key={`${log.ts}-${i}`} className="text-[11.5px] leading-snug">
                          <span className="mr-1.5 tabular-nums text-muted-foreground/70">
                            {formatMessageTime(log.ts)}
                          </span>
                          <span className="text-foreground/90">{log.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/* 工人输出过程（内嵌，不占侧栏会话） */}
                <div>
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      工人输出过程
                    </span>
                    {workerLoading ? (
                      <span className="text-[10px] text-muted-foreground">加载中…</span>
                    ) : null}
                  </div>
                  {workerTranscript.length > 0 ? (
                    <div className="kanban-crew-detail__log space-y-2 rounded-lg border border-border/40 bg-foreground/[0.03] px-2.5 py-2">
                      {workerTranscript.map((line, i) => (
                        <p
                          key={i}
                          className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-foreground/88"
                        >
                          {line}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg bg-foreground/[0.03] px-2.5 py-2 text-[11px] text-muted-foreground">
                      {detailTask.status === 'running'
                        ? '工人执行中，输出将在此刷新（不会出现在侧栏会话列表）。'
                        : detailTask.resultSummary
                          ? '完整过程日志为空；上方「结果摘要」为最终交付。'
                          : '暂无工人输出。若任务刚结束，可关闭后重新点开。'}
                    </p>
                  )}
                </div>

                {blackboard.length > 0 ? (
                  <div>
                    <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                      交接备注
                    </div>
                    <ul className="space-y-1.5">
                      {blackboard.map((c, i) => (
                        <li
                          key={`${c.ts}-${i}`}
                          className="rounded-lg bg-foreground/[0.04] px-2.5 py-1.5 text-[11.5px]"
                        >
                          <span className="text-muted-foreground">
                            {c.author} · {formatMessageTime(c.ts)}
                          </span>
                          <div className="mt-0.5 text-foreground/90">{c.comment}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {blockedApprovals.length > 0 ? (
                  <div>
                    <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                      自动拒绝的审批
                    </div>
                    <ul className="space-y-1 text-[11px] text-muted-foreground">
                      {blockedApprovals.slice(-8).map((a, i) => (
                        <li key={i} className="font-mono">
                          {a.tool ?? 'tool'}
                          {a.reason ? ` — ${a.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {blockerIds.length > 0 ? (
                  <div>
                    <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                      前置任务
                    </div>
                    <ul className="space-y-0.5">
                      {blockerIds.map((id) => (
                        <li key={id} className="truncate font-mono text-[11px] text-muted-foreground">
                          {taskTitleById.get(id) ?? id}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border/50 px-4 py-2.5">
                {!isHistoryScope && detailTask.status === 'blocked' ? (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void onUnblock()}
                    className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-[12px] font-semibold text-amber-800 transition-colors hover:bg-amber-500/25 disabled:opacity-50 dark:text-amber-300"
                  >
                    {actionBusy ? '处理中…' : '解除阻塞'}
                  </button>
                ) : null}
                {!isHistoryScope && detailTask.status === 'failed' ? (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void onRetry()}
                    className="rounded-lg bg-primary/15 px-3 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary/25 disabled:opacity-50"
                  >
                    {actionBusy ? '处理中…' : '重试'}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setDetailTask(null)}
                  className="rounded-lg px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  关闭
                </button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
