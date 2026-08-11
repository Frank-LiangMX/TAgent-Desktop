/**
 * 协作室主区页面 — Stage 1
 *
 * 选中房间 → 头部（标题/状态/目标/成员数 + 重命名/暂停/归档）+ 时间线（只显示已存消息）+ 输入框。
 * 输入框发送的是**静态用户消息**：只落盘 + 刷新，不触发 Agent（S2+ 才接入 MemberBackendAdapter）。
 * 未选中房间 → 空态引导（新建或从左侧选择）。
 *
 * 复用 ChatInput（仅 onSubmit + placeholder），不复用 Chat 的 session 编排/流式/工具过程。
 * 时间线 Stage 1 用简单气泡（plain text）；Markdown/附件渲染留 S2+。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  CirclesThreePlus,
  Pause,
  PencilSimple,
  Play,
} from '@phosphor-icons/react'
import type {
  CollaborationMember,
  CollaborationMessage,
  CollaborationRoom,
  CollaborationRoomStatus,
} from '@tagent/shared'
import { ChatInput, type ChatInputHandle } from '../chat/ChatInput'
import { cn } from '../../lib/utils'

/** 房间状态 → 中文标签 */
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

interface CollaborationRoomsPageProps {
  /** 当前选中房间 ID（null = 未选中 → 空态） */
  roomId: string | null
  /** 外部变更 bump，触发重新拉取房间/消息 */
  refreshKey: number
  /** 房间/消息变更时通知 App（rename/pause/archive/send 后） */
  onRoomsChanged: () => void
  /** 空态「新建协作室」CTA */
  onNewRoom: () => void
}

export function CollaborationRoomsPage({
  roomId,
  refreshKey,
  onRoomsChanged,
  onNewRoom,
}: CollaborationRoomsPageProps): JSX.Element {
  const [room, setRoom] = useState<CollaborationRoom | null>(null)
  const [messages, setMessages] = useState<CollaborationMessage[]>([])
  const [members, setMembers] = useState<CollaborationMember[]>([])
  const [sending, setSending] = useState(false)
  const inputRef = useRef<ChatInputHandle>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 选中房间 / 外部变更 → 重新拉取
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      if (!roomId) {
        setRoom(null)
        setMessages([])
        setMembers([])
        return
      }
      try {
        const [r, msgs, mems] = await Promise.all([
          window.electronAPI.getCollaborationRoom(roomId),
          window.electronAPI.listCollaborationMessages(roomId),
          window.electronAPI.listCollaborationMembers(roomId),
        ])
        if (cancelled) return
        setRoom(r ?? null)
        setMessages(Array.isArray(msgs) ? msgs : [])
        setMembers(Array.isArray(mems) ? mems : [])
      } catch (err) {
        if (cancelled) return
        console.error('[协作室主区] 加载失败:', err)
        setRoom(null)
        setMessages([])
        setMembers([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [roomId, refreshKey])

  // 新消息 → 滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  const send = useCallback(async (): Promise<void> => {
    if (!room || room.status === 'archived') return
    const text = inputRef.current?.getText().trim() ?? ''
    if (!text) return
    setSending(true)
    try {
      await window.electronAPI.appendCollaborationUserMessage({ roomId: room.id, content: text })
      inputRef.current?.clear()
      onRoomsChanged()
    } catch (err) {
      window.alert(`发送失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSending(false)
    }
  }, [room, onRoomsChanged])

  const handleRename = useCallback(async (): Promise<void> => {
    if (!room) return
    const next = window.prompt('重命名协作室', room.title)
    if (!next || next.trim() === '' || next.trim() === room.title) return
    try {
      await window.electronAPI.updateCollaborationRoom({ roomId: room.id, title: next.trim() })
      onRoomsChanged()
    } catch (err) {
      window.alert(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [room, onRoomsChanged])

  const handleTogglePause = useCallback(async (): Promise<void> => {
    if (!room) return
    const nextStatus: CollaborationRoomStatus = room.status === 'paused' ? 'active' : 'paused'
    try {
      await window.electronAPI.updateCollaborationRoom({ roomId: room.id, status: nextStatus })
      onRoomsChanged()
    } catch (err) {
      window.alert(`操作失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [room, onRoomsChanged])

  const handleArchive = useCallback(async (): Promise<void> => {
    if (!room) return
    try {
      await window.electronAPI.updateCollaborationRoom({ roomId: room.id, status: 'archived' })
      onRoomsChanged()
    } catch (err) {
      window.alert(`归档失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [room, onRoomsChanged])

  // 空态
  if (!roomId || !room) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-8">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <CirclesThreePlus size={28} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Agent 协作室</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              在一个持久房间里与协调者和多个成员协作。Stage 1 为静态房间壳：可创建房间、发送静态用户消息、重启后数据仍在；
              成员运行与 A2A 留待后续阶段。
            </p>
          </div>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={onNewRoom}
          >
            <CirclesThreePlus size={16} />
            新建协作室
          </button>
          <p className="text-xs text-muted-foreground">或在左侧选择一个已有房间。</p>
        </div>
      </div>
    )
  }

  const archived = room.status === 'archived'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部 */}
      <header className="flex flex-col gap-1.5 border-b border-border/50 px-5 py-3">
        <div className="flex items-center gap-2">
          <h1 className="flex-1 truncate text-base font-semibold text-foreground" title={room.title}>
            {room.title}
          </h1>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px]',
              room.status === 'paused' && 'bg-amber-500/15 text-amber-600',
              room.status === 'active' && 'bg-emerald-500/15 text-emerald-600',
              room.status === 'archived' && 'bg-muted text-muted-foreground',
              room.status === 'completed' && 'bg-blue-500/15 text-blue-600',
            )}
          >
            {roomStatusLabel(room.status)}
          </span>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="重命名"
            onClick={() => void handleRename()}
          >
            <PencilSimple size={14} />
          </button>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={room.status === 'paused' ? '恢复运行' : '暂停新运行'}
            onClick={() => void handleTogglePause()}
          >
            {room.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="归档"
            onClick={() => void handleArchive()}
          >
            <Archive size={14} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {room.goal ? <span className="truncate" title={room.goal}>目标：{room.goal}</span> : null}
          <span>成员：{members.length}</span>
          {room.workspaceId ? <span>工作区：{room.workspaceId}</span> : null}
        </div>
      </header>

      {/* 时间线 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            还没有消息。在下方输入并发送一条消息试试。
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </ul>
        )}
      </div>

      {/* 输入框 */}
      <div className="border-t border-border/50 px-4 py-3">
        {archived ? (
          <div className="rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
            已归档房间不再发送新消息。可在侧栏「已归档」中恢复。
          </div>
        ) : (
          <ChatInput
            ref={inputRef}
            onSubmit={() => void send()}
            placeholder={
              sending
                ? '发送中…'
                : '输入消息…（Enter 发送。Stage 1：仅落盘静态消息，不触发 Agent）'
            }
          />
        )}
      </div>
    </div>
  )
}

/** 单条消息气泡（Stage 1：plain text；user 右对齐，member/system 左/居中） */
function MessageBubble({ message }: { message: CollaborationMessage }): JSX.Element {
  if (message.authorType === 'user') {
    return (
      <li className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          {message.content}
        </div>
      </li>
    )
  }
  if (message.authorType === 'system') {
    return (
      <li className="flex justify-center">
        <div className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          {message.content}
        </div>
      </li>
    )
  }
  // member
  return (
    <li className="flex justify-start">
      <div className="max-w-[80%]">
        <div className="mb-0.5 text-[11px] text-muted-foreground">{message.authorId}</div>
        <div className="whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm text-foreground">
          {message.content}
        </div>
      </div>
    </li>
  )
}
