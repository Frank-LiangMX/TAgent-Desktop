/**
 * 会话列表侧栏 — 按 workspace 分组
 *
 * 每个 workspace 是一个可折叠组，组头显示 workspace name。
 * 组内显示该 workspace 的会话（按 session.meta.workspaceId 过滤）。
 * 没有 workspaceId 的旧会话归入"未分类"组。
 * 当前 workspace 的组默认展开，组头高亮。
 */
import { useState, useEffect, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import {
  cn,
} from '../lib/utils'
import {
  Button,
  ScrollArea,
  Badge,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
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
  /** 会话轮数（user 消息数） */
  turnCount?: number
}

/** workspace 分组结构 */
interface WorkspaceGroup {
  id: string
  name: string
  sessions: SessionMeta[]
}

export function SessionSidebar({
  activeSessionId,
  onSelect,
  onNew,
}: {
  activeSessionId: string | null
  onSelect: (session: SessionMeta) => void
  onNew: () => void
}): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
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

  // 当前 workspace 的组默认展开
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
    await window.electronAPI.deleteSession(id)
    void refresh()
  }

  // 按 workspace 分组会话
  const groups: WorkspaceGroup[] = buildGroups(sessions, workspaces)

  // 切换组展开/折叠
  const toggleGroup = (groupId: string): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  return (
    <div className="app-nav-sidebar flex flex-col h-full">
      {/* 新建按钮区 */}
      <div className="p-3 border-b border-border/40">
        <Button variant="outline" size="sm" className="w-full" onClick={onNew}>
          + 新建会话
        </Button>
      </div>

      {/* 会话列表（按 workspace 分组） */}
      <ScrollArea className="flex-1">
        {groups.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">暂无会话</div>
        )}

        {groups.map((group) => {
          const isCurrent = group.id === currentWorkspaceId
          const isExpanded = expandedGroups.has(group.id)

          return (
            <Collapsible
              key={group.id}
              open={isExpanded}
              onOpenChange={() => toggleGroup(group.id)}
            >
              {/* 组头 */}
              <CollapsibleTrigger asChild>
                <div
                  className={cn(
                    'px-3 py-1.5 cursor-pointer text-xs select-none flex items-center gap-1',
                    'hover:bg-accent/50 transition-colors',
                    isCurrent && 'text-foreground font-medium'
                  )}
                >
                  {/* 展开箭头 */}
                  <span className={cn(
                    'text-[10px] transition-transform',
                    isExpanded ? 'rotate-90' : 'rotate-0'
                  )}>
                    ▶
                  </span>
                  <span className="truncate">{group.name}</span>
                  <Badge variant="outline" className="text-[10px] h-4 px-1 ml-auto">
                    {group.sessions.length}
                  </Badge>
                </div>
              </CollapsibleTrigger>

              {/* 组内会话 */}
              <CollapsibleContent>
                <div className="pl-2">
                  {group.sessions.length === 0 && (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      暂无会话
                    </div>
                  )}
                  {group.sessions.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => onSelect(s)}
                      className={cn(
                        'px-2.5 py-1.5 cursor-pointer rounded-[12px] text-sm flex justify-between items-center transition-colors',
                        'hover:bg-accent/50',
                        s.id === activeSessionId && 'session-list-item-active',
                      )}
                    >
                      <div className="flex-1 overflow-hidden">
                        <div className="truncate text-xs">{s.title}</div>
                        <div className="mt-0.5 flex items-center gap-2 text-[9px] text-muted-foreground">
                          {s.modelId && <span className="truncate">{s.modelId}</span>}
                          {s.turnCount != null && s.turnCount > 0 && (
                            <span className="shrink-0 tabular-nums">{s.turnCount} 轮</span>
                          )}
                          {s.updatedAt && (
                            <span className="ml-auto shrink-0 tabular-nums">{formatTime(s.updatedAt)}</span>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="ml-1.5 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                        onClick={(e) => void onDelete(s.id, e)}
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )
        })}
      </ScrollArea>
    </div>
  )
}

/**
 * 将会话按 workspaceId 分组
 *
 * 有 workspaceId 的归入对应 workspace 组；
 * 没有 workspaceId 的归入"未分类"组（id = '__unclassified__'）。
 */
function buildGroups(
  sessions: SessionMeta[],
  workspaces: { id: string; name: string }[]
): WorkspaceGroup[] {
  const groupMap = new Map<string, WorkspaceGroup>()

  // 先为每个已知 workspace 创建组
  for (const ws of workspaces) {
    groupMap.set(ws.id, { id: ws.id, name: ws.name, sessions: [] })
  }

  // 将会话分配到组
  for (const s of sessions) {
    const wsId = s.workspaceId
    if (wsId && groupMap.has(wsId)) {
      groupMap.get(wsId)!.sessions.push(s)
    } else {
      // 未分类组
      const unclassifiedId = '__unclassified__'
      if (!groupMap.has(unclassifiedId)) {
        groupMap.set(unclassifiedId, {
          id: unclassifiedId,
          name: '未分类',
          sessions: [],
        })
      }
      groupMap.get(unclassifiedId)!.sessions.push(s)
    }
  }

  // 按顺序输出：workspace 按原顺序 + 未分类放最后
  const result: WorkspaceGroup[] = []
  for (const ws of workspaces) {
    const group = groupMap.get(ws.id)
    if (group) result.push(group)
  }
  const unclassified = groupMap.get('__unclassified__')
  if (unclassified && unclassified.sessions.length > 0) {
    result.push(unclassified)
  }

  return result
}

/** 简短时间：今天显示 HH:MM，更早显示 MM/DD */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}
