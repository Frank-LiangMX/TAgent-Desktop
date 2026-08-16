/**
 * 协作室主区页面 — Stage 3
 *
 * 选中房间 → 头部（标题/状态/目标/成员数/并发 x/y/排队/重命名/暂停/归档/添加成员）+
 * 成员状态条（空闲/思考中/排队中）+ 时间线（用户/成员/系统消息 + 多条「思考中」）+ 输入框。
 * 添加成员弹窗可选内核（渠道）+ 模型 + 是否协调者；成员气泡可再编辑渠道/模型。
 *
 * Stage 3：发消息 → 主进程解析 @mention → 多目标并行 run（受 maxConcurrentRuns + 成员串行限制）→
 *   CHANGED 广播 → 本页重新拉取，实时看到①用户消息②多条「XX 思考中 / 排队中」+ 各自取消③成员回复气泡。
 *   一方失败不影响另一方（各 run 独立落盘）。
 *
 * 复用 ChatInput（仅 onSubmit + placeholder），不复用 Chat 的 session 编排/流式/工具过程。
 * 时间线走 tagent-thread 居中限宽；成员正文 Markdown；run 卡玻璃化 + 状态过渡。
 *
 * 数据通过 window.electronAPI.collaborationRoom.* IPC（见 preload）。
 * 变更后调 onRoomsChanged 通知 App bump refreshKey；run/member 变更由 CHANGED 广播驱动 bump。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { motion } from 'motion/react'
import {
  Archive,
  At,
  CirclesThreePlus,
  Database,
  Pause,
  PencilSimple,
  Play,
  StopCircle,
  UsersThree,
} from '@phosphor-icons/react'
import type {
  Channel,
  CollaborationRoleSnapshot,
  CollaborationMailboxEnvelope,
  CollaborationMember,
  CollaborationMessage,
  CollaborationRoom,
  CollaborationRoomStatus,
  CollaborationRun,
} from '@tagent/shared'
import { DEFAULT_USER_NAME } from '@tagent/shared'
import { userProfileAtom } from '../../atoms/user-profile'
import { AppTooltip, MessageResponse, useSmoothStream } from '@tagent/ui'
import { ChatInput, type ChatInputHandle } from '../chat/ChatInput'
import BlurText from '../chat/BlurText'
import { CollaborationTextPrompt } from './CollaborationTextPrompt'
import { CollaborationMemberSettings } from './CollaborationMemberSettings'
import { CollaborationAddMemberDialog } from './CollaborationAddMemberDialog'
import { cn } from '../../lib/utils'
import { getModelLogo } from '../../lib/model-logo'

type TextPromptKind = 'rename' | null

const EASE = [0.16, 1, 0.3, 1] as const

/** 欢迎页能力点卡片 */
const WELCOME_FEATURES = [
  {
    icon: UsersThree,
    title: '多成员并行',
    desc: '一条消息可同时唤醒多个成员，各自独立执行、互不阻塞。',
  },
  {
    icon: At,
    title: '@点名路由',
    desc: '不 @ 由协调者回复；@成员名 精确投递，@all 唤醒全部。',
  },
  {
    icon: Database,
    title: '持久房间',
    desc: '消息与运行状态落盘，重启不丢历史、不会出现假 running。',
  },
] as const

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

/** 成员显示状态：以 runs 为准（running/queued/awaiting_peer），否则看成员 status */
function memberDisplayStatus(
  member: CollaborationMember,
  runs: CollaborationRun[],
): 'running' | 'queued' | 'awaiting_peer' | 'idle' | 'offline' {
  if (runs.some((r) => r.memberId === member.id && r.status === 'running')) return 'running'
  if (runs.some((r) => r.memberId === member.id && r.status === 'queued')) return 'queued'
  if (runs.some((r) => r.memberId === member.id && r.status === 'awaiting_peer')) return 'awaiting_peer'
  return member.status === 'offline' ? 'offline' : 'idle'
}

/** 成员显示状态 → 中文标签 */
function memberStatusLabel(status: ReturnType<typeof memberDisplayStatus>): string {
  switch (status) {
    case 'running':
      return '思考中'
    case 'queued':
      return '排队中'
    case 'awaiting_peer':
      return '等待成员'
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
  /** 打开指定设置 tab（如「去渠道设置」CTA 跳转到 channels） */
  onOpenSettings?: (tab: 'channels') => void
}

export function CollaborationRoomsPage({
  roomId,
  refreshKey,
  onRoomsChanged,
  onNewRoom,
  onOpenSettings,
}: CollaborationRoomsPageProps): JSX.Element {
  const [room, setRoom] = useState<CollaborationRoom | null>(null)
  const [messages, setMessages] = useState<CollaborationMessage[]>([])
  const [members, setMembers] = useState<CollaborationMember[]>([])
  const [runs, setRuns] = useState<CollaborationRun[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [addingMember, setAddingMember] = useState(false)
  const [showAddMemberDialog, setShowAddMemberDialog] = useState(false)
  const [textPrompt, setTextPrompt] = useState<TextPromptKind>(null)
  const [mailbox, setMailbox] = useState<CollaborationMailboxEnvelope[]>([])
  const [streamByRun, setStreamByRun] = useState<Record<string, string>>({})
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
        setMailbox([])
        setStreamByRun({})
        return
      }
      try {
        const [r, msgs, mems, rs, box] = await Promise.all([
          window.electronAPI.getCollaborationRoom(roomId),
          window.electronAPI.listCollaborationMessages(roomId),
          window.electronAPI.listCollaborationMembers(roomId),
          window.electronAPI.listCollaborationRuns(roomId),
          window.electronAPI.listCollaborationMailbox(roomId),
        ])
        if (cancelled) return
        setRoom(r ?? null)
        setMessages(Array.isArray(msgs) ? msgs : [])
        setMembers(Array.isArray(mems) ? mems : [])
        setRuns(Array.isArray(rs) ? rs : [])
        setMailbox(Array.isArray(box) ? box : [])
        const live = new Set(
          (Array.isArray(rs) ? rs : [])
            .filter((run) => run.status === 'running')
            .map((run) => run.id),
        )
        setStreamByRun((prev) => {
          const next: Record<string, string> = {}
          for (const [id, text] of Object.entries(prev)) {
            if (live.has(id)) next[id] = text
          }
          return next
        })
      } catch (err) {
        if (cancelled) return
        console.error('[协作室主区] 加载失败:', err)
        setRoom(null)
        setMessages([])
        setMembers([])
        setRuns([])
        setMailbox([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [roomId, refreshKey])

  // 挂载时加载渠道列表（用于成员渠道名展示 / 「无渠道」判定）
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const list = await window.electronAPI.listChannels()
        if (cancelled) return
        setChannels(Array.isArray(list) ? list : [])
      } catch (err) {
        if (cancelled) return
        console.error('[协作室主区] 加载渠道失败:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 流式增量：独立通道，不 bump refreshKey
  useEffect(() => {
    const off = window.electronAPI.onCollaborationTextDelta?.((payload) => {
      if (!roomId || payload.roomId !== roomId) return
      setStreamByRun((prev) => ({ ...prev, [payload.runId]: payload.text }))
    })
    return () => {
      off?.()
    }
  }, [roomId])

  // 新消息 / 流式 → 滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, runs.length, streamByRun])

  // 活跃 run（running 优先，queued / awaiting_peer 随后）
  const activeRuns = runs
    .filter((r) => r.status === 'running' || r.status === 'queued' || r.status === 'awaiting_peer')
    .sort((a, b) => {
      const rank = (r: CollaborationRun) =>
        r.status === 'running' ? 0 : r.status === 'queued' ? 1 : 2
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      return (a.startedAt ?? 0) - (b.startedAt ?? 0)
    })
  // 房间并发统计（头部 x/y + 排队）
  const runningCount = runs.filter((r) => r.status === 'running').length
  const queuedCount = runs.filter((r) => r.status === 'queued').length
  const pendingMailbox = mailbox.filter((e) => e.state === 'pending' || e.state === 'delivered')
  const maxConcurrent = room?.maxConcurrentRuns ?? 0
  const memberName = (memberId: string): string =>
    members.find((m) => m.id === memberId)?.displayName ?? '成员'

  // 成员是否具备可执行后端：channel 后端需绑定渠道；cli 后端需 cliWorkerId
  const memberHasExecutableBackend = (m: CollaborationMember): boolean =>
    m.backend === 'cli' ? Boolean(m.cliWorkerId) : Boolean(m.channelId)

  // 渠道显示名（未找到则回退 channelId）
  const channelLabel = (m: CollaborationMember): string => {
    if (m.backend === 'cli') return m.cliWorkerId ? 'CLI' : '未绑定'
    if (!m.channelId) return '未绑定'
    return channels.find((c) => c.id === m.channelId)?.name ?? m.channelId
  }

  // 房间是否存在无可用后端的成员（用于提示去渠道设置）
  const anyMemberMissingBackend = members.some((m) => !memberHasExecutableBackend(m))
  // 是否所有成员都无可用后端 → 发消息必然失败，禁发并 CTA
  const allMembersMissingBackend =
    members.length > 0 && members.every((m) => !memberHasExecutableBackend(m))

  const send = useCallback(async (): Promise<void> => {
    if (!room || room.status === 'archived') return
    const text = inputRef.current?.getText().trim() ?? ''
    if (!text) return
    try {
      await window.electronAPI.appendCollaborationUserMessage({ roomId: room.id, content: text })
      inputRef.current?.clear()
      onRoomsChanged()
    } catch (err) {
      toast.error('发送失败', { description: err instanceof Error ? err.message : String(err) })
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
        toast.error('取消失败', { description: err instanceof Error ? err.message : String(err) })
      } finally {
        setCancellingId(null)
      }
    },
    [room, onRoomsChanged],
  )

  const confirmAddMember = useCallback(
    async (patch: {
      displayName: string
      channelId: string
      modelId: string
      isCoordinator: boolean
      roleId?: string
      roleSnapshot?: CollaborationRoleSnapshot
    }): Promise<void> => {
      if (!room) return
      setShowAddMemberDialog(false)
      setAddingMember(true)
      try {
        await window.electronAPI.addCollaborationMember({
          roomId: room.id,
          displayName: patch.displayName,
          channelId: patch.channelId || undefined,
          modelId: patch.modelId || undefined,
          isCoordinator: patch.isCoordinator,
          roleId: patch.roleId,
          roleSnapshot: patch.roleSnapshot,
        })
        onRoomsChanged()
      } catch (err) {
        console.error('[协作室] 添加成员失败:', err)
        toast.error('添加成员失败', { description: err instanceof Error ? err.message : String(err) })
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
        toast.error('重命名失败', { description: err instanceof Error ? err.message : String(err) })
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
      toast.error('操作失败', { description: err instanceof Error ? err.message : String(err) })
    }
  }, [room, onRoomsChanged])

  const confirmMemberSettings = useCallback(
    async (patch: {
      memberId: string
      displayName: string
      channelId: string
      modelId: string
    }): Promise<void> => {
      if (!room) return
      try {
        await window.electronAPI.updateCollaborationMember({
          roomId: room.id,
          memberId: patch.memberId,
          displayName: patch.displayName,
          channelId: patch.channelId,
          modelId: patch.modelId,
        })
        onRoomsChanged()
      } catch (err) {
        toast.error('更新成员失败', { description: err instanceof Error ? err.message : String(err) })
      }
    },
    [room, onRoomsChanged],
  )

  const handleArchive = useCallback(async (): Promise<void> => {
    if (!room) return
    try {
      await window.electronAPI.updateCollaborationRoom({ roomId: room.id, status: 'archived' })
      onRoomsChanged()
    } catch (err) {
      toast.error('归档失败', { description: err instanceof Error ? err.message : String(err) })
    }
  }, [room, onRoomsChanged])

  // 空态
  if (!roomId || !room) {
    return (
      <div className="relative flex h-full min-h-0 items-center justify-center overflow-hidden px-4">
        {/* 背景氛围光 */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/3 size-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-[120px]" />
        </div>

        <div className="relative w-full max-w-[720px]">
          <motion.p
            className="mb-5 text-center text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70"
            initial={{ opacity: 0, filter: 'blur(8px)' }}
            animate={{ opacity: 1, filter: 'blur(0px)' }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.04 }}
          >
            Agent collaboration room
          </motion.p>

          <div className="mb-4 text-center">
            <BlurText
              text="让多个 Agent 在一个房间里协作。"
              className="justify-center text-2xl font-semibold tracking-tight text-foreground/90"
              delay={90}
              direction="bottom"
              stepDuration={0.4}
            />
          </div>

          <motion.p
            className="mx-auto max-w-md text-center text-sm leading-relaxed text-muted-foreground"
            initial={{ opacity: 0, y: 12, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.3 }}
          >
            新建一个房间，配置成员与内核模型，然后 @ 点名或交给协调者调度。
          </motion.p>

          <motion.div
            className="mt-8 grid grid-cols-1 gap-2.5 sm:grid-cols-3"
            initial="hidden"
            animate="show"
            variants={{
              hidden: {},
              show: { transition: { staggerChildren: 0.08, delayChildren: 0.5 } },
            }}
          >
            {WELCOME_FEATURES.map((f) => (
              <motion.div
                key={f.title}
                className="group flex items-start gap-3 rounded-xl border border-border/55 bg-muted/25 px-3.5 py-3 text-left transition-all hover:border-border hover:bg-accent/70 hover:shadow-sm"
                variants={{
                  hidden: { opacity: 0, y: 14, filter: 'blur(4px)' },
                  show: {
                    opacity: 1,
                    y: 0,
                    filter: 'blur(0px)',
                    transition: { duration: 0.42, ease: EASE },
                  },
                }}
              >
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15"
                  aria-hidden="true"
                >
                  <f.icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-foreground/90">{f.title}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                    {f.desc}
                  </span>
                </span>
              </motion.div>
            ))}
          </motion.div>

          <motion.div
            className="mt-9 flex flex-col items-center gap-3"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: EASE, delay: 0.72 }}
          >
            <button
              type="button"
              className="group flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 hover:shadow-primary/30 active:scale-[0.97]"
              onClick={onNewRoom}
            >
              <CirclesThreePlus
                size={17}
                className="transition-transform group-hover:rotate-12"
              />
              新建协作室
            </button>
            <p className="text-xs text-muted-foreground">或从左侧选择一个已有房间。</p>
          </motion.div>
        </div>
      </div>
    )
  }

  const archived = room.status === 'archived'
  const paused = room.status === 'paused'

  return (
    <div className="session-body flex h-full min-h-0 flex-col">
      {/* 头部 */}
      <header className="flex flex-col gap-1.5 border-b border-border/40 px-5 py-3">
        <div className="flex items-center gap-2">
          <h1 className="flex-1 truncate text-base font-semibold text-foreground" title={room.title}>
            {room.title}
          </h1>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] transition-colors',
              room.status === 'paused' && 'bg-amber-500/15 text-amber-600',
              room.status === 'active' && 'bg-emerald-500/15 text-emerald-600',
              room.status === 'archived' && 'bg-muted text-muted-foreground',
              room.status === 'completed' && 'bg-blue-500/15 text-blue-600',
            )}
          >
            {roomStatusLabel(room.status)}
          </span>
          <AppTooltip label="重命名" side="bottom">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="重命名"
              onClick={() => setTextPrompt('rename')}
            >
              <PencilSimple size={14} />
            </button>
          </AppTooltip>
          <AppTooltip label={room.status === 'paused' ? '恢复运行' : '暂停新运行'} side="bottom">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={room.status === 'paused' ? '恢复运行' : '暂停新运行'}
              onClick={() => void handleTogglePause()}
            >
              {room.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}
            </button>
          </AppTooltip>
          <CollaborationAddMemberDialog
            open={showAddMemberDialog}
            onOpenChange={setShowAddMemberDialog}
            disabled={addingMember || archived}
            channels={channels}
            onSave={(patch) => void confirmAddMember(patch)}
          />
          <AppTooltip label="归档" side="bottom">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="归档"
              onClick={() => void handleArchive()}
            >
              <Archive size={14} />
            </button>
          </AppTooltip>
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
          {pendingMailbox.length > 0 ? (
            <span className="text-sky-600" title="尚未回复的 A2A 信封">
              信箱 {pendingMailbox.length}
            </span>
          ) : null}
          {room.workspaceId ? <span>工作区：{room.workspaceId}</span> : null}
        </div>
        {/* 成员状态条 */}
        {members.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {members.map((m) => {
              const st = memberDisplayStatus(m, runs)
              const hasBackend = memberHasExecutableBackend(m)
              return (
                <CollaborationMemberSettings
                  key={m.id}
                  member={m}
                  channels={channels}
                  onSave={(patch) => void confirmMemberSettings(patch)}
                >
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors hover:ring-1 hover:ring-primary/40',
                      st === 'running' && 'bg-emerald-500/15 text-emerald-600',
                      st === 'queued' && 'bg-amber-500/15 text-amber-600',
                      st === 'awaiting_peer' && 'bg-sky-500/15 text-sky-600',
                      (st === 'idle' || st === 'offline') && 'bg-muted text-muted-foreground',
                      !hasBackend && 'ring-1 ring-amber-500/40',
                    )}
                    aria-label={`编辑成员 ${m.displayName}`}
                  >
                    <span
                      className={cn(
                        'collab-status-dot inline-block size-1.5 rounded-full',
                        st === 'running' && 'animate-pulse bg-emerald-500',
                        st === 'queued' && 'bg-amber-500',
                        st === 'awaiting_peer' && 'animate-pulse bg-sky-500',
                        st === 'idle' && 'bg-muted-foreground/40',
                        st === 'offline' && 'bg-muted-foreground/20',
                      )}
                    />
                    {m.displayName}
                    {m.isCoordinator ? <span className="opacity-60">·协调</span> : null}
                    {!hasBackend ? (
                      <span className="rounded bg-amber-500/15 px-1 font-medium text-amber-600">无渠道</span>
                    ) : (
                      <span className="opacity-60">{channelLabel(m)}</span>
                    )}
                  </button>
                </CollaborationMemberSettings>
              )
            })}
          </div>
        ) : null}
        {pendingMailbox.length > 0 ? (
          <ul className="flex flex-col gap-1 pt-1.5">
            {pendingMailbox.slice(0, 4).map((env) => (
              <li
                key={env.id}
                className="truncate rounded-md bg-sky-500/10 px-2 py-1 text-[11px] text-sky-700 dark:text-sky-300"
                title={env.payload}
              >
                <span className="font-medium">
                  {env.type === 'question' ? '待回复' : env.type === 'reply' ? '回复' : '通知'}
                </span>
                {' · '}
                {memberName(env.fromMemberId)} → {memberName(env.toMemberId)}
                {' · '}
                {env.payload}
              </li>
            ))}
          </ul>
        ) : null}
      </header>

      {/* 时间线（对齐会话信息流：tagent-thread 居中限宽） */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 && activeRuns.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            还没有消息。在下方输入并发送一条消息试试（可 @成员名 点名）。
          </div>
        ) : (
          <div className="tagent-thread px-5 pb-44">
            <ul className="flex flex-col gap-2.5">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} members={members} channels={channels} />
              ))}
              {activeRuns.map((r) => (
                <ThinkingBubble
                  key={r.id}
                  member={members.find((m) => m.id === r.memberId)}
                  channels={channels}
                  memberName={memberName(r.memberId)}
                  status={r.status}
                  streamedText={streamByRun[r.id]}
                  cancelling={cancellingId === r.id}
                  onCancel={() => void handleCancelRun(r.id)}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* 底部输入栈（绝对定位，输入框底与侧栏底对齐，对齐会话 composer） */}
      <div className="session-bottom-stack absolute inset-x-0">
        <div className="composer-blur-underlay" aria-hidden="true" />
        <div className="session-composer-cluster">
          {archived ? (
            <div className="rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
              已归档房间不再发送新消息。可在侧栏「已归档」中恢复。
            </div>
          ) : paused ? (
            <div className="rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
              房间已暂停，不会启动新运行。恢复运行后可继续发送。
            </div>
          ) : allMembersMissingBackend ? (
            <div className="flex flex-col items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-3 text-center">
              <p className="text-xs text-amber-700 dark:text-amber-300">
                所有成员都未绑定可用渠道（kscc / 外部渠道），发送后无法跑起任何回复。
              </p>
              <button
                type="button"
                className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                onClick={() => onOpenSettings?.('channels')}
              >
                去渠道设置
              </button>
            </div>
          ) : anyMemberMissingBackend ? (
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <span>部分成员未绑定渠道（@ 到他们时不会回复）。</span>
              <button
                type="button"
                className="rounded-full bg-primary px-2.5 py-0.5 font-medium text-primary-foreground hover:bg-primary/90"
                onClick={() => onOpenSettings?.('channels')}
              >
                去渠道设置
              </button>
            </div>
          ) : (
            <div className="session-input-dock">
              <ChatInput
                ref={inputRef}
                onSubmit={() => void send()}
                placeholder="输入消息…（Enter 发送。不 @ 时协调者回复；@成员名 点名指定，可多个并行；@all 唤醒全部）"
                mentionRoles={members.map((m) => ({ id: m.id, displayName: m.displayName }))}
              />
            </div>
          )}
        </div>
      </div>

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

/** 成员头像：优先模型 logo，兜底显示名首字 + 按成员 ID 稳定的主题色 */
function MemberAvatar({
  member,
  channels,
  size = 32,
}: {
  member: CollaborationMember
  channels: Channel[]
  size?: number
}): JSX.Element {
  const channel = channels.find((c) => c.id === member.channelId)
  const logo =
    member.modelId && channel?.provider
      ? getModelLogo(member.modelId, channel.provider)
      : undefined
  const box = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.42),
  }
  if (logo) {
    return (
      <img
        src={logo}
        alt={member.displayName}
        className="shrink-0 rounded-full border-[0.5px] border-foreground/10 object-cover"
        style={box}
      />
    )
  }
  const palette = [
    'bg-primary/15 text-primary',
    'bg-sky-500/15 text-sky-600',
    'bg-amber-500/15 text-amber-600',
    'bg-emerald-500/15 text-emerald-600',
    'bg-violet-500/15 text-violet-600',
  ]
  const idx =
    Array.from(member.id).reduce((acc, ch) => acc + ch.charCodeAt(0), 0) %
    palette.length
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border-[0.5px] border-foreground/10 font-semibold',
        palette[idx],
      )}
      style={box}
    >
      {member.displayName.slice(0, 1)}
    </div>
  )
}

/** 用户消息头像：与设置左下角/会话一致，用户名首字圆形渐变头像 */
function UserMessageAvatar(): JSX.Element {
  const profile = useAtomValue(userProfileAtom)
  const userName = (profile.userName || DEFAULT_USER_NAME).trim() || DEFAULT_USER_NAME
  const avatarLetter = userName.charAt(0).toUpperCase() || 'U'
  return (
    <AppTooltip label={userName}>
      <span
        className="flex size-9 shrink-0 select-none items-center justify-center rounded-full border-2 border-background/90 text-sm font-bold leading-none text-primary-foreground"
        style={{
          background:
            'linear-gradient(145deg, color-mix(in srgb, hsl(var(--primary)) 82%, white), hsl(var(--primary) / 0.62))',
          boxShadow:
            '0 1px 2px hsl(var(--foreground) / 0.08), 0 4px 12px -2px hsl(var(--foreground) / 0.12)',
        }}
        aria-label={userName}
      >
        {avatarLetter}
      </span>
    </AppTooltip>
  )
}

/** 单条消息气泡（user 右对齐，member/system 左/居中；成员正文走 Markdown） */
function MessageBubble({
  message,
  members,
  channels,
}: {
  message: CollaborationMessage
  members: CollaborationMember[]
  channels: Channel[]
}): JSX.Element {
  if (message.authorType === 'user') {
    return (
      <li className="flex justify-end gap-2">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl border border-border/60 bg-foreground/[0.05] px-3.5 py-2 text-sm text-foreground backdrop-blur-sm">
          {message.content}
        </div>
        <UserMessageAvatar />
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
  if (message.kind === 'a2a_request' || message.kind === 'a2a_reply') {
    const isAsk = message.kind === 'a2a_request'
    const targets = message.targetMemberIds
      .map((id) => memberDisplayName(id, members))
      .filter(Boolean)
      .join('、')
    const author = members.find((m) => m.id === message.authorId)
    return (
      <li className="flex justify-start gap-2">
        {author ? <MemberAvatar member={author} channels={channels} /> : null}
        <div className="max-w-[80%]">
          <div className="mb-0.5 text-[11px] text-muted-foreground">
            {memberDisplayName(message.authorId, members)}
            <span className="ml-1.5 rounded bg-sky-500/15 px-1 py-px text-sky-600">
              {isAsk ? 'A2A 提问' : 'A2A 回复'}
              {targets ? ` → ${targets}` : ''}
            </span>
          </div>
          <div className="rounded-2xl border border-sky-500/20 bg-sky-500/5 px-3.5 py-2 text-sm text-foreground">
            <MessageResponse className="prose-p:my-1 prose-headings:my-1.5 text-sm">
              {message.content}
            </MessageResponse>
          </div>
        </div>
      </li>
    )
  }
  const author = members.find((m) => m.id === message.authorId)
  return (
    <li className="flex justify-start gap-2">
      {author ? <MemberAvatar member={author} channels={channels} /> : null}
      <div className="max-w-[80%]">
        <div className="mb-0.5 text-[11px] text-muted-foreground">
          {memberDisplayName(message.authorId, members)}
        </div>
        <div className="rounded-2xl border border-border/50 bg-foreground/[0.03] px-3.5 py-2 text-sm text-foreground backdrop-blur-sm">
          <MessageResponse className="prose-p:my-1 prose-headings:my-1.5 text-sm">
            {message.content}
          </MessageResponse>
        </div>
      </div>
    </li>
  )
}

/** 流式正文：跟主会话一样走打字机，不完全量替换 Markdown */
function LiveStreamBody({ text }: { text: string }): JSX.Element {
  const { displayedContent } = useSmoothStream({
    content: text,
    isStreaming: true,
  })
  const shown = displayedContent.trim() || text
  return (
    <MessageResponse
      className="prose-p:my-1 prose-headings:my-1.5 text-sm text-foreground"
      streaming
    >
      {shown}
    </MessageResponse>
  )
}

/** 成员「思考中」气泡 + 取消按钮（活跃 run 时显示在时间线末尾） */
function ThinkingBubble({
  member,
  channels,
  memberName,
  status,
  streamedText,
  cancelling,
  onCancel,
}: {
  member?: CollaborationMember
  channels: Channel[]
  memberName: string
  status: CollaborationRun['status']
  streamedText?: string
  cancelling: boolean
  onCancel: () => void
}): JSX.Element {
  const queued = status === 'queued'
  const waitingPeer = status === 'awaiting_peer'
  const live = Boolean(streamedText && status === 'running')
  return (
    <li className="flex justify-start">
      <div className="max-w-[80%]">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {member ? <MemberAvatar member={member} channels={channels} size={20} /> : null}
          <span className="font-medium text-foreground/70">{memberName}</span>
          <span
            className={cn(
              'collab-status-dot inline-block size-1.5 rounded-full',
              queued && 'bg-amber-500',
              waitingPeer && 'animate-pulse bg-sky-500',
              !queued && !waitingPeer && 'animate-pulse bg-emerald-500',
            )}
          />
          <span>{runStatusLabel(status)}…</span>
        </div>
        <div
          className="collab-run-card rounded-2xl px-3.5 py-2.5 text-sm text-foreground/90"
          data-status={status}
        >
          {queued ? (
            <span className="text-xs">等待空闲 slot…</span>
          ) : waitingPeer ? (
            <span className="text-xs">已释放执行槽，等待另一成员回复</span>
          ) : live ? (
            <LiveStreamBody text={streamedText!} />
          ) : (
            <span className="flex gap-1">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
            </span>
          )}
        </div>
        {!waitingPeer ? (
          <div className="mt-1.5 flex justify-end">
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={onCancel}
              disabled={cancelling}
            >
              <StopCircle size={12} />
              {cancelling ? '取消中…' : '取消'}
            </button>
          </div>
        ) : null}
      </div>
    </li>
  )
}
