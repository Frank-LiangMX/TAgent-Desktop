/**
 * 会话列表侧栏 — D 方案(形态重构 + 状态色点 + 时间桶 + 已归档 + 动效)
 *
 * 结构:顶行(标题/Threads + 新建+工作区胶囊)→ 搜索行 → 置顶栏 → 滚动列表
 *       (workspace 分组 + 当前 ws 内静态时间分段,默认只展开当前 ws)→ 已归档底部固定区
 * 状态色点:从 sessionStatusMapAtom 派生(idle/running/error),running 由 onStreamEvent 实时更新。
 * 选中态:左边框 primary + 行玻璃高光(无独立竖条)。
 * 折叠/展开:CSS max-height 过渡(不用 motion height auto,避免收不回);motion 只管 layout 重排。
 * 置顶后会话仍在列表原位,置顶栏是额外陈列。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { motion } from 'motion/react'
import type { AgentWorkspace } from '@tagent/shared'
import {
  FolderOpen,
  CaretRight,
  ChatsCircle,
  PencilSimple,
  PushPin,
  Trash,
  DotsThreeVertical,
  DotsSixVertical,
  Archive,
  MagnifyingGlass,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { getPlatform } from '../../lib/platform'
import {
  AppTooltip,
  DestructiveConfirmDialog,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@tagent/ui'
import { sessionsRefreshAtom } from '../../atoms/channel-atoms'
import { workspacesAtom } from '../../atoms/workspace-atoms'
import {
  sessionStatusMapAtom,
  initSessionStatusAtom,
  setSessionStatusAtom,
  setSessionArchivedAtom,
  type SessionStatus,
} from '../../atoms/session-status-atoms'

interface SessionMeta {
  id: string
  title: string
  modelId?: string
  channelId?: string
  workspaceId?: string
  createdAt?: number
  updatedAt?: number
  turnCount?: number
  pinned?: boolean
  archived?: boolean
  status?: SessionStatus
}

interface WorkspaceGroup {
  id: string
  name: string
  workspace?: AgentWorkspace
  sessions: SessionMeta[]
  streamingCount: number
  errorCount: number
}

interface WorkspaceDropIndicator {
  id: string
  position: 'before' | 'after'
}

interface TimeBucket {
  name: '今天' | '昨天' | '近 7 天' | '更早'
  sessions: SessionMeta[]
}

/** 状态排序权重:进行中 → 出错 → 其余按时间 */
const STATUS_RANK: Record<SessionStatus, number> = { running: 0, error: 1, idle: 2 }

/** 列表项进场/重排 spring(对齐现代 UI 丝滑感) */
const SPRING = { type: 'spring', stiffness: 380, damping: 32, mass: 0.8 } as const

const BUCKET_ORDER: TimeBucket['name'][] = ['今天', '昨天', '近 7 天', '更早']
const EXPANDED_GROUPS_KEY = 'tagent.sidebar.expanded-groups.v1'

function readStoredSet(key: string): Set<string> | null {
  try {
    const value = localStorage.getItem(key)
    if (value === null) return null
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === 'string')) : null
  } catch {
    return null
  }
}

function storeSet(key: string, value: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...value]))
  } catch {
    // localStorage 不可用时保留当前会话内状态即可
  }
}

export function SessionSidebar({
  activeSessionId,
  onSelect,
  onNew,
  onOpenProject,
  onWorkspaceDeleted,
}: {
  activeSessionId: string | null
  onSelect: (session: SessionMeta) => void
  onNew: () => void
  onOpenProject?: () => void
  onWorkspaceDeleted?: (workspaceId: string) => void
}): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => readStoredSet(EXPANDED_GROUPS_KEY) ?? new Set(),
  )
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // 全局唤出搜索：mac ⌘K / win·linux Ctrl+K（与 kbd 提示一致）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null)
  const [workspaceDropIndicator, setWorkspaceDropIndicator] =
    useState<WorkspaceDropIndicator | null>(null)
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<SessionMeta | null>(null)
  const [deleteWorkspaceTarget, setDeleteWorkspaceTarget] =
    useState<AgentWorkspace | null>(null)
  /** 工作区三点菜单打开期间保持按钮可见（失焦组头后 :hover 失配） */
  const [workspaceMenuOpenId, setWorkspaceMenuOpenId] = useState<string | null>(null)
  const refreshCounter = useAtomValue(sessionsRefreshAtom)
  const workspaces = useAtomValue(workspacesAtom)
  const setWorkspaces = useSetAtom(workspacesAtom)
  const statusMap = useAtomValue(sessionStatusMapAtom)
  const initStatus = useSetAtom(initSessionStatusAtom)
  const setStatus = useSetAtom(setSessionStatusAtom)
  const setArchived = useSetAtom(setSessionArchivedAtom)

  const refresh = useCallback(async (): Promise<void> => {
    const list = (await window.electronAPI.listSessions()) as SessionMeta[] | undefined
    const arr = (Array.isArray(list) ? list : []).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    setSessions(arr)
    // 初始化/刷新状态表(meta 落盘值 + 批量 getSessionStatus 补 running)
    void initStatus(arr)
  }, [initStatus])

  useEffect(() => {
    void refresh()
  }, [activeSessionId, refreshCounter, refresh])

  // 侧栏默认展开最近有活动的工作区；时间段仅用于视觉分隔，不保存展开状态。
  useEffect(() => {
    if (readStoredSet(EXPANDED_GROUPS_KEY) === null) {
      const newestSession = sessions.find((session) => !session.archived && session.workspaceId)
      const firstGroupId = newestSession?.workspaceId ?? workspaces[0]?.id
      if (firstGroupId) setExpandedGroups(new Set([firstGroupId]))
    }
  }, [sessions, workspaces])

  // 订阅 onStreamEvent:turn_end → idle、session_error → error(只处理这两类,按 sessionId 更新)
  useEffect(() => {
    const off = window.electronAPI.onStreamEvent((payload: unknown) => {
      const env = payload as { sessionId?: string; payload?: { kind: string; event?: { type: string } } }
      if (env?.payload?.kind !== 'tagent_event') return
      const evt = env.payload.event
      if (!evt || !env.sessionId) return
      if (evt.type === 'turn_end') setStatus({ id: env.sessionId, status: 'idle' })
      else if (evt.type === 'session_error') setStatus({ id: env.sessionId, status: 'error' })
    })
    return off
  }, [setStatus])

  const requestDeleteSession = (id: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    const target = sessions.find((session) => session.id === id)
    if (target) setDeleteSessionTarget(target)
  }

  const deleteSession = async (): Promise<void> => {
    if (!deleteSessionTarget) return
    const target = deleteSessionTarget
    try {
      await window.electronAPI.deleteSession(target.id)
      setSessions((prev) => prev.filter((session) => session.id !== target.id))
      void refresh()
    } catch (error) {
      console.error('[会话] 删除失败:', error)
      throw new Error(`删除会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const onArchiveToggle = async (s: SessionMeta, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    setArchived({ id: s.id, archived: !s.archived })
    await window.electronAPI.toggleArchive(s.id)
    void refresh()
  }

  const startRename = (s: SessionMeta, e: React.MouseEvent): void => {
    e.stopPropagation()
    setEditingId(s.id)
    setEditingTitle(s.title)
  }

  const commitRename = async (): Promise<void> => {
    if (!editingId) return
    const title = editingTitle.trim()
    if (title) {
      await window.electronAPI.updateSessionMeta(editingId, { title })
      void refresh()
    }
    setEditingId(null)
  }

  const togglePin = async (id: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    await window.electronAPI.togglePin(id)
    void refresh()
  }

  const toggleGroup = (groupId: string): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      storeSet(EXPANDED_GROUPS_KEY, next)
      return next
    })
  }

  const deleteWorkspace = async (workspace: AgentWorkspace): Promise<void> => {
    try {
      await window.electronAPI.deleteWorkspace(workspace.id)
      const remaining = await window.electronAPI.listWorkspaces()
      setWorkspaces(remaining)
      setSessions((prev) => prev.filter((session) => session.workspaceId !== workspace.id))
      setExpandedGroups((prev) => {
        const next = new Set(prev)
        next.delete(workspace.id)
        storeSet(EXPANDED_GROUPS_KEY, next)
        return next
      })
      onWorkspaceDeleted?.(workspace.id)
      setDeleteWorkspaceTarget(null)
    } catch (error) {
      console.error('[工作区] 删除失败:', error)
      throw new Error(`删除工作区失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const startWorkspaceDrag = (event: React.DragEvent, workspaceId: string): void => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', workspaceId)
    setDragWorkspaceId(workspaceId)
  }

  const updateWorkspaceDropIndicator = (
    event: React.DragEvent,
    targetWorkspaceId: string,
  ): void => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (!dragWorkspaceId || dragWorkspaceId === targetWorkspaceId) {
      setWorkspaceDropIndicator(null)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setWorkspaceDropIndicator({
      id: targetWorkspaceId,
      position: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
    })
  }

  const finishWorkspaceDrag = (): void => {
    setDragWorkspaceId(null)
    setWorkspaceDropIndicator(null)
  }

  const dropWorkspace = async (
    event: React.DragEvent,
    targetWorkspaceId: string,
  ): Promise<void> => {
    event.preventDefault()
    const indicator = workspaceDropIndicator
    if (
      !dragWorkspaceId ||
      dragWorkspaceId === targetWorkspaceId ||
      !indicator ||
      indicator.id !== targetWorkspaceId
    ) {
      finishWorkspaceDrag()
      return
    }

    const previous = workspaces
    const orderedIds = workspaces.map((workspace) => workspace.id)
    const nextIds = orderedIds.filter((id) => id !== dragWorkspaceId)
    let insertAt = nextIds.indexOf(targetWorkspaceId)
    if (insertAt < 0) insertAt = nextIds.length
    if (indicator.position === 'after') insertAt += 1
    nextIds.splice(insertAt, 0, dragWorkspaceId)

    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
    setWorkspaces(nextIds.map((id) => byId.get(id)).filter((item): item is AgentWorkspace => Boolean(item)))
    finishWorkspaceDrag()

    try {
      const saved = await window.electronAPI.reorderWorkspaces(nextIds)
      setWorkspaces(saved)
    } catch (error) {
      console.error('[工作区] 排序保存失败:', error)
      setWorkspaces(previous)
      alert('工作区排序保存失败，已恢复原顺序')
    }
  }

  // 会话状态(归档行不用色点;非归档按 statusMap 派生,默认 idle)
  const statusOf = (s: SessionMeta): SessionStatus => {
    if (s.archived) return 'idle' // 归档行不显色点
    return statusMap[s.id]?.status ?? 'idle'
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchesQuery = (session: SessionMeta): boolean =>
    !normalizedQuery ||
    [session.title, session.modelId, session.channelId].some((value) =>
      value?.toLocaleLowerCase().includes(normalizedQuery),
    )

  const visibleWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id))
  const belongsToVisibleWorkspace = (session: SessionMeta): boolean =>
    !session.workspaceId || visibleWorkspaceIds.has(session.workspaceId)
  const pinned = sessions.filter(
    (s) => s.pinned && !s.archived && belongsToVisibleWorkspace(s) && matchesQuery(s),
  )
  const activeSessions = sessions.filter((s) => !s.archived && belongsToVisibleWorkspace(s))
  const archivedSessions = sessions.filter((s) => s.archived && belongsToVisibleWorkspace(s))
  const visibleActiveSessions = activeSessions.filter(matchesQuery)
  const visibleArchivedSessions = archivedSessions.filter(matchesQuery)
  const groups = buildGroups(visibleActiveSessions, workspaces, statusOf)
  const activeSession = activeSessions.find((session) => session.id === activeSessionId)
  const activeGroupId = activeSession?.workspaceId ?? (activeSession ? '__unclassified__' : null)
  const effectiveExpandedGroups = normalizedQuery
    ? new Set(groups.map((group) => group.id))
    : new Set(expandedGroups)
  if (activeGroupId) effectiveExpandedGroups.add(activeGroupId)

  const archivedOpen = archivedExpanded || Boolean(normalizedQuery && visibleArchivedSessions.length)
  const deleteWorkspaceSessionCount = deleteWorkspaceTarget
    ? sessions.filter((session) => session.workspaceId === deleteWorkspaceTarget.id).length
    : 0

  return (
    <div className="app-sidebar-body flex h-full min-h-0 flex-col">
      {/* 顶行:标题 + 新建/工作区胶囊 */}
      <div className="side-title">
        <span className="label">
          <span className="zh">会话</span>
          <span className="en">Threads</span>
        </span>
        <span className="title-actions">
          <AppTooltip label="新建会话" side="bottom">
            <button type="button" className="pill-new" onClick={onNew}>
              <span className="btn-ico">
                <ChatsCircle size={15} weight="regular" />
              </span>
              新建
            </button>
          </AppTooltip>
          {onOpenProject && (
            <AppTooltip label="打开项目目录 · 创建工作区" side="bottom">
              <button
                type="button"
                className="pill-icon"
                onClick={onOpenProject}
                aria-label="打开项目目录"
              >
                <FolderOpen size={14} weight="regular" />
              </button>
            </AppTooltip>
          )}
        </span>
      </div>

      {/* 搜索行 */}
      <div className="side-head">
        <div className="search">
          <MagnifyingGlass size={13} weight="regular" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话…"
            aria-label="搜索会话"
          />
          <span className="kbd">{getPlatform() === 'mac' ? '⌘K' : 'Ctrl+K'}</span>
        </div>
      </div>

      {/* 置顶栏 */}
      {pinned.length > 0 && (
        <div className="pin-rail">
          {pinned.map((s, i) => (
            <AppTooltip key={s.id} label={s.title} side="bottom" multiline>
              <button
                type="button"
                className="pin-chip"
                onClick={() => onSelect(s)}
              >
                <span className={cn('pm', `c${i % 3}`)}>{s.title.slice(0, 1) || '·'}</span>
                <span className="pt">{s.title.slice(0, 8)}</span>
              </button>
            </AppTooltip>
          ))}
        </div>
      )}

      {/* 滚动列表 */}
      <div className="side-scroll">
        {groups.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">暂无会话</div>}
        {groups.map((group) => {
          const isExpanded = effectiveExpandedGroups.has(group.id)
          const hasSessions = group.sessions.length > 0
          const isManagedWorkspace = Boolean(group.workspace)
          const groupHeaderContent = (
            <>
              {hasSessions ? (
                <CaretRight size={12} weight="regular" className="caret" />
              ) : (
                <span className="caret caret-placeholder" aria-hidden="true" />
              )}
              <span className="gname">{group.name}</span>
              <span className="ws-badge">{group.sessions.length}</span>
              {(group.streamingCount > 0 || group.errorCount > 0) && (
                <div className="ws-sub">
                  {group.streamingCount > 0 && (
                    <>
                      <span className="live">
                        {Array.from({ length: Math.min(group.streamingCount, 3) }).map((_, i) => (
                          <i key={i} />
                        ))}
                      </span>
                      <span>
                        {group.streamingCount} 进行中
                        {group.errorCount > 0 && (
                          <>
                            {' · '}<span className="err">{group.errorCount} 出错</span>
                          </>
                        )}
                      </span>
                    </>
                  )}
                  {group.streamingCount === 0 && group.errorCount > 0 && (
                    <span className="err">{group.errorCount} 个出错需关注</span>
                  )}
                </div>
              )}
            </>
          )
          return (
            <div
              key={group.id}
              className={cn(
                'group',
                isManagedWorkspace && 'workspace-group',
                isExpanded && 'open',
                dragWorkspaceId === group.id && 'workspace-dragging',
                group.streamingCount > 0 && 'has-stream',
                group.errorCount > 0 && 'has-error',
              )}
            >
              <div
                className={cn(
                  'workspace-group-head',
                  workspaceMenuOpenId === group.id && 'is-dots-open',
                )}
                onDragOver={
                  isManagedWorkspace
                    ? (event) => updateWorkspaceDropIndicator(event, group.id)
                    : undefined
                }
                onDrop={
                  isManagedWorkspace
                    ? (event) => void dropWorkspace(event, group.id)
                    : undefined
                }
              >
                {workspaceDropIndicator?.id === group.id && (
                  <span
                    className={cn(
                      'workspace-drop-indicator',
                      workspaceDropIndicator.position,
                    )}
                    aria-hidden="true"
                  />
                )}
                {group.workspace && (
                  <AppTooltip label="拖拽调整工作区顺序" side="right">
                    <button
                      type="button"
                      className="workspace-drag-handle"
                      draggable
                      onDragStart={(event) => startWorkspaceDrag(event, group.id)}
                      onDragEnd={finishWorkspaceDrag}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`拖拽调整工作区顺序：${group.name}`}
                    >
                      <DotsSixVertical size={14} weight="bold" />
                    </button>
                  </AppTooltip>
                )}
                <button
                  type="button"
                  className="group-head"
                  onClick={() => hasSessions && toggleGroup(group.id)}
                  aria-expanded={hasSessions ? isExpanded : undefined}
                  disabled={!hasSessions}
                >
                  {groupHeaderContent}
                </button>
                {group.workspace && (
                  <DropdownMenu
                    open={workspaceMenuOpenId === group.id}
                    onOpenChange={(open) => setWorkspaceMenuOpenId(open ? group.id : null)}
                  >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="workspace-menu-button"
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`工作区操作：${group.name}`}
                      >
                        <DotsThreeVertical size={14} weight="bold" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-32 p-1 text-xs">
                      <DropdownMenuItem
                        onClick={() => setDeleteWorkspaceTarget(group.workspace!)}
                        className="rounded-lg px-2 py-1 text-xs text-red-500 focus:text-red-500"
                      >
                        <Trash size={13} weight="regular" /> 删除工作区
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>

              <div className="rows">
                {renderBuckets(group.sessions, statusOf, activeSessionId, editingId, editingTitle, onSelect, requestDeleteSession, startRename, commitRename, togglePin, onArchiveToggle, setEditingTitle, () => setEditingId(null))}
              </div>
            </div>
          )
        })}
      </div>

      {/* 已归档:底部固定区。普通 .group 结构(头在上、rows 在下),折叠展开同 workspace 组(CSS max-height) */}
      {visibleArchivedSessions.length > 0 && (
        <div className="arch-foot">
          <div className={cn('group group-archived', archivedOpen && 'open')}>
            <button
              type="button"
              className="group-head"
              onClick={() => setArchivedExpanded((v) => !v)}
            >
              <CaretRight size={12} weight="regular" className="caret" />
              <span className="gname muted">已归档</span>
              <span className="ws-badge">{visibleArchivedSessions.length}</span>
            </button>
            <div className="rows">
              {visibleArchivedSessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  status="idle"
                  archived
                  active={s.id === activeSessionId}
                  editing={editingId === s.id}
                  editingTitle={editingTitle}
                  onSelect={onSelect}
                  onDelete={requestDeleteSession}
                  onRename={startRename}
                  onCommitRename={commitRename}
                  onTogglePin={togglePin}
                  onArchiveToggle={onArchiveToggle}
                  onEditingTitleChange={setEditingTitle}
                  onCancelRename={() => setEditingId(null)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <DestructiveConfirmDialog
        open={Boolean(deleteSessionTarget)}
        onOpenChange={(open) => !open && setDeleteSessionTarget(null)}
        icon={<Trash size={15} weight="duotone" />}
        title={`删除“${deleteSessionTarget?.title ?? ''}”？`}
        description="该会话的全部聊天记录将被永久删除，此操作无法撤销。"
        confirmLabel="删除会话"
        onConfirm={deleteSession}
      />

      <DestructiveConfirmDialog
        open={Boolean(deleteWorkspaceTarget)}
        onOpenChange={(open) => !open && setDeleteWorkspaceTarget(null)}
        icon={<Trash size={15} weight="duotone" />}
        title={`删除工作区“${deleteWorkspaceTarget?.name ?? ''}”？`}
        description={`将永久删除其中 ${deleteWorkspaceSessionCount} 个会话及全部聊天记录。本地项目目录不会受影响。`}
        confirmLabel="删除工作区"
        onConfirm={() =>
          deleteWorkspaceTarget ? deleteWorkspace(deleteWorkspaceTarget) : Promise.resolve()
        }
      />
    </div>
  )
}

/** 时间分段渲染：仅用于扫描，不承担折叠交互。 */
function renderBuckets(
  sessions: SessionMeta[],
  statusOf: (s: SessionMeta) => SessionStatus,
  activeSessionId: string | null,
  editingId: string | null,
  editingTitle: string,
  onSelect: (s: SessionMeta) => void,
  onDelete: (id: string, e: React.MouseEvent) => void,
  onRename: (s: SessionMeta, e: React.MouseEvent) => void,
  onCommitRename: () => Promise<void>,
  onTogglePin: (id: string, e: React.MouseEvent) => Promise<void>,
  onArchiveToggle: (s: SessionMeta, e: React.MouseEvent) => Promise<void>,
  onEditingTitleChange: (v: string) => void,
  onCancelRename: () => void,
): JSX.Element {
  const buckets = bucketize(sessions)
  return (
    <>
      {BUCKET_ORDER.map((name) => {
        const arr = buckets[name]
        if (!arr || arr.length === 0) return null
        return (
          <section key={name} className="bucket-group" aria-label={name}>
            <div className="bucket-divider">
              <span>{name}</span>
              <i aria-hidden="true" />
            </div>
            <div className="bucket-rows">
              {arr.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  status={statusOf(s)}
                  active={s.id === activeSessionId}
                  editing={editingId === s.id}
                  editingTitle={editingTitle}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onRename={onRename}
                  onCommitRename={onCommitRename}
                  onTogglePin={onTogglePin}
                  onArchiveToggle={onArchiveToggle}
                  onEditingTitleChange={onEditingTitleChange}
                  onCancelRename={onCancelRename}
                />
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}

/** 单个会话行:状态点 + pin(行首)+ 标题/轮数 + 模型/时间 + 三点菜单让位 */
function SessionRow({
  session: s,
  status,
  active,
  archived,
  editing,
  editingTitle,
  onSelect,
  onDelete,
  onRename,
  onCommitRename,
  onTogglePin,
  onArchiveToggle,
  onEditingTitleChange,
  onCancelRename,
}: {
  session: SessionMeta
  status: SessionStatus
  active: boolean
  archived?: boolean
  editing: boolean
  editingTitle: string
  onSelect: (s: SessionMeta) => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onRename: (s: SessionMeta, e: React.MouseEvent) => void
  onCommitRename: () => Promise<void>
  onTogglePin: (id: string, e: React.MouseEvent) => Promise<void>
  onArchiveToggle: (s: SessionMeta, e: React.MouseEvent) => Promise<void>
  onEditingTitleChange: (v: string) => void
  onCancelRename: () => void
}): JSX.Element {
  // 三点菜单打开时保持按钮可见（指针移开行后 .row:hover 失配，需要显式状态）
  const [dotsOpen, setDotsOpen] = useState(false)

  return (
    <motion.div
      layout={!archived} /* 归档行不做 layout 重排,避免与 arch-foot 折叠高度抢位 */
      initial={archived ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: archived ? undefined : 'auto' }}
      exit={archived ? undefined : { opacity: 0, height: 0 }}
      transition={SPRING}
      onClick={() => onSelect(s)}
      className={cn('row', active && 'is-active', archived && 'row-archived', dotsOpen && 'is-dots-open')}
    >
      {/* 行首:归档行用小方块标记,否则状态色点 */}
      {archived ? (
        <span className="arch-mark" />
      ) : (
        <span className={cn('stat-dot', status === 'running' ? 'stream' : status === 'error' ? 'error' : status === 'idle' ? 'idle' : 'done')} />
      )}
      {/* pin 行首(置顶时) */}
      {s.pinned && !archived && <PushPin size={11} weight="fill" className="pin" />}
      <div className="body">
        <div className="title">
          {editing ? (
            <input
              autoFocus
              value={editingTitle}
              onChange={(e) => onEditingTitleChange(e.target.value)}
              onBlur={() => void onCommitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onCommitRename()
                if (e.key === 'Escape') onCancelRename()
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-full border-b border-primary/50 bg-transparent text-[12px] leading-[18px] text-foreground outline-none"
            />
          ) : (
            <span className="t">{s.title}</span>
          )}
        </div>
        <div className="meta">
          {s.turnCount != null && s.turnCount > 0 && (
            <span className="m turns">{s.turnCount} 轮</span>
          )}
          <span className="m time">{archived ? '已归档' : s.updatedAt ? relTime(s.updatedAt) : ''}</span>
        </div>
      </div>
      {/* 三点菜单:hover 让位展开；打开期间保持展开（is-dots-open） */}
      <DropdownMenu open={dotsOpen} onOpenChange={setDotsOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="dots"
            onClick={(e) => e.stopPropagation()}
            aria-label="会话操作"
          >
            <DotsThreeVertical size={14} weight="regular" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-32 p-1 text-xs">
          <DropdownMenuItem onClick={(e) => onRename(s, e)} className="rounded-lg px-2 py-1 text-xs">
            <PencilSimple size={13} weight="regular" /> 重命名
          </DropdownMenuItem>
          {!archived && (
            <DropdownMenuItem onClick={(e) => void onTogglePin(s.id, e)} className="rounded-lg px-2 py-1 text-xs">
              <PushPin size={13} weight="regular" /> {s.pinned ? '取消置顶' : '置顶'}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={(e) => void onArchiveToggle(s, e)} className="rounded-lg px-2 py-1 text-xs">
            <Archive size={13} weight="regular" /> {archived ? '取消归档' : '归档'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={(e) => onDelete(s.id, e)} className="rounded-lg px-2 py-1 text-xs text-red-500 focus:text-red-500">
            <Trash size={13} weight="regular" /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </motion.div>
  )
}

/** 构建 workspace 分组(非归档会话),组内排序:running → error → 其余按 updatedAt */
function buildGroups(
  sessions: SessionMeta[],
  workspaces: AgentWorkspace[],
  statusOf: (s: SessionMeta) => SessionStatus,
): WorkspaceGroup[] {
  const groupMap = new Map<string, WorkspaceGroup>()
  for (const ws of workspaces) {
    groupMap.set(ws.id, {
      id: ws.id,
      name: ws.name,
      workspace: ws,
      sessions: [],
      streamingCount: 0,
      errorCount: 0,
    })
  }
  for (const s of sessions) {
    const wsId = s.workspaceId
    let group: WorkspaceGroup
    if (wsId) {
      // 不可见工作区的残留/旧版会话不混入“未分类”。
      if (!groupMap.has(wsId)) continue
      group = groupMap.get(wsId)!
    } else {
      const unclassifiedId = '__unclassified__'
      if (!groupMap.has(unclassifiedId)) {
        groupMap.set(unclassifiedId, { id: unclassifiedId, name: '未分类', sessions: [], streamingCount: 0, errorCount: 0 })
      }
      group = groupMap.get(unclassifiedId)!
    }
    group.sessions.push(s)
    const st = statusOf(s)
    if (st === 'running') group.streamingCount++
    else if (st === 'error') group.errorCount++
  }
  // 组内排序
  for (const g of groupMap.values()) {
    g.sessions.sort((a, b) => {
      const ra = STATUS_RANK[statusOf(a)]
      const rb = STATUS_RANK[statusOf(b)]
      if (ra !== rb) return ra - rb
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    })
  }
  const result: WorkspaceGroup[] = []
  for (const ws of workspaces) {
    const group = groupMap.get(ws.id)
    if (group) result.push(group)
  }
  const unclassified = groupMap.get('__unclassified__')
  if (unclassified && unclassified.sessions.length > 0) result.push(unclassified)
  return result
}

/** 按时间分桶（今天/昨天/近 7 天/更早）。 */
function bucketize(sessions: SessionMeta[]): Record<TimeBucket['name'], SessionMeta[]> {
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayStartMs = todayStart.getTime()
  const yesterdayStartMs = todayStartMs - DAY
  const recentStartMs = now - 7 * DAY
  const buckets: Record<TimeBucket['name'], SessionMeta[]> = {
    今天: [],
    昨天: [],
    '近 7 天': [],
    更早: [],
  }
  for (const s of sessions) {
    const updatedAt = s.updatedAt ?? 0
    let name: TimeBucket['name']
    if (updatedAt >= todayStartMs) name = '今天'
    else if (updatedAt >= yesterdayStartMs) name = '昨天'
    else if (updatedAt >= recentStartMs) name = '近 7 天'
    else name = '更早'
    buckets[name].push(s)
  }
  return buckets
}

/** 相对时间(替代 formatTime 的 HH:MM):刚刚/N分钟前/N小时前/昨天/N天前/上周 */
function relTime(ts: number): string {
  const ageMin = (Date.now() - ts) / 60000
  if (ageMin < 1) return '刚刚'
  if (ageMin < 60) return `${Math.floor(ageMin)}分钟前`
  if (ageMin < 24 * 60) return `${Math.floor(ageMin / 60)}小时前`
  if (ageMin < 48 * 60) return '昨天'
  if (ageMin < 7 * 24 * 60) return `${Math.floor(ageMin / (24 * 60))}天前`
  return '上周'
}
