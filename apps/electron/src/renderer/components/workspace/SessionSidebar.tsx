/**
 * 会话列表侧栏 — D 方案(形态重构 + 状态色点 + 时间桶 + 已归档 + 动效)
 *
 * 结构:顶行(标题/Threads + 新建+工作区胶囊)→ 搜索行 → 置顶栏 → 滚动列表
 *       (workspace 分组 + 当前 ws 内时间桶,默认只展开当前 ws)→ 已归档底部固定区
 * 状态色点:从 sessionStatusMapAtom 派生(idle/running/error),running 由 onStreamEvent 实时更新。
 * 选中态:左边框 primary + 行玻璃高光(无独立竖条)。
 * 折叠/展开:CSS max-height 过渡(不用 motion height auto,避免收不回);motion 只管 layout 重排。
 * 置顶后会话仍在列表原位,置顶栏是额外陈列。
 */
import { useState, useEffect, useCallback } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { motion } from 'motion/react'
import {
  FolderOpen,
  CaretRight,
  ChatsCircle,
  PencilSimple,
  PushPin,
  Trash,
  DotsThreeVertical,
  Archive,
  MagnifyingGlass,
  CalendarBlank,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import {
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
  sessions: SessionMeta[]
  streamingCount: number
  errorCount: number
}

interface TimeBucket {
  name: '今天' | '昨天' | '本周' | '更早'
  sessions: SessionMeta[]
}

/** 状态排序权重:进行中 → 出错 → 其余按时间 */
const STATUS_RANK: Record<SessionStatus, number> = { running: 0, error: 1, idle: 2 }

/** 列表项进场/重排 spring(对齐现代 UI 丝滑感) */
const SPRING = { type: 'spring', stiffness: 380, damping: 32, mass: 0.8 } as const

const BUCKET_ORDER: TimeBucket['name'][] = ['今天', '昨天', '本周', '更早']
const EXPANDED_GROUPS_KEY = 'tagent.sidebar.expanded-groups.v1'
const EXPANDED_BUCKETS_KEY = 'tagent.sidebar.expanded-buckets.v2'
const bucketStateKey = (workspaceId: string, bucket: string): string =>
  `${workspaceId}:${bucket}`

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
}: {
  activeSessionId: string | null
  onSelect: (session: SessionMeta) => void
  onNew: () => void
  onOpenProject?: () => void
}): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => readStoredSet(EXPANDED_GROUPS_KEY) ?? new Set(),
  )
  const [expandedBuckets, setExpandedBuckets] = useState<Set<string>>(
    () => readStoredSet(EXPANDED_BUCKETS_KEY) ?? new Set(),
  )
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [query, setQuery] = useState('')
  const refreshCounter = useAtomValue(sessionsRefreshAtom)
  const workspaces = useAtomValue(workspacesAtom)
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

  // 侧栏默认展开最近有活动的工作区；今天固定展开；昨天较少时展开。
  useEffect(() => {
    if (readStoredSet(EXPANDED_GROUPS_KEY) === null) {
      const newestSession = sessions.find((session) => !session.archived && session.workspaceId)
      const firstGroupId = newestSession?.workspaceId ?? workspaces[0]?.id
      if (firstGroupId) setExpandedGroups(new Set([firstGroupId]))
    }

    if (readStoredSet(EXPANDED_BUCKETS_KEY) === null) {
      const defaults = new Set<string>()
      for (const workspace of workspaces) {
        const workspaceSessions = sessions.filter(
          (session) => !session.archived && session.workspaceId === workspace.id,
        )
        const buckets = bucketize(workspaceSessions)
        if (buckets.昨天.length > 0 && buckets.昨天.length <= 3) {
          defaults.add(bucketStateKey(workspace.id, '昨天'))
        }
      }
      setExpandedBuckets(defaults)
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

  const onDelete = async (id: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!confirm('删除该会话？历史消息将一并清除。')) return
    setSessions((prev) => prev.filter((s) => s.id !== id))
    await window.electronAPI.deleteSession(id)
    void refresh()
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

  const toggleBucket = (workspaceId: string, name: string): void => {
    setExpandedBuckets((prev) => {
      const next = new Set(prev)
      const key = bucketStateKey(workspaceId, name)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      storeSet(EXPANDED_BUCKETS_KEY, next)
      return next
    })
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

  const pinned = sessions.filter((s) => s.pinned && !s.archived && matchesQuery(s))
  const activeSessions = sessions.filter((s) => !s.archived)
  const archivedSessions = sessions.filter((s) => s.archived)
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

  return (
    <div className="app-nav-sidebar flex flex-col h-full">
      {/* 顶行:标题 + 新建/工作区胶囊 */}
      <div className="side-title">
        <span className="label">
          <span className="zh">会话</span>
          <span className="en">Threads</span>
        </span>
        <span className="title-actions">
          <button type="button" className="pill-new" onClick={onNew} title="新建会话">
            <span className="btn-ico">
              <ChatsCircle size={15} weight="regular" />
            </span>
            新建
          </button>
          {onOpenProject && (
            <button
              type="button"
              className="pill-icon"
              onClick={onOpenProject}
              title="打开项目目录 · 创建工作区"
              aria-label="打开项目目录"
            >
              <FolderOpen size={14} weight="regular" />
            </button>
          )}
        </span>
      </div>

      {/* 搜索行 */}
      <div className="side-head">
        <div className="search">
          <MagnifyingGlass size={13} weight="regular" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话…"
            aria-label="搜索会话"
          />
          <span className="kbd">⌘K</span>
        </div>
      </div>

      {/* 置顶栏 */}
      {pinned.length > 0 && (
        <div className="pin-rail">
          {pinned.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className="pin-chip"
              onClick={() => onSelect(s)}
              title={s.title}
            >
              <span className={cn('pm', `c${i % 3}`)}>{s.title.slice(0, 1) || '·'}</span>
              <span className="pt">{s.title.slice(0, 8)}</span>
            </button>
          ))}
        </div>
      )}

      {/* 滚动列表 */}
      <div className="side-scroll">
        {groups.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">暂无会话</div>}
        {groups.map((group) => {
          const isExpanded = effectiveExpandedGroups.has(group.id)
          const groupExpandedBuckets = normalizedQuery
            ? new Set<string>(BUCKET_ORDER)
            : new Set(
                BUCKET_ORDER.filter((name) =>
                  expandedBuckets.has(bucketStateKey(group.id, name)),
                ),
              )
          if (activeSession && activeGroupId === group.id) {
            const activeBucket = BUCKET_ORDER.find(
              (name) => bucketize([activeSession])[name].length > 0,
            )
            if (activeBucket) groupExpandedBuckets.add(activeBucket)
          }
          const groupHeaderContent = (
            <>
              <CaretRight size={12} weight="regular" className="caret" />
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
            <div key={group.id} className={cn('group', isExpanded && 'open', group.streamingCount > 0 && 'has-stream', group.errorCount > 0 && 'has-error')}>
              <button
                type="button"
                className="group-head"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={isExpanded}
              >
                {groupHeaderContent}
              </button>

              <div className="rows">
                {renderBuckets(group.sessions, groupExpandedBuckets, (name) => toggleBucket(group.id, name), statusOf, activeSessionId, editingId, editingTitle, onSelect, onDelete, startRename, commitRename, togglePin, onArchiveToggle, setEditingTitle, () => setEditingId(null))}
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
                  onDelete={onDelete}
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
    </div>
  )
}

/** 时间桶渲染:当前 workspace 内分 今天/昨天/本周/更早 */
function renderBuckets(
  sessions: SessionMeta[],
  expandedBuckets: Set<string>,
  toggleBucket: (n: string) => void,
  statusOf: (s: SessionMeta) => SessionStatus,
  activeSessionId: string | null,
  editingId: string | null,
  editingTitle: string,
  onSelect: (s: SessionMeta) => void,
  onDelete: (id: string, e: React.MouseEvent) => Promise<void>,
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
        const isToday = name === '今天'
        const isOpen = isToday || expandedBuckets.has(name)
        const preview = arr.slice(0, 2).map((session) => session.title).join('、')
        const bucketContent = (
          <>
            <CalendarBlank size={13} weight="regular" className="bucket-icon" />
            <span className="bucket-copy">
              <span className="b-name">{name}</span>
              {!isOpen && <span className="b-preview">最近：{preview}</span>}
            </span>
            <span className="bucket-count">{arr.length} 个</span>
            {!isToday && <CaretRight size={12} weight="regular" className="b-caret" />}
          </>
        )
        return (
          <div key={name} className={cn('bucket-group', isOpen && 'open')}>
            {isToday ? (
              <div className="bucket bucket-static">{bucketContent}</div>
            ) : (
              <button
                type="button"
                className="bucket"
                onClick={() => toggleBucket(name)}
                aria-expanded={isOpen}
              >
                {bucketContent}
              </button>
            )}
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
          </div>
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
  onDelete: (id: string, e: React.MouseEvent) => Promise<void>
  onRename: (s: SessionMeta, e: React.MouseEvent) => void
  onCommitRename: () => Promise<void>
  onTogglePin: (id: string, e: React.MouseEvent) => Promise<void>
  onArchiveToggle: (s: SessionMeta, e: React.MouseEvent) => Promise<void>
  onEditingTitleChange: (v: string) => void
  onCancelRename: () => void
}): JSX.Element {
  return (
    <motion.div
      layout={!archived} /* 归档行不做 layout 重排,避免与 arch-foot 折叠高度抢位 */
      initial={archived ? false : { opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: archived ? undefined : 'auto' }}
      exit={archived ? undefined : { opacity: 0, height: 0 }}
      transition={SPRING}
      onClick={() => onSelect(s)}
      className={cn('row', active && 'is-active', archived && 'row-archived')}
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
          {s.turnCount != null && s.turnCount > 0 && <span className="turn-pill">{s.turnCount}</span>}
        </div>
        <div className="meta">
          {/* 归档行也保留 model(对齐原型 D archivedRowHtml),时间位改为「已归档」 */}
          {s.modelId && <span className="m">{s.modelId}</span>}
          <span className="m time">{archived ? '已归档' : s.updatedAt ? relTime(s.updatedAt) : ''}</span>
        </div>
      </div>
      {/* 三点菜单:hover 让位展开 */}
      <DropdownMenu>
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
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem onClick={(e) => onRename(s, e)}>
            <PencilSimple size={13} weight="regular" /> 重命名
          </DropdownMenuItem>
          {!archived && (
            <DropdownMenuItem onClick={(e) => void onTogglePin(s.id, e)}>
              <PushPin size={13} weight="regular" /> {s.pinned ? '取消置顶' : '置顶'}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={(e) => void onArchiveToggle(s, e)}>
            <Archive size={13} weight="regular" /> {archived ? '取消归档' : '归档'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={(e) => void onDelete(s.id, e)} className="text-red-500 focus:text-red-500">
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
  workspaces: { id: string; name: string }[],
  statusOf: (s: SessionMeta) => SessionStatus,
): WorkspaceGroup[] {
  const groupMap = new Map<string, WorkspaceGroup>()
  for (const ws of workspaces) {
    groupMap.set(ws.id, { id: ws.id, name: ws.name, sessions: [], streamingCount: 0, errorCount: 0 })
  }
  for (const s of sessions) {
    const wsId = s.workspaceId
    let group: WorkspaceGroup
    if (wsId && groupMap.has(wsId)) {
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
    if (group && group.sessions.length > 0) result.push(group)
  }
  const unclassified = groupMap.get('__unclassified__')
  if (unclassified && unclassified.sessions.length > 0) result.push(unclassified)
  return result
}

/** 按时间分桶(今天/昨天/本周/更早) */
function bucketize(sessions: SessionMeta[]): Record<TimeBucket['name'], SessionMeta[]> {
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  const buckets: Record<TimeBucket['name'], SessionMeta[]> = { 今天: [], 昨天: [], 本周: [], 更早: [] }
  for (const s of sessions) {
    const age = now - (s.updatedAt ?? 0)
    let name: TimeBucket['name']
    if (age < DAY) name = '今天'
    else if (age < 2 * DAY) name = '昨天'
    else if (age < 7 * DAY) name = '本周'
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
