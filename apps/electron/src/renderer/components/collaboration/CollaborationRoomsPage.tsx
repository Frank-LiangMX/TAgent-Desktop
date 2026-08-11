/**
 * 协作室主区页面 — Stage 3
 *
 * 选中房间 → 头部（标题/状态/目标/成员数/并发 x/y/排队/重命名/暂停/归档/添加成员）+
 * 成员状态条（空闲/思考中/排队中）+ 时间线（用户/成员/系统消息 + 多条「思考中」）+ 输入框。
 *
 * Stage 3：发消息 → 主进程解析 @mention → 多目标并行 run（受 maxConcurrentRuns + 成员串行限制）→
 *   CHANGED 广播 → 本页重新拉取，实时看到①用户消息②多条「XX 思考中 / 排队中」+ 各自取消③成员回复气泡。
 *   一方失败不影响另一方（各 run 独立落盘）。
 *
 * 复用 ChatInput（仅 onSubmit + placeholder），不复用 Chat 的 session 编排/流式/工具过程。
 * 时间线 Stage 1–3 用简单气泡（plain text）；Markdown/附件渲染留 S6+。
 *
 * 数据通过 window.electronAPI.collaborationRoom.* IPC（见 preload）。
 * 变更后调 onRoomsChanged 通知 App bump refreshKey；run/member 变更由 CHANGED 广播驱动 bump。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  CirclesThreePlus,
  Pause,
  PencilSimple,
  Play,
  StopCircle,
  UserPlus,
} from '@phosphor-icons/react'
import type {
  CollaborationMember,
  CollaborationMessage,
  CollaborationRoom,
  CollaborationRoomStatus,
  CollaborationRun,
} from '@tagent/shared'
import { ChatInput, type ChatInputHandle } from '../chat/ChatInput'
import { CollaborationTextPrompt } from './CollaborationTextPrompt'
import { cn } from '../../lib/utils'

type TextPromptKind = 'add-member' | 'rename' | null

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

/** run 状态 → 中文标签 */
function runStatusLabel(status: CollaborationRun['status']): string {
  switch (status) {
    case 'queued':
      return '排队中'
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

/** 成员显示状态：以 runs 为准（running/queued），否则看成员 status（idle/offline） */
function memberDisplayStatus(
  member: CollaborationMember,
  runs: CollaborationRun[],
): 'running' | 'queued' | 'idle' | 'offline' {
  if (runs.some((r) => r.memberId === member.id && r.status === 'running')) return 'running'
  if (runs.some((r) => r.memberId === member.id && r.status === 'queued')) return 'queued'
  return member.status === 'offline' ? 'offline' : 'idle'
}

/** 成员显示状态 → 中文标签 */
function memberStatusLabel(status: ReturnType<typeof memberDisplayStatus>): string {
  switch (status) {
    case 'running':
      return '思考中'
    case 'queued':
      return '排队中'
    case 'idle':
      return '空闲'
    case 'offline':
      return '离线'
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
  const [runs, setRuns] = useState<CollaborationRun[]>([])
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [addingMember, setAddingMember] = useState(false)
  const [textPrompt, setTextPrompt] = useState<TextPromptKind>(null)
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
        setRuns([])
        return
      }
      try {
        const [r, msgs, mems, rs] = await Promise.all([
          window.electronAPI.getCollaborationRoom(roomId),
          window.electronAPI.listCollaborationMessages(roomId),
          window.electronAPI.listCollaborationMembers(roomId),
          window.electronAPI.listCollaborationRuns(roomId),
        ])
        if (cancelled) return
        setRoom(r ?? null)
        setMessages(Array.isArray(msgs) ? msgs : [])
        setMembers(Array.isArray(mems) ? mems : [])
        setRuns(Array.isArray(rs) ? rs : [])
      } catch (err) {
        if (cancelled) return
        console.error('[协作室主区] 加载失败:', err)
        setRoom(null)
        setMessages([])
        setMembers([])
        setRuns([])
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
  }, [messages.length, runs.length])

  // 活跃 run（running 优先，queued 随后）— S3 多成员可同时多个
  const activeRuns = runs
    .filter((r) => r.status === 'running' || r.status === 'queued')
    .sort((a, b) => {
      const rank = (r: CollaborationRun) => (r.status === 'running' ? 0 : 1)
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      return (a.startedAt ?? 0) - (b.startedAt ?? 0)
    })
  // 房间并发统计（头部 x/y + 排队）
  const runningCount = runs.filter((r) => r.status === 'running').length
  const queuedCount = runs.filter((r) => r.status === 'queued').length
  const maxConcurrent = room?.maxConcurrentRuns ?? 0
  const memberName = (memberId: string): string =>
    members.find((m) => m.id === memberId)?.displayName ?? '成员'

  const send = useCallback(async (): Promise<void> => {
    if (!room || room.status === 'archived') return
    const text = inputRef.current?.getText().trim() ?? ''
    if (!text) return
    try {
      await window.electronAPI.appendCollaborationUserMessage({ roomId: room.id, content: text })
      inputRef.current?.clear()
      onRoomsChanged()
    } catch (err) {
      window.alert(`发送失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [room, onRoomsChanged])

  const handleCancelRun = useCallback(
    async (runId: string): Promise<void> => {
      if (!room) return
      setCancellingId(runId)
      try {
        await window.electronAPI.cancelCollaborationRun({ roomId: room.id, runId })
        onRoomsChanged()
      } catch (err) {
        window.alert(`取消失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setCancellingId(null)
      }
    },
    [room, onRoomsChanged],
  )

  const confirmAddMember = useCallback(
    async (name: string): Promise<void> => {
      if (!room) return
      setTextPrompt(null)
      setAddingMember(true)
      try {
        await window.electronAPI.addCollaborationMember({ roomId: room.id, displayName: name })
        onRoomsChanged()
      } catch (err) {
        console.error('[协作室] 添加成员失败:', err)
      } finally {
        setAddingMember(false)
      }
    },
    [room, onRoomsChanged],
  )

  const confirmRename = useCallback(
    async (next: string): Promise<void> => {
      if (!room) return
      setTextPrompt(null)
      if (next === room.title) return
      try {
        await window.electronAPI.updateCollaborationRoom({ roomId: room.id, title: next })
        onRoomsChanged()
      } catch (err) {
        console.error('[协作室] 重命名失败:', err)
      }
    },
    [room, onRoomsChanged],
  )

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
              在一个持久房间里与协调者和多个成员协作。不 @ 时协调者回复；<code className="rounded bg-muted px-1">@成员名</code>{' '}
              点名指定成员（可多个，并行扇出）；<code className="rounded bg-muted px-1">@all</code> 唤醒全部。受房间并发上限与成员内串行约束，可取消，重启后无假
              running。
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
  const paused = room.status === 'paused'

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
            onClick={() => setTextPrompt('rename')}
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
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="添加成员"
            disabled={addingMember || archived}
            onClick={() => setTextPrompt('add-member')}
          >
            <UserPlus size={14} />
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
          <span title={`当前运行 ${runningCount} / 并发上限 ${maxConcurrent}`}>
            并发 {runningCount}/{maxConcurrent}
          </span>
          {queuedCount > 0 ? (
            <span className="text-amber-600" title="排队等待启动的 run">排队 {queuedCount}</span>
          ) : null}
          {room.workspaceId ? <span>工作区：{room.workspaceId}</span> : null}
        </div>
        {/* 成员状态条 */}
        {members.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {members.map((m) => {
              const st = memberDisplayStatus(m, runs)
              return (
                <span
                  key={m.id}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
                    st === 'running' && 'bg-emerald-500/15 text-emerald-600',
                    st === 'queued' && 'bg-amber-500/15 text-amber-600',
                    (st === 'idle' || st === 'offline') && 'bg-muted text-muted-foreground',
                  )}
                  title={`${m.displayName}：${memberStatusLabel(st)}${m.isCoordinator ? '（协调者）' : ''}`}
                >
                  <span
                    className={cn(
                      'inline-block size-1.5 rounded-full',
                      st === 'running' && 'animate-pulse bg-emerald-500',
                      st === 'queued' && 'bg-amber-500',
                      st === 'idle' && 'bg-muted-foreground/40',
                      st === 'offline' && 'bg-muted-foreground/20',
                    )}
                  />
                  {m.displayName}
                  {m.isCoordinator ? <span className="opacity-60">·协调</span> : null}
                </span>
              )
            })}
          </div>
        ) : null}
      </header>

      {/* 时间线 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 && activeRuns.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            还没有消息。在下方输入并发送一条消息试试（可 @成员名 点名）。
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} members={members} />
            ))}
            {activeRuns.map((r) => (
              <ThinkingBubble
                key={r.id}
                memberName={memberName(r.memberId)}
                status={r.status}
                cancelling={cancellingId === r.id}
                onCancel={() => void handleCancelRun(r.id)}
              />
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
        ) : paused ? (
          <div className="rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
            房间已暂停，不会启动新运行。恢复运行后可继续发送。
          </div>
        ) : (
          <ChatInput
            ref={inputRef}
            onSubmit={() => void send()}
            placeholder="输入消息…（Enter 发送。不 @ 时协调者回复；@成员名 点名指定，可多个并行；@all 唤醒全部）"
          />
        )}
      </div>

      <CollaborationTextPrompt
        open={textPrompt === 'add-member'}
        title="添加成员"
        label="输入显示名，将自动绑定当前可用渠道（kscc 优先）"
        placeholder="例如：开发"
        confirmLabel="添加"
        onCancel={() => setTextPrompt(null)}
        onConfirm={(name) => void confirmAddMember(name)}
      />
      <CollaborationTextPrompt
        open={textPrompt === 'rename'}
        title="重命名协作室"
        defaultValue={room.title}
        confirmLabel="保存"
        onCancel={() => setTextPrompt(null)}
        onConfirm={(title) => void confirmRename(title)}
      />
    </div>
  )
}

/** 成员名查找（member 气泡显示作者名） */
function memberDisplayName(authorId: string, members: CollaborationMember[]): string {
  return members.find((m) => m.id === authorId)?.displayName ?? '成员'
}

/** 单条消息气泡（user 右对齐，member/system 左/居中） */
function MessageBubble({
  message,
  members,
}: {
  message: CollaborationMessage
  members: CollaborationMember[]
}): JSX.Element {
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
        <div className="mb-0.5 text-[11px] text-muted-foreground">
          {memberDisplayName(message.authorId, members)}
        </div>
        <div className="whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm text-foreground">
          {message.content}
        </div>
      </div>
    </li>
  )
}

/** 成员「思考中」气泡 + 取消按钮（活跃 run 时显示在时间线末尾） */
function ThinkingBubble({
  memberName,
  status,
  cancelling,
  onCancel,
}: {
  memberName: string
  status: CollaborationRun['status']
  cancelling: boolean
  onCancel: () => void
}): JSX.Element {
  const queued = status === 'queued'
  return (
    <li className="flex justify-start">
      <div className="max-w-[80%]">
        <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{memberName}</span>
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              queued ? 'bg-amber-500' : 'animate-pulse bg-emerald-500',
            )}
          />
          <span>{runStatusLabel(status)}…</span>
        </div>
        <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm text-muted-foreground">
          {queued ? (
            <span className="text-xs">等待空闲 slot…</span>
          ) : (
            <span className="flex gap-1">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
            </span>
          )}
          <button
            type="button"
            className="ml-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={onCancel}
            disabled={cancelling}
          >
            <StopCircle size={12} />
            {cancelling ? '取消中…' : '取消'}
          </button>
        </div>
      </div>
    </li>
  )
}
