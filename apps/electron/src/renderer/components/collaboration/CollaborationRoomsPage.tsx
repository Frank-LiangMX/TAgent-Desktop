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
import { toast } from 'sonner'
import { motion } from 'motion/react'
import { Square } from 'lucide-react'
import {
  Archive,
  ArrowRight,
  At,
  Database,
  ListChecks,
  Pause,
  PencilSimple,
  Play,
  UsersThree,
} from '@phosphor-icons/react'
import type {
  Channel,
  CollaborationArtifact,
  CollaborationRoleSnapshot,
  CollaborationMailboxEnvelope,
  CollaborationMember,
  CollaborationMessage,
  CollaborationRoom,
  CollaborationRoomStatus,
  CollaborationRoomTask,
  CollaborationRun,
  CollaborationUserApprovalRequest,
} from '@tagent/shared'
import { AppTooltip, Button } from '@tagent/ui'
import { ChatInput, type ChatInputHandle } from '../chat/ChatInput'
import { SendSplitButton } from '../chat/ConsultMenu'
import BlurText from '../chat/BlurText'
import { CollaborationTextPrompt } from './CollaborationTextPrompt'
import { CollaborationMemberSettings } from './CollaborationMemberSettings'
import { CollaborationAddMemberDialog } from './CollaborationAddMemberDialog'
import { CollaborationTimeline } from './CollaborationTimeline'
import { CollaborationWorkPanel } from './CollaborationWorkPanel'
import { MemberAvatar } from './CollaborationAvatars'
import { cn } from '../../lib/utils'

type TextPromptKind = 'rename' | null

const EASE = [0.16, 1, 0.3, 1] as const

/** 协作室的全员 mention 不是成员 ID，而是结构化路由的特殊目标。 */
const COLLABORATION_ALL_MENTION_ID = 'all'
const COLLABORATION_ALL_MENTION = {
  id: COLLABORATION_ALL_MENTION_ID,
  displayName: '所有人',
  description: '唤醒房间内全部成员（含协调者）',
} as const

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
    desc: '不 @ 由协调者回复；@成员名 精确投递，@所有人 唤醒全部。',
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
  /** 当前房间被归档后清空主区选中态 */
  onRoomArchived?: (roomId: string) => void
  /** 空态「新建协作室」CTA */
  onNewRoom: () => void
  /** 打开指定设置 tab（如「去渠道设置」CTA 跳转到 channels） */
  onOpenSettings?: (tab: 'channels') => void
}

export function CollaborationRoomsPage({
  roomId,
  refreshKey,
  onRoomsChanged,
  onRoomArchived,
  onNewRoom,
  onOpenSettings,
}: CollaborationRoomsPageProps): JSX.Element {
  const [room, setRoom] = useState<CollaborationRoom | null>(null)
  const [messages, setMessages] = useState<CollaborationMessage[]>([])
  const [members, setMembers] = useState<CollaborationMember[]>([])
  const [runs, setRuns] = useState<CollaborationRun[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [stoppingRuns, setStoppingRuns] = useState(false)
  const [addingMember, setAddingMember] = useState(false)
  const [showAddMemberDialog, setShowAddMemberDialog] = useState(false)
  const [textPrompt, setTextPrompt] = useState<TextPromptKind>(null)
  /** composer 中选中的成员 mention 芯片 id（结构化路由用；无芯片时不传 → 文本兜底） */
  const [composerMentionIds, setComposerMentionIds] = useState<string[]>([])
  const [hasDraft, setHasDraft] = useState(false)
  const [mailbox, setMailbox] = useState<CollaborationMailboxEnvelope[]>([])
  const [streamByRun, setStreamByRun] = useState<Record<string, string>>({})
  /** S5：室级任务/产物（主进程真值，CHANGED 后重新拉取；渲染层不是真值源） */
  const [tasks, setTasks] = useState<CollaborationRoomTask[]>([])
  const [artifacts, setArtifacts] = useState<CollaborationArtifact[]>([])
  const [approvals, setApprovals] = useState<CollaborationUserApprovalRequest[]>([])
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null)
  /** S5：右侧工作面板展开态（默认展开；窄屏可收起，键盘可达） */
  const [workPanelOpen, setWorkPanelOpen] = useState(true)
  /** S4.5：本地已「停止」关闭的深度停止信封 id（仅前端态，不持久化、不触后端） */
  const [dismissedDepthStopIds, setDismissedDepthStopIds] = useState<Set<string>>(new Set())
  /** S4.5：正在继续的深度停止信封 id（主操作 loading 态） */
  const [continuingDepthStopId, setContinuingDepthStopId] = useState<string | null>(null)
  /** S4.5：按信封 id 记录的继续失败原因（主操作 error 态） */
  const [depthStopErrorByEnvelope, setDepthStopErrorByEnvelope] = useState<Record<string, string>>({})
  const inputRef = useRef<ChatInputHandle>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 切房间时清空深度停止的前端态（dismissed / loading / error）。
  // 仅依赖 roomId：刷新（refreshKey 变化）时保留 dismissed，避免广播刷新后已关闭的卡片复活。
  useEffect(() => {
    setDismissedDepthStopIds(new Set())
    setContinuingDepthStopId(null)
    setDepthStopErrorByEnvelope({})
  }, [roomId])

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
        setTasks([])
        setArtifacts([])
        setApprovals([])
        setStreamByRun({})
        return
      }
      try {
        const [r, msgs, mems, rs, box, tks, arts, aps] = await Promise.all([
          window.electronAPI.getCollaborationRoom(roomId),
          window.electronAPI.listCollaborationMessages(roomId),
          window.electronAPI.listCollaborationMembers(roomId),
          window.electronAPI.listCollaborationRuns(roomId),
          window.electronAPI.listCollaborationMailbox(roomId),
          window.electronAPI.listCollaborationRoomTasks(roomId),
          window.electronAPI.listCollaborationArtifacts(roomId),
          window.electronAPI.listCollaborationUserApprovals(roomId),
        ])
        if (cancelled) return
        setRoom(r ?? null)
        setMessages(Array.isArray(msgs) ? msgs : [])
        setMembers(Array.isArray(mems) ? mems : [])
        setRuns(Array.isArray(rs) ? rs : [])
        setMailbox(Array.isArray(box) ? box : [])
        setTasks(Array.isArray(tks) ? tks : [])
        setArtifacts(Array.isArray(arts) ? arts : [])
        setApprovals(Array.isArray(aps) ? aps : [])
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
        setTasks([])
        setArtifacts([])
        setApprovals([])
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

  // 房间并发统计（头部 x/y + 排队）
  const runningCount = runs.filter((r) => r.status === 'running').length
  const queuedCount = runs.filter((r) => r.status === 'queued').length
  const stoppableRuns = runs.filter((r) => r.status === 'running' || r.status === 'queued')
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
      await window.electronAPI.appendCollaborationUserMessage({
        roomId: room.id,
        content: text,
        mentions:
          composerMentionIds.length > 0
            ? composerMentionIds.map((id) =>
                id === COLLABORATION_ALL_MENTION_ID
                  ? { kind: 'all' as const, displayNameSnapshot: '所有人' }
                  : { kind: 'agent' as const, memberId: id },
              )
            : undefined,
      })
      inputRef.current?.clear()
      setComposerMentionIds([])
      onRoomsChanged()
    } catch (err) {
      toast.error('发送失败', { description: err instanceof Error ? err.message : String(err) })
    }
  }, [room, composerMentionIds, onRoomsChanged])

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

  /** 会话同款停止键：一次停止当前房间内所有可取消的 run。 */
  const handleStopRuns = useCallback(async (): Promise<void> => {
    if (!room || stoppingRuns) return
    const targets = runs.filter((run) => run.status === 'running' || run.status === 'queued')
    if (targets.length === 0) return
    setStoppingRuns(true)
    try {
      await Promise.all(
        targets.map((run) =>
          window.electronAPI.cancelCollaborationRun({ roomId: room.id, runId: run.id }),
        ),
      )
      onRoomsChanged()
    } catch (err) {
      toast.error('停止失败', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setStoppingRuns(false)
    }
  }, [room, runs, stoppingRuns, onRoomsChanged])

  const handleResolveApproval = useCallback(
    async (requestId: string, decision: 'approved' | 'denied', response?: string): Promise<void> => {
      if (!room) return
      setResolvingApprovalId(requestId)
      try {
        const result = await window.electronAPI.resolveCollaborationUserApproval({
          roomId: room.id,
          requestId,
          decision,
          response,
        })
        if (!result.ok) {
          toast.error('审批操作失败', { description: result.reason })
          return
        }
        onRoomsChanged()
      } catch (err) {
        toast.error('审批操作失败', { description: err instanceof Error ? err.message : String(err) })
      } finally {
        setResolvingApprovalId(null)
      }
    },
    [room, onRoomsChanged],
  )

  // S4.5：继续一次已达 A2A 深度上限的交接。主操作 → IPC；带 loading（continuing）/ error（行内）
  // 状态；成功后刷新房间（CHANGED 广播也会 bump，这里显式确保即时）。IPC 逻辑失败返回
  // { ok: false, reason }（不抛），仅 unexpected IPC 错误走 catch。
  const handleContinueDepthStop = useCallback(
    async (envelopeId: string): Promise<void> => {
      if (!room) return
      setContinuingDepthStopId(envelopeId)
      setDepthStopErrorByEnvelope((prev) => {
        if (!(envelopeId in prev)) return prev
        const next = { ...prev }
        delete next[envelopeId]
        return next
      })
      try {
        const res = await window.electronAPI.continueCollaborationDepthStop({
          roomId: room.id,
          envelopeId,
        })
        if (res.ok) {
          onRoomsChanged()
        } else {
          setDepthStopErrorByEnvelope((prev) => ({ ...prev, [envelopeId]: res.reason }))
        }
      } catch (err) {
        setDepthStopErrorByEnvelope((prev) => ({
          ...prev,
          [envelopeId]: err instanceof Error ? err.message : String(err),
        }))
      } finally {
        setContinuingDepthStopId(null)
      }
    },
    [room, onRoomsChanged],
  )

  // S4.5：仅本地关闭该深度停止提示（次操作）。不调 IPC、不改后端状态；刷新保留、切房间清空。
  const handleDismissDepthStop = useCallback((envelopeId: string): void => {
    setDismissedDepthStopIds((prev) => {
      if (prev.has(envelopeId)) return prev
      const next = new Set(prev)
      next.add(envelopeId)
      return next
    })
  }, [])

  // S5：从工作面板定位到时间线 run / 消息。通过 scrollRef 在时间线内查询 [data-run-id] /
  // [data-message-id] 元素并滚动入视 + 短时高亮闪示，便于用户在长时间线里找到关联项。
  // 不传引用给时间线组件，避免侵入其 props；定位完全在页面侧用 scrollRef 完成。
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const locateTimeline = useCallback((selector: string): void => {
    const el = scrollRef.current?.querySelector(selector)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('collab-locate-flash')
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => el.classList.remove('collab-locate-flash'), 1600)
  }, [])
  const handleLocateRun = useCallback(
    (runId: string): void => locateTimeline(`[data-run-id="${CSS.escape(runId)}"]`),
    [locateTimeline],
  )
  const handleLocateMessage = useCallback(
    (messageId: string): void => locateTimeline(`[data-message-id="${CSS.escape(messageId)}"]`),
    [locateTimeline],
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
      onRoomArchived?.(room.id)
      onRoomsChanged()
    } catch (err) {
      toast.error('归档失败', { description: err instanceof Error ? err.message : String(err) })
    }
  }, [onRoomArchived, onRoomsChanged, room])

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
              className="welcome-start group"
              onClick={onNewRoom}
            >
              <span className="welcome-start__icon" aria-hidden="true">
                <UsersThree size={20} weight="regular" />
              </span>
              <span className="welcome-start__copy">
                <strong>新建协作室</strong>
                <small>配置成员并开始协作</small>
              </span>
              <ArrowRight
                size={18}
                weight="regular"
                className="welcome-start__arrow"
                aria-hidden="true"
              />
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
          <AppTooltip label={workPanelOpen ? '收起工作面板' : '展开工作面板'} side="bottom">
            <button
              type="button"
              className={cn(
                'flex size-7 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground',
                workPanelOpen ? 'text-primary' : 'text-muted-foreground',
              )}
              aria-label={workPanelOpen ? '收起工作面板' : '展开工作面板'}
              aria-pressed={workPanelOpen}
              onClick={() => setWorkPanelOpen((v) => !v)}
            >
              <ListChecks size={14} />
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
                      'inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-foreground/[0.04] py-0.5 pl-0.5 pr-2 text-[11px] transition-colors hover:border-primary/40 hover:bg-foreground/[0.08]',
                      st === 'running' && 'border-emerald-500/30 bg-emerald-500/10',
                      st === 'queued' && 'border-amber-500/30 bg-amber-500/10',
                      st === 'awaiting_peer' && 'border-sky-500/30 bg-sky-500/10',
                      !hasBackend && 'ring-1 ring-amber-500/40',
                    )}
                    aria-label={`编辑成员 ${m.displayName}`}
                  >
                    <MemberAvatar member={m} channels={channels} size={18} />
                    <span className="font-medium text-foreground/85">{m.displayName}</span>
                    {m.isCoordinator ? (
                      <span className="rounded bg-primary/10 px-1 text-[9px] font-medium text-primary">
                        协调
                      </span>
                    ) : null}
                    {!hasBackend ? (
                      <span className="font-medium text-amber-600">无渠道</span>
                    ) : (
                      <span className="opacity-60">{channelLabel(m)}</span>
                    )}
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

      {/* S5：主区改为「左：时间线+输入 | 右：工作面板」行布局。输入栈移入左列（session-chat-col），
           使其只覆盖左列宽度、不遮挡右侧面板；面板收起时左列自动占满。 */}
      <div className="flex min-h-0 flex-1">
        <div className="session-chat-col relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 时间线（S3.5-c：一 run 一卡，对齐会话信息流） */}
          <CollaborationTimeline
            messages={messages}
            runs={runs}
            members={members}
            channels={channels}
            streamByRun={streamByRun}
            cancellingId={cancellingId}
            onCancelRun={(runId) => void handleCancelRun(runId)}
            scrollRef={scrollRef}
            mailbox={mailbox}
            maxDepth={room.maxA2ADepth}
            handoffEnabled={room.a2aHandoffEnabled}
            dismissedDepthStopIds={dismissedDepthStopIds}
            continuingDepthStopId={continuingDepthStopId}
            depthStopErrorByEnvelope={depthStopErrorByEnvelope}
            onContinueDepthStop={(envelopeId) => void handleContinueDepthStop(envelopeId)}
            onDismissDepthStop={handleDismissDepthStop}
            approvals={approvals}
            resolvingApprovalId={resolvingApprovalId}
            onResolveApproval={(requestId, decision, response) =>
              void handleResolveApproval(requestId, decision, response)
            }
          />

          {/* 底部输入栈（绝对定位，锚在左列 session-chat-col，输入框底与侧栏底对齐） */}
          <div className="collab-bottom-stack session-bottom-stack absolute inset-x-0">
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
                    placeholder="输入消息…（Enter 发送。不 @ 时协调者回复；@成员名 点名指定，可多个并行；@所有人 唤醒全部）"
                    onDraftChange={setHasDraft}
                    mentionRoles={[
                      ...(members.length > 0 ? [COLLABORATION_ALL_MENTION] : []),
                      ...members.map((m) => ({ id: m.id, displayName: m.displayName })),
                    ]}
                    onMentionChange={setComposerMentionIds}
                    footer={
                      <div className="composer-footer-bar flex h-7 items-center justify-end px-2 pb-2 pt-0.5">
                        {stoppableRuns.length > 0 && !hasDraft ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 rounded-glass-popover text-destructive hover:bg-destructive/10"
                            onClick={() => void handleStopRuns()}
                            disabled={stoppingRuns}
                            aria-label="停止"
                          >
                            <Square className="size-4" fill="currentColor" />
                          </Button>
                        ) : (
                          <SendSplitButton
                            presets={[]}
                            hasDraft={hasDraft}
                            onSend={() => void send()}
                            onConsultPreset={() => undefined}
                          />
                        )}
                      </div>
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* S5：右侧室级任务/产物面板（可折叠）。收起时不渲染，左列自动占满。 */}
        {workPanelOpen ? (
          <CollaborationWorkPanel
            room={room}
            tasks={tasks}
            artifacts={artifacts}
            members={members}
            runs={runs}
            onLocateRun={handleLocateRun}
            onLocateMessage={handleLocateMessage}
            onChanged={onRoomsChanged}
            onClose={() => setWorkPanelOpen(false)}
          />
        ) : null}
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

