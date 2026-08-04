/**
 * 会话页核心
 *
 * 吃 TAgentDesktopStreamPayload（IPC 流式）+ TAgentMessage IR 渲染。
 * 消息区用 Conversation 容器（自动钉底），输入区用 TipTap ChatInput。
 * 模型：首条消息只绑定运行内核（KSCC / 外部），同内核内渠道与模型可继续切换。
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  sessionRunMapAtom,
  startSessionRunAtom,
  stopSessionRunAtom,
  adoptSessionRunAtom,
} from '../../atoms/session-run-atoms'
import type { StickToBottomContext } from 'use-stick-to-bottom'
import type {
  TAgentDesktopStreamPayload,
  TAgentMessage,
  TAgentPermissionMode,
  SubagentEagerness,
  ReasoningEffort,
  ExecutionMode,
  AgentSessionMeta,
  TurnDuration,
} from '@tagent/shared'
import { migrateExecutionMode, DEFAULT_EXECUTION_MODE, parseMentions } from '@tagent/shared'
import {
  resolveChannelDefaultModelId,
  sdkMessageToIR,
  TAGENT_DEFAULT_PERMISSION_MODE,
  TAGENT_PERMISSION_MODE_CONFIG,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_CONTEXT_WINDOW,
  migrateReasoningEffort,
  type TAgentUsage,
} from '@tagent/shared'
import { type ContextUsageSnapshotView } from './ContextUsageBadge'
import { TokenStatsBar, type SessionTokenTotals } from './TokenStatsBar'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ScrollMinimap,
  type MinimapItem,
  Message,
  MessageContent,
  MessageResponse,
  MessageLoading,
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
  Button,
  AppTooltip,
  MessageFilePathProvider,
} from '@tagent/ui'
import { ArrowUp, Square, Compass, Zap, Plus, SlidersHorizontal, Unlock, X } from 'lucide-react'
import { UsersThree } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import {
  COMPACTION_IN_PROGRESS_LABEL,
  getCompactBoundaryLabel,
} from '@tagent/shared'
import { MessageView } from './MessageView'
import { AssistantTurnView } from './AssistantTurnView'
import { SubagentDetailView } from './SubagentDetailView'
import { ComposerRunTimer } from './ComposerRunTimer'
import {
  buildTurnPresentation,
  backfillTurnDurations,
  getLastMainAssistantCreatedAt,
  groupItemsIntoTurns,
  isRealUserInput,
} from './session-turn-model'
import { ChatInput, type ChatInputHandle } from './ChatInput'
import { ModelSelector } from './ModelSelector'
import { WorkspaceSelector } from './WorkspaceSelector'
import { NewConversationLanding } from './NewConversationLanding'
import {
  resolveEagerness,
  reduceTaskEvent,
  type TaskCardState,
  type TaskCardEvent,
} from './subagent-ui-model'
import { filePreviewRequestAtom } from '../../atoms/file-preview'
import { PermissionBanner } from '../permission/PermissionBanner'
import { ExecutionModeSuggestionBanner } from './ExecutionModeSuggestionBanner'
import { ExecutionModeToggle } from './ExecutionModeToggle'
import { ReasoningEffortPicker } from './ReasoningEffortPicker'
import { KanbanCrewPanel } from './KanbanCrewPanel'
import { MessageQueue } from './MessageQueue'
import { ComposerUnderlay } from './ComposerUnderlay'
import { ScrollPositionManager } from '../shell/ScrollPositionManager'
import {
  channelsAtom,
  selectedModelSelectionAtom,
  bumpSessionsRefreshAtom,
} from '../../atoms/channel-atoms'
import {
  getChannelCoreKind,
  type ChannelCoreKind,
  type ModelSelection,
} from '../../atoms/model-selection'
import { tabsAtom, activeTabIdAtom, materializeTab } from '../../atoms/tabs'
import { loadWorkspacesAtom } from '../../atoms/workspace-atoms'
import { pendingSuggestionAtom } from '../../atoms/pending-suggestion'

export interface SessionMeta {
  id: string
  title: string
  workspaceId?: string
  modelId?: string
  channelId?: string
}

interface StreamEventEnvelope {
  sessionId: string
  payload: TAgentDesktopStreamPayload
}

/** 一轮显示项：完整消息或流式增量 */
interface DisplayItem {
  /** 稳定 key */
  key: string
  /** 完整消息（IR） */
  message?: TAgentMessage
  /** 流式追加中的文本（stream_text_delta 累积） */
  streamingText?: string
  /** 流式 thinking 累积 */
  streamingThinking?: string
  /** 是否流式中 */
  streaming?: boolean
  /** 子代理任务卡片（task_started/progress/notification 状态机，独立小卡片） */
  taskCard?: TaskCardState
  /** 上下文压缩状态行 */
  compactStatus?: 'compacting' | 'complete'
  compactTrigger?: 'auto' | 'manual'
}

/** 新会话页提示词默认值见 NewConversationLanding（welcome / compose 两形态共用） */

/** 右栏班组面板宽度（可拖宽，localStorage 持久化；clamp 280–560） */
const CREW_PANEL_WIDTH_KEY = 'tagent:crewPanelWidth'
const CREW_PANEL_WIDTH_MIN = 280
const CREW_PANEL_WIDTH_MAX = 560
const CREW_PANEL_WIDTH_DEFAULT = 380
/**
 * turn_end 延迟停止宽限期（ms）：kscc/pi 多工具循环中每个 SDK turn 结束都发 turn_end，
 * 若立即 stopRun → running=false → 过程区（思考链）2.5s 后收起、下一轮 delta 又来再展开，
 * 视觉反复跳动。宽限期内有新流式事件 → 保持 running；真正结束由 result → completeRun 兜底。
 */
const RUN_STOP_GRACE_MS = 3000
function loadCrewPanelWidth(): number {
  try {
    const n = Number(localStorage.getItem(CREW_PANEL_WIDTH_KEY))
    if (Number.isFinite(n) && n > 0) {
      return Math.min(CREW_PANEL_WIDTH_MAX, Math.max(CREW_PANEL_WIDTH_MIN, n))
    }
  } catch {
    /* localStorage 不可用时走默认 */
  }
  return CREW_PANEL_WIDTH_DEFAULT
}

export function Chat({
  session,
  onDraftWorkspaceChange,
  onBack,
  crewExternalized = false,
  onOpenCrew,
}: {
  session: SessionMeta
  /** 草稿态（无 tab）改工作区：改 App 的 draftSession。已有 tab 时由 SessionRouter 不传 */
  onDraftWorkspaceChange?: (id: string) => void
  /** 草稿态返回欢迎页（丢弃草稿）；会话页/线程态由 SessionRouter 不传 */
  onBack?: () => void
  /**
   * 班组面板已外置到 Dockview 独立 pane（分屏模式）。true 时隐藏 Chat 内部班组面板
   * 及其入口（footer 按钮 / edge-tab / Work 自动开），班组全走 dock 的 crew pane。
   */
  crewExternalized?: boolean
  /** 分屏模式下，点 chat 内部班组按钮时开外部 crew pane（由 ChatPane 传入） */
  onOpenCrew?: () => void
}): JSX.Element {
  const sessionId = session.id
  const [items, setItems] = useState<DisplayItem[]>([])
  /**
   * 运行态（running / startedAt）走 per-session Jotai atom（session-run-atoms），
   * 不用 local useState：草稿态与真实 tab 态是两个不同位置的 <Chat> 实例，切换时
   * 草稿实例卸载会丢 local state；atom 按 sessionId 键跨实例存活，真实实例挂载时
   * 由会话切换 effect 对照主进程 getSessionStatus 收养在跑的轮（保住草稿 startedAt）。
   */
  // 直接订阅稳定的 map atom（单例），再按 sessionId 取条目。不用 sessionRunAtom(id)
  // 工厂（每渲染新建 atom 实例 → useAtomValue 订阅不稳定 → 可能触发更新循环）。
  const sessionRunMap = useAtomValue(sessionRunMapAtom)
  const runState = sessionRunMap[sessionId] ?? { running: false, startedAt: null }
  const running = runState.running
  const runStartedAt = runState.startedAt
  // runStartedAt 同步到 ref：completeRun 闭包里取最新值，避免读到旧渲染的 startedAt
  const runStartedAtRef = useRef<number | null>(runStartedAt)
  runStartedAtRef.current = runStartedAt
  // 全程起点持久化：每轮 result 的 completeRun→stopSessionRun 会把 atom startedAt 清 null，
  // 工具循环中 adopt 恢复 running 时用它保计时连续（新发送时 startRun 覆盖）
  const runStartedAtPersistRef = useRef<number | null>(runStartedAt)
  // running 同步到 ref：handlePayload 是首渲染闭包（onStreamEvent effect 空依赖），用 ref 取最新
  const runningRef = useRef(running)
  runningRef.current = running
  // turn_end 延迟停止定时器（见 RUN_STOP_GRACE_MS 注释）
  const pendingStopTimerRef = useRef<number | null>(null)
  const clearPendingStop = useCallback(() => {
    if (pendingStopTimerRef.current != null) {
      window.clearTimeout(pendingStopTimerRef.current)
      pendingStopTimerRef.current = null
    }
  }, [])
  const scheduleRunStop = useCallback(() => {
    clearPendingStop()
    pendingStopTimerRef.current = window.setTimeout(() => {
      pendingStopTimerRef.current = null
      stopSessionRun(sessionId)
    }, RUN_STOP_GRACE_MS)
  }, [clearPendingStop, sessionId])
  // 最后一个 assistant-turn 的 key：完成时把全程耗时记到它名下（按 turn.key 查）
  const lastAssistantTurnKeyRef = useRef<string | null>(null)
  /** 会话 meta 快照（加载时设置）：completeRun 持久化 turnDurations 时合并旧值 */
  const metaRef = useRef<Partial<AgentSessionMeta> | null>(null)
  /** 完成耗时表：turnKey → 耗时 + 结束方式（完成/停止/出错）。留存后供 AssistantTurnView 显示 */
  const [completedDurations, setCompletedDurations] = useState<Record<string, TurnDuration>>({})
  const startSessionRun = useSetAtom(startSessionRunAtom)
  const stopSessionRun = useSetAtom(stopSessionRunAtom)
  const adoptSessionRun = useSetAtom(adoptSessionRunAtom)
  /** 开始一轮运行：写 atom 置 running 并记起始时间戳 */
  const startRun = (): void => {
    clearPendingStop()
    const now = Date.now()
    runStartedAtPersistRef.current = now
    startSessionRun({ id: sessionId, startedAt: now })
  }
  /** 结束一轮运行（仅清 running；发送失败等无有效 turn 的路径用） */
  const stopRun = (): void => {
    stopSessionRun(sessionId)
  }
  /**
   * 用户主动停止：本地同步清 running + 起点。
   * 否则 stopAgent 后飞行中的 stray delta 到达时 handlePayload 会用 persistRef 的旧时间戳
   * adopt 复活 running → 停止键卡死 / 计时复活。
   */
  const userStopRun = (): void => {
    clearPendingStop()
    recordCompletion('stopped')
    runStartedAtPersistRef.current = null
    stopRun()
  }
  /**
   * 记录一轮运行耗时（发送→idle/停止/出错全程）到最后一个 assistant-turn，并持久化到 meta。
   * endedBy：complete（正常 result）/ stopped（用户停止）/ error（session_error）。
   * 口径对齐 TAgent_General 的 _durationMs（queryStartedAt → persistSDKMessages），
   * 覆盖思考期 + 所有工具轮，非 turn 内 assistant 间隔。
   */
  const recordCompletion = (endedBy: TurnDuration['endedBy']): void => {
    const startedAt = runStartedAtRef.current
    if (startedAt == null) return
    const durationMs = Math.max(0, Date.now() - startedAt)
    const turnKey = lastAssistantTurnKeyRef.current
    if (!turnKey) return
    const dur: TurnDuration = { ms: durationMs, endedBy }
    setCompletedDurations((prev) => ({ ...prev, [turnKey]: dur }))
    // 持久化：最后一条主线 assistant 消息 createdAt 作稳定 key，写入 meta，重开回填
    const createdAt = getLastMainAssistantCreatedAt(items)
    if (createdAt != null) {
      const prevDurations = metaRef.current?.turnDurations ?? {}
      const nextDurations = { ...prevDurations, [createdAt]: dur }
      // 本地同步合并，避免连续两轮完成时旧值丢失
      metaRef.current = {
        ...(metaRef.current ?? {}),
        turnDurations: nextDurations,
      }
      void window.electronAPI
        .updateSessionMeta(sessionId, { turnDurations: nextDurations })
        .catch(() => {})
    }
  }
  /**
   * 完成一轮运行：算发送→idle 全程耗时，记到最后一个 assistant-turn 名下，再清 running。
   */
  const completeRun = (): void => {
    recordCompletion('complete')
    stopSessionRun(sessionId)
  }
  /** 输入框是否有草稿（供发送/停止键同槽复用：运行中且有草稿→仍可追加发送，显示发送键；运行中无草稿→停止键） */
  const [hasDraft, setHasDraft] = useState(false)
  /** 运行中排队的消息（运行中发送→入队，运行结束→自动消费） */
  const [messageQueue, setMessageQueue] = useState<Array<{ text: string; selection: ModelSelection }>>([])
  /** 待发送附件（输入框暂存，发送后清空） */
  const [pendingAttachments, setPendingAttachments] = useState<Array<{
    id: string; filename: string; mediaType: string; size: number; previewUrl?: string; data: string
  }>>([])
  /** 历史加载完成的标志：false 时 Conversation resize=instant（无动画）+ ScrollPositionManager 恢复位置 */
  const [scrollReady, setScrollReady] = useState(false)
  /**
   * 流式结束过渡：result/turn_end 瞬间（流式占位 → 落盘消息，高度切换）切 resize=instant，
   * 150ms 后回 smooth——防止高度变化触发平滑滚动动画（对齐 1.0/Proma 的 needsInstant 机制）。
   */
  const [streamTransitioning, setStreamTransitioning] = useState(false)
  const streamTransitionTimerRef = useRef<number | null>(null)
  const beginStreamTransition = useCallback(() => {
    setStreamTransitioning(true)
    if (streamTransitionTimerRef.current != null) {
      window.clearTimeout(streamTransitionTimerRef.current)
    }
    streamTransitionTimerRef.current = window.setTimeout(() => {
      streamTransitionTimerRef.current = null
      setStreamTransitioning(false)
    }, 150)
  }, [])
  useEffect(() => {
    return () => {
      if (streamTransitionTimerRef.current != null) {
        window.clearTimeout(streamTransitionTimerRef.current)
        streamTransitionTimerRef.current = null
      }
    }
  }, [])
  /** 虚拟化：当前挂载的消息条数（从尾部切）。20 首 batch，idle 帧递增 40/批，全挂完置 Infinity。
   * 保近期：底部对话区永远全量渲染，旧的渐进补齐，超长会话不卡。 */
  const [visibleCount, setVisibleCount] = useState<number>(20)
  const [selectionOverride, setSelectionOverride] = useState<ModelSelection | null>(null)
  const [sentCoreKind, setSentCoreKind] = useState<ChannelCoreKind | null>(null)
  /** 会话当前权限模式（默认 auto；切会话 key 重建后重置。运行中切换即时生效） */
  const [permissionMode, setPermissionMode] = useState<TAgentPermissionMode>(TAGENT_DEFAULT_PERMISSION_MODE)
  /**
   * 协作形态 Chat|Work（默认 chat；旧会话无字段回显 work）
   * 仅用户可切换（含点确认建议）
   */
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(DEFAULT_EXECUTION_MODE)
  /** 挂起的形态切换建议（Chat 硬拦 / meta 恢复） */
  const [pendingModeSuggestion, setPendingModeSuggestion] = useState<
    import('@tagent/shared').ExecutionModeSuggestion | null
  >(null)
  /** 会话绑定的看板（建板后写入 meta.boardId） */
  const [sessionBoardId, setSessionBoardId] = useState<string | null>(null)
  /** 右侧班组面板（有板才有入口） */
  const [crewPanelOpen, setCrewPanelOpen] = useState(false)
  const [hasCrewBoards, setHasCrewBoards] = useState(false)
  /** 右栏宽度（可拖宽，持久化） */
  const [crewPanelWidth, setCrewPanelWidth] = useState<number>(loadCrewPanelWidth)
  const handleCrewPanelWidth = useCallback((w: number) => {
    setCrewPanelWidth(Math.min(CREW_PANEL_WIDTH_MAX, Math.max(CREW_PANEL_WIDTH_MIN, Math.round(w))))
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(CREW_PANEL_WIDTH_KEY, String(crewPanelWidth))
    } catch {
      /* ignore */
    }
  }, [crewPanelWidth])
  /** 对话列变窄时启用紧凑输入底栏（右栏展开 / 窗口窄） */
  const [composerCompact, setComposerCompact] = useState(false)
  /** Chat @ 角色库短列表 */
  const [mentionRoles, setMentionRoles] = useState<
    Array<{ id: string; displayName: string; description?: string }>
  >([])
  /** 最近一轮 @ 的展示名（助手铭牌旁顺序条） */
  const [liveMentionLabels, setLiveMentionLabels] = useState<string[]>([])
  /**
   * 当前对话跟随的角色（activeSpeaker / followMode）：
   * @ 设置/切换；无 @ 时保持上一轮（连续追问同一角色）；✕ 清空回默认总助。
   * 与主进程 pendingMentionRoleIds 对齐（主进程权威注入，本地用于输入框指示与铭牌）。
   */
  const [activeMentionRoleIds, setActiveMentionRoleIds] = useState<string[]>([])
  /**
   * Work→Chat 后班组仍在后台执行时的轻提示条。
   * setSessionExecutionMode 可带 backgroundCrew；也可客户端兜底数任务。
   */
  const [backgroundCrewBanner, setBackgroundCrewBanner] = useState<{
    running: number
    ready: number
    pending: number
  } | null>(null)
  /** 子代理委派积极性（默认 conservative；切会话 key 重建后重置，挂载时回显持久化值。下次发送注入 kscc 生效） */
  const [subagentEagerness, setSubagentEagerness] = useState<SubagentEagerness>('conservative')
  /** 当前打开的子代理详情（parentToolUseId），非空时全屏切换显示独立会话页 */
  const [subagentDetail, setSubagentDetail] = useState<string | null>(null)
  /** 思考强度（默认 medium；切会话 key 重建后重置，挂载时回显持久化值。下次发送注入 SDK query 生效） */
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT)
  /** 子代理任务卡片 lookup：parentToolUseId → taskCard（taskCard.toolUseId 即发起它的主线 tool_use id） */
  const subagentCards = useMemo(() => {
    const map = new Map<string, TaskCardState>()
    for (const it of items) {
      if (it.taskCard?.toolUseId) map.set(it.taskCard.toolUseId, it.taskCard)
    }
    return map
  }, [items])

  // 会话页入场动画：mount 后一帧加 is-mounted class 触发 CSS transition */
  const [pageMounted, setPageMounted] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setPageMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  /** 最近一轮 usage（仅外部/Pi 展示；kscc 不采信） */
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshotView | null>(null)
  const [tokenTotals, setTokenTotals] = useState<SessionTokenTotals>({
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    turnCount: 0,
  })
  const [isCompactingUi, setIsCompactingUi] = useState(false)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  const applyUsage = (usage: TAgentUsage | undefined, contextWindow = DEFAULT_CONTEXT_WINDOW): void => {
    if (!usage) return
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheWrite = usage.cacheCreationTokens ?? 0
    // 有任意 usage 字段就更新（有的 provider 主字段只在 cache 上）
    if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) return

    setContextUsage((prev) => ({
      inputTokens: Math.max(input, cacheRead + cacheWrite > 0 ? input : 0) || input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      contextWindow:
        prev?.contextWindow && prev.contextWindow > 0 ? prev.contextWindow : contextWindow,
    }))
    setTokenTotals((prev) => ({
      totalInput: prev.totalInput + input,
      totalOutput: prev.totalOutput + output,
      totalCacheRead: prev.totalCacheRead + cacheRead,
      totalCacheWrite: prev.totalCacheWrite + cacheWrite,
      turnCount: prev.turnCount + (input > 0 || output > 0 ? 1 : 0),
    }))
  }

  // 切会话时清空占用与累计
  useEffect(() => {
    setContextUsage(null)
    setTokenTotals({
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      turnCount: 0,
    })
    setIsCompactingUi(false)
  }, [sessionId])
  const scrollContextRef = useRef<StickToBottomContext | null>(null)
  const itemIdxRef = useRef(0)
  const streamingRef = useRef<DisplayItem | null>(null)
  const chatInputRef = useRef<ChatInputHandle>(null)
  const composerClusterRef = useRef<HTMLDivElement>(null)
  const bottomStackRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 输入框聚焦时展开功能栏 */
  const [composerExpanded, setComposerExpanded] = useState(false)

  const channels = useAtomValue(channelsAtom)
  const tabs = useAtomValue(tabsAtom)
  const selectedModelSelection = useAtomValue(selectedModelSelectionAtom)
  const setSelectedModelSelection = useSetAtom(selectedModelSelectionAtom)
  const bumpRefresh = useSetAtom(bumpSessionsRefreshAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const loadWorkspaces = useSetAtom(loadWorkspacesAtom)
  const pendingSuggestion = useAtomValue(pendingSuggestionAtom)
  const setPendingSuggestion = useSetAtom(pendingSuggestionAtom)

  /**
   * ScrollMinimap 刻度：一轮对话一刻度。
   * 必须用 turn 分组，且只认「真实用户输入」——
   * tool_result 也是 type=user，若不过滤会把每个工具结果都画成刻度（过程块污染 minimap）。
   */
  const minimapItems = useMemo<MinimapItem[]>(() => {
    const turns = groupItemsIntoTurns(items)
    const result: MinimapItem[] = []
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]
      if (!t || t.kind !== 'user') continue
      if (!isRealUserInput(t.message)) continue

      const userText = firstText(t.message) ?? ''
      let replyPreview: string | undefined
      let replyModel: string | undefined
      for (let j = i + 1; j < turns.length; j++) {
        const next = turns[j]
        if (!next) continue
        if (next.kind === 'user') break
        if (next.kind === 'assistant-turn') {
          const pres = buildTurnPresentation(next)
          const ans = pres.answerTexts[0]?.replace(/\s+/g, ' ').trim()
          if (ans) replyPreview = ans.slice(0, 120)
          replyModel = next.modelId ?? pres.modelId
          break
        }
      }
      result.push({
        // 与 TurnView 上 data-message-id 一致，便于刻度跳转定位
        id: t.key,
        role: 'user',
        preview: userText.slice(0, 160) || '用户消息',
        replyPreview,
        model: replyModel,
      })
    }
    return result
  }, [items])

  /** 虚拟化：是否已全挂（visibleCount 追上 items.length 或 Infinity） */
  const fullyMounted = visibleCount >= items.length
  /** 实际挂载数（Infinity 当 items.length） */
  const effectiveVisible = visibleCount >= items.length ? items.length : visibleCount
  /** 挂载窗口起点（旧消息条数，未挂载） */
  const visibleStartOffset = Math.max(0, items.length - effectiveVisible)
  /** 虚拟化切片：尾部 effectiveVisible 条（最新在底） */
  const visibleItems = items.slice(visibleStartOffset)
  /**
   * 将扁平消息合成 turn：工具循环 + 中间 tool_result 合并，模型铭牌只出一次。
   * 在虚拟化切片上分组（底栏近期完整，超长会话旧段渐进加载）。
   */
  const visibleTurns = useMemo(() => groupItemsIntoTurns(visibleItems), [visibleItems])
  /** scrollReady 门控：历史加载完 && 全挂完才恢复滚动位置（对齐旧版 scrollReady = ready && fullyMounted） */
  const effectiveScrollReady = scrollReady && fullyMounted

  // 选择优先级：本会话最近选择 > 持久化会话选择 > 新会话全局选择。
  // 旧会话只有 channelId 没有 modelId 时，用该渠道当前默认模型做一次迁移。
  const sessionChannel = channels.find((channel) => channel.id === session.channelId)
  const sessionModelId = session.modelId ?? resolveChannelDefaultModelId(sessionChannel)
  const persistedSelection = session.channelId && sessionModelId
    ? { channelId: session.channelId, modelId: sessionModelId }
    : null
  const effectiveSelection = selectionOverride ?? persistedSelection ?? selectedModelSelection
  const selectionChannel = effectiveSelection
    ? channels.find((c) => c.id === effectiveSelection.channelId)
    : undefined
  // 会话已绑渠道优先；否则用当前选择；再否则用本会话已发送过的核
  const lockedKind: ChannelCoreKind | null = sessionChannel
    ? getChannelCoreKind(sessionChannel)
    : selectionChannel
      ? getChannelCoreKind(selectionChannel)
      : sentCoreKind
  /** 仅外部/Pi 显示 token 栏；kscc 占用不可信 */
  const showTokenBar = lockedKind === 'external'

  // 切换会话时加载历史。滚动位置恢复交给 ScrollPositionManager（Conversation 内部），
  // 它用 useLayoutEffect + stopScroll + 直接设 scrollTop（无动画、无可见滚动过程）。
  useEffect(() => {
    sessionIdRef.current = sessionId
    setItems([])
    // 运行态 reconcile 延后到下方 async：对照主进程 getSessionStatus 决定保 / 收养 / 清，
    // 避免真实 Chat 挂载时无条件 stopRun 抹掉草稿实例 seed 的在跑计时（草稿→真实切换）。
    setHasDraft(false)
    setScrollReady(false)
    setVisibleCount(20) // 虚拟化：切会话重置首批 20
    streamingRef.current = null
    itemIdxRef.current = 0
    setSubagentEagerness('conservative') // 切会话重置，下面异步回显持久化值
    setReasoningEffort(DEFAULT_REASONING_EFFORT) // 切会话重置，下面异步回显持久化值
    setExecutionMode(DEFAULT_EXECUTION_MODE) // 切会话重置，下面异步回显持久化值
    setBackgroundCrewBanner(null) // 切会话清掉后台班组提示
    // welcome 形态点提示词时暂存的文本：草稿态挂载后预填输入框并清空。
    // 只有刚 newSession 的草稿会带 pending；切到已有会话时它已被清空，不误填。
    if (pendingSuggestion) {
      chatInputRef.current?.setText(pendingSuggestion)
      chatInputRef.current?.focus()
      setPendingSuggestion(null)
    }
    void (async () => {
      // 运行态 reconcile：草稿→真实切换时，草稿实例 startRun 已 seed atom(running=true)，
      // 真实实例全新挂载需对照主进程真相收养，保住 startedAt 让计时/停止键/流式动画连续。
      // runState 是挂载时刻闭包值（草稿 seed 的 running=true）；即便 IPC 竞态，atom 在跑就不清。
      try {
        const status = await window.electronAPI.getSessionStatus(sessionId)
        if (status?.status === 'running') {
          if (!runState.running) adoptSessionRun({ id: sessionId, startedAt: runState.startedAt ?? Date.now() })
          // atom 已在跑（草稿 seed）→ 保留 startedAt，什么都不做
        } else {
          stopRun() // 主进程说没在跑 → 清（正常切到 idle 会话）
        }
      } catch {
        // IPC 失败：保守按 atom 当前值，在跑就保留、否则清
        if (!runState.running) stopRun()
      }
      const history = (await window.electronAPI.getMessages(sessionId)) as unknown[]
      // 按核分流转译：kscc 会话落盘 SDKMessage → sdkMessageToIR；pi 会话落盘 TAgentMessage IR → 直读。
      // 旧 pi 会话可能仍是 SDKMessage 形态（有 message 包装），用 sdkMessageToIR 兜底。
      const isKsccCore = sessionChannel ? getChannelCoreKind(sessionChannel) === 'kscc' : true
      const irItems: DisplayItem[] = []
      for (const raw of history) {
        const message = isKsccCore
          ? sdkMessageToIR(raw as never).message
          : isIRMessage(raw)
            ? (raw as TAgentMessage)
            : sdkMessageToIR(raw as never).message
        if (message) {
          irItems.push({ key: `h${itemIdxRef.current++}`, message })
        }
      }
      setItems(irItems)
      // 从历史 assistant.usage 回填底栏（最近一条有 usage 的 assistant）
      for (let i = irItems.length - 1; i >= 0; i--) {
        const m = irItems[i]?.message
        if (m?.type === 'assistant' && m.usage && (m.usage.inputTokens ?? 0) > 0) {
          applyUsage(m.usage)
          break
        }
      }
      setScrollReady(true)
      // 回显持久化的子代理委派积极性（新会话无 meta → resolveEagerness 回退默认 conservative）
      try {
        const metas = (await window.electronAPI.listSessions()) as Array<{
          id: string
          subagentEagerness?: SubagentEagerness
          reasoningEffort?: ReasoningEffort
          executionMode?: ExecutionMode
          permissionMode?: TAgentPermissionMode
          pendingExecutionModeSuggestion?: import('@tagent/shared').ExecutionModeSuggestion | null
          boardId?: string
          pendingMentionRoleIds?: string[]
          turnDurations?: Record<string, TurnDuration>
        }>
        const persisted = metas.find((m) => m.id === sessionId)
        if (persisted) {
          // 记录 meta 快照（completeRun 持久化 turnDurations 时合并旧值）
          metaRef.current = persisted
          // 回填持久化的完成耗时：createdAt 稳定 key → 当前渲染 turn key
          const backfilled = backfillTurnDurations(irItems, persisted.turnDurations)
          if (Object.keys(backfilled).length > 0) {
            setCompletedDurations((prev) => ({ ...prev, ...backfilled }))
          }
          setSubagentEagerness(resolveEagerness(persisted))
          setReasoningEffort(migrateReasoningEffort(persisted.reasoningEffort))
          // 旧会话无字段 → migrate 为 work，避免突然只读
          setExecutionMode(migrateExecutionMode(persisted.executionMode))
          if (persisted.permissionMode) {
            setPermissionMode(persisted.permissionMode)
          }
          setPendingModeSuggestion(persisted.pendingExecutionModeSuggestion ?? null)
          setSessionBoardId(persisted.boardId ?? null)
          // 回显对话跟随的 activeSpeaker（followMode 持久化）
          setActiveMentionRoleIds(
            Array.isArray(persisted.pendingMentionRoleIds) ? persisted.pendingMentionRoleIds : [],
          )
        } else {
          setPendingModeSuggestion(null)
          setSessionBoardId(null)
          setActiveMentionRoleIds([])
        }
      } catch {
        /* 回显失败不影响主流程，沿用默认 */
      }
    })()
  }, [sessionId])

  // main 会话滚动时关闭滚动内容自身的 backdrop-filter，避免 GPU 合成滞后产生拖影。
  // 输入框是滚动容器的兄弟节点，不受 is-scrolling 选择器影响，玻璃遮挡保持不变。
  useEffect(() => {
    const scrollEl = scrollContextRef.current?.scrollRef.current
    if (!scrollEl) return

    let scrollTimer = 0
    const handleScroll = (): void => {
      scrollEl.classList.add('is-scrolling')
      window.clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => {
        scrollEl.classList.remove('is-scrolling')
      }, 150)
    }

    scrollEl.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      scrollEl.removeEventListener('scroll', handleScroll)
      window.clearTimeout(scrollTimer)
      scrollEl.classList.remove('is-scrolling')
    }
  }, [sessionId])

  // Chat 无功能栏：切回 Chat 时强制收起
  useEffect(() => {
    if (executionMode === 'chat') setComposerExpanded(false)
  }, [executionMode])

  // Work 模式下不展示「后台班组」提示（用户已回到可派工形态）
  useEffect(() => {
    if (executionMode === 'work') setBackgroundCrewBanner(null)
  }, [executionMode])

  /**
   * 看板全部完成 → 软刷新 panel 消息（回流摘要）+ 清后台班组条。
   * 仅匹配 parentSessionId；运行中不打断流式。
   */
  useEffect(() => {
    const off = window.electronAPI.onKanbanBoardCompleted?.((payload: unknown) => {
      const p = payload as { parentSessionId?: string; boardId?: string }
      const sid = sessionIdRef.current
      const matchesParent = !!p?.parentSessionId && p.parentSessionId === sid
      const matchesBoard =
        !!p?.boardId && !!sessionBoardId && p.boardId === sessionBoardId
      // 仅刷新与当前会话相关的看板完成
      if (!matchesParent && !matchesBoard) return
      setBackgroundCrewBanner(null)
      if (streamingRef.current) return
      void (async () => {
        try {
          const history = (await window.electronAPI.getMessages(sid)) as unknown[]
          const ch = channels.find((c) => c.id === session.channelId)
          const isKsccCore = ch ? getChannelCoreKind(ch) === 'kscc' : true
          const irItems: DisplayItem[] = []
          let idx = 0
          for (const raw of history) {
            const message = isKsccCore
              ? sdkMessageToIR(raw as never).message
              : isIRMessage(raw)
                ? (raw as TAgentMessage)
                : sdkMessageToIR(raw as never).message
            if (message) {
              irItems.push({ key: `h${idx++}`, message })
            }
          }
          if (sessionIdRef.current !== sid) return
          itemIdxRef.current = Math.max(itemIdxRef.current, irItems.length)
          setItems(irItems)
        } catch {
          /* 回流刷新失败不影响主流程 */
        }
      })()
    })
    return () => {
      off?.()
    }
  }, [session.channelId, sessionBoardId, channels])

  /** 解析 Work→Chat 后是否展示后台班组条（优先 IPC 返回，缺则 listTasks 兜底） */
  const applyBackgroundCrewFromModeSwitch = useCallback(
    async (
      mode: ExecutionMode,
      res: {
        backgroundCrew?: {
          running: number
          ready: number
          pending: number
          boardId?: string
        }
      },
    ): Promise<void> => {
      if (mode === 'work') {
        setBackgroundCrewBanner(null)
        return
      }
      let crew = res.backgroundCrew
      if (!crew && sessionBoardId) {
        try {
          const t = (await window.electronAPI.kanbanListTasks?.(sessionBoardId)) as Array<{
            status?: string
          }>
          if (Array.isArray(t)) {
            const running = t.filter((x) => x.status === 'running').length
            const ready = t.filter((x) => x.status === 'ready').length
            const pending = t.filter((x) => x.status === 'pending').length
            if (running + ready + pending > 0) {
              crew = { running, ready, pending, boardId: sessionBoardId }
            }
          }
        } catch {
          /* ignore */
        }
      }
      if (crew && crew.running + crew.ready + crew.pending > 0) {
        setBackgroundCrewBanner({
          running: crew.running,
          ready: crew.ready,
          pending: crew.pending,
        })
      } else {
        setBackgroundCrewBanner(null)
      }
    },
    [sessionBoardId],
  )

  // 点击输入框外部时折叠功能栏（仅 Work 展开时）
  useEffect(() => {
    if (!composerExpanded || executionMode !== 'work') return
    const handlePointerDown = (e: PointerEvent): void => {
      const cluster = composerClusterRef.current
      if (!cluster) return
      const target = e.target as HTMLElement
      // 点击在 composer 内部 → 不折叠
      if (cluster.contains(target)) return
      // 点击在 Radix popover 内 → 不折叠
      if (target.closest('[data-radix-popper-content-wrapper]')) return
      setComposerExpanded(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [composerExpanded, executionMode])

  // 动态测量底部 UI 实际顶部 → --session-composer-top（下箭头 bottom 锚定）
  // 必须以 Conversation 底边为基准（按钮定位上下文），不能只量 root：
  // 有图片附件时输入玻璃变高，若变量滞后，箭头会停在旧高度并被 z-20 底栏盖住。
  const updateComposerTop = useCallback((): void => {
    const root = rootRef.current
    const stack = bottomStackRef.current
    if (!root || !stack) return
    // Conversation 是 absolute inset-0 的滚动容器，scroll 按钮 relative 于它
    const conversationEl =
      (root.querySelector('[role="log"]') as HTMLElement | null) ?? root
    const convBottom = conversationEl.getBoundingClientRect().bottom
    const stackTop = stack.getBoundingClientRect().top
    const dist = Math.max(0, Math.round(convBottom - stackTop))
    root.style.setProperty('--session-composer-top', `${dist}px`)
  }, [])

  /** 布局变化后多帧校正（附件 DOM 插入、图片解码、功能栏动画） */
  const scheduleComposerTopUpdate = useCallback((): (() => void) => {
    updateComposerTop()
    const raf1 = requestAnimationFrame(() => {
      updateComposerTop()
      requestAnimationFrame(updateComposerTop)
    })
    const t1 = window.setTimeout(updateComposerTop, 50)
    const t2 = window.setTimeout(updateComposerTop, 200)
    return () => {
      cancelAnimationFrame(raf1)
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [updateComposerTop])

  useEffect(() => {
    const stack = bottomStackRef.current
    const composer = composerClusterRef.current
    if (!stack || !composer) return

    // RO：box 尺寸变化（功能栏/token/多行输入/附件撑高）
    const ro = new ResizeObserver(() => {
      updateComposerTop()
    })
    ro.observe(stack)
    ro.observe(composer)
    // MutationObserver：附件队列/横幅/预览卡片增删
    const mo = new MutationObserver(() => {
      updateComposerTop()
    })
    mo.observe(stack, { childList: true, subtree: true, attributes: true })
    const cancel = scheduleComposerTopUpdate()
    // 会话页入场动画结束后再校一次
    const t = window.setTimeout(updateComposerTop, 500)

    return () => {
      ro.disconnect()
      mo.disconnect()
      cancel()
      clearTimeout(t)
    }
  }, [updateComposerTop, scheduleComposerTopUpdate])

  // 功能栏 / 附件 / 模式：显式重测（不依赖 RO 是否丢帧）
  useEffect(() => {
    return scheduleComposerTopUpdate()
  }, [
    composerExpanded,
    pendingAttachments.length,
    executionMode,
    messageQueue.length,
    scheduleComposerTopUpdate,
  ])

  // 班组条展开/折叠：强制多帧重测（列表 max-height 变化时 RO 偶发滞后 → 下箭头压在列表上）
  useEffect(() => {
    const onRemeasure = (): void => {
      scheduleComposerTopUpdate()
    }
    window.addEventListener('tagent:composer-top-remeasure', onRemeasure)
    return () => window.removeEventListener('tagent:composer-top-remeasure', onRemeasure)
  }, [scheduleComposerTopUpdate])

  // 对话列宽度：右栏打开或窗口变窄 → 紧凑输入栏（图标优先，防文字叠压）
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      setComposerCompact(crewPanelOpen)
      return
    }
    const measure = (): void => {
      const w = el.getBoundingClientRect().width
      // 约 560：再塞满模型名+token 标签就会叠；右栏打开通常 < 560
      setComposerCompact(crewPanelOpen || w < 560)
    }
    measure()
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [crewPanelOpen, sessionId])

  // Chat @ 角色列表（B1）
  useEffect(() => {
    void (async () => {
      try {
        const roles = await window.electronAPI.listAgentRoles()
        setMentionRoles(
          (roles ?? []).map((r) => ({
            id: r.id,
            displayName: r.displayName,
            description: r.description,
            pinned: r.pinned === true,
          })),
        )
      } catch {
        setMentionRoles([])
      }
    })()
  }, [])

  // roleId → 展示名（activeSpeaker 指示条 / 跟随铭牌用）
  const roleNameById = useMemo(
    () => new Map(mentionRoles.map((r) => [r.id, r.displayName] as const)),
    [mentionRoles],
  )

  /** ✕ 清除对话跟随：本地清空 + 主进程 pendingMentionRoleIds 置空（回默认总助） */
  const clearActiveMention = useCallback(async () => {
    setActiveMentionRoleIds([])
    setLiveMentionLabels([])
    try {
      await window.electronAPI.clearMentionFollow(sessionId)
    } catch {
      /* ignore */
    }
  }, [sessionId])

  /**
   * Chat 输入框顶部的 activeSpeaker 指示条（参考主流 IM「当前对话对象」）：
   * @ 某角色后显示「正在与 @角色 对话」，续聊下一轮保持；✕ 结束跟随回默认总助。
   */
  const activeMentionBar =
    executionMode === 'chat' && activeMentionRoleIds.length > 0 ? (
      <div className="active-speaker-bar" role="status" aria-live="polite">
        <UsersThree className="size-3.5 shrink-0 text-primary" weight="fill" aria-hidden />
        <span className="active-speaker-bar__label">正在与</span>
        {activeMentionRoleIds.map((id) => (
          <span key={id} className="active-speaker-chip">
            @{roleNameById.get(id) ?? id}
          </span>
        ))}
        <span className="active-speaker-bar__label">对话</span>
        <button
          type="button"
          className="active-speaker-clear"
          onClick={() => void clearActiveMention()}
          aria-label="结束跟随，回到默认助手"
          title="结束跟随，回到默认助手"
        >
          <X className="size-3" aria-hidden />
        </button>
      </div>
    ) : null

  // 虚拟化分批递增：未全挂时，idle 帧每批 +40 补齐旧消息（保近期，底部对话不受影响）
  useEffect(() => {
    if (fullyMounted) return
    if (items.length === 0) return
    // requestIdleCallback 兼容（Electron Chromium 原生支持，fallback setTimeout）
    const scheduleIdle: (cb: () => void) => number =
      typeof window !== 'undefined' && 'requestIdleCallback' in window
        ? window.requestIdleCallback
        : (cb) => window.setTimeout(cb, 16) as unknown as number
    const cancelIdle: (h: number) => void =
      typeof window !== 'undefined' && 'cancelIdleCallback' in window
        ? window.cancelIdleCallback
        : (h) => window.clearTimeout(h)
    const handle = scheduleIdle(() => {
      setVisibleCount((prev) => {
        if (prev >= items.length) return prev // 已全挂，不动
        const next = Math.min(prev + 40, items.length)
        return next >= items.length ? Number.POSITIVE_INFINITY : next // 全挂完置 Infinity，流式追加走全量分支
      })
    })
    return () => cancelIdle(handle)
  }, [visibleCount, items.length, fullyMounted])

  // 监听流式事件
  useEffect(() => {
    const off = window.electronAPI.onStreamEvent((payload: unknown) => {
      const env = payload as StreamEventEnvelope
      if (env.sessionId !== sessionIdRef.current) return
      handlePayload(env.payload)
    })
    return () => {
      off?.()
      clearPendingStop()
      if (thinkingFlushRafRef.current != null) {
        cancelAnimationFrame(thinkingFlushRafRef.current)
        thinkingFlushRafRef.current = null
      }
    }
  }, [])

  /**
   * 任务卡片 apply：existing=undefined 新建（分配稳定 key），否则就地更新 taskCard
   * （保留 message / streamingText 等其他字段）。reduceTaskEvent 的承载项工厂。
   */
  const taskCardApply = (
    existing: DisplayItem | undefined,
    card: TaskCardState,
  ): DisplayItem =>
    existing ? { ...existing, taskCard: card } : { key: `task${itemIdxRef.current++}`, taskCard: card }

  /**
   * 清掉纯流式占位（无 message / 任务卡 / 压缩行）。
   * 落盘 sdk_message 后必须 purge，否则会与最终正文叠成双份。
   */
  const purgeStreamingItems = (prev: DisplayItem[]): DisplayItem[] =>
    prev.filter((it) => Boolean(it.message || it.taskCard || it.compactStatus))

  const upsertStreamItem = (
    prev: DisplayItem[],
    patch: Partial<Pick<DisplayItem, 'streamingText' | 'streamingThinking'>>,
  ): DisplayItem[] => {
    const base = purgeStreamingItems(prev)
    const existing = streamingRef.current
    const inList = existing ? prev.some((it) => it.key === existing.key && it.streaming) : false
    if (!inList || !existing) {
      const created: DisplayItem = {
        key: `s${itemIdxRef.current++}`,
        streaming: true,
        streamingText: patch.streamingText ?? '',
        streamingThinking: patch.streamingThinking ?? '',
      }
      streamingRef.current = created
      return [...base, created]
    }
    const next: DisplayItem = {
      ...existing,
      streaming: true,
      streamingText:
        patch.streamingText !== undefined ? patch.streamingText : existing.streamingText,
      streamingThinking:
        patch.streamingThinking !== undefined
          ? patch.streamingThinking
          : existing.streamingThinking,
    }
    streamingRef.current = next
    return prev.map((it) => (it.key === existing.key ? next : it))
  }

  // thinking delta 的 rAF 合并缓冲：同一帧内多次 delta 只 flush 一次（渲染频率从"每事件"降到"每帧"）
  const pendingThinkingRef = useRef('')
  const thinkingFlushRafRef = useRef<number | null>(null)
  const flushThinkingDelta = useCallback((): void => {
    thinkingFlushRafRef.current = null
    const delta = pendingThinkingRef.current
    pendingThinkingRef.current = ''
    if (!delta) return
    setItems((prev) => {
      const cur = streamingRef.current
      // 流式项已被落盘就地升级（streamingRef 已清空）→ 思考全文已在 message，丢弃尾部缓冲
      if (!cur || !prev.some((it) => it.key === cur.key)) return prev
      const prevThink = cur.streamingThinking ?? ''
      return upsertStreamItem(prev, { streamingThinking: prevThink + delta })
    })
  }, [])

  const handlePayload = (p: TAgentDesktopStreamPayload): void => {
    // run 仍在进行：取消 turn_end 的延迟停止；流式/落盘事件恢复 running
    // （保过程区展开、停止键在位；adopt 沿用原 startedAt，不重置计时）
    clearPendingStop()
    if (
      p.kind === 'stream_text_delta' ||
      p.kind === 'stream_thinking_delta' ||
      p.kind === 'sdk_message'
    ) {
      if (!runningRef.current) {
        adoptSessionRun({
          id: sessionId,
          startedAt: runStartedAtPersistRef.current ?? runStartedAtRef.current ?? Date.now(),
        })
      }
    }
    if (p.kind === 'sdk_message') {
      // 先记下流式占位 key（下面要清 streamingRef），用于就地升级占位、保留打字机起点
      const streamingKey = streamingRef.current?.key
      streamingRef.current = null
      // assistant.usage 更新底栏（Pi）；kscc 圆环不展示，但状态可写无害
      if (p.message.type === 'assistant' && p.message.usage) {
        applyUsage(p.message.usage)
      }
      // 落盘消息：若当前有流式占位，就地升级它为落盘 message 项。
      // 关键：清掉 streamingText（打字机续接靠 useSmoothStream 内部 prevContentRef，不靠保留 streamingText）。
      // 保留 streamingText 会导致多轮工具时旧轮的 streamingText 残留、buildTurnPresentation 误收集 → 重复文字。
      // useSmoothStream 实例在 turn 生命周期内存活（turn key 稳定），content 从 streamingText 切到 answerText，
      // 同源前缀则 isAppend 逐字追完，不重挂不跳变。无流式占位（历史回放/纯落盘）则 append 新项。
      setItems((prev) => {
        if (streamingKey != null && prev.some((it) => it.key === streamingKey && it.streaming)) {
          return prev.map((it) =>
            it.key === streamingKey
              ? { ...it, message: p.message, streaming: false, streamingText: undefined, streamingThinking: undefined }
              : it,
          )
        }
        // Pi 核流式：每个 sdk_message 都是完整累积的 assistant message（无 stop_reason 表示仍在流式）。
        // 必须就地更新最后一个 assistant item，否则每次 chunk append 新 item →
        // 同一 turn 内出现 N 个递增长度的 assistant text → buildTurnPresentation 收集到重复文字。
        // 标记 streaming: true 让 turn model 把它当流式 turn（isStreaming）→ 打字机 + 过程区展开生效。
        const isPiStreamingAssistant =
          p.message.type === 'assistant' && !p.message.stop_reason
        if (isPiStreamingAssistant) {
          const lastIdx = prev.length - 1
          const last = prev[lastIdx]
          if (last?.message?.type === 'assistant') {
            // 同一个 turn 的连续 assistant 流式 chunk → 原地替换 content，标记 streaming
            // （保留 key，useSmoothStream 平滑续接；stop_reason 到来后再标 streaming:false）
            return prev.map((it, i) =>
              i === lastIdx
                ? { ...it, message: p.message, streaming: true, streamingText: undefined, streamingThinking: undefined }
                : it,
            )
          }
        }
        // Pi 核完成（有 stop_reason）→ 落盘最终 message：清 streaming 标记
        if (p.message.type === 'assistant' && p.message.stop_reason) {
          const lastIdx = prev.length - 1
          const last = prev[lastIdx]
          if (last?.message?.type === 'assistant' && last.streaming) {
            return prev.map((it, i) =>
              i === lastIdx
                ? { ...it, message: p.message, streaming: false, streamingText: undefined, streamingThinking: undefined }
                : it,
            )
          }
        }
        return [
          ...purgeStreamingItems(prev),
          { key: `m${itemIdxRef.current++}`, message: p.message },
        ]
      })
    } else if (p.kind === 'result') {
      if (p.usage) applyUsage(p.usage)
      streamingRef.current = null
      // Pi 核流式 item 此时仍在 streaming:true → 标 false（防后续 turn 误判为流式中）
      setItems((prev) => {
        const cleaned = prev.map((it) =>
          it.streaming ? { ...it, streaming: false, streamingText: undefined, streamingThinking: undefined } : it,
        )
        return purgeStreamingItems(cleaned)
      })
      // result = 整个 run 真正 idle（turn_end 只是单个 SDK turn 结束，工具循环还会继续）。
      // 用 completeRun 记发送→idle 全程耗时到最后 assistant-turn，再清 running。
      clearPendingStop()
      beginStreamTransition()
      completeRun()
      bumpRefresh()
    } else if (p.kind === 'stream_text_delta') {
      setItems((prev) => {
        const cur = streamingRef.current
        const prevText =
          cur && prev.some((it) => it.key === cur.key) ? (cur.streamingText ?? '') : ''
        return upsertStreamItem(prev, { streamingText: prevText + p.text })
      })
    } else if (p.kind === 'stream_thinking_delta') {
      // Pi message_start 的空占位：立即立起流式项（思考行/加载态先出现），不经 rAF
      if (p.text === '') {
        setItems((prev) => {
          const cur = streamingRef.current
          const prevThink =
            cur && prev.some((it) => it.key === cur.key) ? (cur.streamingThinking ?? '') : ''
          return upsertStreamItem(prev, { streamingThinking: prevThink })
        })
        return
      }
      // 非空 delta 按帧合并（Pi 每 token 一事件），避免高频 setItems 全量重建 turn
      pendingThinkingRef.current += p.text
      if (thinkingFlushRafRef.current == null) {
        thinkingFlushRafRef.current = requestAnimationFrame(flushThinkingDelta)
      }
    } else if (p.kind === 'tagent_event') {
      const evt = p.event as {
        type: string
        message?: string
        taskId?: string
        toolUseId?: string
        description?: string
        status?: string
        summary?: string
        lastToolName?: string
      }
      if (evt.type === 'turn_end') {
        streamingRef.current = null
        // Pi 核流式 item 此时仍在 streaming:true → 标 false（防后续 turn 误判为流式中）
        setItems((prev) => {
          const cleaned = prev.map((it) =>
            it.streaming ? { ...it, streaming: false, streamingText: undefined, streamingThinking: undefined } : it,
          )
          return purgeStreamingItems(cleaned)
        })
        // 工具循环中 turn_end 只是单轮结束：延迟停止，宽限期内有下一轮 delta → 保持 running
        // （过程区/思考链不闪断收起）；宽限期到且无后续 → 真正停止
        scheduleRunStop()
        // 流式占位→落盘消息的高度切换：瞬间切 instant resize 防滚动动画闪动
        beginStreamTransition()
        // followMode：不再清 liveMentionLabels——铭牌代表当前 activeSpeaker，续聊仍由该角色接。
        // 用户在输入框 ✕ 清除 activeMentionRoleIds 时会一并清 liveMentionLabels。
        bumpRefresh()
      } else if (evt.type === 'memory_organizing') {
        // Phase 4/5：kscc 软重置 / 影子压缩 — 显示「正在整理记忆」
        setIsCompactingUi(true)
        setItems((prev) => {
          if (prev.some((it) => it.compactStatus === 'compacting')) return prev
          return [
            ...prev,
            {
              key: `mem-org-${itemIdxRef.current++}`,
              compactStatus: 'compacting' as const,
            },
          ]
        })
        if (evt.status === 'ready' || evt.status === 'idle') {
          setIsCompactingUi(false)
          setItems((prev) => {
            const filtered = prev.filter((it) => it.compactStatus !== 'compacting')
            return [
              ...filtered,
              {
                key: `mem-org-done-${itemIdxRef.current++}`,
                compactStatus: 'complete' as const,
                compactTrigger: 'auto' as const,
              },
            ]
          })
        }
      } else if (evt.type === 'session_error') {
        // 主进程已按分类表转译（classifyUserFacingError）：友好标题 + 原文 + 可重试标记
        const userError = (evt as { error?: { title?: string; retryable?: boolean } }).error
        const title = userError?.title ?? '错误'
        const detail = `${title}：${evt.message ?? ''}${userError?.retryable ? '（可重试）' : ''}`
        setItems((prev) => [
          ...prev,
          {
            key: `e${itemIdxRef.current++}`,
            message: {
              type: 'assistant',
              content: [{ type: 'text', text: detail }],
            } as TAgentMessage,
          },
        ])
        clearPendingStop()
        recordCompletion('error')
        stopRun()
      } else if (evt.type === 'compacting') {
        setIsCompactingUi(true)
        setItems((prev) => [
          ...prev,
          {
            key: `c${itemIdxRef.current++}`,
            compactStatus: 'compacting' as const,
          },
        ])
      } else if (evt.type === 'compact_complete') {
        setIsCompactingUi(false)
        const trigger = (evt as { trigger?: 'auto' | 'manual' }).trigger
        const tokensBefore = (evt as { tokensBefore?: number }).tokensBefore
        // 压缩后用 tokensBefore 刷新环（估算）；无则保留旧 usage
        if (typeof tokensBefore === 'number' && tokensBefore > 0) {
          setContextUsage((prev) =>
            prev
              ? { ...prev, inputTokens: Math.min(prev.inputTokens, tokensBefore) || tokensBefore }
              : {
                  inputTokens: tokensBefore,
                  contextWindow: DEFAULT_CONTEXT_WINDOW,
                },
          )
        }
        setItems((prev) => {
          // 去掉进行中的占位，换成完成分隔
          const filtered = prev.filter((it) => it.compactStatus !== 'compacting')
          return [
            ...filtered,
            {
              key: `c${itemIdxRef.current++}`,
              compactStatus: 'complete' as const,
              compactTrigger: trigger,
            },
          ]
        })
      } else if (evt.type === 'task_started') {
        // 子代理启动：upsert 任务卡片（running），不再塞 assistant 文本气泡
        const event: TaskCardEvent = {
          type: 'task_started',
          taskId: evt.taskId ?? '',
          toolUseId: evt.toolUseId,
          description: evt.description ?? '',
        }
        setItems((prev) => reduceTaskEvent(prev, event, taskCardApply))
      } else if (evt.type === 'task_progress') {
        // 子代理进度：更新同一张任务卡片的 lastToolName / progressText，不新增气泡
        const event: TaskCardEvent = {
          type: 'task_progress',
          taskId: evt.taskId,
          toolUseId: evt.toolUseId,
          description: evt.description,
          lastToolName: evt.lastToolName,
        }
        setItems((prev) => reduceTaskEvent(prev, event, taskCardApply))
      } else if (evt.type === 'task_notification') {
        // 子代理收口：置 status + summary，清空进度文案
        const status: TaskCardState['status'] =
          evt.status === 'completed' || evt.status === 'failed' || evt.status === 'stopped'
            ? evt.status
            : 'stopped'
        const event: TaskCardEvent = {
          type: 'task_notification',
          taskId: evt.taskId ?? '',
          toolUseId: evt.toolUseId,
          status,
          summary: evt.summary ?? '',
        }
        setItems((prev) => reduceTaskEvent(prev, event, taskCardApply))
      }
    }
  }

  const compactContext = async (): Promise<void> => {
    try {
      const res = await window.electronAPI.compactSession(sessionIdRef.current)
      if (!res.ok) {
        alert(res.reason ?? '压缩失败')
        return
      }
      if (!res.compacted) {
        alert(res.reason ?? '当前无需压缩')
      }
      // 成功时 compact_complete 事件由主进程流推入 items
    } catch (err) {
      alert(err instanceof Error ? err.message : '压缩失败')
    }
  }

  /** 核心发送逻辑：校验渠道 → 保存附件 → IPC sendMessage → materializeTab */
  const sendQueued = async ({ text, selection, attachments }: {
    text: string; selection: ModelSelection;
    attachments?: Array<{ id: string; filename: string; mediaType: string; size: number; previewUrl?: string; data: string }>
  }): Promise<void> => {
    if (!selection) {
      alert('没有可用模型，请先在「设置 → 渠道」中启用渠道和模型')
      return
    }
    const channel = channels.find((item) => item.id === selection.channelId)
    const model = channel?.models.find((item) => item.id === selection.modelId)
    if (!channel?.enabled || !model?.enabled) {
      alert('当前渠道或模型已停用，请选择同一运行区域内的可用模型')
      return
    }
    // 保存附件到磁盘
    let savedAttachments: Array<{ id: string; filename: string; mediaType: string; localPath: string; size: number }> = []
    if (attachments?.length) {
      for (const att of attachments) {
        try {
          const saved = await (window.electronAPI as any).saveAttachment({
            sessionId: sessionIdRef.current,
            filename: att.filename,
            mediaType: att.mediaType,
            data: att.data,
          })
          savedAttachments.push(saved)
        } catch (err) {
          console.error('[Chat] 保存附件失败:', att.filename, err)
        }
      }
      // 清空待发附件 + revoke blob URLs
      for (const att of attachments) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl)
      }
      setPendingAttachments([])
    }
    startRun()
    try {
      const res = await window.electronAPI.sendMessage({
        sessionId: sessionIdRef.current,
        prompt: text,
        channelId: selection.channelId,
        model: selection.modelId,
        workspaceId: session.workspaceId,
        ...(savedAttachments.length ? { attachments: savedAttachments } : {}),
        mentionRoleIds:
          executionMode === 'chat' && mentionRoles.length > 0
            ? parseMentions(text, mentionRoles).map((h) => h.roleId)
            : undefined,
        executionMode,
      } as any)
      if (res && !res.ok) {
        alert(`发送失败：${res.error ?? '未知错误'}`)
        stopRun()
      } else {
        const coreKind = getChannelCoreKind(channel)
        setSelectionOverride(selection)
        setSentCoreKind(coreKind)
        const sid = sessionIdRef.current
        const exists = tabs.some((t) => t.sessionId === sid)
        if (!exists) {
          const { tabs: nextTabs, activeTabId } = materializeTab(
            tabs,
            sid,
            session.title || '新会话',
            session.workspaceId,
            selection.channelId,
            selection.modelId,
          )
          setTabs(nextTabs)
          setActiveTabId(activeTabId)
        } else {
          setTabs((prev) => prev.map((tab) => (
            tab.sessionId === sid
              ? { ...tab, channelId: selection.channelId, modelId: selection.modelId }
              : tab
          )))
        }
      }
      bumpRefresh()
    } catch (err) {
      console.error('[Chat] sendMessage 异常:', err)
      alert(`发送异常：${err instanceof Error ? err.message : String(err)}`)
      stopRun()
    }
  }

  /** 用户发送：空闲→立即发；运行中→入队 */
  const send = async (): Promise<void> => {
    const text = chatInputRef.current?.getText().trim()
    if (!text) return
    // Chat @：本轮有 @ → 切换 activeSpeaker；无 @ → 保持上一个（follow）。铭牌按 effective 角色展示。
    if (executionMode === 'chat' && mentionRoles.length > 0) {
      const hits = parseMentions(text, mentionRoles)
      if (hits.length > 0) {
        setActiveMentionRoleIds(hits.map((h) => h.roleId))
        setLiveMentionLabels(hits.map((h) => h.displayName))
      } else {
        // follow：本轮未 @，沿用当前 activeSpeaker 的铭牌（无则空 → 默认总助）
        setLiveMentionLabels(
          activeMentionRoleIds
            .map((id) => roleNameById.get(id))
            .filter((v): v is string => Boolean(v)),
        )
      }
    } else {
      setLiveMentionLabels([])
    }
    chatInputRef.current?.clear()
    if (running) {
      // 运行中 → 入队，等当前轮结束自动消费
      if (effectiveSelection) {
        setMessageQueue((q) => [...q, { text, selection: effectiveSelection }])
      }
      return
    }
    // 空闲 → 立即发
    if (!effectiveSelection) {
      alert('没有可用模型，请先在「设置 → 渠道」中启用渠道和模型')
      return
    }
    await sendQueued({ text, selection: effectiveSelection, attachments: pendingAttachments })
  }

  /** 运行结束 → 批量消费队列（逐条 await，确保 running 状态正确） */
  useEffect(() => {
    if (running || messageQueue.length === 0) return
    const pending = messageQueue
    setMessageQueue([])
    void (async () => {
      for (const item of pending) {
        await sendQueued(item)
      }
    })()
  }, [running, messageQueue])

  /** 队列操作 */
  const removeQueueItem = (index: number): void => {
    setMessageQueue((q) => q.filter((_, i) => i !== index))
  }
  const clearQueue = (): void => setMessageQueue([])

  /** 新会话页：切换工作区（草稿态无 tab → 改 App 的 draftSession；已有 tab → 改 tab） */
  const changeWorkspace = (id: string): void => {
    onDraftWorkspaceChange?.(id)
    setTabs((prev) => prev.map((tab) => (
      tab.sessionId === sessionId ? { ...tab, workspaceId: id } : tab
    )))
  }

  /** 新会话页：打开其他项目（原生目录选择 → 注册工作区 → 切到新工作区） */
  const handleOpenProjectInLanding = async (): Promise<void> => {
    const workspace = await window.electronAPI.createProjectWorkspace()
    if (!workspace) return
    await loadWorkspaces()
    changeWorkspace(workspace.id)
  }

  /** 提示词点击：填入输入框并聚焦（不自动发送） */
  const pickSuggestion = (text: string): void => {
    chatInputRef.current?.setText(text)
    chatInputRef.current?.focus()
  }

  /** 打开文件选择器 → 添加待发附件 */
  const handleOpenFileDialog = useCallback(async () => {
    const result = await (window.electronAPI as any).openFileDialog()
    if (!result?.files?.length) return
    const newAttachments = result.files.map((f: any) => {
      const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const isImage = f.mediaType?.startsWith('image/')
      return {
        id,
        filename: f.filename,
        mediaType: f.mediaType,
        size: f.size,
        previewUrl: isImage && f.data ? `data:${f.mediaType};base64,${f.data}` : undefined,
        data: f.data,
      }
    })
    setPendingAttachments((prev) => [...prev, ...newAttachments])
  }, [])

  /** 新会话页底部工具栏：模式切换（左）+ 模型（中）+ 发送/停止钮（右）。
   *  工作区选择已移到输入框下方的独立容器（见 workspaceSlot），不再挤在 footer。 */
  const landingFooter = (
    <div className="flex items-center justify-end gap-1.5 px-2 pb-2 pt-1">
      {/* Chat | Work 切换（草稿会话仅改本地状态，首条发送时主进程创建 meta 会带上） */}
      <ExecutionModeToggle
        value={executionMode}
        onChange={(m) => {
          setExecutionMode(m)
          setPendingModeSuggestion(null)
          // 非草稿会话才同步主进程 meta（草稿会话尚未有 meta，IPC 会失败；首条发送时创建 meta 会带上本地 mode）
          if (!onDraftWorkspaceChange) {
            void (async () => {
              const res = await window.electronAPI.setSessionExecutionMode(
                sessionId,
                m,
                'user',
              )
              if (!res.ok) {
                console.warn('[Chat] setSessionExecutionMode failed:', res.error)
              } else {
                void window.electronAPI.dismissExecutionModeSuggestion?.(sessionId)
                await applyBackgroundCrewFromModeSwitch(m, res)
              }
            })()
          }
        }}
      />
      <ModelSelector
        selection={effectiveSelection}
        lockedKind={null}
        onSelect={(nextSelection) => {
          setSelectionOverride(nextSelection)
          setSelectedModelSelection(nextSelection)
        }}
      />
      {running ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-9 rounded-full text-destructive hover:bg-destructive/10"
          onClick={() => {
            userStopRun()
            void window.electronAPI.stopAgent(sessionIdRef.current)
          }}
          aria-label="停止"
        >
          <Square className="size-4" fill="currentColor" />
        </Button>
      ) : (
        <Button
          variant={hasDraft ? 'default' : 'ghost'}
          size="icon"
          className="size-9 rounded-full"
          disabled={!hasDraft}
          onClick={() => void send()}
          aria-label="发送"
        >
          <ArrowUp className="size-5" />
        </Button>
      )}
    </div>
  )

  const landingComposer = (
    <ChatInput
      ref={chatInputRef}
      onSubmit={() => void send()}
      placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
      onDraftChange={setHasDraft}
      attachments={pendingAttachments}
      onAttachmentsChange={setPendingAttachments}
      onOpenFileDialog={handleOpenFileDialog}
      mentionRoles={executionMode === 'chat' ? mentionRoles : undefined}
      topBar={activeMentionBar}
      footer={landingFooter}
    />
  )

  /** 新会话页：输入框下方的工作区选择容器（独立卡片）。WorkspaceSelector 自带文件夹图标，左侧只放纯文字标签。 */
  const workspaceSlot = (
    <div className="flex items-center justify-between rounded-xl border border-border/55 bg-muted/20 pl-3 pr-1.5 py-1.5">
      <span className="shrink-0 text-[11px] text-muted-foreground/70">工作区</span>
      <WorkspaceSelector
        value={session.workspaceId}
        onSelect={changeWorkspace}
        onOpenProject={() => void handleOpenProjectInLanding()}
      />
    </div>
  )

  // 消息内文件 chip 的注入上下文：打开/存在性检查走主进程 IPC；
  // 存在性结果（含 null）短期缓存，避免流式逐帧重建 chip 时每帧打 IPC
  const setFilePreviewRequest = useSetAtom(filePreviewRequestAtom)
  const filePathProviderValue = useMemo(() => {
    const negCache = new Map<string, { value: string | null; at: number }>()
    const NEG_TTL = 10_000
    return {
      // 点击文件 chip → 右侧分屏打开应用内预览（dock 监听 filePreviewRequestAtom 开 pane）
      onOpenFile: (path: string): void => {
        setFilePreviewRequest({ sessionId: sessionIdRef.current, path })
      },
      onResolveFile: async (path: string, bases?: string[]): Promise<string | null> => {
        const key = `${path}\0${(bases ?? []).join('\0')}`
        const hit = negCache.get(key)
        if (hit && Date.now() - hit.at < NEG_TTL) return hit.value
        const resolved = await window.electronAPI.resolveFile({
          sessionId: sessionIdRef.current,
          path,
          bases,
        })
        negCache.set(key, { value: resolved, at: Date.now() })
        return resolved
      },
      getSessionId: () => sessionIdRef.current,
    }
  }, [])

  return (
    <MessageFilePathProvider value={filePathProviderValue}>
    <div className="session-body flex h-full min-h-0">
      {/* 左：对话 + 输入（测量锚点 rootRef 只包对话列，避免右栏影响下箭头） */}
      <div
        ref={rootRef}
        className={cn(
          'session-chat-col relative min-h-0 min-w-0 flex-1',
          composerCompact && 'is-composer-compact',
        )}
        data-composer-density={composerCompact ? 'compact' : 'comfortable'}
      >
      {items.length === 0 && !running ? (
        <NewConversationLanding
          composer={landingComposer}
          workspaceSlot={workspaceSlot}
          onPickSuggestion={pickSuggestion}
          onBack={onBack}
        />
      ) : (
        <div className={`relative h-full min-h-0 chat-page-enter ${pageMounted ? 'is-mounted' : ''}`}>
          {/* 消息区：全高；线程有 max-width 居中；底栏输入/token 铺满对话列 */}
          <Conversation
            className="absolute inset-0 min-h-0"
            contextRef={scrollContextRef}
            resize={
              effectiveScrollReady && !streamTransitioning ? 'smooth' : 'instant'
            }
          >
            <ConversationContent className="session-conversation-pad px-4 pt-2 pb-44">
              <div className="tagent-thread">
              {/* 虚拟化加载提示：未全挂时常驻显示（说清楚在加载、剩多少条），不闪烁 */}
              {!fullyMounted && items.length > 0 && (
                <div
                  className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  <span className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
                  <span>正在加载更早的 {items.length - effectiveVisible} 条…</span>
                </div>
              )}
              {visibleTurns.map((turn, turnIndex) => {
                // 整轮 Agent 仍在跑且是最新 turn → 过程区保持展开（含工具间隙，不只 stream delta）
                const isLiveTurn =
                  running &&
                  turnIndex === visibleTurns.length - 1 &&
                  turn.kind === 'assistant-turn'
                // 追踪最后一个 assistant-turn 的 key，供 completeRun 记完成耗时
                if (turn.kind === 'assistant-turn') lastAssistantTurnKeyRef.current = turn.key
                return (
                  <TurnView
                    key={turn.key}
                    turn={turn}
                    isLiveTurn={isLiveTurn}
                    onRefillToInput={pickSuggestion}
                    mentionLabels={
                      isLiveTurn && liveMentionLabels.length > 0
                        ? liveMentionLabels
                        : undefined
                    }
                    completedDuration={completedDurations[turn.key]}
                    subagentCards={subagentCards}
                    onOpenSubagent={(parentToolUseId) => setSubagentDetail(parentToolUseId)}
                  />
                )
              })}
              {running &&
                !items.some((it) => it.streaming) &&
                visibleTurns[visibleTurns.length - 1]?.kind !== 'assistant-turn' && (
                  <MessageLoading />
                )}
            </div>
        </ConversationContent>
        {/* 切会话恢复滚动位置（无动画、不打断查历史），对齐 TAgent_General ScrollPositionManager */}
        <ScrollPositionManager id={sessionId} ready={effectiveScrollReady} />
        <ScrollMinimap items={minimapItems} />
        <ConversationScrollButton />
      </Conversation>

      {/*
        底栏坐标系（对齐 General）：
        窗底 ── status(7) ── token 栏 ── 间隙 ── 输入框底（= band = rail/sidebar 底）
        stack 锚在 status；输入用 margin-bottom 抬到 band，token 不把输入顶上去。
        权限确认面板放在 composer 上方（stack 内、cluster 之前），从输入框上方伸出，靠文档流撑高。
      */}
      <div ref={bottomStackRef} className="session-bottom-stack absolute inset-x-0">
        {/* 底部统一模糊带：一块 backdrop-filter + 向下渐浓底色，覆盖「输入框顶→窗口底」
            整条底层，宽 = 输入框宽（gutter）。定位用 --session-composer-top，功能栏展开时
            该变量被抬高，背板顶自动上移、高度自动变大。输入框 / token 栏 / 功能栏都不再
            各自 backdrop-filter，共用这一块，避免两层模糊叠成糊块。z-index:-1 沉到 stack
            内最底（在 token(z1)/输入框(z2) 与 MessageQueue/PermissionBanner 之下）。 */}
        <div className="composer-blur-underlay" aria-hidden="true" />
        <MessageQueue queue={messageQueue} onRemove={removeQueueItem} onClear={clearQueue} />
        {backgroundCrewBanner && executionMode === 'chat' ? (
          <div
            className="kanban-crew-bg-banner pointer-events-auto mx-3 mb-2 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11.5px] leading-snug text-foreground/90 shadow-sm backdrop-blur-md"
            role="status"
            aria-live="polite"
          >
            <span className="min-w-0 flex-1">
              班组仍在后台执行（{backgroundCrewBanner.running} 个进行中 /{' '}
              {backgroundCrewBanner.ready + backgroundCrewBanner.pending} 排队），Chat
              模式不会杀工人
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              onClick={() => {
                setBackgroundCrewBanner(null)
                setCrewPanelOpen(true)
              }}
              aria-label="打开班组面板"
            >
              查看班组
            </button>
            <button
              type="button"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              onClick={() => setBackgroundCrewBanner(null)}
              aria-label="关闭后台班组提示"
            >
              关闭
            </button>
          </div>
        ) : null}
        <ExecutionModeSuggestionBanner
          sessionId={sessionId}
          executionMode={executionMode}
          initialSuggestion={pendingModeSuggestion}
          onExecutionModeChange={async (m, source) => {
            const prev = executionMode
            setExecutionMode(m)
            setPendingModeSuggestion(null)
            const res = await window.electronAPI.setSessionExecutionMode(sessionId, m, source)
            if (!res.ok) {
              setExecutionMode(prev)
              console.error('[Chat] setSessionExecutionMode (suggestion) failed:', res.error)
            } else {
              await applyBackgroundCrewFromModeSwitch(m, res)
            }
          }}
        />
        <PermissionBanner sessionId={sessionId} />
        <div
          ref={composerClusterRef}
          className={`session-composer-cluster ${showTokenBar ? 'has-token-bar' : ''} ${composerExpanded ? 'is-composer-expanded' : ''}`}
        >
          <ComposerRunTimer startedAt={runStartedAt} />
          <div
            className="session-input-dock"
            data-permission-mode={permissionMode}
            data-execution-mode={executionMode}
          >
            <ChatInput
              ref={chatInputRef}
              onSubmit={() => void send()}
              placeholder={
                executionMode === 'chat'
                  ? '输入消息… @ 点名角色（Enter 发送）'
                  : '输入消息…（Enter 发送，Shift+Enter 换行）'
              }
              onDraftChange={setHasDraft}
              attachments={pendingAttachments}
              onAttachmentsChange={setPendingAttachments}
              onOpenFileDialog={handleOpenFileDialog}
              mentionRoles={executionMode === 'chat' ? mentionRoles : undefined}
              topBar={activeMentionBar}
              footer={
                /* h-7 固定底栏；窄宽时 is-composer-compact 走图标优先方案 */
                <div
                  className={cn(
                    'composer-footer-bar flex h-7 items-center justify-between gap-1 px-2 pb-2 pt-0.5',
                    composerCompact && 'composer-footer-bar--compact',
                  )}
                >
                  <div className="composer-footer-bar__left flex h-7 min-w-0 items-center gap-0.5">
                    {/* 加号最左 */}
                    <AppTooltip label="添加附件">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 rounded-lg text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                        onClick={handleOpenFileDialog}
                        aria-label="添加附件"
                      >
                        <Plus className="size-4" />
                      </Button>
                    </AppTooltip>
                    {/* Chat | Work */}
                    <ExecutionModeToggle
                      value={executionMode}
                      onChange={(m) => {
                        void (async () => {
                          const prev = executionMode
                          setExecutionMode(m)
                          setPendingModeSuggestion(null)
                          const res = await window.electronAPI.setSessionExecutionMode(
                            sessionId,
                            m,
                            'user',
                          )
                          if (!res.ok) {
                            setExecutionMode(prev)
                            console.error('[Chat] setSessionExecutionMode failed:', res.error)
                          } else {
                            void window.electronAPI.dismissExecutionModeSuggestion?.(sessionId)
                            await applyBackgroundCrewFromModeSwitch(m, res)
                            if (m === 'work' && !crewExternalized) setCrewPanelOpen(true)
                          }
                        })()
                      }}
                    />
                    {/* 班组：窄模式仅图标。
                        分屏模式（crewExternalized）也保留按钮（绑定本会话），点击开外部 crew pane；
                        非分屏模式点开关内部面板。按 hasCrewBoards/sessionBoardId 显隐（有/有过板才显）。 */}
                    {hasCrewBoards || sessionBoardId ? (
                      <AppTooltip label={crewExternalized ? '打开班组面板（分屏）' : crewPanelOpen ? '收起班组面板' : '打开班组面板'}>
                        <button
                          type="button"
                          className={cn(
                            'composer-crew-btn inline-flex h-7 shrink-0 items-center justify-center rounded-lg transition-colors',
                            composerCompact ? 'w-7 px-0' : 'gap-1 px-2',
                            !crewExternalized && crewPanelOpen
                              ? 'bg-primary/12 text-primary'
                              : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
                          )}
                          onClick={() => {
                            if (crewExternalized) onOpenCrew?.()
                            else setCrewPanelOpen((v) => !v)
                          }}
                          aria-label={crewExternalized ? '打开班组面板' : crewPanelOpen ? '收起班组面板' : '打开班组面板'}
                          aria-pressed={!crewExternalized ? crewPanelOpen : undefined}
                        >
                          <UsersThree className="size-3.5 shrink-0" weight="bold" />
                          {!composerCompact ? (
                            <span className="composer-crew-btn__label text-[11px] font-semibold">
                              班组
                            </span>
                          ) : null}
                        </button>
                      </AppTooltip>
                    ) : null}
                    {/* Work 权限角标：窄模式隐藏文字 */}
                    {executionMode === 'work' && permissionMode !== 'auto' ? (
                      <AppTooltip
                        label={`权限：${TAGENT_PERMISSION_MODE_CONFIG[permissionMode]?.label ?? permissionMode}`}
                      >
                        <button
                          type="button"
                          className={`composer-permission-chip composer-permission-chip--${permissionMode}`}
                          onClick={() => setComposerExpanded(true)}
                          aria-label={`权限：${TAGENT_PERMISSION_MODE_CONFIG[permissionMode]?.label ?? permissionMode}（点击展开切换）`}
                        >
                          {permissionMode === 'plan' ? (
                            <Compass className="composer-permission-chip__icon" aria-hidden />
                          ) : (
                            <Unlock className="composer-permission-chip__icon" aria-hidden />
                          )}
                          <span className="composer-permission-chip__label max-w-[64px] truncate">
                            {TAGENT_PERMISSION_MODE_CONFIG[permissionMode]?.label ?? permissionMode}
                          </span>
                        </button>
                      </AppTooltip>
                    ) : null}
                    {executionMode === 'work' ? (
                      <AppTooltip
                        label={
                          composerExpanded ? '收起功能栏' : '展开功能栏（权限 / 子代理）'
                        }
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className={`size-7 shrink-0 rounded-lg transition-colors hover:bg-foreground/10 hover:text-foreground ${composerExpanded ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground'}`}
                          onClick={() => setComposerExpanded((v) => !v)}
                          aria-label={composerExpanded ? '收起功能栏' : '展开功能栏'}
                        >
                          <SlidersHorizontal className="size-4" />
                        </Button>
                      </AppTooltip>
                    ) : null}
                  </div>
                  <div className="composer-footer-bar__right flex h-7 min-w-0 shrink items-center gap-0.5">
                    <ReasoningEffortPicker
                      value={reasoningEffort}
                      onChange={(effort) => {
                        void (async () => {
                          setReasoningEffort(effort)
                          await window.electronAPI.updateSessionMeta(sessionId, {
                            reasoningEffort: effort,
                          })
                        })()
                      }}
                    />
                    <ModelSelector
                      selection={effectiveSelection}
                      lockedKind={lockedKind}
                      onSelect={(nextSelection) => {
                        setSelectionOverride(nextSelection)
                        setSelectedModelSelection(nextSelection)
                      }}
                    />
                    {/*
                      发送/停止/引导/立即发送 同槽复用：
                      · 运行中 + 无草稿 → 停止键（清队列 + 中断）
                      · 运行中 + 有草稿 → [引导] [立即发送] [排队发送]
                      · 空闲 + 有草稿 → 发送键（enabled，立即发）
                      · 空闲 + 无草稿 → 发送键（disabled）
                    */}
                    {running && !hasDraft ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 rounded-full text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          setMessageQueue([])
                          userStopRun()
                          window.electronAPI.stopAgent(sessionIdRef.current)
                        }}
                        aria-label="停止"
                      >
                        <Square className="size-4 fill-current" />
                      </Button>
                    ) : running && hasDraft ? (
                      <div className="flex items-center gap-1">
                        <AppTooltip label="引导：不中断当前轮，Agent 在下一轮看到此消息">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                            onClick={() => {
                              const text = chatInputRef.current?.getText().trim()
                              if (!text) return
                              chatInputRef.current?.clear()
                              void (window.electronAPI as any).steerAgent(sessionIdRef.current, text)
                            }}
                            aria-label="引导"
                          >
                            <Compass className="size-4" />
                          </Button>
                        </AppTooltip>
                        <AppTooltip label="立即发送：中断当前轮，立刻发送此消息">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                            onClick={() => {
                              const text = chatInputRef.current?.getText().trim()
                              if (!text || !effectiveSelection) return
                              chatInputRef.current?.clear()
                              setMessageQueue([])
                              userStopRun()
                              void (async () => {
                                await window.electronAPI.stopAgent(sessionIdRef.current)
                                await sendQueued({ text, selection: effectiveSelection })
                              })()
                            }}
                            aria-label="立即发送"
                          >
                            <Zap className="size-4" />
                          </Button>
                        </AppTooltip>
                        <AppTooltip label="排队：当前轮结束后自动发送">
                          <Button
                            size="icon"
                            className="size-8 rounded-full"
                            onClick={() => void send()}
                            aria-label="排队"
                          >
                            <ArrowUp className="size-4" />
                          </Button>
                        </AppTooltip>
                      </div>
                    ) : (
                      <Button
                        variant={hasDraft ? 'default' : 'ghost'}
                        size="icon"
                        className="size-9 rounded-full"
                        disabled={!hasDraft}
                        onClick={() => void send()}
                        aria-label="发送"
                      >
                        <ArrowUp className="size-5" />
                      </Button>
                    )}
                  </div>
                </div>
              }
            />
          </div>
          {/* 仅 Work 且展开时挂载，避免 height:0 占位/边框导致切换时底栏跳动 */}
          {executionMode === 'work' && composerExpanded ? (
            <ComposerUnderlay
              permissionMode={permissionMode}
              onPermissionModeChange={async (m) => {
                setPermissionMode(m)
                await window.electronAPI.setSessionPermissionMode(sessionId, m)
              }}
              subagentEagerness={subagentEagerness}
              onSubagentEagernessChange={async (level) => {
                setSubagentEagerness(level)
                await window.electronAPI.updateSessionMeta(sessionId, {
                  subagentEagerness: level,
                })
              }}
            />
          ) : null}
        </div>
        {/* token 栏：cluster 外部，stack 最底，落在 band 与窗边之间；仅 Pi/external */}
        {showTokenBar && (
          <TokenStatsBar
            usage={contextUsage}
            totals={tokenTotals}
            channelId={effectiveSelection?.channelId}
            isCompacting={isCompactingUi}
            onCompact={() => void compactContext()}
            compact={composerCompact}
          />
        )}
      </div>
        </div>
      )}

      {/* 右缘：班组面板关闭时的轻入口（分屏模式隐藏，班组走 dock） */}
      {!crewExternalized && !crewPanelOpen && (hasCrewBoards || sessionBoardId) ? (
        <button
          type="button"
          className="kanban-crew-edge-tab"
          onClick={() => setCrewPanelOpen(true)}
          aria-label="打开班组面板"
        >
          <UsersThree className="size-3.5" weight="bold" />
          <span>班组</span>
        </button>
      ) : null}
      </div>
      {/* 右栏：全高班组面板（分屏模式不渲染，班组走 dock 的 crew pane） */}
      {!crewExternalized ? (
        <KanbanCrewPanel
          sessionId={sessionId}
          boardId={sessionBoardId}
          open={crewPanelOpen}
          onOpenChange={setCrewPanelOpen}
          onPresenceChange={setHasCrewBoards}
          width={crewPanelWidth}
          onWidthChange={handleCrewPanelWidth}
        />
      ) : null}

      {/* 子代理独立会话页面：从入口卡片全屏切换（覆盖整个 Chat 区域，返回回主会话） */}
      {subagentDetail && (
        <div className="subagent-detail-overlay">
          <SubagentDetailView
            items={items}
            parentToolUseId={subagentDetail}
            card={subagentCards.get(subagentDetail)}
            onBack={() => setSubagentDetail(null)}
          />
        </div>
      )}
    </div>
    </MessageFilePathProvider>
  )
}

/** turn 渲染：user / assistant-turn / 独立状态行 */
function TurnView({
  turn,
  isLiveTurn = false,
  onRefillToInput,
  mentionLabels,
  completedDuration,
  subagentCards,
  onOpenSubagent,
}: {
  turn: ReturnType<typeof groupItemsIntoTurns>[number]
  isLiveTurn?: boolean
  onRefillToInput?: (text: string) => void
  mentionLabels?: string[]
  completedDuration?: TurnDuration
  subagentCards?: Map<string, TaskCardState>
  onOpenSubagent?: (parentToolUseId: string) => void
}): JSX.Element {
  if (turn.kind === 'user') {
    return (
      <div data-message-id={turn.key}>
        <MessageView message={turn.message} onRefillToInput={onRefillToInput} />
      </div>
    )
  }
  if (turn.kind === 'assistant-turn') {
    return (
      <div data-message-id={turn.key}>
        <AssistantTurnView
          turn={turn}
          isLiveTurn={isLiveTurn}
          mentionLabels={mentionLabels}
          completedDuration={completedDuration}
          subagentCards={subagentCards}
          onOpenSubagent={onOpenSubagent ?? (() => {})}
        />
      </div>
    )
  }
  return <ItemView item={turn.item as DisplayItem} />
}

/** 显示项渲染（standalone：压缩行 / 任务卡 / 兜底） */
function ItemView({ item }: { item: DisplayItem }): JSX.Element {
  // 子代理任务卡片（task_started/progress/notification 状态机，独立小卡片）
  if (item.taskCard) {
    return (
      <div data-message-id={item.key}>
        <TaskCardView card={item.taskCard} />
      </div>
    )
  }

  // 上下文压缩状态行
  if (item.compactStatus === 'compacting') {
    return (
      <div data-message-id={item.key} className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-primary/60" />
        {COMPACTION_IN_PROGRESS_LABEL}
      </div>
    )
  }
  if (item.compactStatus === 'complete') {
    return (
      <div data-message-id={item.key} className="relative flex items-center justify-center py-2">
        <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
        <span className="mx-3 text-xs text-muted-foreground select-none">
          {getCompactBoundaryLabel(
            item.compactTrigger ? { trigger: item.compactTrigger } : undefined,
          )}
        </span>
        <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
      </div>
    )
  }

  // 完整消息（IR）→ MessageView（挂 data-message-id 供 ScrollMinimap 定位）
  if (item.message) {
    return (
      <div data-message-id={item.key}>
        <MessageView message={item.message} />
      </div>
    )
  }

  // 流式占位
  return (
    <div data-message-id={item.key}>
      <Message from="assistant">
        <MessageContent>
          {/* thinking 流式 */}
          {item.streamingThinking && (
            <Reasoning isStreaming defaultOpen>
              <ReasoningTrigger />
              <ReasoningContent>{item.streamingThinking}</ReasoningContent>
            </Reasoning>
          )}
          {/* text 流式：typewriter 逐字挤出，平滑端点粗粒度分块（~500ms/块）的顿挫感 */}
          {item.streamingText && <TypewriterText text={item.streamingText} />}
          {/* 无内容时显示加载 */}
          {!item.streamingText && !item.streamingThinking && <MessageLoading />}
        </MessageContent>
    </Message>
    </div>
  )
}

/**
 * TaskCardView — 子代理任务卡片
 *
 * 圆角边框 + 状态色圆点（running 脉冲）+ 可选进度文案 / 收口摘要。
 * 放在消息流中，承载 task_started → task_progress → task_notification 生命周期。
 */
const TASK_CARD_STATUS: Record<TaskCardState['status'], {
  label: string
  box: string
  dot: string
  text: string
}> = {
  running: {
    label: '运行中',
    box: 'border-muted-foreground/20 bg-muted/20',
    dot: 'bg-muted-foreground/60 animate-pulse',
    text: 'text-muted-foreground',
  },
  completed: {
    label: '已完成',
    box: 'border-emerald-500/30 bg-emerald-500/5',
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  failed: {
    label: '失败',
    box: 'border-destructive/30 bg-destructive/5',
    dot: 'bg-destructive',
    text: 'text-destructive',
  },
  stopped: {
    label: '已停止',
    box: 'border-muted-foreground/20 bg-muted/20',
    dot: 'bg-muted-foreground/40',
    text: 'text-muted-foreground/70',
  },
}

function TaskCardView({ card }: { card: TaskCardState }): JSX.Element {
  const s = TASK_CARD_STATUS[card.status]
  const isRunning = card.status === 'running'
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${s.box}`}>
      <span className={`mt-1 size-2 shrink-0 rounded-full ${s.dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-medium text-foreground/80">子代理</span>
          <span className={s.text}>{s.label}</span>
          {isRunning && card.lastToolName && (
            <span className="truncate text-muted-foreground/60">· {card.lastToolName}</span>
          )}
        </div>
        {card.description && (
          <div className="mt-0.5 truncate text-xs text-foreground/70">{card.description}</div>
        )}
        {isRunning && card.progressText && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{card.progressText}</div>
        )}
        {!isRunning && card.summary && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{card.summary}</div>
        )}
      </div>
    </div>
  )
}

/**
 * Typewriter 逐字显示：端点（aicode/minimax）流式粒度粗，每 ~500ms 发一大块，
 * 块到达后不瞬间全部显示，而是用 rAF 在块间隔内逐字挤出，视觉连续丝滑。
 *
 * 速度自适应：按"剩余字符 / 剩余预估时间"算每帧步长，保证下一块到达前刚好显示完。
 * 收尾：turn 结束后 streamingText 不再增长，剩余字符快速追完。
 */
function TypewriterText({ text }: { text: string }): JSX.Element {
  const [displayed, setDisplayed] = useState('')
  const rafRef = useRef<number | null>(null)
  const textRef = useRef(text)
  textRef.current = text

  useEffect(() => {
    // text 增长时若 rAF 没在跑，启动；rAF 循环读 textRef 最新值，自动追上新块
    if (rafRef.current != null) return
    const step = () => {
      const full = textRef.current
      setDisplayed((cur) => {
        if (cur.length >= full.length) {
          rafRef.current = null
          return cur // 已追上，停 rAF，等下一块触发 effect 重启
        }
        // 每帧追加：剩余字符的 1/8（约 8 帧 ≈ 130ms 追完一段），最少 1 字
        const remain = full.length - cur.length
        const add = Math.max(1, Math.ceil(remain / 8))
        return full.slice(0, cur.length + add)
      })
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [text])

  // 新消息/切换会话时 text 重置为空，displayed 同步重置
  useEffect(() => {
    if (text === '') setDisplayed('')
  }, [text])

  return <MessageResponse>{displayed}</MessageResponse>
}

/** 取消息首个 text 块的文本（供 minimap preview） */
function firstText(m: TAgentMessage): string | undefined {
  const block = m.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  return block?.text
}

/** 判断历史行是否已是 TAgentMessage IR（pi 落盘）而非 Claude SDKMessage（有 message 包装）。
 *  IR：顶层 type='assistant'|'user' + content 数组、无 message 字段；SDKMessage：有 message 包装。 */
function isIRMessage(raw: unknown): boolean {
  if (raw == null || typeof raw !== 'object') return false
  const r = raw as { type?: unknown; message?: unknown; content?: unknown }
  return (r.type === 'assistant' || r.type === 'user') && r.message === undefined && Array.isArray(r.content)
}
