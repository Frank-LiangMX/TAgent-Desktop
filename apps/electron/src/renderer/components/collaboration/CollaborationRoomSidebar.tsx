/**
 * 协作室侧栏 — Stage 1
 *
 * 结构对齐 SessionSidebar：顶行（新建）→ 滚动房间列表（选中 + 状态 + 更多菜单）→ 已归档底栏。
 * 只做静态房间壳的列表/选中/重命名/暂停/归档；不运行 Agent、不 A2A。
 * 复用 app-sidebar-body / side-title / pill-new / side-scroll / arch-foot 等既有样式类。
 *
 * 数据通过 window.electronAPI.collaborationRoom.* IPC（见 preload）。
 * 变更后调 onRoomsChanged 通知 App bump refreshKey，触发本侧栏 + 主区页面重新拉取。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Archive,
  CaretRight,
  DotsThreeVertical,
  Pause,
  PencilSimple,
  Play,
  Plus,
} from '@phosphor-icons/react'
import type { CollaborationRoom, CollaborationRoomStatus } from '@tagent/shared'
import { cn } from '../../lib/utils'
import {
  AppTooltip,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tagent/ui'
import { CollaborationTextPrompt } from './CollaborationTextPrompt'

/** 房间状态 → 中文标签（Stage 1 房间不运行，只有 active/paused/archived/completed） */
function roomStatusLabel(status: CollaborationRoomStatus): string {
  switch (status) {
    case 'active':
      return '空闲'
    case 'paused':
      return '已暂停'
    case 'archived':
      return '已归档'
    case 'completed':
      return '已完成'
  }
}

/** 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期） */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ts).toLocaleDateString()
}

interface CollaborationRoomSidebarProps {
  /** 当前选中房间 ID（null = 未选中） */
  activeRoomId: string | null
  /** 选中房间 */
  onSelectRoom: (room: CollaborationRoom) => void
  /** 新建房间 */
  onNewRoom: () => void
  /** 外部变更后 bump，触发重新拉取 */
  refreshKey: number
  /** 房间列表发生变更时通知 App（rename/pause/archive 后） */
  onRoomsChanged: () => void
}

export function CollaborationRoomSidebar({
  activeRoomId,
  onSelectRoom,
  onNewRoom,
  refreshKey,
  onRoomsChanged,
}: CollaborationRoomSidebarProps): JSX.Element {
  const [rooms, setRooms] = useState<CollaborationRoom[]>([])
  const [archivedExpanded, setArchivedExpanded] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.electronAPI.listCollaborationRooms({ includeArchived: true })
      setRooms(Array.isArray(list) ? list : [])
    } catch (err) {
      console.error('[协作室侧栏] listCollaborationRooms 失败:', err)
      setRooms([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  const activeRooms = rooms.filter((r) => r.status !== 'archived')
  const archivedRooms = rooms.filter((r) => r.status === 'archived')

  const [renameTarget, setRenameTarget] = useState<CollaborationRoom | null>(null)

  /** 重命名确认（Electron 不支持 window.prompt） */
  const confirmRename = useCallback(
    async (next: string): Promise<void> => {
      const room = renameTarget
      setRenameTarget(null)
      if (!room || next === room.title) return
      try {
        await window.electronAPI.updateCollaborationRoom({ roomId: room.id, title: next })
        onRoomsChanged()
      } catch (err) {
        console.error('[协作室侧栏] 重命名失败:', err)
      }
    },
    [renameTarget, onRoomsChanged],
  )

  /** 暂停 / 恢复（active ↔ paused） */
  const handleTogglePause = useCallback(
    async (room: CollaborationRoom): Promise<void> => {
      const nextStatus: CollaborationRoomStatus = room.status === 'paused' ? 'active' : 'paused'
      try {
        await window.electronAPI.updateCollaborationRoom({ roomId: room.id, status: nextStatus })
        onRoomsChanged()
      } catch (err) {
        window.alert(`${nextStatus === 'paused' ? '暂停' : '恢复'}失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [onRoomsChanged],
  )

  /** 归档 */
  const handleArchive = useCallback(
    async (room: CollaborationRoom): Promise<void> => {
      try {
        await window.electronAPI.updateCollaborationRoom({ roomId: room.id, status: 'archived' })
        onRoomsChanged()
      } catch (err) {
        window.alert(`归档失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [onRoomsChanged],
  )

  /** 恢复归档 → active */
  const handleRestore = useCallback(
    async (room: CollaborationRoom): Promise<void> => {
      try {
        await window.electronAPI.updateCollaborationRoom({ roomId: room.id, status: 'active' })
        onRoomsChanged()
      } catch (err) {
        window.alert(`恢复失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [onRoomsChanged],
  )

  return (
    <div className="app-sidebar-body flex h-full min-h-0 flex-col">
      {/* 顶行：标题 + 新建 */}
      <div className="side-title flex items-center justify-between px-3 py-2">
        <span className="text-sm font-medium text-foreground">协作室</span>
        <button
          type="button"
          className="pill-new flex items-center gap-1 rounded-full px-2.5 py-1 text-xs"
          onClick={onNewRoom}
        >
          <Plus size={12} weight="bold" />
          新建
        </button>
      </div>

      {/* 滚动列表 */}
      <div className="side-scroll min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {activeRooms.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            暂无协作室。点「新建」创建一个房间。
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {activeRooms.map((room) => (
              <RoomRow
                key={room.id}
                room={room}
                active={room.id === activeRoomId}
                onSelect={() => onSelectRoom(room)}
                onRename={() => setRenameTarget(room)}
                onTogglePause={() => void handleTogglePause(room)}
                onArchive={() => void handleArchive(room)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 已归档底栏 */}
      {archivedRooms.length > 0 ? (
        <div className="arch-foot border-t border-border/50 px-1.5 py-1.5">
          <button
            type="button"
            className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            onClick={() => setArchivedExpanded((v) => !v)}
          >
            <CaretRight
              size={12}
              weight="bold"
              className={cn('transition-transform', archivedExpanded && 'rotate-90')}
            />
            已归档（{archivedRooms.length}）
          </button>
          {archivedExpanded ? (
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {archivedRooms.map((room) => (
                <li
                  key={room.id}
                  className="group flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                >
                  <span className="flex-1 truncate" title={room.title}>
                    {room.title}
                  </span>
                  <AppTooltip label="恢复" side="top">
                    <button
                      type="button"
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="恢复"
                      onClick={() => void handleRestore(room)}
                    >
                      <Play size={12} />
                    </button>
                  </AppTooltip>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <CollaborationTextPrompt
        open={renameTarget != null}
        title="重命名协作室"
        defaultValue={renameTarget?.title ?? ''}
        confirmLabel="保存"
        onCancel={() => setRenameTarget(null)}
        onConfirm={(title) => void confirmRename(title)}
      />
    </div>
  )
}

/** 单个房间行 */
function RoomRow({
  room,
  active,
  onSelect,
  onRename,
  onTogglePause,
  onArchive,
}: {
  room: CollaborationRoom
  active: boolean
  onSelect: () => void
  onRename: () => void
  onTogglePause: () => void
  onArchive: () => void
}): JSX.Element {
  return (
    <li
      className={cn(
        'group relative flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors',
        active ? 'bg-primary/10 text-foreground' : 'text-foreground/80 hover:bg-accent',
      )}
    >
      <button type="button" className="flex min-w-0 flex-1 flex-col items-start gap-0.5" onClick={onSelect}>
        <span className="flex w-full items-center gap-1.5">
          <span className="truncate font-medium" title={room.title}>
            {room.title}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              room.status === 'paused' && 'bg-amber-500',
              room.status === 'active' && 'bg-emerald-500',
              room.status === 'completed' && 'bg-blue-500',
            )}
          />
          <span>{roomStatusLabel(room.status)}</span>
          <span>· {formatRelativeTime(room.updatedAt)}</span>
        </span>
      </button>

      <div className="opacity-0 transition-opacity group-hover:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="更多操作"
            >
              <DotsThreeVertical size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRename}>
              <PencilSimple size={14} className="mr-1.5" /> 重命名
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onTogglePause}>
              {room.status === 'paused' ? (
                <>
                  <Play size={14} className="mr-1.5" /> 恢复运行
                </>
              ) : (
                <>
                  <Pause size={14} className="mr-1.5" /> 暂停新运行
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onArchive}>
              <Archive size={14} className="mr-1.5" /> 归档
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}
