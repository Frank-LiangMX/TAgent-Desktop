/**
 * 协作室侧栏 — 对齐会话侧栏视觉
 *
 * 结构对齐 SessionSidebar：顶行（新建）→ 滚动房间列表（选中 + 状态 + 更多菜单）→ 已归档底栏。
 * 标题中/英 + 新建胶囊、搜索（Ctrl+K）、状态点房间行、玻璃归档抽屉均复用会话样式类。
 * 复用 app-sidebar-body / side-title / pill-new / side-scroll / arch-foot 等既有样式类。
 *
 * 数据通过 window.electronAPI.collaborationRoom.* IPC（见 preload）。
 * 变更后调 onRoomsChanged 通知 App bump refreshKey，触发本侧栏 + 主区页面重新拉取。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Archive,
  CaretRight,
  DotsThreeVertical,
  MagnifyingGlass,
  Pause,
  PencilSimple,
  Play,
  Plus,
} from '@phosphor-icons/react'
import type { CollaborationRoom, CollaborationRoomStatus } from '@tagent/shared'
import { cn } from '../../lib/utils'
import { getPlatform } from '../../lib/platform'
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
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

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

  const q = query.trim().toLowerCase()
  const matchesQuery = (room: CollaborationRoom): boolean =>
    !q || room.title.toLowerCase().includes(q)
  const activeRooms = rooms.filter((r) => r.status !== 'archived' && matchesQuery(r))
  const archivedRooms = rooms.filter((r) => r.status === 'archived' && matchesQuery(r))

  // Ctrl+K / ⌘K 聚焦搜索（对齐会话侧栏）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
        toast.error('重命名失败', { description: err instanceof Error ? err.message : String(err) })
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
        toast.error(nextStatus === 'paused' ? '暂停失败' : '恢复失败', {
          description: err instanceof Error ? err.message : String(err),
        })
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
        toast.error('归档失败', { description: err instanceof Error ? err.message : String(err) })
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
        toast.error('恢复失败', { description: err instanceof Error ? err.message : String(err) })
      }
    },
    [onRoomsChanged],
  )

  return (
    <div className="app-sidebar-body flex h-full min-h-0 flex-col">
      {/* 顶行：标题（中/英）+ 新建胶囊（对齐会话侧栏） */}
      <div className="side-title">
        <span className="label">
          <span className="zh">协作室</span>
          <span className="en">Rooms</span>
        </span>
        <span className="title-actions">
          <AppTooltip label="新建协作室" side="bottom">
            <button type="button" className="pill-new" onClick={onNewRoom}>
              <span className="btn-ico">
                <Plus size={15} weight="regular" />
              </span>
              新建
            </button>
          </AppTooltip>
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
            placeholder="搜索协作室…"
            aria-label="搜索协作室"
          />
          <span className="kbd">{getPlatform() === 'mac' ? '⌘K' : 'Ctrl+K'}</span>
        </div>
      </div>

      {/* 滚动列表 */}
      <div className="side-scroll scrollbar-thin">
        {activeRooms.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {q ? '没有匹配的协作室。' : '暂无协作室。点「新建」创建一个房间。'}
          </div>
        ) : (
          <ul className="flex flex-col">
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
        <div className="arch-foot">
          <div className={cn('group-archived', archivedExpanded && 'open')}>
            <button
              type="button"
              className="group-head"
              onClick={() => setArchivedExpanded((v) => !v)}
            >
              <CaretRight
                size={12}
                weight="regular"
                className={cn('caret', !archivedExpanded && 'caret-empty')}
                aria-hidden
              />
              <span className="gname">已归档</span>
              <span className="ws-badge">{archivedRooms.length}</span>
            </button>
            <div className="rows">
              <ul className="flex flex-col">
                {archivedRooms.map((room) => (
                  <ArchivedRoomRow
                    key={room.id}
                    room={room}
                    onRestore={() => void handleRestore(room)}
                  />
                ))}
              </ul>
            </div>
          </div>
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

/** 单个房间行：状态点 + 标题/状态 + 时间 + 三点菜单（对齐会话侧栏行） */
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
      className={cn('row', active && 'is-open')}
      onClick={onSelect}
    >
      <span
        className={cn(
          'stat-dot',
          room.status === 'active' && 'room-active',
          room.status === 'paused' && 'room-paused',
          room.status === 'completed' && 'room-completed',
        )}
      />
      <div className="body">
        <div className="title">
          <AppTooltip label={room.title} side="top" multiline>
            <span className="t">{room.title}</span>
          </AppTooltip>
        </div>
        <div className="meta">
          <span className="m turns">{roomStatusLabel(room.status)}</span>
          <span className="m time">{formatRelativeTime(room.updatedAt)}</span>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="dots"
            onClick={(e) => e.stopPropagation()}
            aria-label="房间操作"
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
    </li>
  )
}

/** 归档房间行：arch-mark + 标题 + 内联「已归档」+ hover 恢复（对齐会话归档行） */
function ArchivedRoomRow({
  room,
  onRestore,
}: {
  room: CollaborationRoom
  onRestore: () => void
}): JSX.Element {
  return (
    <li className="row row-archived" onClick={onRestore}>
      <span className="arch-mark" />
      <div className="body">
        <div className="title">
          <span className="t" title={room.title}>
            {room.title}
          </span>
          <span className="arch-status">已归档</span>
        </div>
      </div>
      <AppTooltip label="恢复" side="top">
        <button
          type="button"
          className="dots"
          aria-label="恢复"
          onClick={(e) => {
            e.stopPropagation()
            onRestore()
          }}
        >
          <Play size={12} />
        </button>
      </AppTooltip>
    </li>
  )
}
