/**
 * 协作室工作面板（S5 室级任务/产物面板）。
 *
 * 房间右侧可折叠全高栏：任务按 todo/in_progress/blocked/done/failed 分组，产物按时间列出。
 * 任务与产物都是主进程落盘的真值；本组件只读其字段做展示与链接，绝不自行推导状态或路径。
 *
 * 能力：
 * - 任务：分组展示标题/负责人/状态/阻塞失败/关联 run/产物数；展开可改派、切换状态（严格状态机
 *   的合法下一状态）、定位关联 run/消息；可新建任务（挂板时 fail-closed，主进程拒绝）。
 * - 产物：展示 relativePath/作者/时间/sha 短码/关联任务/关联 run；可预览文本（只传 artifactId，
 *   主进程按记录反查后复用安全路径解析读盘，渲染层不传路径）；从产物定位任务/run。
 * - 无关联时明确显示「无关联 run / 无关联任务 / 无关联消息」。
 * - 成员模型权限不在此扩大：面板的 create/update 走宿主 IPC，与 room_task_update 模型工具同一真值层
 *   与同一守卫（挂板 fail-closed、负责人归属、严格状态机、CAS）；面板不暴露任意文件读。
 *
 * 数据刷新由页面在 CHANGED 广播后重新拉取并经 props 下发；本组件不是真值源。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  Eye,
  FileText,
  PencilSimple,
  Plus,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import {
  type CollaborationArtifact,
  type CollaborationMember,
  type CollaborationRoom,
  type CollaborationRoomTask,
  type CollaborationRoomTaskStatus,
  type CollaborationRun,
  type ReadCollaborationArtifactResult,
} from '@tagent/shared'
import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'
import {
  ROOM_TASK_STATUS_ORDER,
  artifactShaShort,
  buildArtifactLinkInfo,
  buildTaskLinkInfo,
  groupRoomTasksByStatus,
  legalNextTaskStatuses,
  roomTaskStatusLabel,
} from './collaborationWorkPanelModel'

/** run 状态 → 短标签（定位 run 时展示用，与时间线口径一致） */
function runStatusShort(status: CollaborationRun['status']): string {
  switch (status) {
    case 'queued':
      return '排队'
    case 'running':
      return '思考中'
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    case 'awaiting_peer':
      return '等待成员'
    case 'awaiting_user':
      return '等待用户'
    case 'blocked':
      return '阻塞'
  }
}

function formatTime(ts: number): string {
  try {
    const d = new Date(ts)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return String(ts)
  }
}

/** 任务状态徽章配色 */
function statusBadgeClass(status: CollaborationRoomTaskStatus): string {
  switch (status) {
    case 'todo':
      return 'bg-muted text-muted-foreground'
    case 'in_progress':
      return 'bg-emerald-500/15 text-emerald-600'
    case 'blocked':
      return 'bg-amber-500/15 text-amber-600'
    case 'done':
      return 'bg-sky-500/15 text-sky-600'
    case 'failed':
      return 'bg-destructive/15 text-destructive'
  }
}

export interface CollaborationWorkPanelProps {
  room: CollaborationRoom
  tasks: CollaborationRoomTask[]
  artifacts: CollaborationArtifact[]
  members: CollaborationMember[]
  runs: CollaborationRun[]
  /** 定位时间线 run（页面在时间线滚动到对应 run 卡） */
  onLocateRun: (runId: string) => void
  /** 定位时间线消息（页面在时间线滚动到对应消息） */
  onLocateMessage: (messageId: string) => void
  /** 房间数据变更后触发刷新（任务/产物创建更新后立即 bump） */
  onChanged: () => void
  /** 关闭面板（收起） */
  onClose: () => void
}

interface PreviewState {
  loading: boolean
  result: ReadCollaborationArtifactResult | null
  error: string | null
}

export function CollaborationWorkPanel({
  room,
  tasks,
  artifacts,
  members,
  runs,
  onLocateRun,
  onLocateMessage,
  onChanged,
  onClose,
}: CollaborationWorkPanelProps): JSX.Element {
  const archived = room.status === 'archived'
  const attachedBoard = Boolean(room.attachedBoardId)
  /** 挂板或归档时：任务真值归看板/只读，面板禁用创建与改派/改状态 */
  const tasksReadOnly = attachedBoard || archived

  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newAssignee, setNewAssignee] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  /** 产物预览状态（按 artifactId 切换展开；同时只预览一个，省内存） */
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewState>({
    loading: false,
    result: null,
    error: null,
  })
  /** 高亮定位到的任务行（短时清除） */
  const [highlightTaskId, setHighlightTaskId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const grouped = useMemo(() => groupRoomTasksByStatus(tasks), [tasks])
  const memberName = useCallback(
    (memberId: string | undefined): string | null => {
      if (!memberId) return null
      return members.find((m) => m.id === memberId)?.displayName ?? null
    },
    [members],
  )
  const runLabel = useCallback(
    (runId: string | undefined): string | null => {
      if (!runId) return null
      const r = runs.find((x) => x.id === runId)
      return r ? `${runStatusShort(r.status)}` : null
    },
    [runs],
  )

  const createTask = useCallback(async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) return
    setBusyTaskId('__creating__')
    try {
      await window.electronAPI.createCollaborationRoomTask({
        roomId: room.id,
        title,
        description: newDesc.trim() || undefined,
        assigneeMemberId: newAssignee || undefined,
      })
      setNewTitle('')
      setNewDesc('')
      setNewAssignee('')
      setCreating(false)
      onChanged()
    } catch (err) {
      toast.error('创建任务失败', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusyTaskId(null)
    }
  }, [newTitle, newDesc, newAssignee, room.id, onChanged])

  const updateTask = useCallback(
    async (patch: {
      taskId: string
      status?: CollaborationRoomTaskStatus
      assigneeMemberId?: string
      expectedVersion: number
    }): Promise<void> => {
      setBusyTaskId(patch.taskId)
      try {
        await window.electronAPI.updateCollaborationRoomTask({
          roomId: room.id,
          taskId: patch.taskId,
          status: patch.status,
          assigneeMemberId: patch.assigneeMemberId,
          expectedVersion: patch.expectedVersion,
        })
        onChanged()
      } catch (err) {
        toast.error('更新任务失败', { description: err instanceof Error ? err.message : String(err) })
      } finally {
        setBusyTaskId(null)
      }
    },
    [room.id, onChanged],
  )

  const previewArtifact = useCallback(
    async (artifactId: string): Promise<void> => {
      if (previewId === artifactId) {
        // 再次点击收起
        setPreviewId(null)
        setPreview({ loading: false, result: null, error: null })
        return
      }
      setPreviewId(artifactId)
      setPreview({ loading: true, result: null, error: null })
      try {
        const res = await window.electronAPI.readCollaborationArtifact({
          roomId: room.id,
          artifactId,
        })
        setPreview({ loading: false, result: res, error: null })
      } catch (err) {
        setPreview({
          loading: false,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [previewId, room.id],
  )

  const locateTask = useCallback((taskId: string): void => {
    setExpandedTaskId(taskId)
    setHighlightTaskId(taskId)
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlightTaskId(null), 1600)
    const el = scrollRef.current?.querySelector(`[data-task-id="${taskId}"]`)
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  const taskCount = tasks.length
  const artifactCount = artifacts.length

  return (
    <aside className="collab-work-panel" aria-label="协作室工作面板">
      {/* 面板头 */}
      <header className="flex items-center gap-2 border-b border-border/40 px-3 py-2.5">
        <FileText size={14} className="text-primary/80" />
        <h2 className="flex-1 text-xs font-semibold text-foreground/90">工作面板</h2>
        <span className="text-[10px] text-muted-foreground" title="任务数 / 产物数">
          任务 {taskCount} · 产物 {artifactCount}
        </span>
        <AppTooltip label="收起面板" side="left">
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="收起工作面板"
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </AppTooltip>
      </header>

      {attachedBoard ? (
        <div className="mx-3 mt-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
          房间已挂载看板，任务真值由看板维护；面板内任务为只读历史，不能新建或修改。
        </div>
      ) : null}
      {archived && !attachedBoard ? (
        <div className="mx-3 mt-2 rounded-md bg-muted px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          房间已归档，任务为只读历史。
        </div>
      ) : null}

      <div ref={scrollRef} className="collab-work-panel__scroll scrollbar-thin">
        {/* ===== 任务区 ===== */}
        <section className="collab-work-panel__section">
          <div className="mb-1.5 flex items-center gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              任务
            </h3>
            {!tasksReadOnly ? (
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
                onClick={() => setCreating((v) => !v)}
                disabled={busyTaskId === '__creating__'}
              >
                <Plus size={11} />
                {creating ? '取消' : '新建任务'}
              </button>
            ) : null}
          </div>

          {creating && !tasksReadOnly ? (
            <div className="collab-work-panel__row mb-2 flex flex-col gap-1.5">
              <input
                className="w-full rounded-md border border-border/50 bg-background/60 px-2 py-1 text-xs outline-none focus:border-primary/50"
                placeholder="任务标题（必填）"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                aria-label="任务标题"
              />
              <textarea
                className="w-full resize-none rounded-md border border-border/50 bg-background/60 px-2 py-1 text-[11px] outline-none focus:border-primary/50"
                placeholder="任务说明（可选）"
                rows={2}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                aria-label="任务说明"
              />
              <select
                className="w-full rounded-md border border-border/50 bg-background/60 px-2 py-1 text-[11px] outline-none focus:border-primary/50"
                value={newAssignee}
                onChange={(e) => setNewAssignee(e.target.value)}
                aria-label="负责人"
              >
                <option value="">不指派</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                    {m.isCoordinator ? '（协调）' : ''}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  onClick={() => void createTask()}
                  disabled={!newTitle.trim() || busyTaskId !== null}
                >
                  <Plus size={11} />
                  创建
                </button>
                <button
                  type="button"
                  className="rounded-full px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setCreating(false)
                    setNewTitle('')
                    setNewDesc('')
                    setNewAssignee('')
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}

          {taskCount === 0 && !creating ? (
            <div className="rounded-md bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground">
              暂无任务。{tasksReadOnly ? '' : '点「新建任务」创建一个。'}
            </div>
          ) : null}

          {ROOM_TASK_STATUS_ORDER.map((status) => {
            const list = grouped[status]
            if (!list || list.length === 0) return null
            return (
              <div key={status} className="collab-work-panel__group">
                <div className="mb-1 flex items-center gap-1.5 px-0.5">
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', statusBadgeClass(status))}>
                    {roomTaskStatusLabel(status)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{list.length}</span>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {list.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      members={members}
                      artifacts={artifacts}
                      runs={runs}
                      expanded={expandedTaskId === task.id}
                      busy={busyTaskId === task.id}
                      readOnly={tasksReadOnly}
                      highlighted={highlightTaskId === task.id}
                      onToggle={() => setExpandedTaskId((cur) => (cur === task.id ? null : task.id))}
                      onUpdate={updateTask}
                      onLocateRun={onLocateRun}
                      onLocateMessage={onLocateMessage}
                      memberName={memberName}
                      runLabel={runLabel}
                    />
                  ))}
                </ul>
              </div>
            )
          })}
        </section>

        {/* ===== 产物区 ===== */}
        <section className="collab-work-panel__section">
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            产物
          </h3>
          {artifactCount === 0 ? (
            <div className="rounded-md bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground">
              暂无产物。成员通过 room_publish_artifact 发布后在此展示。
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {artifacts.map((art) => (
                <ArtifactRow
                  key={art.id}
                  artifact={art}
                  tasks={tasks}
                  members={members}
                  runs={runs}
                  previewOpen={previewId === art.id}
                  preview={preview}
                  onPreview={() => void previewArtifact(art.id)}
                  onLocateRun={onLocateRun}
                  onLocateTask={locateTask}
                  memberName={memberName}
                  runLabel={runLabel}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  )
}

// ===== 任务行 =====

interface TaskRowProps {
  task: CollaborationRoomTask
  members: CollaborationMember[]
  artifacts: CollaborationArtifact[]
  runs: CollaborationRun[]
  expanded: boolean
  busy: boolean
  readOnly: boolean
  highlighted: boolean
  onToggle: () => void
  onUpdate: (patch: {
    taskId: string
    status?: CollaborationRoomTaskStatus
    assigneeMemberId?: string
    expectedVersion: number
  }) => void
  onLocateRun: (runId: string) => void
  onLocateMessage: (messageId: string) => void
  memberName: (memberId: string | undefined) => string | null
  runLabel: (runId: string | undefined) => string | null
}

function TaskRow({
  task,
  members,
  artifacts,
  expanded,
  busy,
  readOnly,
  highlighted,
  onToggle,
  onUpdate,
  onLocateRun,
  onLocateMessage,
  memberName,
  runLabel,
}: TaskRowProps): JSX.Element {
  const link = buildTaskLinkInfo(task, artifacts)
  const assigneeName = memberName(task.assigneeMemberId)
  const [editAssignee, setEditAssignee] = useState(false)
  const [nextAssignee, setNextAssignee] = useState(task.assigneeMemberId ?? '')
  const nextStatuses = readOnly ? [] : legalNextTaskStatuses(task.status)

  return (
    <li
      data-task-id={task.id}
      className={cn(
        'collab-work-panel__row transition-shadow',
        highlighted && 'ring-2 ring-primary/60',
      )}
      data-status={task.status}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          className="mt-0.5 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={expanded ? '收起任务详情' : '展开任务详情'}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground/90" title={task.title}>
              {task.title}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
            <span className={cn('rounded-full px-1.5 py-0.5 font-medium', statusBadgeClass(task.status))}>
              {roomTaskStatusLabel(task.status)}
            </span>
            {assigneeName ? (
              <span title="负责人">@{assigneeName}</span>
            ) : (
              <span className="italic opacity-70">未指派</span>
            )}
            {link.artifactCount > 0 ? (
              <span title="关联产物数">产物 {link.artifactCount}</span>
            ) : null}
            {runLabel(link.runId) ? (
              <button
                type="button"
                className="rounded bg-foreground/5 px-1 transition-colors hover:bg-foreground/10 hover:text-foreground"
                title="定位到时间线 run"
                onClick={() => link.runId && onLocateRun(link.runId)}
              >
                run · {runLabel(link.runId)}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {expanded ? (
        <div className="mt-2 flex flex-col gap-2 border-t border-border/30 pt-2">
          {task.description ? (
            <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/80">
              {task.description}
            </p>
          ) : null}
          {task.acceptanceCriteria ? (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground">验收标准</div>
              <p className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/80">
                {task.acceptanceCriteria}
              </p>
            </div>
          ) : null}

          {/* 关联追溯：消息 / run（无则明确显示「无」） */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span>
              消息：
              {link.sourceMessageId ? (
                <button
                  type="button"
                  className="ml-0.5 rounded px-1 text-primary hover:underline"
                  title="定位到产生该任务的消息"
                  onClick={() => onLocateMessage(link.sourceMessageId!)}
                >
                  定位
                </button>
              ) : (
                <span className="ml-0.5 italic opacity-70">无关联消息</span>
              )}
            </span>
            <span>
              run：
              {link.runId ? (
                <button
                  type="button"
                  className="ml-0.5 rounded px-1 text-primary hover:underline"
                  title="定位到时间线 run 卡"
                  onClick={() => onLocateRun(link.runId!)}
                >
                  定位
                </button>
              ) : (
                <span className="ml-0.5 italic opacity-70">无关联 run</span>
              )}
            </span>
            <span className="font-mono opacity-70" title="任务 ID / 版本">
              {task.id} · v{task.version}
            </span>
          </div>

          {/* 阻塞/失败提示 */}
          {task.status === 'blocked' ? (
            <div className="flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
              <WarningCircle size={11} /> 任务阻塞中，等待输入或依赖
            </div>
          ) : null}
          {task.status === 'failed' ? (
            <div className="flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
              <WarningCircle size={11} /> 任务失败，可重试回到待办/进行中
            </div>
          ) : null}

          {readOnly ? null : (
            <>
              {/* 状态切换：严格状态机的合法下一状态 */}
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[10px] text-muted-foreground">切换状态：</span>
                {nextStatuses.length === 0 ? (
                  <span className="text-[10px] italic opacity-70">无可用迁移</span>
                ) : (
                  nextStatuses.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={busy}
                      className="rounded-full border border-border/50 bg-foreground/[0.03] px-2 py-0.5 text-[10px] transition-colors hover:border-primary/40 hover:bg-primary/10 disabled:opacity-50"
                      title={`迁移到 ${roomTaskStatusLabel(s)}`}
                      onClick={() =>
                        onUpdate({ taskId: task.id, status: s, expectedVersion: task.version })
                      }
                    >
                      {roomTaskStatusLabel(s)}
                    </button>
                  ))
                )}
              </div>

              {/* 改派 */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">负责人：</span>
                {editAssignee ? (
                  <>
                    <select
                      className="rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] outline-none focus:border-primary/50"
                      value={nextAssignee}
                      onChange={(e) => setNextAssignee(e.target.value)}
                      aria-label="改派负责人"
                    >
                      <option value="">不指派</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName}
                          {m.isCoordinator ? '（协调）' : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
                      onClick={() => {
                        onUpdate({
                          taskId: task.id,
                          assigneeMemberId: nextAssignee,
                          expectedVersion: task.version,
                        })
                        setEditAssignee(false)
                      }}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setEditAssignee(false)
                        setNextAssignee(task.assigneeMemberId ?? '')
                      }}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border border-border/50 px-2 py-0.5 text-[10px] transition-colors hover:border-primary/40"
                    onClick={() => {
                      setNextAssignee(task.assigneeMemberId ?? '')
                      setEditAssignee(true)
                    }}
                  >
                    <PencilSimple size={10} />
                    {assigneeName ? `改派（当前 @${assigneeName}）` : '指派负责人'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </li>
  )
}

// ===== 产物行 =====

interface ArtifactRowProps {
  artifact: CollaborationArtifact
  tasks: CollaborationRoomTask[]
  members: CollaborationMember[]
  runs: CollaborationRun[]
  previewOpen: boolean
  preview: PreviewState
  onPreview: () => void
  onLocateRun: (runId: string) => void
  onLocateTask: (taskId: string) => void
  memberName: (memberId: string | undefined) => string | null
  runLabel: (runId: string | undefined) => string | null
}

function ArtifactRow({
  artifact,
  tasks,
  runs,
  previewOpen,
  preview,
  onPreview,
  onLocateRun,
  onLocateTask,
  memberName,
  runLabel,
}: ArtifactRowProps): JSX.Element {
  const link = buildArtifactLinkInfo(artifact, tasks)
  const authorName = memberName(artifact.memberId)
  const hasTask = Boolean(link.taskId)
  const taskGone = hasTask && link.taskTitle === null

  return (
    <li className="collab-work-panel__row">
      <div className="flex items-start gap-1.5">
        <FileText size={13} className="mt-0.5 shrink-0 text-primary/70" />
        <div className="min-w-0 flex-1">
          <div className="break-all text-xs font-medium text-foreground/90" title={artifact.relativePath}>
            {artifact.relativePath}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
            <span title="作者">{authorName ? `@${authorName}` : '成员'}</span>
            <span title="发布时间">{formatTime(artifact.createdAt)}</span>
            <span className="font-mono" title={`sha256：${artifact.sha256}`}>
              {artifactShaShort(artifact.sha256)}
            </span>
            <span title="字节数">{artifact.byteSize}B</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <span>
              任务：
              {hasTask && link.taskTitle ? (
                <button
                  type="button"
                  className="ml-0.5 max-w-[10rem] truncate align-middle rounded px-1 text-primary hover:underline"
                  title={link.taskTitle}
                  onClick={() => link.taskId && onLocateTask(link.taskId)}
                >
                  {link.taskTitle}
                </button>
              ) : taskGone ? (
                <span className="ml-0.5 italic opacity-70">任务已删除</span>
              ) : (
                <span className="ml-0.5 italic opacity-70">无关联任务</span>
              )}
            </span>
            <span>
              run：
              {runLabel(link.runId) ? (
                <button
                  type="button"
                  className="ml-0.5 rounded px-1 text-primary hover:underline"
                  title="定位到时间线 run 卡"
                  onClick={() => link.runId && onLocateRun(link.runId)}
                >
                  定位 · {runLabel(link.runId)}
                </button>
              ) : (
                <span className="ml-0.5 italic opacity-70">无关联 run</span>
              )}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-foreground/[0.03] px-2 py-0.5 text-[10px] transition-colors hover:border-primary/40 hover:bg-primary/10"
              onClick={onPreview}
              aria-expanded={previewOpen}
            >
              <Eye size={11} />
              {previewOpen ? '收起预览' : '预览文本'}
            </button>
            <ArrowClockwise size={11} className="text-muted-foreground/50" />
          </div>
        </div>
      </div>

      {previewOpen ? (
        <div className="mt-2 border-t border-border/30 pt-2">
          {preview.loading ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ArrowClockwise size={12} className="animate-spin" />
              读取中…
            </div>
          ) : null}
          {!preview.loading && preview.error ? (
            <div className="flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
              <WarningCircle size={11} /> {preview.error}
            </div>
          ) : null}
          {!preview.loading && preview.result && preview.result.ok ? (
            <div>
              {preview.result.truncated ? (
                <div className="mb-1 text-[10px] text-amber-600" title="文件超过预览上限，仅显示前 1MB">
                  文件较大，仅显示前 1MB（共 {preview.result.byteSize} 字节）
                </div>
              ) : null}
              <pre className="collab-work-panel__preview">{preview.result.content}</pre>
            </div>
          ) : null}
          {!preview.loading && preview.result && !preview.result.ok ? (
            <div className="flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
              <WarningCircle size={11} /> {preview.result.reason}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

