/**
 * 会话列表侧栏 — 按 workspace 分组
 *
 * 丝滑动效用 motion（Framer Motion）：
 * - motion.div layout：列表重排时位置/尺寸 spring 平滑滑动（非硬切）
 * - layoutId 选中指示条：在会话项之间平滑滑动（非各算各）
 * - AnimatePresence：新建/删除 spring 进出 + 其他项 layout 让位
 * - 组折叠：height spring 展开（非 grid-template-rows 生硬）
 */
import { useState, useEffect, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { motion, AnimatePresence } from 'motion/react'
import { FolderOpen, CaretRight, ChatsCircle, PencilSimple, PushPin, Trash, DotsThreeVertical } from '@phosphor-icons/react'
import { cn } from '../lib/utils'
import {
  Button,
  ScrollArea,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@tagent/ui'
import { sessionsRefreshAtom } from '../atoms/channel-atoms'
import {
  workspacesAtom,
  currentWorkspaceIdAtom,
} from '../atoms/workspace-atoms'

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
}

interface WorkspaceGroup {
  id: string
  name: string
  sessions: SessionMeta[]
}

/** motion spring 缓动（柔顺弹性，对齐现代 UI 丝滑感） */
const SPRING = { type: 'spring', stiffness: 380, damping: 32, mass: 0.8 } as const
const SPRING_SOFT = { type: 'spring', stiffness: 260, damping: 28, mass: 0.8 } as const

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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const refreshCounter = useAtomValue(sessionsRefreshAtom)
  const workspaces = useAtomValue(workspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)

  const refresh = useCallback(async (): Promise<void> => {
    const list = (await window.electronAPI.listSessions()) as SessionMeta[] | undefined
    const arr = Array.isArray(list) ? list : []
    setSessions(arr.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)))
  }, [])

  useEffect(() => {
    void refresh()
  }, [activeSessionId, refreshCounter, refresh])

  useEffect(() => {
    if (currentWorkspaceId) {
      setExpandedGroups((prev) => {
        if (prev.has(currentWorkspaceId)) return prev
        return new Set([...prev, currentWorkspaceId])
      })
    }
  }, [currentWorkspaceId])

  const onDelete = async (id: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!confirm('删除该会话？历史消息将一并清除。')) return
    // 乐观移除（AnimatePresence 播 exit 动画），再 deleteSession + refresh 兜底
    setSessions((prev) => prev.filter((s) => s.id !== id))
    await window.electronAPI.deleteSession(id)
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

  const groups: WorkspaceGroup[] = buildGroups(sessions, workspaces)

  const toggleGroup = (groupId: string): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  return (
    <div className="app-nav-sidebar flex flex-col h-full">
      {/* 新建按钮区 */}
      <div className="flex gap-2 p-3 border-b border-border/40">
        <Button variant="outline" size="sm" className="flex-1" onClick={onNew}>
          + 新建会话
        </Button>
        {onOpenProject && (
          <Button variant="outline" size="sm" className="flex items-center gap-1.5" onClick={onOpenProject} aria-label="打开项目目录">
            <FolderOpen size={14} weight="regular" />
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1">
        {groups.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">暂无会话</div>
        )}

        {groups.map((group) => {
          const isCurrent = group.id === currentWorkspaceId
          const isExpanded = expandedGroups.has(group.id)
          return (
            <div key={group.id} className="px-1">
              {/* 组头 */}
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-left',
                  'text-[13px] font-medium transition-colors',
                  isCurrent ? 'text-foreground' : 'text-foreground/65 hover:text-foreground/88',
                  'hover:bg-foreground/[0.04]',
                )}
              >
                <motion.span animate={{ rotate: isExpanded ? 90 : 0 }} transition={{ duration: 0.15 }}>
                  <CaretRight size={12} weight="regular" className="shrink-0 text-foreground/40" />
                </motion.span>
                <span className="truncate">{group.name}</span>
                <span className="ml-auto inline-grid min-w-[18px] h-[18px] place-items-center rounded-[7px] border border-white/20 bg-white/40 px-1 text-[9px] tabular-nums text-muted-foreground dark:border-white/10 dark:bg-glass-rgb/50">
                  {group.sessions.length}
                </span>
              </button>

              {/* 组内会话：AnimatePresence height spring 展开/折叠 */}
              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    key="content"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={SPRING_SOFT}
                    className="overflow-hidden"
                  >
                    <div>
                      {group.sessions.length === 0 && (
                        <div className="px-2 py-1.5 text-[11px] text-muted-foreground">暂无会话</div>
                      )}
                      <AnimatePresence initial={false}>
                        {group.sessions.map((s) => (
                          <SessionRow
                            key={s.id}
                            session={s}
                            active={s.id === activeSessionId}
                            editing={editingId === s.id}
                            editingTitle={editingTitle}
                            onSelect={onSelect}
                            onDelete={onDelete}
                            onRename={startRename}
                            onCommitRename={commitRename}
                            onTogglePin={togglePin}
                            onEditingTitleChange={setEditingTitle}
                            onCancelRename={() => setEditingId(null)}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </ScrollArea>
    </div>
  )
}

/** 单个会话项：motion layout 平滑重排 + layoutId 选中指示条 + AnimatePresence 进出场 */
function SessionRow({
  session: s,
  active,
  editing,
  editingTitle,
  onSelect,
  onDelete,
  onRename,
  onCommitRename,
  onTogglePin,
  onEditingTitleChange,
  onCancelRename,
}: {
  session: SessionMeta
  active: boolean
  editing: boolean
  editingTitle: string
  onSelect: (s: SessionMeta) => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onRename: (s: SessionMeta, e: React.MouseEvent) => void
  onCommitRename: () => void
  onTogglePin: (id: string, e: React.MouseEvent) => void
  onEditingTitleChange: (v: string) => void
  onCancelRename: () => void
}): JSX.Element {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={SPRING}
      onClick={() => onSelect(s)}
      className={cn(
        'session-row group relative flex items-center justify-between',
        active && 'session-list-item-active',
      )}
    >
      {/* 选中指示条：layoutId 在项之间平滑滑动。用 top/bottom inset 撑高度，不用 translate（避免和 layout transform 冲突歪斜） */}
      {active && (
        <motion.div
          layoutId="session-active-indicator"
          transition={SPRING}
          className="absolute -left-px top-2 bottom-2 w-[3px] rounded-full bg-primary"
        />
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden pr-7">
        <ChatsCircle
          size={13}
          weight="regular"
          className={cn('shrink-0 transition-opacity', active ? 'text-primary opacity-80' : 'text-muted-foreground opacity-45')}
        />
        {s.pinned && <PushPin size={11} weight="fill" className="shrink-0 text-primary/70" />}
        <div className="min-w-0 flex-1">
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
            <div className={cn(
              'truncate text-[12px] leading-[18px] transition-colors',
              active ? 'font-semibold text-foreground' : 'text-foreground/80',
            )}>
              {s.title}
              {s.turnCount != null && s.turnCount > 0 && (
                <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground/60">{s.turnCount}轮</span>
              )}
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-2 pl-5 text-[9px] text-muted-foreground/80">
            <span className="truncate">{s.modelId ?? '未选择模型'}</span>
            {s.updatedAt && <span className="ml-auto shrink-0 tabular-nums">{formatTime(s.updatedAt)}</span>}
          </div>
        </div>
      </div>
      {/* 三点菜单 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-foreground/30 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-foreground/[0.06] hover:text-foreground/60"
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
          <DropdownMenuItem onClick={(e) => void onTogglePin(s.id, e)}>
            <PushPin size={13} weight="regular" /> {s.pinned ? '取消置顶' : '置顶'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={(e) => void onDelete(s.id, e)} className="text-red-500 focus:text-red-500">
            <Trash size={13} weight="regular" /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </motion.div>
  )
}

function buildGroups(
  sessions: SessionMeta[],
  workspaces: { id: string; name: string }[]
): WorkspaceGroup[] {
  const groupMap = new Map<string, WorkspaceGroup>()
  for (const ws of workspaces) groupMap.set(ws.id, { id: ws.id, name: ws.name, sessions: [] })
  for (const s of sessions) {
    const wsId = s.workspaceId
    if (wsId && groupMap.has(wsId)) {
      groupMap.get(wsId)!.sessions.push(s)
    } else {
      const unclassifiedId = '__unclassified__'
      if (!groupMap.has(unclassifiedId)) {
        groupMap.set(unclassifiedId, { id: unclassifiedId, name: '未分类', sessions: [] })
      }
      groupMap.get(unclassifiedId)!.sessions.push(s)
    }
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

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return `${d.getMonth() + 1}/${d.getDate()}`
}
