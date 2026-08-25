/**
 * 会话页核心
 *
 * 吃 TAgentDesktopStreamPayload（IPC 流式）+ TAgentMessage IR 渲染。
 * 消息区用 Conversation 容器（自动钉底），输入区用 TipTap ChatInput。
 * 模型：首条消息只绑定运行内核（KSCC / 外部），同内核内渠道与模型可继续切换。
 */
import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  Fragment,
} from "react";
import { getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import {
  sessionRunMapAtom,
  startSessionRunAtom,
  stopSessionRunAtom,
  softStopSessionRunAtom,
  adoptSessionRunAtom,
} from "../../atoms/session-run-atoms";
import type { StickToBottomContext } from "use-stick-to-bottom";
import type {
  TAgentDesktopStreamPayload,
  TAgentMessage,
  TAgentPermissionMode,
  SubagentEagerness,
  ReasoningEffort,
  ExecutionMode,
  AgentSessionMeta,
  TurnDuration,
  UserFacingError,
  FileAttachment,
  FileReviewContext,
  BotProfileRecord,
} from "@tagent/shared";
import {
  migrateExecutionMode,
  DEFAULT_EXECUTION_MODE,
  parseMentions,
  classifyUserFacingError,
  isMoaModelId,
} from "@tagent/shared";
import {
  resolveChannelDefaultModelId,
  resolveConsultPresetsForChannel,
  sdkMessageToIR,
  TAGENT_DEFAULT_PERMISSION_MODE,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_CONTEXT_WINDOW,
  resolveUiContextWindow,
  migrateReasoningEffort,
  migratePermissionMode,
  moaDiscussionConsensusUuid,
  type TAgentUsage,
  type MoARoundtablePanel,
  type MoAPreset,
  type MoADiscussionPanel,
} from "@tagent/shared";
import { type ContextUsageSnapshotView } from "./ContextUsageBadge";
import { TokenStatsBar, type SessionTokenTotals } from "./TokenStatsBar";
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
} from "@tagent/ui";
import { Square, Plus, X } from "lucide-react";
import { UsersThree } from "@phosphor-icons/react";
import {
  collectSessionCollabOutline,
  type SessionCollabItem,
} from "./session-collab-outline";
import { cn } from "../../lib/utils";
import { SessionBotBar } from "./SessionBotBar";
import { CollaborationRoomsPage } from "../collaboration/CollaborationRoomsPage";

type ChatMentionOption = {
  id: string;
  displayName: string;
  description?: string;
  pinned?: boolean;
  kind?: "role" | "bot";
};
import { BotSidecarPanel } from "./BotSidecarPanel";
import {
  applyMessageToInFlightToolIds,
  collectPendingToolUseIds,
  sessionHasInFlightWork,
  shouldScheduleRunStopAfterTurnEnd,
} from "../../lib/session-run-inflight";
import {
  COMPACTION_IN_PROGRESS_LABEL,
  getCompactBoundaryLabel,
} from "@tagent/shared";
import { MessageView } from "./MessageView";
import { AssistantTurnView } from "./AssistantTurnView";
import { MoaRoundtableCard } from "./MoaRoundtableCard";
import { MoaDiscussionCard } from "./MoaDiscussionCard";
import { MoaDiscussionRoom } from "./MoaDiscussionRoom";
import { SendSplitButton } from "./ConsultMenu";
import { SubagentDetailView } from "./SubagentDetailView";
import { ComposerRunTimer } from "./ComposerRunTimer";
import { ComposerActivityIsland } from "./ComposerActivityIsland";
import {
  collectComposerActivity,
  summarizeComposerActivity,
  type ComposerActivityItem,
} from "./composer-activity-model";
import { useSessionProcesses } from "../../atoms/session-processes";
import {
  buildTurnPresentation,
  backfillTurnDurations,
  classifyRunAbort,
  getLastMainAssistantCreatedAt,
  groupItemsIntoTurns,
  hasRunStartedProcessing,
  isRealUserInput,
  isSyntheticRunTurnKey,
  resolveRunTurnKey,
  shouldRenderStoppedSyntheticShell,
  sliceItemsBeforeLastRealUser,
  syntheticLiveTurnKeyForUser,
} from "./session-turn-model";
import {
  applySdkMessageToItems,
  compactAssistantMessageForDisplay,
  applySdkMessageToStreamState,
  applyTextDelta,
  applyTextReplace,
  applyThinkingDeltaToState,
  applyThinkingReplaceToState,
  clearSessionStreamState,
  commitStreamThinkingToLastAssistant,
  commitStreamTextToLastAssistant,
  EMPTY_STREAM_STATE,
  hasStreamContent,
  purgeStreamingItems,
  shouldClearStreamThinking,
  type SessionStreamState,
} from "./stream-item-model";
import {
  ChatInput,
  type ChatInputHandle,
  type PendingAttachment,
} from "./ChatInput";
import { ModelSelector } from "./ModelSelector";
import { WorkspaceSelector } from "./WorkspaceSelector";
import { KnowledgeBaseSelector } from "../knowledge-base/KnowledgeBaseSelector";

import { NewConversationLanding } from "./NewConversationLanding";
import {
  resolveEagerness,
  reduceTaskEvent,
  rehydrateSubagentTaskCardsFromHistory,
  type TaskCardState,
  type TaskCardEvent,
} from "./subagent-ui-model";
import {
  MessageFilePathProvider,
  MessageRichPreviewProvider,
  type RichPreviewKind,
} from "@tagent/ui";
import { filePreviewRequestAtom } from "../../atoms/file-preview";
import { richPreviewRequestAtom } from "../../atoms/rich-preview";
import { splitDockModeAtom } from "../../atoms/feature-flags";
import {
  readSubagentEagernessDefault,
  subagentEagernessDefaultAtom,
} from "../../atoms/subagent-prefs";
import { PermissionBanner } from "../permission/PermissionBanner";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { ExitPlanModeBanner } from "./ExitPlanModeBanner";
import { PlanProgressCard } from "./PlanProgressCard";
import { isPlanIncomplete, pauseActivePlanSteps } from "./plan-progress-model";
import { sessionPlanProgressAtom } from "../../atoms/plan-progress-atoms";
import { ExecutionModeSuggestionBanner } from "./ExecutionModeSuggestionBanner";
import { SessionErrorBanner } from "./SessionErrorBanner";
import { setSessionErrorAtom } from "../../atoms/session-error-atoms";
import {
  allPendingAskUserRequestsAtom,
  askUserDismissedAtAtom,
} from "../../atoms/ask-user-atoms";
import { pendingPermissionMapAtom } from "../../atoms/permission-atoms";
import { allPendingExitPlanRequestsAtom } from "../../atoms/exit-plan-atoms";
import { isSessionAwaitingUser } from "../../lib/session-awaiting-user";
import { RunModeSelector } from "./RunModeSelector";
import { KanbanCrewPanel } from "./KanbanCrewPanel";
import { MessageQueue } from "./MessageQueue";
import {
  activateSessionAtBottom,
  markSessionAtBottom,
  peekSessionScrollDistance,
  ScrollPositionManager,
} from "../shell/ScrollPositionManager";
import { hasSavedMidPosition } from "../shell/scroll-position";
import {
  CHAT_MOUNT_BATCH,
  CHAT_MOUNT_ESTIMATED_TURN_HEIGHT,
  CHAT_MOUNT_TOP_LOAD_PX,
  CHAT_MOUNT_WINDOW,
} from "./chat-mount-window";
import {
  channelsAtom,
  selectedModelSelectionAtom,
  bumpSessionsRefreshAtom,
} from "../../atoms/channel-atoms";
import {
  getChannelCoreKind,
  type ChannelCoreKind,
  type ModelSelection,
} from "../../atoms/model-selection";
import {
  tabsAtom,
  activeTabIdAtom,
  openTabWithLimit,
  type TabItem,
} from "../../atoms/tabs";
import {
  loadWorkspacesAtom,
  workspacesAtom,
} from "../../atoms/workspace-atoms";
import { pendingSuggestionAtom } from "../../atoms/pending-suggestion";
import { moaPresetsRevisionAtom } from "../../atoms/moa-presets";
import {
  makeStatusTickerItem,
  pushStatusTickerAtom,
} from "../../atoms/status-ticker";
import {
  crewOpenRequestAtom,
  crewPanelOpenMapAtom,
} from "../../atoms/dock-api";
import {
  clearSessionSummaryHostAtom,
  sessionSummaryActionAtom,
  setSessionSummaryHostAtom,
} from "../../atoms/session-summary";

export interface SessionMeta {
  id: string;
  title: string;
  workspaceId?: string;
  modelId?: string;
  channelId?: string;
  botProfileIds?: string[];
  fusionRoomId?: string;
  kbRoots?: string[];
  knowledgeBaseIds?: string[];
  knowledgeBaseMode?: "off" | "preferred" | "strict";
}

interface StreamEventEnvelope {
  sessionId: string;
  payload: TAgentDesktopStreamPayload;
}

/** 一轮显示项：完整消息或流式增量 */
interface DisplayItem {
  /** 稳定 key */
  key: string;
  /** 完整消息（IR） */
  message?: TAgentMessage;
  /** 流式追加中的文本（stream_text_delta 累积） */
  streamingText?: string;
  /** 流式 thinking 累积 */
  streamingThinking?: string;
  /**
   * 流式占位绑定的 assistant.uuid（与 IR / stream_*_delta.uuid 对齐）。
   * 同 uuid 就地更新，避免重试/多 chunk 双卡片。
   */
  streamUuid?: string;
  /** 是否流式中 */
  streaming?: boolean;
  /** 子代理任务卡片（task_started/progress/notification 状态机，独立小卡片） */
  taskCard?: TaskCardState;
  /** 上下文压缩状态行 */
  compactStatus?: "compacting" | "complete";
  compactTrigger?: "auto" | "manual";
  /** MoA 圆桌卡（moa_roundtable 事件按 roundtableId 就地 upsert） */
  moaRoundtable?: MoARoundtablePanel;
  /** 圆桌讨论入口卡（moa_discussion 事件按 discussionId 就地 upsert） */
  moaDiscussion?: MoADiscussionPanel;
}

/**
 * 圆桌讨论入口卡按 discussionId 就地 upsert（同场多张状态卡只保留最新）。
 *
 * 新卡落点（T8 重启重放对齐实时落点）：若 items 已有该讨论的共识 assistant（uuid =
 * `moa-disc-agg-<discussionId>`，由 runMoADiscussion 收口时落盘），把入口卡插到它**前面**——
 * 与实时运行时「入口卡先于共识 assistant 推送」的天然顺序一致。实时运行时共识 assistant 尚未
 * 到达 → 找不到 → 末尾追加（行为不变，共识随后追加在其后）。cancelled/error 无共识 assistant /
 * 历史损坏 → 末尾追加兜底。重放与实时事件共用本函数（按 discussionId 去重），避免双卡。
 */
function upsertMoADiscussionItem(
  prev: DisplayItem[],
  panel: MoADiscussionPanel,
): DisplayItem[] {
  const idx = prev.findIndex(
    (it) => it.moaDiscussion?.discussionId === panel.discussionId,
  );
  if (idx >= 0) {
    return prev.map((it, i) =>
      i === idx ? { ...it, moaDiscussion: panel } : it,
    );
  }
  const item: DisplayItem = {
    key: `disc-${panel.discussionId}`,
    moaDiscussion: panel,
  };
  const aggUuid = moaDiscussionConsensusUuid(panel.discussionId);
  const aggIdx = prev.findIndex(
    (it) => it.message?.type === "assistant" && it.message.uuid === aggUuid,
  );
  if (aggIdx >= 0) {
    const next = [...prev];
    next.splice(aggIdx, 0, item);
    return next;
  }
  return [...prev, item];
}

/** 新会话页提示词默认值见 NewConversationLanding（welcome / compose 两形态共用） */

/** 右栏班组面板宽度（可拖宽，localStorage 持久化；clamp 280–560） */
const CREW_PANEL_WIDTH_KEY = "tagent:crewPanelWidth";
const CREW_PANEL_WIDTH_MIN = 280;
const CREW_PANEL_WIDTH_MAX = 560;
const CREW_PANEL_WIDTH_DEFAULT = 380;
/**
 * turn_end 延迟停止：
 * - 有未完成 tool_use / 子代理 / 圆桌时 **不安排停止**（工具间隙不是一轮结束）
 * - GRACE：无在途工作且宽限期内有新流式 → 取消停止
 * - 到期只软停（running=false，**保留 startedAt**）。硬清交给 result / 用户停 / 看门狗。
 *   旧 HARD=2s 会在 Bash/Read 等 >5s 间隙清记忆，下一 delta 从 0 重计。
 */
const RUN_STOP_GRACE_MS = 3000;
function loadCrewPanelWidth(): number {
  try {
    const n = Number(localStorage.getItem(CREW_PANEL_WIDTH_KEY));
    if (Number.isFinite(n) && n > 0) {
      return Math.min(CREW_PANEL_WIDTH_MAX, Math.max(CREW_PANEL_WIDTH_MIN, n));
    }
  } catch {
    /* localStorage 不可用时走默认 */
  }
  return CREW_PANEL_WIDTH_DEFAULT;
}

export function Chat({
  session,
  onDraftWorkspaceChange,
  onBack,
  onMaterialized,
  canMaterializeTab,
  onTabEvicted,
  crewExternalized = false,
  onOpenCrew,
}: {
  session: SessionMeta;
  /** 草稿态（无 tab）改工作区：改 App 的 draftSession。已有 tab 时由 SessionRouter 不传 */
  onDraftWorkspaceChange?: (id: string) => void;
  /** 草稿态返回欢迎页（丢弃草稿）；会话页/线程态由 SessionRouter 不传 */
  onBack?: () => void;
  /**
   * 草稿态发送首条消息物化为正式 tab 后通知 App 清草稿态。
   * 已有 tab（SessionRouter）不传；调用方负责 setDraftSession(null)。
   * 不清的话切到其他 tab 时草稿 overlay 条件会复活，覆盖带 TabBar 的会话页。
   */
  onMaterialized?: () => void;
  /** 草稿首发前由 App 统一检查顶部标签容量；false 时不发送，避免后台孤儿会话。 */
  canMaterializeTab?: () => boolean;
  /** 草稿物化时替换了旧标签，交由 App 同步关闭其 Dockview pane。 */
  onTabEvicted?: (tab: TabItem) => void;
  /**
   * 班组面板已外置到 Dockview 独立 pane（分屏模式）。true 时隐藏 Chat 内部班组面板
   * 及其入口（footer 按钮 / edge-tab / Work 自动开），班组全走 dock 的 crew pane。
   */
  crewExternalized?: boolean;
  /** 分屏模式下，点 chat 内部班组按钮时开外部 crew pane（由 ChatPane 传入） */
  onOpenCrew?: () => void;
}): JSX.Element {
  const sessionId = session.id;
  const [fusionRoomRefreshKey, setFusionRoomRefreshKey] = useState(0);
  useEffect(() => {
    const roomId = session.fusionRoomId;
    if (!roomId) return;
    const off = window.electronAPI.onCollaborationRoomChanged?.((payload) => {
      if (payload.roomId === roomId) {
        setFusionRoomRefreshKey((value) => value + 1);
      }
    });
    return () => off?.();
  }, [session.fusionRoomId]);
  const [items, setItems] = useState<DisplayItem[]>([]);
  /** 会话级流式缓冲（delta 累积；与 items 分离） */
  const [streamState, setStreamState] =
    useState<SessionStreamState>(EMPTY_STREAM_STATE);
  // items 同步到 ref：recordCompletion 经 handlePayload 触发（onStreamEvent effect 空依赖
  // → 首渲染闭包），直接读 items 永远拿到初始空数组，耗时就落不了盘。
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /**
   * 运行态（running / startedAt）走 per-session Jotai atom（session-run-atoms），
   * 不用 local useState：草稿态与真实 tab 态是两个不同位置的 <Chat> 实例，切换时
   * 草稿实例卸载会丢 local state；atom 按 sessionId 键跨实例存活，真实实例挂载时
   * 由会话切换 effect 对照主进程 getSessionStatus 收养在跑的轮（保住草稿 startedAt）。
   */
  // 直接订阅稳定的 map atom（单例），再按 sessionId 取条目。不用 sessionRunAtom(id)
  // 工厂（每渲染新建 atom 实例 → useAtomValue 订阅不稳定 → 可能触发更新循环）。
  const sessionRunMap = useAtomValue(sessionRunMapAtom);
  const runState = sessionRunMap[sessionId] ?? {
    running: false,
    startedAt: null,
  };
  const running = runState.running;
  const runStartedAt = runState.startedAt;
  // runStartedAt 同步到 ref：completeRun 闭包里取最新值，避免读到旧渲染的 startedAt
  const runStartedAtRef = useRef<number | null>(runStartedAt);
  runStartedAtRef.current = runStartedAt;
  // 全程起点持久化：每轮 result 的 completeRun→stopSessionRun 会把 atom startedAt 清 null，
  // 工具循环中 adopt 恢复 running 时用它保计时连续（新发送时 startRun 覆盖）
  const runStartedAtPersistRef = useRef<number | null>(runStartedAt);
  // running 同步到 ref：handlePayload 是首渲染闭包（onStreamEvent effect 空依赖），用 ref 取最新
  const runningRef = useRef(running);
  runningRef.current = running;
  // 历史异步回流不能覆盖已经进入运行态的当前列表。引导消息尤其容易
  // 与看板/会话元数据回流撞在同一时间窗内，使用运行态和 stream 缓冲做保护。
  const shouldPreserveLiveItems = (current: DisplayItem[]): boolean =>
    current.length > 0 &&
    (runningRef.current ||
      runStartedAtRef.current != null ||
      hasStreamContent(streamStateRef.current) ||
      current.some(
        (item) =>
          item.streaming ||
          item.streamingText !== undefined ||
          item.streamingThinking !== undefined,
      ));
  // 最后一个 assistant-turn 的 key：完成时把全程耗时记到它名下（按 turn.key 查）
  const lastAssistantTurnKeyRef = useRef<string | null>(null);
  /**
   * 同轮完成耗时幂等闸：completeRun / 用户停止 / session_error / 真 error 都走 recordCompletion，
   * 任一终态先到即记一次；迟到的第二个终态 no-op（避免 turnDurations 同轮写多条碎片）。
   * startRun 与切会话清零。配合 runStartedAtRef==null 守卫双保险。
   * 见 SESSION-UX-RESIDUAL-SPEC §4。
   */
  const completionRecordedRef = useRef(false);
  /** 会话 meta 快照（加载时设置）：completeRun 持久化 turnDurations 时合并旧值 */
  const metaRef = useRef<Partial<AgentSessionMeta> | null>(null);
  /** 完成耗时表：turnKey → 耗时 + 结束方式（完成/停止/出错）。留存后供 AssistantTurnView 显示 */
  const [completedDurations, setCompletedDurations] = useState<
    Record<string, TurnDuration>
  >({});
  /** result 已到但本轮没有正文时的可见收口状态，避免留下“完成”的空壳。 */
  const [finalOutputState, setFinalOutputState] = useState<
    "waiting" | "missing" | null
  >(null);
  /** 同步记录本轮是否曾收到主线正文，避免 sdk_message/result 同帧时读到旧 items。 */
  const finalOutputSeenRef = useRef(false);
  const startSessionRun = useSetAtom(startSessionRunAtom);
  const stopSessionRun = useSetAtom(stopSessionRunAtom);
  const softStopSessionRun = useSetAtom(softStopSessionRunAtom);
  const adoptSessionRun = useSetAtom(adoptSessionRunAtom);
  const setSessionPlanProgress = useSetAtom(sessionPlanProgressAtom);
  const pushTicker = useSetAtom(pushStatusTickerAtom);
  // turn_end 延迟停止定时器（见 RUN_STOP_GRACE_MS 注释）
  /**
   * 用户主动停止后置位：后续迟到的 error_* result / session_error（abort 文案）
   * 不当「运行出错」，保持已中断语义。新一轮 startRun 清零。
   */
  const userStoppedRef = useRef(false);
  /** 上次用户停止的时间戳：短窗口内到达的 error 视为迟到的 abort 副作用，不弹错误条 */
  const lastUserStopAtRef = useRef(0);
  /** 本轮发送快照：未进入处理即停止时撤回气泡并回填输入框 */
  const pendingSendRecallRef = useRef<{
    text: string;
    attachments: Array<{
      id: string;
      filename: string;
      mediaType: string;
      size: number;
      previewUrl?: string;
      data: string;
    }>;
  } | null>(null);
  const pendingStopTimerRef = useRef<number | null>(null);
  const pendingHardStopTimerRef = useRef<number | null>(null);
  /** 主线未完成 tool_use id：sdk_message 同步维护，避免 turn_end 读到尚未 flush 的 itemsRef */
  const inFlightToolIdsRef = useRef<Set<string>>(new Set());
  const sessionHasOpenWork = useCallback((): boolean => {
    return sessionHasInFlightWork({
      pendingToolUseIds:
        inFlightToolIdsRef.current.size > 0
          ? inFlightToolIdsRef.current
          : collectPendingToolUseIds(itemsRef.current),
      items: itemsRef.current,
      awaitingUser: isSessionAwaitingUser(sessionIdRef.current),
    });
  }, []);
  const clearPendingStop = useCallback(() => {
    if (pendingStopTimerRef.current != null) {
      window.clearTimeout(pendingStopTimerRef.current);
      pendingStopTimerRef.current = null;
    }
    if (pendingHardStopTimerRef.current != null) {
      window.clearTimeout(pendingHardStopTimerRef.current);
      pendingHardStopTimerRef.current = null;
    }
  }, []);
  const pausePlanIfIncomplete = useCallback((): void => {
    setSessionPlanProgress((prev) => {
      const current = prev[sessionId];
      if (!current || !isPlanIncomplete(current)) return prev;
      const next = pauseActivePlanSteps(current);
      return next === current ? prev : { ...prev, [sessionId]: next };
    });
  }, [sessionId, setSessionPlanProgress]);
  const scheduleRunStop = useCallback(() => {
    if (!shouldScheduleRunStopAfterTurnEnd(sessionHasOpenWork())) return;
    clearPendingStop();
    pendingStopTimerRef.current = window.setTimeout(() => {
      pendingStopTimerRef.current = null;
      // 宽限期内又派出工具 / 子代理：保持 running，勿软停（否则停止键/过程区闪一下）
      if (sessionHasOpenWork()) return;
      // 只软停：保留 startedAt。硬清交给 result / 用户停 / 看门狗。
      softStopSessionRun(sessionId);
      // 计划未做完时把当前步标成 paused，进度卡继续留着等用户跟进。
      pausePlanIfIncomplete();
    }, RUN_STOP_GRACE_MS);
  }, [
    clearPendingStop,
    pausePlanIfIncomplete,
    sessionHasOpenWork,
    sessionId,
    softStopSessionRun,
  ]);
  /** 开始一轮运行：写 atom 置 running 并记起始时间戳 */
  const startRun = (): void => {
    clearPendingStop();
    // 仅清掉「已全部完成」的旧计划；未完成的计划跨 turn 保留，
    // 避免跟进一句后进度卡被抹掉、步骤又从头开始。
    // 新的 ExitPlanMode 请求会直接覆盖为新计划。
    setSessionPlanProgress((prev) => {
      const existing = prev[sessionId];
      if (!existing) return prev;
      const incomplete = existing.steps.some(
        (step) => step.status !== "completed",
      );
      if (incomplete) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    userStoppedRef.current = false;
    completionRecordedRef.current = false;
    finalOutputSeenRef.current = false;
    setFinalOutputState(null);
    inFlightToolIdsRef.current = new Set();
    const now = Date.now();
    runStartedAtPersistRef.current = now;
    startSessionRun({ id: sessionId, startedAt: now });
  };
  /** 硬停一轮（清 running + 起点记忆；发送失败 / result / error / 用户停止） */
  const stopRun = (): void => {
    inFlightToolIdsRef.current = new Set();
    setFinalOutputState(null);
    stopSessionRun(sessionId);
    pausePlanIfIncomplete();
  };
  /**
   * 用户主动停止：渲染层硬清 running + 起点记忆（与主进程 STOP_AGENT 双保险）。
   * 主进程：interrupt + meta idle + 显式 turn_end（不依赖 Pi abort 是否再推 result）。
   * 否则 stopAgent 后 stray delta 到达时 handlePayload 会用旧时间戳 adopt 复活 running。
   */
  const userStopRun = (): void => {
    clearPendingStop();
    pendingSendRecallRef.current = null;
    userStoppedRef.current = true;
    lastUserStopAtRef.current = Date.now();
    recordCompletion("stopped");
    runStartedAtPersistRef.current = null;
    stopRun();
  };
  /**
   * 记录一轮运行耗时（发送→idle/停止/出错全程）到最后一个 assistant-turn，并持久化到 meta。
   * endedBy：complete（正常 result）/ stopped（用户停止）/ error（session_error）。
   * 口径对齐 TAgent_General 的 _durationMs（queryStartedAt → persistSDKMessages），
   * 覆盖思考期 + 所有工具轮，非 turn 内 assistant 间隔。
   */
  const recordCompletion = (endedBy: TurnDuration["endedBy"]): void => {
    // 同轮幂等：第二次终态到达 no-op（避免 turnDurations 同轮写多条碎片）
    if (completionRecordedRef.current) return;
    const startedAt = runStartedAtRef.current;
    if (startedAt == null) return;
    const durationMs = Math.max(0, Date.now() - startedAt);
    const turnKey = lastAssistantTurnKeyRef.current;
    if (!turnKey) return;
    completionRecordedRef.current = true;
    const dur: TurnDuration = { ms: durationMs, endedBy };
    setCompletedDurations((prev) => ({ ...prev, [turnKey]: dur }));
    // 持久化：最后一条主线 assistant 消息 createdAt 作稳定 key，写入 meta，重开回填
    // 合成 live turn 尚无 assistant 落盘：勿把 stopped/error 写到上一轮 assistant 的 createdAt
    const createdAt = isSyntheticRunTurnKey(turnKey)
      ? undefined
      : getLastMainAssistantCreatedAt(itemsRef.current);
    if (createdAt != null) {
      const prevDurations = metaRef.current?.turnDurations ?? {};
      const nextDurations = { ...prevDurations, [createdAt]: dur };
      // 本地同步合并，避免连续两轮完成时旧值丢失
      metaRef.current = {
        ...(metaRef.current ?? {}),
        turnDurations: nextDurations,
      };
      void window.electronAPI
        .updateSessionMeta(sessionId, { turnDurations: nextDurations })
        .catch(() => {});
    }
  };
  /**
   * 完成一轮运行：算发送→idle 全程耗时，记到最后一个 assistant-turn 名下，再清 running。
   */
  const completeRun = (): void => {
    recordCompletion("complete");
    inFlightToolIdsRef.current = new Set();
    stopSessionRun(sessionId);
    pausePlanIfIncomplete();
  };
  /** 输入框是否有草稿（供发送/停止键同槽复用：运行中且有草稿→仍可追加发送，显示发送键；运行中无草稿→停止键） */
  const [hasDraft, setHasDraft] = useState(false);
  const [messageQueue, setMessageQueue] = useState<
    Array<{
      text: string;
      selection: ModelSelection;
      /** 待发附件（运行中入队时快照；drain 时 sendQueued 保存到磁盘并透传主进程）。
       *  不带则队列项只发文本——历史回归：运行中带附件发送会丢附件（队列引导改动 53dd1b0 引入，
       *  入队只放 {text,selection} 且不清空 pendingAttachments，预览残留“像发出”但核侧从未收到）。 */
      attachments?: Array<{
        id: string;
        filename: string;
        mediaType: string;
        size: number;
        previewUrl?: string;
        data: string;
      }>;
      /** MoA 会诊本条（one-shot）preset id：选了预置后追加发送带它；非 sticky */
      moaOneShotPresetId?: string;
      /** 圆桌讨论本条（one-shot）preset id：选了预置后追加发送带它；非 sticky，主进程 runMoADiscussionTurn 消费 */
      moaDiscussionPresetId?: string;
    }>
  >([]);
  /**
   * 用户点「立即发送」时跳过一次 running→false 自动消费：
   * 先保证用户选中的那条发出，再让其余队列在该轮结束后按序消费。
   */
  const deferQueueAutoConsumeRef = useRef(false);
  /** 队列「立即发送 / 引导」进行中 */
  const [queueActionBusy, setQueueActionBusy] = useState(false);
  /** 待发送附件（输入框暂存，发送后清空） */
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{
      id: string;
      filename: string;
      mediaType: string;
      size: number;
      previewUrl?: string;
      data: string;
    }>
  >([]);
  /** 可发送：有文字草稿，或仅有附件 */
  const hasSendable = hasDraft || pendingAttachments.length > 0;
  /** MoA 会诊预置（发送键旁 ▾「发送方式」）。挂载拉一次。 */
  const [consultPresets, setConsultPresets] = useState<MoAPreset[]>([]);
  const moaPresetsRevision = useAtomValue(moaPresetsRevisionAtom);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      .listMoaPresets()
      .then((list) => {
        if (!cancelled) setConsultPresets(list ?? []);
      })
      .catch(() => {
        /* 预置拉取失败：菜单空态，不阻塞正常发送 */
      });
    return () => {
      cancelled = true;
    };
  }, [moaPresetsRevision]);
  /** 历史已写入 items：钉底只等这个，不等虚拟化全挂。 */
  const [scrollReady, setScrollReady] = useState(false);
  /**
   * 虚拟化：尾部挂载窗口。默认只挂最近 CHAT_MOUNT_WINDOW 条；
   * 上滑 / 中间位恢复 / 锚点跳转才允许拉满。开流且在底部时收回窗口，避免 60+ 轮拖死流式。
   */
  const [visibleCount, setVisibleCount] = useState<number>(CHAT_MOUNT_WINDOW);
  /** 用户主动查历史或中间位恢复：允许突破尾部窗口 */
  const [allowFullMount, setAllowFullMount] = useState(false);
  const [selectionOverride, setSelectionOverride] =
    useState<ModelSelection | null>(null);
  const [sentCoreKind, setSentCoreKind] = useState<ChannelCoreKind | null>(
    null,
  );
  /** 会话当前权限模式（默认 bypassPermissions；切会话 key 重建后重置。运行中切换即时生效） */
  const [permissionMode, setPermissionMode] = useState<TAgentPermissionMode>(
    TAGENT_DEFAULT_PERMISSION_MODE,
  );
  /**
   * 协作形态 Chat|Work（默认 work；旧会话无字段回显 work）
   * 仅用户可切换（含点确认建议）
   */
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(
    DEFAULT_EXECUTION_MODE,
  );
  /** 挂起的形态切换建议（Chat 硬拦 / meta 恢复） */
  const [pendingModeSuggestion, setPendingModeSuggestion] = useState<
    import("@tagent/shared").ExecutionModeSuggestion | null
  >(null);
  /** 会话绑定的看板（建板后写入 meta.boardId） */
  const [sessionBoardId, setSessionBoardId] = useState<string | null>(null);
  /** 右侧班组面板（有板才有入口） */
  const [crewPanelOpen, setCrewPanelOpen] = useState(false);
  const crewOpenRequest = useAtomValue(crewOpenRequestAtom);
  const setCrewPanelOpenMap = useSetAtom(crewPanelOpenMapAtom);
  const [hasCrewBoards, setHasCrewBoards] = useState(false);
  /** 右栏宽度（可拖宽，持久化） */
  const [crewPanelWidth, setCrewPanelWidth] =
    useState<number>(loadCrewPanelWidth);

  // 非分屏：标签栏/顶栏请求打开或切换本会话班组右栏。
  useEffect(() => {
    if (crewExternalized || crewOpenRequest?.sessionId !== sessionId) return;
    if (crewOpenRequest.toggle) setCrewPanelOpen((v) => !v);
    else setCrewPanelOpen(true);
  }, [
    crewExternalized,
    crewOpenRequest?.requestId,
    crewOpenRequest?.sessionId,
    crewOpenRequest?.toggle,
    sessionId,
  ]);

  useEffect(() => {
    if (crewExternalized) return;
    setCrewPanelOpenMap((prev) =>
      prev[sessionId] === crewPanelOpen
        ? prev
        : { ...prev, [sessionId]: crewPanelOpen },
    );
    return () => {
      setCrewPanelOpenMap((prev) => {
        if (!(sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    };
  }, [crewExternalized, crewPanelOpen, sessionId, setCrewPanelOpenMap]);
  const handleCrewPanelWidth = useCallback((w: number) => {
    setCrewPanelWidth(
      Math.min(
        CREW_PANEL_WIDTH_MAX,
        Math.max(CREW_PANEL_WIDTH_MIN, Math.round(w)),
      ),
    );
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(CREW_PANEL_WIDTH_KEY, String(crewPanelWidth));
    } catch {
      /* ignore */
    }
  }, [crewPanelWidth]);
  /** 对话列变窄时启用紧凑输入底栏（右栏展开 / 窗口窄） */
  const [composerCompact, setComposerCompact] = useState(false);
  /** @ 选择面板是否展开：展开时让位输入框上方重叠 UI（运行胶囊/下箭头），不碰计时状态 */
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  /** AskUser / 权限横幅：与 @ 一样让位浮层，避免胶囊+下箭头压在弹窗底栏 */
  const pendingAskUserMap = useAtomValue(allPendingAskUserRequestsAtom);
  const pendingExitPlanMap = useAtomValue(allPendingExitPlanRequestsAtom);
  const sessionPlanProgressMap = useAtomValue(sessionPlanProgressAtom);
  const sessionPlanProgress = sessionPlanProgressMap[sessionId] ?? null;
  const planStillOpen = isPlanIncomplete(sessionPlanProgress);
  const hasPendingExitPlan =
    (pendingExitPlanMap.get(sessionId)?.length ?? 0) > 0;
  const pendingPermissionMap = useAtomValue(pendingPermissionMapAtom);
  const hasBlockingBottomBanner =
    (pendingAskUserMap.get(sessionId)?.length ?? 0) > 0 ||
    (pendingPermissionMap[sessionId]?.length ?? 0) > 0 ||
    hasPendingExitPlan;
  /** Chat @ 角色库短列表 */
  const [mentionRoles, setMentionRoles] = useState<ChatMentionOption[]>([]);
  const [mentionBots, setMentionBots] = useState<ChatMentionOption[]>([]);
  /** 最近一轮 @ 的展示名（助手铭牌旁顺序条） */
  const [liveMentionLabels, setLiveMentionLabels] = useState<string[]>([]);
  /**
   * 当前对话跟随的角色（activeSpeaker / followMode）：
   * @ 设置/切换；无 @ 时保持上一轮（连续追问同一角色）；✕ 清空回默认总助。
   * 与主进程 pendingMentionRoleIds 对齐（主进程权威注入，本地用于输入框指示与铭牌）。
   */
  const [activeMentionRoleIds, setActiveMentionRoleIds] = useState<string[]>(
    [],
  );
  /**
   * Work→Chat 后班组仍在后台执行时的轻提示条。
   * setSessionExecutionMode 可带 backgroundCrew；也可客户端兜底数任务。
   */
  const [backgroundCrewBanner, setBackgroundCrewBanner] = useState<{
    running: number;
    ready: number;
    pending: number;
  } | null>(null);
  /**
   * 子代理委派积极性（会话级）。
   * 挂载时：meta 有值用会话档；否则用设置页全局默认（再缺省 balanced）。
   * 未写过 meta 的会话会把解析结果落盘一次，保证主进程注入与 UI 一致。
   */
  const [subagentEagerness, setSubagentEagerness] =
    useState<SubagentEagerness>("balanced");
  /** 当前打开的子代理详情（parentToolUseId），非空时全屏切换显示独立会话页 */
  const [subagentDetail, setSubagentDetail] = useState<string | null>(null);
  /** 当前打开的圆桌讨论（discussionId），非空时全屏切换显示讨论室 */
  const [openDiscussionId, setOpenDiscussionId] = useState<string | null>(null);
  const [sidecarBots, setSidecarBots] = useState<
    Array<{ bot: BotProfileRecord; stackIndex: number }>
  >([]);
  const sidecarStackIndexRef = useRef(0);
  /** 思考强度（默认 medium；切会话 key 重建后重置，挂载时回显持久化值。下次发送注入 SDK query 生效） */
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    DEFAULT_REASONING_EFFORT,
  );
  /** 子代理任务卡片 lookup：parentToolUseId → taskCard（taskCard.toolUseId 即发起它的主线 tool_use id） */
  const subagentCards = useMemo(() => {
    const map = new Map<string, TaskCardState>();
    for (const it of items) {
      if (it.taskCard?.toolUseId) map.set(it.taskCard.toolUseId, it.taskCard);
    }
    return map;
  }, [items]);
  const backgroundProcesses = useSessionProcesses(sessionId);
  const composerActivity = useMemo(
    () =>
      summarizeComposerActivity(
        collectComposerActivity({ processes: backgroundProcesses }),
      ),
    [backgroundProcesses],
  );
  // 进程列表可能在 IPC 刷新时短暂为空；主任务仍在运行时保留最近一次活动，
  // 避免运行进度栏因空窗突然卸载。主任务结束后才清掉这份显示状态。
  const [stickyComposerActivityItems, setStickyComposerActivityItems] =
    useState<ComposerActivityItem[]>([]);
  const composerActivityRunActive = running || runStartedAt != null;
  useEffect(() => {
    if (composerActivity.items.length > 0) {
      setStickyComposerActivityItems(composerActivity.items);
    } else if (!composerActivityRunActive) {
      setStickyComposerActivityItems([]);
    }
  }, [composerActivity.items, composerActivityRunActive]);
  const visibleComposerActivityItems =
    composerActivity.items.length > 0
      ? composerActivity.items
      : composerActivityRunActive
        ? stickyComposerActivityItems
        : [];

  /** 当前打开的圆桌讨论 panel（按 discussionId 从 items 查；panel 不在 items 时回退关闭） */
  const openDiscussionPanel = useMemo(
    () =>
      openDiscussionId
        ? items.find(
            (it) => it.moaDiscussion?.discussionId === openDiscussionId,
          )?.moaDiscussion
        : undefined,
    [items, openDiscussionId],
  );
  // panel 被移出 items（状态卡理论上不会消失，兜底）→ 关闭讨论室，避免悬空 openDiscussionId
  useEffect(() => {
    if (openDiscussionId && !openDiscussionPanel) setOpenDiscussionId(null);
  }, [openDiscussionId, openDiscussionPanel]);

  // 会话页入场动画：mount 后一帧加 is-mounted class 触发 CSS transition */
  const [pageMounted, setPageMounted] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setPageMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  /** 最近一轮 usage（kscc 渠道占用不可信，圆环由 hideContext 隐藏） */
  const [contextUsage, setContextUsage] =
    useState<ContextUsageSnapshotView | null>(null);
  const [tokenTotals, setTokenTotals] = useState<SessionTokenTotals>({
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    turnCount: 0,
  });
  const [isCompactingUi, setIsCompactingUi] = useState(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  /** 当前模型窗口（ref）：流式回调里 applyUsage 不闭包过期 */
  const contextWindowRef = useRef(DEFAULT_CONTEXT_WINDOW);

  const applyUsage = (usage: TAgentUsage | undefined): void => {
    if (!usage) return;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheCreationTokens ?? 0;
    // 有任意 usage 字段就更新（有的 provider 主字段只在 cache 上）
    if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) return;

    const contextWindow = contextWindowRef.current;

    setContextUsage({
      inputTokens:
        Math.max(input, cacheRead + cacheWrite > 0 ? input : 0) || input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      contextWindow,
    });
    setTokenTotals((prev) => ({
      totalInput: prev.totalInput + input,
      totalOutput: prev.totalOutput + output,
      totalCacheRead: prev.totalCacheRead + cacheRead,
      totalCacheWrite: prev.totalCacheWrite + cacheWrite,
      turnCount: prev.turnCount + (input > 0 || output > 0 ? 1 : 0),
    }));
  };

  // 切会话时清空占用与累计
  useEffect(() => {
    setContextUsage(null);
    setTokenTotals({
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      turnCount: 0,
    });
    setIsCompactingUi(false);
  }, [sessionId]);
  const scrollContextRef = useRef<StickToBottomContext | null>(null);
  const itemIdxRef = useRef(0);
  const streamStateRef = useRef<SessionStreamState>(EMPTY_STREAM_STATE);
  streamStateRef.current = streamState;
  const chatInputRef = useRef<ChatInputHandle>(null);
  const composerClusterRef = useRef<HTMLDivElement>(null);
  const composerInputDockRef = useRef<HTMLDivElement>(null);
  const bottomStackRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const channels = useAtomValue(channelsAtom);
  const tabs = useAtomValue(tabsAtom);
  const selectedModelSelection = useAtomValue(selectedModelSelectionAtom);
  const setSelectedModelSelection = useSetAtom(selectedModelSelectionAtom);
  const bumpRefresh = useSetAtom(bumpSessionsRefreshAtom);
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTabId = useSetAtom(activeTabIdAtom);
  const loadWorkspaces = useSetAtom(loadWorkspacesAtom);
  const pendingSuggestion = useAtomValue(pendingSuggestionAtom);
  const setPendingSuggestion = useSetAtom(pendingSuggestionAtom);
  const setSessionError = useSetAtom(setSessionErrorAtom);

  /**
   * ScrollMinimap 刻度：一轮对话一刻度。
   * 必须用 turn 分组，且只认「真实用户输入」——
   * tool_result 也是 type=user，若不过滤会把每个工具结果都画成刻度（过程块污染 minimap）。
   */
  /** 先把原始 DisplayItem 归并成真实对话轮次；虚拟化和刻度都以 turn 为单位。 */
  const allTurns = useMemo(() => groupItemsIntoTurns(items), [items]);
  const turnCount = allTurns.length;

  const minimapItems = useMemo<MinimapItem[]>(() => {
    const turns = allTurns;
    const result: MinimapItem[] = [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (!t || t.kind !== "user") continue;
      if (!isRealUserInput(t.message)) continue;

      const userText = firstText(t.message) ?? "";
      let replyPreview: string | undefined;
      let replyModel: string | undefined;
      for (let j = i + 1; j < turns.length; j++) {
        const next = turns[j];
        if (!next) continue;
        if (next.kind === "user") break;
        if (next.kind === "assistant-turn") {
          const pres = buildTurnPresentation(next);
          const ans = pres.answerTexts[0]?.replace(/\s+/g, " ").trim();
          if (ans) replyPreview = ans.slice(0, 120);
          replyModel = next.modelId ?? pres.modelId;
          break;
        }
      }
      result.push({
        // 与 TurnView 上 data-message-id 一致，便于刻度跳转定位
        id: t.key,
        role: "user",
        preview: userText.slice(0, 160) || "用户消息",
        replyPreview,
        model: replyModel,
      });
    }
    return result;
  }, [allTurns]);

  /** 实际挂载的 turn 数（Infinity 当全部 turn） */
  const effectiveVisible = visibleCount >= turnCount ? turnCount : visibleCount;
  /** 历史是否已全部挂载 */
  const allMounted = effectiveVisible >= turnCount;
  /**
   * 首屏窗口已就绪（钉底 / 打开 settle 用）。不再等全历史挂满——
   * 否则会回到「拉满 Infinity → 流式拖全树」的老路径。
   */
  const windowReady =
    turnCount === 0 ||
    effectiveVisible >= Math.min(CHAT_MOUNT_WINDOW, turnCount) ||
    allMounted;
  /** 未挂载 turn 的顶部占位，保证短尾部内容仍有真实滚动范围。 */
  const omittedTurnCount = Math.max(0, turnCount - effectiveVisible);
  const topVirtualSpacerHeight =
    omittedTurnCount * CHAT_MOUNT_ESTIMATED_TURN_HEIGHT;
  /** 虚拟化切片：尾部 effectiveVisible 个 turn（最新在底）。 */
  const visibleTurns = allTurns.slice(
    Math.max(0, turnCount - effectiveVisible),
  );
  /**
   * 单条消息入场动画门控：只给「本轮新出现的末尾 turn」加 message-enter。
   * - 跟踪上一帧的末尾 turn key；末尾 key 变化 + 运行中 → 该 key 挂淡入上滑。
   * - 历史虚拟化补齐（头部增、末尾不变）、切空闲会话（非运行）都不触发，避免整列闪。
   * - 合成占位壳（liveKey / stoppedSyntheticKey）也参与：发送后空窗的占位壳同样丝滑出现。
   * - enterKey 用 state 保持，动画时长（280ms）+余量后才清空——保证流式每帧 re-render
   *   期间 class 持续挂着，CSS animation 只触发一次且不被中途移除断帧。
   */
  const prevLastTurnKeyRef = useRef<string | null>(null);
  const lastVisibleTurn = visibleTurns[visibleTurns.length - 1];
  const syntheticLiveTurnKey =
    (running || runStartedAt != null) &&
    lastVisibleTurn?.kind !== "assistant-turn"
      ? resolveRunTurnKey(visibleTurns, sessionId, true)
      : null;
  const finalLastTurnKey = syntheticLiveTurnKey ?? lastVisibleTurn?.key ?? null;
  const [enterKey, setEnterKey] = useState<string | null>(null);
  useEffect(() => {
    if (
      finalLastTurnKey &&
      finalLastTurnKey !== prevLastTurnKeyRef.current &&
      (running || runStartedAt != null)
    ) {
      prevLastTurnKeyRef.current = finalLastTurnKey;
      setEnterKey(finalLastTurnKey);
      const timer = window.setTimeout(() => setEnterKey(null), 340);
      return () => window.clearTimeout(timer);
    }
    prevLastTurnKeyRef.current = finalLastTurnKey;
  }, [finalLastTurnKey, running, runStartedAt]);

  // 选择优先级：本会话最近选择 > 持久化会话选择 > 新会话全局选择。
  // 旧会话只有 channelId 没有 modelId 时，用该渠道当前默认模型做一次迁移。
  const sessionChannel = channels.find(
    (channel) => channel.id === session.channelId,
  );
  const sessionModelId =
    session.modelId ?? resolveChannelDefaultModelId(sessionChannel);
  const persistedSelection =
    session.channelId && sessionModelId
      ? { channelId: session.channelId, modelId: sessionModelId }
      : null;
  const effectiveSelection =
    selectionOverride ?? persistedSelection ?? selectedModelSelection;
  const selectionChannel = effectiveSelection
    ? channels.find((c) => c.id === effectiveSelection.channelId)
    : undefined;
  /**
   * 会诊本条菜单预置：按当前渠道解析。
   * - kscc：过滤掉席位模型未启用的 stored 预置
   * - 外部 ≥2 模：命中本渠的 stored，否则合成 channel-default
   * - 外部 =1 模：合成 channel-same-model（同模多角色，菜单标「同模」）
   * 渠道缺失 / 无可用预置 → []（SendSplitButton 退回单发送键）
   */
  const consultPresetsForMenu = resolveConsultPresetsForChannel(
    selectionChannel,
    consultPresets,
  );
  const configuredContextWindow = effectiveSelection
    ? selectionChannel?.models.find((m) => m.id === effectiveSelection.modelId)
        ?.contextWindow
    : undefined;
  const displayContextWindow = resolveUiContextWindow({
    modelId: effectiveSelection?.modelId,
    configuredWindow: configuredContextWindow,
  });
  contextWindowRef.current = displayContextWindow;

  // 旧粘性 moa:*：会诊入口已迁出发送旁，自动落回渠道默认真实模型，避免选择器卡死在会诊名上
  useEffect(() => {
    if (!effectiveSelection || !isMoaModelId(effectiveSelection.modelId))
      return;
    const ch = channels.find((c) => c.id === effectiveSelection.channelId);
    const realId = resolveChannelDefaultModelId(ch);
    if (!realId || !ch) return;
    const next = { channelId: ch.id, modelId: realId };
    setSelectionOverride(next);
    setSelectedModelSelection(next);
    if (!onDraftWorkspaceChange) {
      void window.electronAPI.updateSessionMeta(sessionId, { modelId: realId });
    }
  }, [
    effectiveSelection?.channelId,
    effectiveSelection?.modelId,
    channels,
    sessionId,
    onDraftWorkspaceChange,
    setSelectedModelSelection,
  ]);

  // 切模型时刷新圆环分母（不必等下一轮 usage）
  useEffect(() => {
    setContextUsage((prev) =>
      prev && prev.contextWindow !== displayContextWindow
        ? { ...prev, contextWindow: displayContextWindow }
        : prev,
    );
  }, [displayContextWindow]);

  // 会话已绑渠道优先；否则用当前选择；再否则用本会话已发送过的核
  const lockedKind: ChannelCoreKind | null = sessionChannel
    ? getChannelCoreKind(sessionChannel)
    : selectionChannel
      ? getChannelCoreKind(selectionChannel)
      : sentCoreKind;
  /** 已绑定渠道即显示 token 栏；kscc 仅隐藏占用圆环（占用不可信），累计统计照常 */
  const showTokenBar = lockedKind !== null;

  // 滚动位置恢复交给 ScrollPositionManager（Conversation 内部）：
  // 钉底在 scrollReady + 尾部窗口就绪后即可；中间位才拉满历史再还原。
  useEffect(() => {
    sessionIdRef.current = sessionId;
    // 切会话清同轮完成耗时幂等闸，避免上轮残留 true 屏蔽新会话首条终态记录
    completionRecordedRef.current = false;
    finalOutputSeenRef.current = false;
    setFinalOutputState(null);
    setItems([]);
    setStreamState(clearSessionStreamState());
    // 运行态：不在此 stopRun（见下方 async reconcile 注释）。
    setHasDraft(false);
    setScrollReady(false);
    const restoreMid = hasSavedMidPosition(
      peekSessionScrollDistance(sessionId),
    );
    setAllowFullMount(restoreMid);
    setVisibleCount(restoreMid ? Number.POSITIVE_INFINITY : CHAT_MOUNT_WINDOW);
    streamStateRef.current = clearSessionStreamState();
    itemIdxRef.current = 0;
    setSubagentEagerness("conservative"); // 切会话重置，下面异步回显持久化值
    setReasoningEffort(DEFAULT_REASONING_EFFORT); // 切会话重置，下面异步回显持久化值
    setExecutionMode(DEFAULT_EXECUTION_MODE); // 切会话重置，下面异步回显持久化值
    setPermissionMode(TAGENT_DEFAULT_PERMISSION_MODE); // 切会话重置，下面异步回显持久化值
    setBackgroundCrewBanner(null); // 切会话清掉后台班组提示
    // welcome 形态点提示词时暂存的文本：草稿态挂载后预填输入框并清空。
    // 只有刚 newSession 的草稿会带 pending；切到已有会话时它已被清空，不误填。
    if (pendingSuggestion) {
      chatInputRef.current?.setText(pendingSuggestion);
      chatInputRef.current?.focus();
      setPendingSuggestion(null);
    }
    let cancelled = false;
    void (async () => {
      // 运行态 reconcile（以主进程 getSessionStatus 为准）：
      // - running → adopt，保留已有 startedAt（软停后仍 turnInFlight 的合法态靠此续上）
      // - idle/error 且 atom 仍 running 或 startedAt 残留 → hard stop，避免计时/停止键卡死
      // 注意：cancelled 只跳过 setState，不能在 getSessionStatus 后整段 return，
      // 否则 StrictMode 双挂载 / 快切时历史永远不加载 → 主区像「没切换」。
      try {
        const status = await window.electronAPI.getSessionStatus(sessionId);
        if (!cancelled) {
          if (status?.status === "running") {
            const latest = getDefaultStore().get(sessionRunMapAtom)[sessionId];
            adoptSessionRun({
              id: sessionId,
              startedAt: latest?.startedAt ?? Date.now(),
            });
          } else if (status?.status === "idle" || status?.status === "error") {
            // 主进程已空闲/出错：atom 仍 running 或 startedAt 残留 → 硬清（软停合法态
            // 若主进程仍 turnInFlight 会走上面 running 分支，不会被误杀）
            // 等用户点选时主进程可能已 idle，禁止硬清，否则提交后从 0 重计。
            const latest = getDefaultStore().get(sessionRunMapAtom)[sessionId];
            if (
              !isSessionAwaitingUser(sessionId) &&
              (latest?.running || latest?.startedAt != null)
            ) {
              runStartedAtPersistRef.current = null;
              stopSessionRun(sessionId);
            }
          }
        }
      } catch {
        // IPC 失败：保留 atom 现状
      }
      if (cancelled) return;
      const history = (await window.electronAPI.getMessages(
        sessionId,
      )) as unknown[];
      if (cancelled) return;
      // 按核分流转译：kscc 会话落盘 SDKMessage → sdkMessageToIR；pi 会话落盘 TAgentMessage IR → 直读。
      // 旧 pi 会话可能仍是 SDKMessage 形态（有 message 包装），用 sdkMessageToIR 兜底。
      const isKsccCore = sessionChannel
        ? getChannelCoreKind(sessionChannel) === "kscc"
        : true;
      const irItems: DisplayItem[] = [];
      for (const raw of history) {
        const message = isKsccCore
          ? sdkMessageToIR(raw as never).message
          : isIRMessage(raw)
            ? (raw as TAgentMessage)
            : sdkMessageToIR(raw as never).message;
        if (message) {
          irItems.push({
            key: `h${itemIdxRef.current++}`,
            message: compactAssistantMessageForDisplay(message),
          });
        }
      }
      if (cancelled) return;
      // 子代理入口卡：运行时 taskCard 不落盘；从历史 tool_use(task)+tool_result 回填「派过 + 结论」
      const rehydrated = rehydrateSubagentTaskCardsFromHistory(
        irItems,
        taskCardApply,
      );
      setItems((current) => {
        if (shouldPreserveLiveItems(current)) return current;
        inFlightToolIdsRef.current = collectPendingToolUseIds(rehydrated);
        return rehydrated;
      });
      // 默认只挂尾部窗口；中间位恢复才拉满。≤100 也曾 Infinity，60 轮流式会被历史树拖死。
      setVisibleCount((prev) => {
        if (prev === Number.POSITIVE_INFINITY) return prev;
        const rehydratedTurnCount = groupItemsIntoTurns(rehydrated).length;
        return Math.min(CHAT_MOUNT_WINDOW, Math.max(rehydratedTurnCount, 1));
      });
      // 从历史 assistant.usage 回填底栏（最近一条有 usage 的 assistant）
      for (let i = rehydrated.length - 1; i >= 0; i--) {
        const m = rehydrated[i]?.message;
        if (
          m?.type === "assistant" &&
          m.usage &&
          (m.usage.inputTokens ?? 0) > 0
        ) {
          applyUsage(m.usage);
          break;
        }
      }
      setScrollReady(true);
      // 回显子代理委派积极性：会话 meta → 设置页全局默认 → conservative
      try {
        const metas = (await window.electronAPI.listSessions()) as Array<{
          id: string;
          subagentEagerness?: SubagentEagerness;
          reasoningEffort?: ReasoningEffort;
          executionMode?: ExecutionMode;
          permissionMode?: TAgentPermissionMode;
          pendingExecutionModeSuggestion?:
            import("@tagent/shared").ExecutionModeSuggestion | null;
          boardId?: string;
          pendingMentionRoleIds?: string[];
          turnDurations?: Record<string, TurnDuration>;
          cliWorkerId?: string;
        }>;
        if (cancelled) return;
        const persisted = metas.find((m) => m.id === sessionId);
        if (persisted) {
          // 记录 meta 快照（completeRun 持久化 turnDurations 时合并旧值）
          metaRef.current = persisted;
          // 回填持久化的完成耗时：createdAt 稳定 key → 当前渲染 turn key
          const backfilled = backfillTurnDurations(
            irItems,
            persisted.turnDurations,
          );
          if (Object.keys(backfilled).length > 0) {
            setCompletedDurations((prev) => ({ ...prev, ...backfilled }));
          }
          // 全局默认从 store 即时读，避免把 eagernessDefault 放进 deps 导致整页重载
          const globalDefault = readSubagentEagernessDefault(
            getDefaultStore().get(subagentEagernessDefaultAtom),
          );
          const resolvedEagerness = resolveEagerness(persisted, globalDefault);
          setSubagentEagerness(resolvedEagerness);
          // 会话从未单独设过 → 把解析结果落盘，主进程注入与 UI 对齐
          if (persisted.subagentEagerness === undefined) {
            void window.electronAPI.updateSessionMeta(sessionId, {
              subagentEagerness: resolvedEagerness,
            });
          }
          setReasoningEffort(migrateReasoningEffort(persisted.reasoningEffort));
          // 旧会话无字段 → migrate 为 work，避免突然只读
          setExecutionMode(migrateExecutionMode(persisted.executionMode));
          setPermissionMode(
            persisted.permissionMode
              ? migratePermissionMode(persisted.permissionMode)
              : TAGENT_DEFAULT_PERMISSION_MODE,
          );
          setPendingModeSuggestion(
            persisted.pendingExecutionModeSuggestion ?? null,
          );
          setSessionBoardId(persisted.boardId ?? null);
          // 回显对话跟随的 activeSpeaker（followMode 持久化）
          setActiveMentionRoleIds(
            Array.isArray(persisted.pendingMentionRoleIds)
              ? persisted.pendingMentionRoleIds
              : [],
          );
        } else {
          setPendingModeSuggestion(null);
          setSessionBoardId(null);
          setActiveMentionRoleIds([]);
        }
      } catch {
        /* 回显失败不影响主流程，沿用默认 */
      }
      // T8：重放本场会话已落盘的圆桌讨论 → 重建入口卡（主进程读 moa-discussion.jsonl，按 discussionId
      //   推 moa_discussion 事件，复用上面 upsertMoADiscussionItem；终态卡落点对齐共识 assistant）。
      //   历史消息已 setItems(irItems) 在先 → 重放卡就地 upsert 不被覆盖；切走会话（cancelled）→
      //   流式监听器按 sessionIdRef 过滤丢弃，无副作用。
      if (cancelled) return;
      try {
        await window.electronAPI.replayMoADiscussions(sessionId);
      } catch (err) {
        console.warn("[chat] replayMoADiscussions failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // main 会话滚动时关闭滚动内容自身的 backdrop-filter，避免 GPU 合成滞后产生拖影。
  // 输入框是滚动容器的兄弟节点，不受 is-scrolling 选择器影响，玻璃遮挡保持不变。
  useEffect(() => {
    const scrollEl = scrollContextRef.current?.scrollRef.current;
    if (!scrollEl) return;

    let scrollTimer = 0;
    const handleScroll = (): void => {
      scrollEl.classList.add("is-scrolling");
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        scrollEl.classList.remove("is-scrolling");
      }, 150);
    };

    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", handleScroll);
      window.clearTimeout(scrollTimer);
      scrollEl.classList.remove("is-scrolling");
    };
  }, [sessionId]);

  // Work 模式下不展示「后台班组」提示（用户已回到可派工形态）
  useEffect(() => {
    if (executionMode === "work") setBackgroundCrewBanner(null);
  }, [executionMode]);

  /**
   * 看板全部完成 → 软刷新 panel 消息（回流摘要）+ 清后台班组条。
   * 仅匹配 parentSessionId；运行中不打断流式。
   */
  useEffect(() => {
    const off = window.electronAPI.onKanbanBoardCompleted?.(
      (payload: unknown) => {
        const p = payload as { parentSessionId?: string; boardId?: string };
        const sid = sessionIdRef.current;
        const matchesParent = !!p?.parentSessionId && p.parentSessionId === sid;
        const matchesBoard =
          !!p?.boardId && !!sessionBoardId && p.boardId === sessionBoardId;
        // 仅刷新与当前会话相关的看板完成
        if (!matchesParent && !matchesBoard) return;
        setBackgroundCrewBanner(null);
        if (
          hasStreamContent(streamStateRef.current) ||
          runningRef.current ||
          runStartedAtRef.current != null
        )
          return;
        void (async () => {
          try {
            const history = (await window.electronAPI.getMessages(
              sid,
            )) as unknown[];
            const ch = channels.find((c) => c.id === session.channelId);
            const isKsccCore = ch ? getChannelCoreKind(ch) === "kscc" : true;
            const irItems: DisplayItem[] = [];
            let idx = 0;
            for (const raw of history) {
              const message = isKsccCore
                ? sdkMessageToIR(raw as never).message
                : isIRMessage(raw)
                  ? (raw as TAgentMessage)
                  : sdkMessageToIR(raw as never).message;
              if (message) {
                irItems.push({
                  key: `h${idx++}`,
                  message: compactAssistantMessageForDisplay(message),
                });
              }
            }
            if (sessionIdRef.current !== sid) return;
            const rehydrated = rehydrateSubagentTaskCardsFromHistory(
              irItems,
              (existing, card) =>
                existing
                  ? { ...existing, taskCard: card }
                  : { key: `h${idx++}`, taskCard: card },
            );
            itemIdxRef.current = Math.max(
              itemIdxRef.current,
              idx,
              rehydrated.length,
            );
            setItems((current) =>
              shouldPreserveLiveItems(current) ? current : rehydrated,
            );
          } catch {
            /* 回流刷新失败不影响主流程 */
          }
        })();
      },
    );
    return () => {
      off?.();
    };
  }, [session.channelId, sessionBoardId, channels]);

  /** 解析 Work→Chat 后是否展示后台班组条（优先 IPC 返回，缺则 listTasks 兜底） */
  const applyBackgroundCrewFromModeSwitch = useCallback(
    async (
      mode: ExecutionMode,
      res: {
        backgroundCrew?: {
          running: number;
          ready: number;
          pending: number;
          boardId?: string;
        };
      },
    ): Promise<void> => {
      if (mode === "work") {
        setBackgroundCrewBanner(null);
        return;
      }
      let crew = res.backgroundCrew;
      if (!crew && sessionBoardId) {
        try {
          const t = (await window.electronAPI.kanbanListTasks?.(
            sessionBoardId,
          )) as Array<{
            status?: string;
          }>;
          if (Array.isArray(t)) {
            const running = t.filter((x) => x.status === "running").length;
            const ready = t.filter((x) => x.status === "ready").length;
            const pending = t.filter((x) => x.status === "pending").length;
            if (running + ready + pending > 0) {
              crew = { running, ready, pending, boardId: sessionBoardId };
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
        });
      } else {
        setBackgroundCrewBanner(null);
      }
    },
    [sessionBoardId],
  );

  // 动态测量底部 UI：
  //   --session-composer-top：Conversation 底 → bottom-stack 顶（下箭头 bottom 锚定）
  //   --session-stack-over-cluster：cluster 顶 → stack 顶（队列/横幅高度；运行胶囊上抬量）
  // 必须以 Conversation 底边为基准（按钮定位上下文），不能只量 root：
  // 有图片附件时输入玻璃变高，若变量滞后，箭头会停在旧高度并被 z-20 底栏盖住。
  const updateComposerTop = useCallback((): void => {
    const root = rootRef.current;
    const stack = bottomStackRef.current;
    const cluster = composerClusterRef.current;
    if (!root || !stack) return;
    // Conversation 是 absolute inset-0 的滚动容器，scroll 按钮 relative 于它
    const conversationEl =
      (root.querySelector('[role="log"]') as HTMLElement | null) ?? root;
    const convBottom = conversationEl.getBoundingClientRect().bottom;
    const stackTop = stack.getBoundingClientRect().top;
    // 刻度要避让输入框和运行时计时胶囊；不把 AskUser/权限/队列等弹窗高度算进来。
    const timer = root.querySelector<HTMLElement>(".composer-run-timer");
    const timerRect = timer?.getBoundingClientRect();
    const timerStyle = timer ? window.getComputedStyle(timer) : null;
    const timerVisible = Boolean(
      timerRect &&
      timerRect.height > 0 &&
      timerStyle &&
      timerStyle.display !== "none" &&
      timerStyle.visibility !== "hidden" &&
      Number(timerStyle.opacity) > 0.01,
    );
    const inputDockRect = composerInputDockRef.current?.getBoundingClientRect();
    const inputDockVisible = Boolean(
      inputDockRect && inputDockRect.height > 0 && inputDockRect.width > 0,
    );
    const obstacleTop = Math.min(
      timerVisible ? timerRect!.top : Number.POSITIVE_INFINITY,
      inputDockVisible ? inputDockRect!.top : Number.POSITIVE_INFINITY,
    );
    const minimapBottomInset = Number.isFinite(obstacleTop)
      ? // 轨道底部必须停在障碍物顶部之上；用 bottom 会让刻度穿到输入框/胶囊后面。
        Math.max(8, Math.round(convBottom - obstacleTop + 8))
      : 8;
    root.style.setProperty(
      "--session-minimap-bottom-inset",
      `${minimapBottomInset}px`,
    );
    const dist = Math.max(0, Math.round(convBottom - stackTop));
    root.style.setProperty("--session-composer-top", `${dist}px`);
    // 队列/建议条等在 cluster 之上：胶囊不能再贴输入框顶，要抬过它们
    if (cluster) {
      const clusterTop = cluster.getBoundingClientRect().top;
      const over = Math.max(0, Math.round(clusterTop - stackTop));
      root.style.setProperty("--session-stack-over-cluster", `${over}px`);
    } else {
      root.style.setProperty("--session-stack-over-cluster", "0px");
    }
  }, []);

  /** 布局变化后多帧校正（附件 DOM 插入、图片解码、功能栏动画、底栏进出） */
  const scheduleComposerTopUpdate = useCallback((): (() => void) => {
    updateComposerTop();
    const raf1 = requestAnimationFrame(() => {
      updateComposerTop();
      requestAnimationFrame(updateComposerTop);
    });
    const t1 = window.setTimeout(updateComposerTop, 50);
    // 底栏 fade 约 200ms；不再跟 spring height，420ms 补测可省
    const t2 = window.setTimeout(updateComposerTop, 220);
    return () => {
      cancelAnimationFrame(raf1);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [updateComposerTop]);

  useEffect(() => {
    const stack = bottomStackRef.current;
    const composer = composerClusterRef.current;
    if (!stack || !composer) return;

    // RO：box 尺寸变化（功能栏/token/多行输入/附件撑高/队列高度）
    const ro = new ResizeObserver(() => {
      updateComposerTop();
    });
    ro.observe(stack);
    ro.observe(composer);
    // MutationObserver：附件队列/横幅/预览卡片增删。
    // 勿开 attributes——motion 每帧改 style 会拖垮 updateComposerTop。
    const mo = new MutationObserver(() => {
      updateComposerTop();
    });
    mo.observe(stack, { childList: true, subtree: true });
    const cancel = scheduleComposerTopUpdate();
    // 会话页入场动画结束后再校一次
    const t = window.setTimeout(updateComposerTop, 500);

    return () => {
      ro.disconnect();
      mo.disconnect();
      cancel();
      clearTimeout(t);
    };
  }, [updateComposerTop, scheduleComposerTopUpdate]);

  // 附件 / 模式 / 消息队列：显式重测（不依赖 RO 是否丢帧）
  useEffect(() => {
    // 队列清空时立刻压掉抬升量，避免胶囊/下箭头悬在空洞上（等 motion exit 会滞后）
    if (messageQueue.length === 0) {
      rootRef.current?.style.setProperty("--session-stack-over-cluster", "0px");
    }
    return scheduleComposerTopUpdate();
  }, [
    pendingAttachments.length,
    executionMode,
    messageQueue.length,
    mentionPickerOpen,
    scheduleComposerTopUpdate,
  ]);

  // 班组条展开/折叠：强制多帧重测（列表 max-height 变化时 RO 偶发滞后 → 下箭头压在列表上）
  useEffect(() => {
    const onRemeasure = (): void => {
      scheduleComposerTopUpdate();
    };
    window.addEventListener("tagent:composer-top-remeasure", onRemeasure);
    return () =>
      window.removeEventListener("tagent:composer-top-remeasure", onRemeasure);
  }, [scheduleComposerTopUpdate]);

  // AskUser / 权限弹窗出现或收起：只重测底栏占位；滚动补偿统一交给 ScrollPositionManager。
  useEffect(() => {
    return scheduleComposerTopUpdate();
  }, [hasBlockingBottomBanner, scheduleComposerTopUpdate]);

  // 对话列宽度：右栏打开或窗口变窄 → 紧凑输入栏（图标优先，防文字叠压）
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      setComposerCompact(crewPanelOpen);
      return;
    }
    const measure = (): void => {
      const w = el.getBoundingClientRect().width;
      // 滞回：避免列宽贴着阈值时 compact class 和 RO 互推，打出 Maximum update depth
      setComposerCompact((prev) => {
        if (crewPanelOpen) return true;
        if (prev) return w < 576;
        return w < 544;
      });
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [crewPanelOpen, sessionId]);

  // Chat @ 角色列表（B1）与当前会话已加入的 Bot
  useEffect(() => {
    void (async () => {
      try {
        const roles = await window.electronAPI.listAgentRoles();
        setMentionRoles(
          (roles ?? []).map((r) => ({
            id: r.id,
            displayName: r.displayName,
            description: r.description,
            pinned: r.pinned === true,
            kind: "role" as const,
          })),
        );
      } catch {
        setMentionRoles([]);
      }
      try {
        const selectedIds = new Set(session.botProfileIds ?? []);
        const bots = await window.electronAPI.listBots();
        setMentionBots(
          (bots ?? [])
            .filter(
              (bot) =>
                selectedIds.has(bot.profile.id) && !bot.profile.archivedAt,
            )
            .map((bot) => ({
              id: bot.profile.id,
              displayName: bot.profile.displayName,
              description: bot.profile.description,
              kind: "bot" as const,
            })),
        );
      } catch {
        setMentionBots([]);
      }
    })();
  }, [session.botProfileIds?.join("\u0000")]);

  const mentionOptions = useMemo(
    () => [...mentionRoles, ...mentionBots],
    [mentionBots, mentionRoles],
  );
  const roleMentionOptions = useMemo(
    () => mentionOptions.filter((item) => item.kind !== "bot"),
    [mentionOptions],
  );

  // roleId → 展示名（activeSpeaker 指示条 / 跟随铭牌用）
  const roleNameById = useMemo(
    () => new Map(mentionRoles.map((r) => [r.id, r.displayName] as const)),
    [mentionRoles],
  );

  /** ✕ 清除对话跟随：本地清空 + 主进程 pendingMentionRoleIds 置空（回默认总助） */
  const clearActiveMention = useCallback(async () => {
    setActiveMentionRoleIds([]);
    setLiveMentionLabels([]);
    try {
      await window.electronAPI.clearMentionFollow(sessionId);
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  /**
   * Chat 输入框顶部的 activeSpeaker 指示条（参考主流 IM「当前对话对象」）：
   * @ 某角色后显示「正在与 @角色 对话」，续聊下一轮保持；✕ 结束跟随回默认总助。
   */
  const activeMentionBar =
    executionMode === "chat" && activeMentionRoleIds.length > 0 ? (
      <div className="active-speaker-bar" role="status" aria-live="polite">
        <UsersThree
          className="size-3.5 shrink-0 text-primary"
          weight="fill"
          aria-hidden
        />
        <span className="active-speaker-bar__label">正在与</span>
        {activeMentionRoleIds.map((id) => (
          <span key={id} className="active-speaker-chip">
            @{roleNameById.get(id) ?? id}
          </span>
        ))}
        <span className="active-speaker-bar__label">对话</span>
        <AppTooltip label="结束跟随，回到默认助手">
          <button
            type="button"
            className="active-speaker-clear"
            onClick={() => void clearActiveMention()}
            aria-label="结束跟随，回到默认助手"
          >
            <X className="size-3" aria-hidden />
          </button>
        </AppTooltip>
      </div>
    ) : null;

  // 虚拟化分批：默认只补到尾部窗口；allowFullMount（上滑/中间位/锚点）才继续往更早补。
  useEffect(() => {
    if (allMounted) return;
    if (turnCount === 0) return;
    const windowCap = Math.min(CHAT_MOUNT_WINDOW, turnCount);
    if (!allowFullMount && effectiveVisible >= windowCap) return;
    // requestIdleCallback 兼容（Electron Chromium 原生支持，fallback setTimeout）
    const scheduleIdle: (cb: () => void) => number =
      typeof window !== "undefined" && "requestIdleCallback" in window
        ? window.requestIdleCallback
        : (cb) => window.setTimeout(cb, 16) as unknown as number;
    const cancelIdle: (h: number) => void =
      typeof window !== "undefined" && "cancelIdleCallback" in window
        ? window.cancelIdleCallback
        : (h) => window.clearTimeout(h);
    const handle = scheduleIdle(() => {
      setVisibleCount((prev) => {
        if (prev >= turnCount) return prev;
        const cap = allowFullMount
          ? turnCount
          : Math.min(CHAT_MOUNT_WINDOW, turnCount);
        const base = prev === Number.POSITIVE_INFINITY ? turnCount : prev;
        const next = Math.min(base + CHAT_MOUNT_BATCH, cap);
        return next >= turnCount ? Number.POSITIVE_INFINITY : next;
      });
    });
    return () => cancelIdle(handle);
  }, [visibleCount, turnCount, allMounted, allowFullMount, effectiveVisible]);

  // 开流后若未在查历史，把过度挂载收回尾部窗口（中间位 allowFullMount 时不撤）。
  useEffect(() => {
    const live = running || runStartedAt != null;
    if (!live || allowFullMount) return;
    setVisibleCount((prev) => {
      if (prev === Number.POSITIVE_INFINITY || prev > CHAT_MOUNT_WINDOW) {
        return CHAT_MOUNT_WINDOW;
      }
      return prev;
    });
  }, [running, runStartedAt, allowFullMount]);

  // 滚近顶部 → 允许突破窗口，按批加载更早消息（补页时 ScrollPositionManager 会补偿 scrollTop）
  useEffect(() => {
    if (!scrollReady) return;
    const scroller = scrollContextRef.current?.scrollRef.current;
    if (!scroller) return;
    let coolUntil = 0;

    const onScroll = (): void => {
      if (scroller.scrollTop > CHAT_MOUNT_TOP_LOAD_PX) return;
      if (turnCount === 0) return;
      const now = Date.now();
      if (now < coolUntil) return;
      coolUntil = now + 120;
      setVisibleCount((prev) => {
        const mounted = prev >= turnCount ? turnCount : prev;
        if (mounted >= turnCount) return prev;
        const next = Math.min(mounted + CHAT_MOUNT_BATCH, turnCount);
        return next >= turnCount ? Number.POSITIVE_INFINITY : next;
      });
      setAllowFullMount(true);
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scrollReady, sessionId, turnCount]);

  // 兜底：如果当前窗口仍没有形成滚动范围，继续挂载一批历史轮次。
  // 正常情况下顶部占位块已经能提供滚动范围；这里处理容器尺寸、字体加载等异步布局场景。
  useEffect(() => {
    if (!scrollReady || allMounted || turnCount <= 0) return;
    const scroller = scrollContextRef.current?.scrollRef.current;
    if (!scroller || scroller.scrollHeight > scroller.clientHeight + 1) return;

    setVisibleCount((prev) => {
      const mounted = Number.isFinite(prev)
        ? Math.min(prev, turnCount)
        : turnCount;
      const next = Math.min(mounted + CHAT_MOUNT_BATCH, turnCount);
      return next >= turnCount ? Number.POSITIVE_INFINITY : next;
    });
  }, [allMounted, effectiveVisible, scrollReady, turnCount]);
  // 流式中回到底部 → 收回窗口，把更早的 DOM 卸掉（ScrollPositionManager 负责锚点收口）
  useEffect(() => {
    const live = running || runStartedAt != null;
    if (!live || !scrollReady) return;
    const scroller = scrollContextRef.current?.scrollRef.current;
    if (!scroller) return;
    const onScroll = (): void => {
      const dist =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (dist > 40) return;
      setVisibleCount((prev) => {
        if (prev === Number.POSITIVE_INFINITY || prev > CHAT_MOUNT_WINDOW) {
          return CHAT_MOUNT_WINDOW;
        }
        return prev;
      });
      setAllowFullMount(false);
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [running, runStartedAt, scrollReady, sessionId]);

  // 监听流式事件
  useEffect(() => {
    const off = window.electronAPI.onStreamEvent((payload: unknown) => {
      const env = payload as StreamEventEnvelope;
      if (env.sessionId !== sessionIdRef.current) return;
      handlePayload(env.payload);
    });
    return () => {
      off?.();
      clearPendingStop();
      if (thinkingFlushRafRef.current != null) {
        cancelAnimationFrame(thinkingFlushRafRef.current);
        thinkingFlushRafRef.current = null;
      }
    };
  }, []);

  // 主进程发起的权限模式切换（EnterPlanMode 进入 / ExitPlanMode 审批后切目标模式）：
  // 只更新当前会话的输入框 pill（setPermissionMode）。后台会话的 pill 在切回时从 meta 回显。
  // 「正在规划」会话集合（planModeSessionsAtom，含后台）由 useExitPlanSync 全局维护，此处不重复。
  // pill 手动切换由用户本地先设，主进程不回推 PLAN_MODE_CHANGED，故无回环。
  useEffect(() => {
    const off = window.electronAPI.onPlanModeChanged((payload) => {
      if (!payload || payload.sessionId !== sessionIdRef.current) return;
      setPermissionMode(
        migratePermissionMode(payload.mode as TAgentPermissionMode),
      );
    });
    return () => off?.();
  }, []);

  /**
   * 任务卡片 apply：existing=undefined 新建（分配稳定 key），否则就地更新 taskCard
   * （保留 message / streamingText 等其他字段）。reduceTaskEvent 的承载项工厂。
   */
  const taskCardApply = (
    existing: DisplayItem | undefined,
    card: TaskCardState,
  ): DisplayItem =>
    existing
      ? { ...existing, taskCard: card }
      : { key: `task${itemIdxRef.current++}`, taskCard: card };

  /** 段边界 / 落盘同批：清会话级 streamState */
  const resetStreamState = useCallback((): void => {
    setStreamState(clearSessionStreamState());
    pendingThinkingRef.current = "";
    pendingThinkingUuidRef.current = undefined;
  }, []);

  /**
   * 用户点停止：若 Agent 尚未开始处理 → 撤回 user 气泡、回填输入框；
   * 否则走正常「已中断」收尾。
   */
  const handleUserStop = useCallback(async (): Promise<void> => {
    clearPendingStop();
    const canRecall = !hasRunStartedProcessing(
      itemsRef.current,
      streamStateRef.current,
    );
    await window.electronAPI.stopAgent(sessionIdRef.current);
    if (canRecall) {
      const recalled = await window.electronAPI.recallUnsentTurn(
        sessionIdRef.current,
      );
      if (recalled?.ok && recalled.text) {
        const recallDraft = pendingSendRecallRef.current;
        pendingSendRecallRef.current = null;
        userStoppedRef.current = false;
        runStartedAtPersistRef.current = null;
        stopRun();
        resetStreamState();
        setItems((prev) => sliceItemsBeforeLastRealUser(prev) ?? prev);
        setCompletedDurations((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(next)) {
            if (key.endsWith("-live")) delete next[key];
          }
          return next;
        });
        chatInputRef.current?.setText(recallDraft?.text ?? recalled.text);
        if (recallDraft?.attachments?.length) {
          setPendingAttachments(recallDraft.attachments);
        }
        chatInputRef.current?.focus();
        scheduleComposerTopUpdate();
        bumpRefresh();
        return;
      }
    }
    userStopRun();
    scheduleComposerTopUpdate();
  }, [
    bumpRefresh,
    clearPendingStop,
    resetStreamState,
    scheduleComposerTopUpdate,
    stopRun,
  ]);

  // thinking delta 的 rAF 合并缓冲：同一帧内多次 delta 只 flush 一次（渲染频率从"每事件"降到"每帧"）
  const pendingThinkingRef = useRef("");
  /** 与 pendingThinkingRef 对应的 assistant.uuid（同帧合并时保留最新） */
  const pendingThinkingUuidRef = useRef<string | undefined>(undefined);
  const thinkingFlushRafRef = useRef<number | null>(null);
  const flushThinkingDelta = useCallback((): void => {
    thinkingFlushRafRef.current = null;
    const delta = pendingThinkingRef.current;
    pendingThinkingRef.current = "";
    if (!delta) return;
    setStreamState((prev) => applyThinkingDeltaToState(prev, delta));
  }, []);

  const handlePayload = (p: TAgentDesktopStreamPayload): void => {
    // 终态 assistant（有 stop_reason、非 partial）不再 adopt / 取消停止计时——
    // 否则 turn_end 已 scheduleStop，终态 sdk_message 又 clearPendingStop，result 一丢就永远 live。
    const isTerminalAssistant =
      p.kind === "sdk_message" &&
      p.message.type === "assistant" &&
      Boolean(p.message.stop_reason) &&
      p.message._partial !== true;

    // 子代理 parented 消息：不 adopt / 不清停止计时（否则失败后 ComposerRunTimer 常驻）
    const isParentedSdk =
      p.kind === "sdk_message" &&
      (p.message.type === "assistant" || p.message.type === "user") &&
      Boolean(p.message.parentToolUseId);
    const hasMainlineAssistantText =
      p.kind === "sdk_message" &&
      !isParentedSdk &&
      p.message.type === "assistant" &&
      p.message.content.some(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim().length > 0,
      );
    const hasMainlineStreamText =
      p.kind === "stream_text_delta" &&
      !p.parentToolUseId &&
      p.text.trim().length > 0;
    const hasMainlineStreamThinking =
      p.kind === "stream_thinking_delta" && p.text.trim().length > 0;
    const hasMainlineAssistantMessage =
      p.kind === "sdk_message" &&
      !isParentedSdk &&
      p.message.type === "assistant";
    if (
      hasMainlineAssistantMessage ||
      hasMainlineStreamText ||
      hasMainlineStreamThinking
    ) {
      // 发送时只挂起“跟随最新轮”的意图；首个主线 assistant 内容到达后才激活，
      // 避免发送阶段收回虚拟化窗口时把上一轮 DOM 的底部误当成本轮底部。
      activateSessionAtBottom(sessionId);
      // 迟到的主线正文到达：解除“等待后台回调/缺少最终答复”提示。
      finalOutputSeenRef.current = true;
      setFinalOutputState(null);
    }

    // run 仍在进行：取消 turn_end 的延迟停止；流式/落盘事件恢复 running
    // （保过程区展开、停止键在位；adopt 沿用原 startedAt，不重置计时）
    if (!isTerminalAssistant && !isParentedSdk) {
      clearPendingStop();
      if (
        p.kind === "stream_text_delta" ||
        p.kind === "stream_thinking_delta" ||
        p.kind === "sdk_message"
      ) {
        if (!runningRef.current) {
          adoptSessionRun({
            id: sessionId,
            startedAt:
              runStartedAtPersistRef.current ??
              runStartedAtRef.current ??
              Date.now(),
          });
        }
      }
    }
    if (p.kind === "sdk_message") {
      // 子代理落盘消息：只静默 append（供入口卡进度 + 详情页），不碰主线 streaming 占位、
      // 不升级主线打字机、不刷底栏 usage。避免子代理一出就污染主会话。
      const parentedMsg =
        (p.message.type === "assistant" || p.message.type === "user") &&
        Boolean(p.message.parentToolUseId);
      if (!parentedMsg) {
        applyMessageToInFlightToolIds(inFlightToolIdsRef.current, p.message);
      }
      if (parentedMsg) {
        const msgUuid =
          p.message.type === "assistant" || p.message.type === "user"
            ? p.message.uuid
            : undefined;
        setItems((prev) => {
          if (msgUuid) {
            const uuidIdx = prev.findIndex(
              (it) =>
                it.streamUuid === msgUuid ||
                (it.message?.type === "assistant" &&
                  it.message.uuid === msgUuid) ||
                (it.message?.type === "user" && it.message.uuid === msgUuid),
            );
            if (uuidIdx >= 0) {
              return prev.map((it, i) =>
                i === uuidIdx
                  ? {
                      ...it,
                      message: p.message,
                      streamUuid: msgUuid ?? it.streamUuid,
                      streaming: false,
                      streamingText: undefined,
                      streamingThinking: undefined,
                    }
                  : it,
              );
            }
          }
          return [
            ...prev,
            {
              key: `m${itemIdxRef.current++}`,
              message: p.message,
              streamUuid: msgUuid,
              streaming: false,
            },
          ];
        });
        return;
      }

      // 同帧未 flush 的 thinking：消息已带完整 thinking 才丢弃（防重复）；
      // tool-only 中间态必须先并进 streamState，否则思考链会「出完即消失」。
      if (thinkingFlushRafRef.current != null) {
        cancelAnimationFrame(thinkingFlushRafRef.current);
        thinkingFlushRafRef.current = null;
      }
      const pendingThinking = pendingThinkingRef.current;
      pendingThinkingRef.current = "";
      pendingThinkingUuidRef.current = undefined;
      const clearThinking = shouldClearStreamThinking(p.message);

      // 段边界思考提交（修同会话 live 思考不显 / 与 reload 不一致）：
      // 主进程对 partial assistant 调 stripPartialAssistantBody 把 thinking 主体剥成空串再发 renderer
      // （落盘喂原始全量 msg，不经剥离）→ 同会话内存里 thinking 自己 uuid 的 item 主体为 ''，真实思考
      // 只活在 streamState.thinking。对 GLM 等无 final 非空 thinking 校准的核心，streamState.thinking
      // 跨段累积（shouldClearStreamThinking 对剥空块不触发），result/turn_end 时
      // commitStreamThinkingToLastAssistant 把全程累积的思考 graft 到**末条主线 assistant**（另一 uuid
      // 的 text/tool item）→ 同会话时间线把所有思考拼到末条、位置错；reload 却每段自带 → 不一致。
      // 修复（对称 tool_start 的 text 提交）：incoming 是 tool_use/text（当前思考段结束信号）且
      // streamState 仍有思考 → 先 graft 到末条主线 assistant（对 GLM = thinking 自己那条 uuid 的 item，
      // 因其 thinking 主体被剥空、排在 tool/text 之前，commitStreamThinkingToLastAssistant 前插其 content），
      // 再清 streamState.thinking——每段思考落在原位置，对齐落盘 reload。提交+清（非旧版整表 resetStreamState
      // 只清不提交），思考已落 message 不丢，不重 introduce REGRESS-E。
      // kscc 累计快照：final 带非空 thinking 经 shouldClearStreamThinking 清过 streamState.thinking →
      // fullPendingThink='' no-op，不影响。
      const incomingHasTool =
        p.message.type === "assistant" &&
        p.message.content.some((b) => b.type === "tool_use");
      const incomingHasToolOrText =
        incomingHasTool ||
        (p.message.type === "assistant" &&
          p.message.content.some((b) => b.type === "text"));
      const fullPendingThink = (
        streamStateRef.current.thinking + pendingThinking
      ).trim();
      const fullPendingText = streamStateRef.current.text.trim();
      // 思考：tool/text 到达 = 本段思考结束 → 写入 items
      const commitThinkAtSegment =
        incomingHasToolOrText && !clearThinking && fullPendingThink.length > 0;
      // 段间 progress 正文：tool 到达（含无 tool_start 事件的 kscc 路径）必须先 commit，
      // 否则 streamState 在 result 清空后中间 progress 全丢 → 多阶段并成一大块（用户截图）。
      const commitTextAtSegment = incomingHasTool && fullPendingText.length > 0;

      // assistant.usage 更新底栏（Pi）；kscc 圆环不展示，但状态可写无害
      if (p.message.type === "assistant" && p.message.usage) {
        applyUsage(p.message.usage);
      }
      // 先 upsert 落盘快照，再提交同帧缓冲：首条「thinking + tool」快照本身就是第一条 assistant，
      // 如果先 commit，列表里还没有 assistant，首条思考会被清缓存后吞掉。
      setItems((prev) => {
        let next = applySdkMessageToItems(
          prev,
          p.message,
          () => `m${itemIdxRef.current++}`,
        );
        if (commitThinkAtSegment) {
          next = commitStreamThinkingToLastAssistant(next, fullPendingThink);
        }
        if (commitTextAtSegment) {
          next = commitStreamTextToLastAssistant(next, fullPendingText);
        }
        return next;
      });
      setStreamState((prev) => {
        let base = prev;
        if (commitThinkAtSegment) base = { ...base, thinking: "" };
        if (commitTextAtSegment) base = { ...base, text: "" };
        if (commitThinkAtSegment || commitTextAtSegment) {
          return applySdkMessageToStreamState(base, p.message);
        }
        const withPending =
          !clearThinking && pendingThinking
            ? applyThinkingDeltaToState(prev, pendingThinking)
            : prev;
        return applySdkMessageToStreamState(withPending, p.message);
      });
    } else if (p.kind === "result") {
      if (p.usage) applyUsage(p.usage);
      // 提交前先 flush rAF 合帧缓冲：result 与 thinking delta 同帧到达时，pending batch 尚未
      // 写入 streamState（rAF 未 fire），直接读 ref 会漏，resetStreamState 又清掉 pending →
      // 末段思考增量永久丢失（REGRESS-F RC1，对齐 sdk_message 分支的 flush 守卫）
      if (thinkingFlushRafRef.current != null) {
        cancelAnimationFrame(thinkingFlushRafRef.current);
        thinkingFlushRafRef.current = null;
      }
      const pendingDelta = pendingThinkingRef.current;
      pendingThinkingRef.current = "";
      pendingThinkingUuidRef.current = undefined;
      const pendingThink = (
        streamStateRef.current.thinking + pendingDelta
      ).trim();
      // REGRESS-G（正文对称思考）：GLM 把每个 content 块拆成独立 uuid 的 assistant 且 stop_reason 始终 null，
      // 永不发非 partial 终态快照校准 → 正文只活在 streamState.text，边界不提交则 resetStreamState 丢弃，
      // 回合结束后只剩空壳（重开会话读 JSONL 才恢复）。此处把正文写入末条主线 assistant，与思考提交对称。
      // 累计快照（Claude/Pi）的 final（带 stop_reason）已清 streamState.text → trim()='' no-op，不重复落字。
      const pendingText = streamStateRef.current.text.trim();
      if (pendingText) finalOutputSeenRef.current = true;
      // commit 思考/正文 + 清 streaming 标记一次原子更新，避免分步 setItems 互相覆盖
      setItems((prev) => {
        let next = prev;
        if (pendingThink)
          next = commitStreamThinkingToLastAssistant(next, pendingThink);
        if (pendingText)
          next = commitStreamTextToLastAssistant(next, pendingText);
        const cleaned = next.map((it) =>
          it.streaming
            ? {
                ...it,
                streaming: false,
                streamingText: undefined,
                streamingThinking: undefined,
              }
            : it,
        );
        return purgeStreamingItems(cleaned);
      });
      resetStreamState();
      // result = 整个 run 真正 idle（turn_end 只是单个 SDK turn 结束，工具循环还会继续）。
      clearPendingStop();

      // error_* 以前几乎对 UI 透明（只吃 usage）；抬到 SessionErrorBanner，避免「气泡里有失败但无错误条」
      const subtype = typeof p.subtype === "string" ? p.subtype : "";
      const isErrorResult = subtype.startsWith("error_");
      const errorTexts = Array.isArray(p.errors)
        ? p.errors.filter(
            (e): e is string => typeof e === "string" && e.trim().length > 0,
          )
        : [];
      if (isErrorResult || errorTexts.length > 0) {
        const raw =
          errorTexts.join("\n") ||
          (subtype === "error_max_turns"
            ? "已达最大工具循环轮次"
            : subtype === "error_during_execution"
              ? "执行过程中出错"
              : subtype || "运行出错");
        // 终态分类（classifyRunAbort）：区分真用户停止 / AskUser 关窗后迟到 interrupt / 真 error。
        // 关窗后的迟到 interrupt 不当用户停止——按正常完成收口，勿抬错误条、勿把 endedBy 改 stopped。
        const verdict = classifyRunAbort({
          userStopped: userStoppedRef.current,
          lastUserStopAt: lastUserStopAtRef.current,
          lastAskUserDismissAt:
            getDefaultStore()
              .get(askUserDismissedAtAtom)
              .get(sessionIdRef.current) ?? 0,
          now: Date.now(),
          errorText: raw,
        });
        if (verdict === "complete") {
          // AskUser 关窗后迟到的 interrupt：非用户停止，按完成收口（recordCompletion('complete')）
          completeRun();
        } else if (verdict === "stopped") {
          // 用户停止 / 迟到 abort 文案：保持「已中断」，勿抬错误条
          if (runStartedAtRef.current != null) recordCompletion("stopped");
          stopRun();
        } else {
          const userError = classifyUserFacingError(raw);
          setSessionError({
            sessionId: sessionIdRef.current,
            error: {
              title: userError.title,
              message: userError.message || raw,
              retryable: userError.retryable,
              code: userError.code,
              action: userError.action,
              at: Date.now(),
            },
          });
          recordCompletion("error");
          stopRun();
        }
      } else {
        const hasOpenWork = sessionHasOpenWork();
        const hasFinalOutput = finalOutputSeenRef.current;
        if (subtype === "paused_no_progress" || hasOpenWork) {
          // result 先到、后台任务/工具回调尚未归还时，保留 startedAt 让后续事件可以续跑；
          // 以前这里只软停，消息区没有任何状态，用户会看到“完成”的空壳。
          if (!hasFinalOutput) {
            setFinalOutputState("waiting");
            pushTicker(
              makeStatusTickerItem(
                "当前阶段已结束，正在等待后台回调，暂未收到最终答复",
                "info",
                20000,
              ),
            );
          }
          softStopSessionRun(sessionId);
        } else {
          if (!hasFinalOutput) {
            // 没有在途工作却没有正文：正常收口，但必须把异常的空结果告诉用户。
            setFinalOutputState("missing");
            pushTicker(
              makeStatusTickerItem(
                "任务已结束，但模型没有返回最终答复",
                "warn",
                16000,
              ),
            );
          }
          completeRun();
        }
      }
      bumpRefresh();
    } else if (p.kind === "stream_text_delta") {
      // 子代理流式正文不进主会话（详情页靠落盘 parentToolUseId 消息回放）
      if (p.parentToolUseId) return;
      // E：replace = resync（前缀不匹配，main 发全量），整体替换；否则 append(suffix)
      setStreamState((prev) =>
        p.replace
          ? applyTextReplace(prev, p.text)
          : applyTextDelta(prev, p.text),
      );
    } else if (p.kind === "stream_thinking_delta") {
      // 子代理思考流不进主会话
      if (p.parentToolUseId) return;
      // E：replace = resync，立即整体替换（不走 rAF append 合帧，并清掉未 flush 的 append 缓冲）
      if (p.replace) {
        if (thinkingFlushRafRef.current != null) {
          cancelAnimationFrame(thinkingFlushRafRef.current);
          thinkingFlushRafRef.current = null;
        }
        pendingThinkingRef.current = "";
        pendingThinkingUuidRef.current = undefined;
        setStreamState((prev) => applyThinkingReplaceToState(prev, p.text));
        return;
      }
      // Pi message_start 的空 delta：无需改 state
      if (p.text === "") return;
      // 非空 delta 按帧合并（Pi 每 token 一事件），避免高频 setState
      pendingThinkingRef.current += p.text;
      if (p.uuid) pendingThinkingUuidRef.current = p.uuid;
      if (thinkingFlushRafRef.current == null) {
        thinkingFlushRafRef.current = requestAnimationFrame(flushThinkingDelta);
      }
    } else if (p.kind === "tagent_event") {
      const evt = p.event as {
        type: string;
        message?: string;
        taskId?: string;
        toolUseId?: string;
        description?: string;
        status?: string;
        summary?: string;
        lastToolName?: string;
        parentToolUseId?: string;
      };
      if (evt.type === "session_meta_changed") {
        window.dispatchEvent(
          new CustomEvent("tagent:session-meta-changed", {
            detail: { sessionId },
          }),
        );
        return;
      }
      // No-Progress Guard 阶段事件（§20.4 / §11）：非错误，不抬 SessionErrorBanner。
      // shadow 事件仅诊断，UI 忽略；enforce 下 paused → 清 running（result 的 paused_no_progress 也会 completeRun，幂等）。
      if (evt.type === "no_progress") {
        const npEvt = p.event as {
          phase?: "warning" | "reflection" | "paused" | "cleared";
          shadow?: boolean;
          summary?: string;
        };
        if (npEvt.shadow) {
          // 影子模式：只发诊断，不改 UI
        } else if (npEvt.phase === "paused") {
          clearPendingStop();
          // 软停：等 AskUser 澄清时计时不能清零，用户提交后 adopt 续原 startedAt
          softStopSessionRun(sessionId);
          pushTicker(
            makeStatusTickerItem(
              npEvt.summary?.trim() || "已暂停：连续多次操作未获得新进展",
              "warn",
              12000,
            ),
          );
        } else if (npEvt.phase === "warning" || npEvt.phase === "reflection") {
          pushTicker(
            makeStatusTickerItem(
              npEvt.summary?.trim() ||
                (npEvt.phase === "reflection"
                  ? "连续无进展，已要求策略复盘"
                  : "检测到重复失败，正在重新评估策略"),
              "warn",
              8000,
            ),
          );
        }
        // 'cleared'：暂无 UI
      }
      if (evt.type === "moa_roundtable") {
        // MoA 圆桌卡：按 roundtableId 就地 upsert（同轮多张状态卡只保留最新）。
        const panel = (p.event as { panel?: MoARoundtablePanel }).panel;
        if (panel) {
          const key = `moa-${panel.roundtableId}`;
          setItems((prev) => {
            const idx = prev.findIndex(
              (it) => it.moaRoundtable?.roundtableId === panel.roundtableId,
            );
            if (idx >= 0) {
              return prev.map((it, i) =>
                i === idx ? { ...it, moaRoundtable: panel } : it,
              );
            }
            return [...prev, { key, moaRoundtable: panel }];
          });
          // 非终态（参考/汇总中）→ 标 running，保过程区展开 + 停止键在位；
          // 终态（done/error/cancelled）由后续 result/turn_end 收尾，不在此抢停。
          const isRunning =
            panel.phase === "references" || panel.phase === "aggregating";
          if (isRunning && !runningRef.current) {
            adoptSessionRun({
              id: sessionId,
              startedAt:
                runStartedAtPersistRef.current ??
                runStartedAtRef.current ??
                Date.now(),
            });
          }
          bumpRefresh();
        }
      } else if (evt.type === "moa_discussion") {
        // 圆桌讨论入口卡：按 discussionId 就地 upsert（同场多张状态卡只保留最新）。
        // 用户中途把讨论室打开后也能看到 entries 增量；本任务（T3a）只读版不做插话。
        // T8 重放与实时事件共用 upsertMoADiscussionItem（按 discussionId 去重 + 终态卡落点对齐共识 assistant）。
        const panel = (p.event as { panel?: MoADiscussionPanel }).panel;
        if (panel) {
          setItems((prev) => upsertMoADiscussionItem(prev, panel));
          // 非终态（discussing / finalizing）→ 标 running；终态由后续 result 收尾
          const isRunning =
            panel.phase === "discussing" || panel.phase === "finalizing";
          if (isRunning && !runningRef.current) {
            adoptSessionRun({
              id: sessionId,
              startedAt:
                runStartedAtPersistRef.current ??
                runStartedAtRef.current ??
                Date.now(),
            });
          }
          bumpRefresh();
        }
      } else if (evt.type === "tool_start" && !evt.parentToolUseId) {
        // 段间 progress 常只活在 streamState.text；工具一开就清 → 阶段性总结打字机秒消。
        // 先 commit 进末条主线 assistant（插到 tool_use 前），再清缓冲；思考仍保留。
        const pendingText = streamStateRef.current.text.trim();
        if (pendingText) {
          setItems((prev) =>
            commitStreamTextToLastAssistant(prev, pendingText),
          );
        }
        setStreamState((prev) => (prev.text ? { ...prev, text: "" } : prev));
      } else if (evt.type === "turn_end") {
        // 回合边界：若 stream 仍有思考且末条 assistant 无 thinking 块，先写入 items 再清。
        // 提交前先 flush rAF 合帧缓冲：turn_end 与 thinking delta 同帧到达时，pending batch 尚未
        // 写入 streamState，直接读 ref 会漏，resetStreamState 又清掉 pending → 末段思考丢失（REGRESS-F RC1）
        if (thinkingFlushRafRef.current != null) {
          cancelAnimationFrame(thinkingFlushRafRef.current);
          thinkingFlushRafRef.current = null;
        }
        const pendingDelta = pendingThinkingRef.current;
        pendingThinkingRef.current = "";
        pendingThinkingUuidRef.current = undefined;
        const pendingThink = (
          streamStateRef.current.thinking + pendingDelta
        ).trim();
        // REGRESS-G（正文对称思考）：GLM 独立块无终态快照校准，正文只活在 streamState.text；
        // 边界不提交则 resetStreamState 丢弃 → 回合结束后只剩空壳。把正文写入末条主线 assistant。
        // 累计快照（Claude/Pi）final 已清 streamState.text → trim()='' no-op。STOP / Chat 拦截只推
        // turn_end（无 result），故此处是它们唯一兜底提交点。
        const pendingText = streamStateRef.current.text.trim();
        // 与 result 分支一致：commit + 清 streaming 一次原子更新
        setItems((prev) => {
          let next = prev;
          if (pendingThink)
            next = commitStreamThinkingToLastAssistant(next, pendingThink);
          if (pendingText)
            next = commitStreamTextToLastAssistant(next, pendingText);
          const cleaned = next.map((it) =>
            it.streaming
              ? {
                  ...it,
                  streaming: false,
                  streamingText: undefined,
                  streamingThinking: undefined,
                }
              : it,
          );
          return purgeStreamingItems(cleaned);
        });
        resetStreamState();
        // 工具循环中 turn_end 只是单轮结束。有未完成 tool_use 时不停表；
        // 无在途工作才延迟软停（宽限期内有下一轮 delta → 保持 running）。
        scheduleRunStop();
        // 工具循环中的 turn_end：不切 resize=instant（留给真正 result 收尾的平滑折进）
        // followMode：不再清 liveMentionLabels——铭牌代表当前 activeSpeaker，续聊仍由该角色接。
        // 用户在输入框 ✕ 清除 activeMentionRoleIds 时会一并清 liveMentionLabels。
        bumpRefresh();
      } else if (evt.type === "memory_organizing") {
        // Phase 4/5：kscc 软重置 / 影子压缩 — 显示「正在整理记忆」
        setIsCompactingUi(true);
        setItems((prev) => {
          if (prev.some((it) => it.compactStatus === "compacting")) return prev;
          return [
            ...prev,
            {
              key: `mem-org-${itemIdxRef.current++}`,
              compactStatus: "compacting" as const,
            },
          ];
        });
        if (evt.status === "ready" || evt.status === "idle") {
          setIsCompactingUi(false);
          setItems((prev) => {
            const filtered = prev.filter(
              (it) => it.compactStatus !== "compacting",
            );
            return [
              ...filtered,
              {
                key: `mem-org-done-${itemIdxRef.current++}`,
                compactStatus: "complete" as const,
                compactTrigger: "auto" as const,
              },
            ];
          });
        }
      } else if (evt.type === "session_error") {
        // 主进程已按分类表转译（classifyUserFacingError）：友好标题 + 原文 + 可重试标记
        // 独立错误条（非 assistant 气泡）：copy / dismiss / retryable→重试
        const userError = (evt as { error?: UserFacingError }).error;
        const rawMessage = typeof evt.message === "string" ? evt.message : "";
        // 终态分类（同 result 分支）：AskUser 关窗后迟到的 interrupt 不当用户停止
        const verdict = classifyRunAbort({
          userStopped: userStoppedRef.current,
          lastUserStopAt: lastUserStopAtRef.current,
          lastAskUserDismissAt:
            getDefaultStore()
              .get(askUserDismissedAtAtom)
              .get(sessionIdRef.current) ?? 0,
          now: Date.now(),
          errorText: `${userError?.message ?? ""} ${rawMessage}`,
        });
        if (verdict === "complete") {
          // AskUser 关窗后迟到的 interrupt：非用户停止，按完成收口，不抬错误条
          clearPendingStop();
          completeRun();
        } else if (verdict === "stopped") {
          // 用户打断 / 迟到的上轮错误：只收口运行态，不展示错误条、不把侧栏打成 error
          if (runStartedAtRef.current != null) recordCompletion("stopped");
          clearPendingStop();
          stopRun();
        } else {
          setSessionError({
            sessionId: sessionIdRef.current,
            error: {
              title: userError?.title ?? "错误",
              message: userError?.message || rawMessage,
              retryable: userError?.retryable ?? false,
              code: userError?.code,
              action: userError?.action,
              at: Date.now(),
            },
          });
          clearPendingStop();
          recordCompletion("error");
          stopRun();
        }
      } else if (evt.type === "compacting") {
        setIsCompactingUi(true);
        setItems((prev) => [
          ...prev,
          {
            key: `c${itemIdxRef.current++}`,
            compactStatus: "compacting" as const,
          },
        ]);
      } else if (evt.type === "compact_complete") {
        setIsCompactingUi(false);
        const trigger = (evt as { trigger?: "auto" | "manual" }).trigger;
        const tokensBefore = (evt as { tokensBefore?: number }).tokensBefore;
        // 压缩后用 tokensBefore 刷新环（估算）；无则保留旧 usage
        if (typeof tokensBefore === "number" && tokensBefore > 0) {
          setContextUsage((prev) =>
            prev
              ? {
                  ...prev,
                  inputTokens:
                    Math.min(prev.inputTokens, tokensBefore) || tokensBefore,
                }
              : {
                  inputTokens: tokensBefore,
                  contextWindow: contextWindowRef.current,
                },
          );
        }
        setItems((prev) => {
          // 去掉进行中的占位，换成完成分隔
          const filtered = prev.filter(
            (it) => it.compactStatus !== "compacting",
          );
          return [
            ...filtered,
            {
              key: `c${itemIdxRef.current++}`,
              compactStatus: "complete" as const,
              compactTrigger: trigger,
            },
          ];
        });
      } else if (evt.type === "task_started") {
        // 子代理启动：upsert 任务卡片（running），不再塞 assistant 文本气泡
        // taskType 必须传入：reduceTaskEvent 白名单只放行 local_agent 等，挡 local_bash
        const event: TaskCardEvent = {
          type: "task_started",
          taskId: evt.taskId ?? "",
          toolUseId: evt.toolUseId,
          description: evt.description ?? "",
          taskType: (evt as { taskType?: string }).taskType,
        };
        setItems((prev) => reduceTaskEvent(prev, event, taskCardApply));
      } else if (evt.type === "task_progress") {
        // 子代理进度：更新同一张任务卡片的 lastToolName / progressText，不新增气泡
        const event: TaskCardEvent = {
          type: "task_progress",
          taskId: evt.taskId,
          toolUseId: evt.toolUseId,
          description: evt.description,
          lastToolName: evt.lastToolName,
          taskType: (evt as { taskType?: string }).taskType,
        };
        setItems((prev) => reduceTaskEvent(prev, event, taskCardApply));
      } else if (evt.type === "task_notification") {
        // 子代理收口：置 status + summary，清空进度文案
        const status: TaskCardState["status"] =
          evt.status === "completed" ||
          evt.status === "failed" ||
          evt.status === "stopped"
            ? evt.status
            : "stopped";
        const event: TaskCardEvent = {
          type: "task_notification",
          taskId: evt.taskId ?? "",
          toolUseId: evt.toolUseId,
          status,
          summary: evt.summary ?? "",
          taskType: (evt as { taskType?: string }).taskType,
        };
        setItems((prev) => reduceTaskEvent(prev, event, taskCardApply));
        // 失败/停止：若主会话已无 running 心跳，兜底 hard stop，避免底栏「运行中」常驻
        if (
          (status === "failed" || status === "stopped") &&
          !runningRef.current
        ) {
          stopRun();
        }
      }
    }
  };

  const compactContext = async (): Promise<void> => {
    try {
      const res = await window.electronAPI.compactSession(sessionIdRef.current);
      if (!res.ok) {
        alert(res.reason ?? "压缩失败");
        return;
      }
      if (!res.compacted) {
        alert(res.reason ?? "当前无需压缩");
      }
      // 成功时 compact_complete 事件由主进程流推入 items
    } catch (err) {
      alert(err instanceof Error ? err.message : "压缩失败");
    }
  };

  /** 核心发送逻辑：校验渠道 → 保存附件 → IPC sendMessage → materializeTab */
  const sendQueued = async ({
    text,
    selection,
    attachments,
    moaOneShotPresetId,
    moaDiscussionPresetId,
  }: {
    text: string;
    selection: ModelSelection;
    attachments?: Array<{
      id: string;
      filename: string;
      mediaType: string;
      size: number;
      previewUrl?: string;
      data: string;
    }>;
    /** MoA 会诊本条（one-shot）：本轮临时走会诊但不写 sticky moa modelId。SPEC §3 */
    moaOneShotPresetId?: string;
    /**
     * 圆桌讨论本条（one-shot）：本轮临时走 runMoADiscussion（多轮讨论+总结人收口）但不写
     * sticky moa modelId；拼进 sendMessage payload 由主进程 runMoADiscussionTurn 消费。SPEC §3
     */
    moaDiscussionPresetId?: string;
  }): Promise<void> => {
    if (!selection) {
      alert("没有可用模型，请先在「设置 → 渠道」中启用渠道和模型");
      return;
    }

    // 新发送/重试开始时收起错误条（若再失败会重新推 session_error）
    setSessionError({ sessionId: sessionIdRef.current, error: null });
    resetStreamState();
    const channel = channels.find((item) => item.id === selection.channelId);
    // MoA 会诊/圆桌讨论（sticky 或 one-shot）：modelId 可能是虚拟 moa:<preset> 或 one-shot presetId。
    // 都不在渠道模型表里——跳过模型启用校验，由主进程 runMoATurn / runMoADiscussion 校验预置 + 参考/汇总模型可用性。
    const isMoa = isMoaModelId(selection.modelId);
    // one-shot：会诊 ▾ 或 圆桌讨论 ▾ 选了预置（modelId 仍是真实模型，本轮临时走会诊/讨论但不写 sticky）
    const isOneShot = Boolean(moaOneShotPresetId || moaDiscussionPresetId);
    const skipModelCheck = isMoa || isOneShot;
    const model = skipModelCheck
      ? undefined
      : channel?.models.find((item) => item.id === selection.modelId);
    if (!channel?.enabled || (!skipModelCheck && !model?.enabled)) {
      alert("当前渠道或模型已停用，请选择同一运行区域内的可用模型");
      return;
    }
    const isExistingTab = tabs.some(
      (tab) => tab.sessionId === sessionIdRef.current,
    );
    if (!isExistingTab && canMaterializeTab && !canMaterializeTab()) {
      return;
    }
    pendingSendRecallRef.current = {
      text,
      attachments: attachments?.map((att) => ({ ...att })) ?? [],
    };
    // 保存附件到磁盘
    let savedAttachments: Array<{
      id: string;
      filename: string;
      mediaType: string;
      localPath: string;
      size: number;
    }> = [];
    if (attachments?.length) {
      for (const att of attachments) {
        try {
          const saved = await (window.electronAPI as any).saveAttachment({
            sessionId: sessionIdRef.current,
            filename: att.filename,
            mediaType: att.mediaType,
            data: att.data,
          });
          savedAttachments.push(saved);
        } catch (err) {
          console.error("[Chat] 保存附件失败:", att.filename, err);
        }
      }
      // 清空待发附件 + revoke blob URLs
      for (const att of attachments) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
      setPendingAttachments([]);
    }
    // 发送前收回挂载窗口：长会话若已拉满历史，避免本轮流式拖着全树重渲
    setAllowFullMount(false);
    setVisibleCount(CHAT_MOUNT_WINDOW);
    // 发送时只记录“本轮要跟随到底部”的意图，不要立刻钉底。
    // 此时新用户消息还没有进入 items，DOM 的底部仍然是上一轮；
    // 立即 scrollToBottom 会把上一轮错误地当成本轮位置。等新消息/流式壳
    // 挂载后，由 ScrollPositionManager 的 ResizeObserver 统一钉到真正的新尾部。
    markSessionAtBottom(sessionIdRef.current);
    startRun();
    try {
      const res = await window.electronAPI.sendMessage({
        sessionId: sessionIdRef.current,
        prompt: text,
        channelId: selection.channelId,
        model: selection.modelId,
        workspaceId: session.workspaceId,
        ...(savedAttachments.length ? { attachments: savedAttachments } : {}),
        ...(moaOneShotPresetId ? { moaOneShotPresetId } : {}),
        ...(moaDiscussionPresetId ? { moaDiscussionPresetId } : {}),
        mentionRoleIds:
          executionMode === "chat" && roleMentionOptions.length > 0
            ? parseMentions(text, roleMentionOptions).map((h) => h.roleId)
            : undefined,
        executionMode,
      } as any);
      if (res && !res.ok) {
        alert(`发送失败：${res.error ?? "未知错误"}`);
        stopRun();
      } else {
        const coreKind = getChannelCoreKind(channel);
        setSelectionOverride(selection);
        setSentCoreKind(coreKind);
        const sid = sessionIdRef.current;
        // 与主进程 createSession 对齐：首条 prompt 前 20 字作为标题（草稿仍是「新会话」）
        const tabTitle =
          text.slice(0, 20) ||
          attachments?.[0]?.filename.slice(0, 20) ||
          session.title ||
          "新会话";
        const exists = tabs.some((t) => t.sessionId === sid);
        if (!exists) {
          const result = openTabWithLimit(
            tabs,
            sid,
            tabTitle,
            (id) => sessionRunMap[id]?.running === true,
            session.workspaceId,
            selection.channelId,
            selection.modelId,
          );
          // 正常路径已在发送前预检；保留防御分支，避免极端并发下挤掉正在运行的会话。
          if (result.blocked) return;
          setTabs(result.tabs);
          setActiveTabId(result.activeTabId);
          if (result.evictedTab) onTabEvicted?.(result.evictedTab);
          // 草稿转正：通知 App 清 draftSession，否则切到其他 tab 时
          // 草稿 overlay 条件（draftSession.id !== activeTab.sessionId）会复活，覆盖带 TabBar 的会话页
          onMaterialized?.();
        } else {
          setTabs((prev) =>
            prev.map((tab) =>
              tab.sessionId === sid
                ? {
                    ...tab,
                    title: tab.title === "新会话" ? tabTitle : tab.title,
                    channelId: selection.channelId,
                    modelId: selection.modelId,
                  }
                : tab,
            ),
          );
        }
      }
      bumpRefresh();
    } catch (err) {
      console.error("[Chat] sendMessage 异常:", err);
      alert(`发送异常：${err instanceof Error ? err.message : String(err)}`);
      stopRun();
    }
  };

  /**
   * 取最后一条真实用户输入文案（错误条重试用）。
   * 跳过 tool_result / 子代理合成 user；无则 null。
   */
  const getLastRealUserPrompt = useCallback((): string | null => {
    for (let i = items.length - 1; i >= 0; i--) {
      const msg = items[i]?.message;
      if (!msg || msg.type !== "user") continue;
      if (!isRealUserInput(msg)) continue;
      const text = firstText(msg)?.trim();
      if (text) return text;
    }
    return null;
  }, [items]);

  /** 错误条「重试」：重发上一条真实用户输入（走现有 send 路径，无附件） */
  const retryLastUserPrompt = useCallback(async (): Promise<void> => {
    const text = getLastRealUserPrompt();
    if (!text) return;
    if (!effectiveSelection) {
      alert("没有可用模型，请先在「设置 → 渠道」中启用渠道和模型");
      return;
    }
    if (running) return;
    await sendQueued({ text, selection: effectiveSelection });
  }, [getLastRealUserPrompt, effectiveSelection, running]);

  /** 运行中引导：不中断；气泡夹进当前执行块；主进程落盘 isSteer 并注入模型。 */
  const submitSteer = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return;
      try {
        const res = (await window.electronAPI.steerAgent(
          sessionIdRef.current,
          trimmed,
        )) as { ok?: boolean; mode?: string; error?: string } | undefined;
        if (!res?.ok) {
          pushTicker(
            makeStatusTickerItem(
              `引导失败：${res?.error ?? "未知错误"}`,
              "error",
              5000,
            ),
          );
          return;
        }
        if (res.mode === "pending_next_turn") {
          pushTicker(
            makeStatusTickerItem(
              "已记下引导：这场运行停稳后才会交给模型",
              "info",
              3500,
            ),
          );
        }
      } catch (err) {
        pushTicker(
          makeStatusTickerItem(
            `引导失败：${err instanceof Error ? err.message : String(err)}`,
            "error",
            5000,
          ),
        );
      }
    },
    [pushTicker],
  );

  /** 用户发送：空闲→立即发；运行中→入队，由用户在队列里选「按序排队」或「引导」 */
  const send = async (): Promise<void> => {
    const text = chatInputRef.current?.getText().trim() ?? "";
    if (!text && pendingAttachments.length === 0) return;
    // Chat @：本轮有 @ → 切换 activeSpeaker；无 @ → 保持上一个（follow）。铭牌按 effective 角色展示。
    if (executionMode === "chat" && roleMentionOptions.length > 0) {
      const hits = parseMentions(text, roleMentionOptions);
      if (hits.length > 0) {
        setActiveMentionRoleIds(hits.map((h) => h.roleId));
        setLiveMentionLabels(hits.map((h) => h.displayName));
      } else {
        // follow：本轮未 @，沿用当前 activeSpeaker 的铭牌（无则空 → 默认总助）
        setLiveMentionLabels(
          activeMentionRoleIds
            .map((id) => roleNameById.get(id))
            .filter((v): v is string => Boolean(v)),
        );
      }
    } else {
      setLiveMentionLabels([]);
    }
    const inFlight = running || runStartedAtRef.current != null;
    if (inFlight) {
      chatInputRef.current?.clear();
      if (effectiveSelection) {
        setMessageQueue((q) => [
          ...q,
          {
            text,
            selection: effectiveSelection,
            ...(pendingAttachments.length
              ? { attachments: pendingAttachments }
              : {}),
          },
        ]);
      }
      setPendingAttachments([]);
      return;
    }
    chatInputRef.current?.clear();
    // 空闲 → 立即发
    if (!effectiveSelection) {
      alert("没有可用模型，请先在「设置 → 渠道」中启用渠道和模型");
      return;
    }
    await sendQueued({
      text,
      selection: effectiveSelection,
      attachments: pendingAttachments,
    });
  };

  /**
   * 会诊本条（one-shot）：取当前输入框文案 + 选中的预置 → 走 sendQueued 带
   * `moaOneShotPresetId`。**不**改 meta.modelId，会话 tab / ModelSelector 仍显示真实模型。
   * 输入空 / 无可用预置 / 无渠道：放弃（按钮已禁用，本函数兜底）。
   */
  const sendConsult = async (presetId: string): Promise<void> => {
    const text = chatInputRef.current?.getText().trim() ?? "";
    if (!text && pendingAttachments.length === 0) return;
    if (!effectiveSelection) {
      alert("没有可用模型，请先在「设置 → 渠道」中启用渠道和模型");
      return;
    }
    // 复用 send() 的 @ mention / 草稿铭牌同步（避免会诊路径出现 follow 漂移）
    if (executionMode === "chat" && roleMentionOptions.length > 0) {
      const hits = parseMentions(text, roleMentionOptions);
      if (hits.length > 0) {
        setActiveMentionRoleIds(hits.map((h) => h.roleId));
        setLiveMentionLabels(hits.map((h) => h.displayName));
      } else {
        setLiveMentionLabels(
          activeMentionRoleIds
            .map((id) => roleNameById.get(id))
            .filter((v): v is string => Boolean(v)),
        );
      }
    } else {
      setLiveMentionLabels([]);
    }
    chatInputRef.current?.clear();
    if (running) {
      // 运行中：入队等本轮结束自动消费；带 presetId 让队列项保留会诊语义
      setMessageQueue((q) => [
        ...q,
        {
          text,
          selection: effectiveSelection,
          moaOneShotPresetId: presetId,
          ...(pendingAttachments.length
            ? { attachments: pendingAttachments }
            : {}),
        },
      ]);
      setPendingAttachments([]);
      return;
    }
    await sendQueued({
      text,
      selection: effectiveSelection,
      attachments: pendingAttachments,
      moaOneShotPresetId: presetId,
    });
  };

  /**
   * 圆桌讨论本条（one-shot）：取当前输入框文案 + 选中的预置 → 走 sendQueued 带
   * `moaDiscussionPresetId`。不改 meta.modelId，会话 tab / ModelSelector 仍显示真实模型
   * （主进程 runMoADiscussionTurn → runMoADiscussion 多轮讨论+总结人收口）。
   * 输入空 / 无可用预置 / 无渠道：放弃（按钮已禁用，本函数兜底）。
   */
  const sendDiscussion = async (presetId: string): Promise<void> => {
    const text = chatInputRef.current?.getText().trim() ?? "";
    if (!text && pendingAttachments.length === 0) return;
    if (!effectiveSelection) {
      alert("没有可用模型，请先在「设置 → 渠道」中启用渠道和模型");
      return;
    }
    // 复用 send() 的 @ mention / 草稿铭牌同步（与 sendConsult 一致）
    if (executionMode === "chat" && roleMentionOptions.length > 0) {
      const hits = parseMentions(text, roleMentionOptions);
      if (hits.length > 0) {
        setActiveMentionRoleIds(hits.map((h) => h.roleId));
        setLiveMentionLabels(hits.map((h) => h.displayName));
      } else {
        setLiveMentionLabels(
          activeMentionRoleIds
            .map((id) => roleNameById.get(id))
            .filter((v): v is string => Boolean(v)),
        );
      }
    } else {
      setLiveMentionLabels([]);
    }
    chatInputRef.current?.clear();
    if (running) {
      // 运行中：入队等本轮结束自动消费；带 presetId 让队列项保留圆桌讨论语义
      setMessageQueue((q) => [
        ...q,
        {
          text,
          selection: effectiveSelection,
          moaDiscussionPresetId: presetId,
          ...(pendingAttachments.length
            ? { attachments: pendingAttachments }
            : {}),
        },
      ]);
      setPendingAttachments([]);
      return;
    }
    await sendQueued({
      text,
      selection: effectiveSelection,
      attachments: pendingAttachments,
      moaDiscussionPresetId: presetId,
    });
  };

  /** 运行结束 → 批量消费队列（逐条 await，确保 running 状态正确） */
  useEffect(() => {
    if (running) return;
    if (deferQueueAutoConsumeRef.current) {
      deferQueueAutoConsumeRef.current = false;
      return;
    }
    if (messageQueue.length === 0) return;
    const pending = messageQueue;
    setMessageQueue([]);
    void (async () => {
      for (const item of pending) {
        await sendQueued(item);
      }
    })();
  }, [running, messageQueue]);

  /** 队列操作 */
  const removeQueueItem = (index: number): void => {
    setMessageQueue((q) => q.filter((_, i) => i !== index));
  };
  const clearQueue = (): void => {
    setMessageQueue([]);
    rootRef.current?.style.setProperty("--session-stack-over-cluster", "0px");
    scheduleComposerTopUpdate();
  };

  /** 引导指定条目：不打断；成功后从 UI 队列移除 */
  const steerQueueItem = (index: number): void => {
    if (queueActionBusy) return;
    if (!running && runStartedAtRef.current == null) return;
    const item = messageQueue[index];
    if (!item) return;
    setQueueActionBusy(true);
    void (async () => {
      try {
        await submitSteer(item.text);
        setMessageQueue((q) => q.filter((_, i) => i !== index));
        scheduleComposerTopUpdate();
      } finally {
        setQueueActionBusy(false);
      }
    })();
  };

  /** 编辑：取出填回输入框，方便改完再发 */
  const editQueueItem = (index: number): void => {
    if (queueActionBusy) return;
    const item = messageQueue[index];
    if (!item) return;
    setMessageQueue((q) => q.filter((_, i) => i !== index));
    scheduleComposerTopUpdate();
    chatInputRef.current?.setText(item.text);
    // 还原附件到输入框（previewUrl 仍有效；未落盘，发送时 sendQueued 再 saveAttachment）
    if (item.attachments?.length) setPendingAttachments(item.attachments);
    chatInputRef.current?.focus();
  };

  /** 新会话页：切换工作区（草稿态无 tab → 改 App 的 draftSession；已有 tab → 改 tab） */
  const changeWorkspace = (id: string): void => {
    onDraftWorkspaceChange?.(id);
    setTabs((prev) =>
      prev.map((tab) =>
        tab.sessionId === sessionId ? { ...tab, workspaceId: id } : tab,
      ),
    );
  };

  /** 新会话页：打开其他项目（原生目录选择 → 注册工作区 → 切到新工作区） */
  const handleOpenProjectInLanding = async (): Promise<void> => {
    const workspace = await window.electronAPI.createProjectWorkspace();
    if (!workspace) return;
    await loadWorkspaces();
    changeWorkspace(workspace.id);
  };

  /** 提示词点击：填入输入框并聚焦（不自动发送） */
  const pickSuggestion = (text: string): void => {
    chatInputRef.current?.setText(text);
    chatInputRef.current?.focus();
  };

  /** 打开文件选择器 → 添加待发附件 */
  const handleOpenFileDialog = useCallback(async () => {
    const result = await (window.electronAPI as any).openFileDialog();
    if (!result?.files?.length) return;
    const newAttachments = result.files.map((f: any) => {
      const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const isImage = f.mediaType?.startsWith("image/");
      return {
        id,
        filename: f.filename,
        mediaType: f.mediaType,
        size: f.size,
        previewUrl:
          isImage && f.data
            ? `data:${f.mediaType};base64,${f.data}`
            : undefined,
        data: f.data,
      };
    });
    setPendingAttachments((prev) => [...prev, ...newAttachments]);
  }, []);

  /** 新会话页底部工具栏：模式切换（左）+ 模型（中）+ 发送/停止钮（右）。
   *  工作区选择已移到输入框下方的独立容器（见 workspaceSlot），不再挤在 footer。 */
  const landingFooter = (
    <div className="flex items-center justify-end gap-1.5 px-2 pb-2 pt-1">
      {/* 运行模式（草稿会话仅改本地状态，首条发送时主进程创建 meta 会带上） */}
      <RunModeSelector
        executionMode={executionMode}
        onExecutionModeChange={(m) => {
          setExecutionMode(m);
          setPendingModeSuggestion(null);
          // 非草稿会话才同步主进程 meta（草稿会话尚未有 meta，IPC 会失败；首条发送时创建 meta 会带上本地 mode）
          if (!onDraftWorkspaceChange) {
            void (async () => {
              const res = await window.electronAPI.setSessionExecutionMode(
                sessionId,
                m,
                "user",
              );
              if (!res.ok) {
                console.warn(
                  "[Chat] setSessionExecutionMode failed:",
                  res.error,
                );
              } else {
                void window.electronAPI.dismissExecutionModeSuggestion?.(
                  sessionId,
                );
                await applyBackgroundCrewFromModeSwitch(m, res);
              }
            })();
          }
        }}
        permissionMode={permissionMode}
        onPermissionModeChange={(m) => {
          setPermissionMode(m);
          if (!onDraftWorkspaceChange) {
            void window.electronAPI.setSessionPermissionMode(sessionId, m);
          }
        }}
        subagentEagerness={subagentEagerness}
        onSubagentEagernessChange={(level) => {
          setSubagentEagerness(level);
          if (!onDraftWorkspaceChange) {
            void window.electronAPI.updateSessionMeta(sessionId, {
              subagentEagerness: level,
            });
          }
        }}
      />
      {!onDraftWorkspaceChange && (
        <KnowledgeBaseSelector sessionId={sessionId} />
      )}
      <ModelSelector
        selection={effectiveSelection}
        lockedKind={null}
        onSelect={(nextSelection) => {
          setSelectionOverride(nextSelection);
          setSelectedModelSelection(nextSelection);
        }}
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={(effort) => {
          setReasoningEffort(effort);
          if (!onDraftWorkspaceChange) {
            void window.electronAPI.updateSessionMeta(sessionId, {
              reasoningEffort: effort,
            });
          }
        }}
      />
      {running ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-glass-popover text-destructive hover:bg-destructive/10"
          onClick={() => {
            void handleUserStop();
          }}
          aria-label="停止"
        >
          <Square className="size-4" fill="currentColor" />
        </Button>
      ) : (
        <SendSplitButton
          presets={consultPresetsForMenu}
          channel={selectionChannel}
          hasDraft={hasSendable}
          onSend={() => void send()}
          onConsultPreset={(id) => void sendConsult(id)}
          onDiscussionPreset={(id) => void sendDiscussion(id)}
        />
      )}
    </div>
  );

  /** 新会话页：输入框下方的工作区选择容器（独立卡片）。WorkspaceSelector 自带文件夹图标，左侧只放纯文字标签。 */
  const workspaceSlot = (
    <div className="flex items-center justify-between rounded-xl border border-border/55 bg-muted/20 pl-3 pr-1.5 py-1.5">
      <span className="shrink-0 text-[11px] text-muted-foreground/70">
        工作区
      </span>
      <WorkspaceSelector
        value={session.workspaceId}
        onSelect={changeWorkspace}
        onOpenProject={() => void handleOpenProjectInLanding()}
      />
    </div>
  );

  // 消息内文件 chip 的注入上下文：打开/存在性检查走主进程 IPC。
  const setFilePreviewRequest = useSetAtom(filePreviewRequestAtom);
  const setRichPreviewRequest = useSetAtom(richPreviewRequestAtom);
  const setSplitDockMode = useSetAtom(splitDockModeAtom);
  const splitDockMode = useAtomValue(splitDockModeAtom);
  const workspaces = useAtomValue(workspacesAtom);
  /** 会话工作区的项目绝对目录：chip 解析相对路径的 base。草稿会话主进程反查不到 workspace，只能靠这里注入。 */
  const workspaceDirectory =
    workspaces.find((w) => w.id === session.workspaceId)?.projectDirectory ??
    null;
  // 只缓存命中：null 多半是「Agent 刚说要建、文件还没落盘」，缓存下来会把 chip 锁死成「文件不存在」
  const resolveHitCacheRef = useRef(
    new Map<string, { path: string; at: number }>(),
  );
  // 依赖只挂 workspaceDirectory（字符串）：context value 每变一次，下游所有 chip 都会重跑解析
  const filePathProviderValue = useMemo(() => {
    const HIT_TTL = 10_000;
    const hitCache = resolveHitCacheRef.current;
    return {
      basePaths: workspaceDirectory ? [workspaceDirectory] : undefined,
      // 点击文件 chip / Files Changed → 打开分屏 + 解析路径后开预览。
      // 须先 setSplitDockMode：非 dock 布局下 WorkspaceDock 不挂载，只写 atom 会像「点了没反应」。
      // options.review（句尾 Files Changed 卡片）→ 走「本轮 unified diff 审阅」；保留原始 path
      // 与 review.files 对齐（FilePreviewPane 内部自行 resolve）。chip 不传 review，仍走预览。
      onOpenFile: (
        path: string,
        options?: { basePaths?: string[]; review?: FileReviewContext },
      ): void => {
        const sid = sessionIdRef.current;
        const bases =
          options?.basePaths ??
          (workspaceDirectory ? [workspaceDirectory] : undefined);
        if (!splitDockMode) setSplitDockMode(true);
        if (options?.review) {
          setFilePreviewRequest({
            sessionId: sid,
            path,
            bases,
            review: options.review,
          });
          return;
        }
        void (async () => {
          const resolved = await window.electronAPI.resolveFile({
            sessionId: sid,
            path,
            bases,
          });
          setFilePreviewRequest({
            sessionId: sid,
            path: resolved ?? path,
            bases,
          });
        })();
      },
      onResolveFile: async (
        path: string,
        bases?: string[],
      ): Promise<string | null> => {
        const key = `${path}\0${(bases ?? []).join("\0")}`;
        const hit = hitCache.get(key);
        if (hit && Date.now() - hit.at < HIT_TTL) return hit.path;
        const resolved = await window.electronAPI.resolveFile({
          sessionId: sessionIdRef.current,
          path,
          bases,
        });
        if (resolved) hitCache.set(key, { path: resolved, at: Date.now() });
        else hitCache.delete(key);
        return resolved;
      },
      getSessionId: () => sessionIdRef.current,
    };
  }, [
    workspaceDirectory,
    setFilePreviewRequest,
    setSplitDockMode,
    splitDockMode,
  ]);

  /** 消息内文本/文件附件 chip → 分屏预览（附件在 ~/.tagent/attachments/，不走工作区读文件） */
  const openAttachmentPreview = useCallback(
    (attachment: FileAttachment): void => {
      if (!splitDockMode) setSplitDockMode(true);
      setFilePreviewRequest({
        sessionId: sessionIdRef.current,
        path: attachment.filename,
        title: attachment.filename,
        attachmentLocalPath: attachment.localPath,
        attachmentMediaType: attachment.mediaType,
      });
    },
    [setFilePreviewRequest, setSplitDockMode, splitDockMode],
  );

  /**
   * 刻度/面板跳转到窗口外消息：只把「目标→末尾」扩进挂载，
   * 不顺带把更早的历史 Markdown 全挂上。回到底部流式时仍会收回窗口。
   */
  const ensureMinimapMessageMounted = useCallback(
    async (messageId: string): Promise<void> => {
      const turnIdx = allTurns.findIndex((turn) => turn.key === messageId);
      if (turnIdx < 0) {
        setAllowFullMount(true);
        setVisibleCount(Number.POSITIVE_INFINITY);
        return;
      }
      // 多挂几轮上下文，避免目标贴在虚拟化切边上。
      const from = Math.max(0, turnIdx - 4);
      const needCount = turnCount - from;
      setAllowFullMount(true);
      setVisibleCount(
        needCount >= turnCount
          ? Number.POSITIVE_INFINITY
          : Math.max(needCount, CHAT_MOUNT_WINDOW),
      );
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    },
    [allTurns, turnCount],
  );

  const jumpToCollabAnchor = useCallback((anchorKey: string) => {
    setAllowFullMount(true);
    setVisibleCount(Number.POSITIVE_INFINITY);
    const tryScroll = (attempt = 0): void => {
      const ctx = scrollContextRef.current;
      const scroller = ctx?.scrollRef.current;
      const target = scroller?.querySelector<HTMLElement>(
        `[data-message-id="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(anchorKey) : anchorKey}"]`,
      );
      if (!scroller || !target) {
        if (attempt < 16) window.setTimeout(() => tryScroll(attempt + 1), 50);
        return;
      }
      ctx.stopScroll?.();
      const sticky = ctx.state;
      if (sticky) {
        sticky.animation = undefined;
        sticky.velocity = 0;
        sticky.accumulated = 0;
      }
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("session-collab-flash");
      window.setTimeout(
        () => target.classList.remove("session-collab-flash"),
        1600,
      );
    };
    requestAnimationFrame(() => tryScroll());
  }, []);

  const handleCollabSelect = useCallback(
    (item: SessionCollabItem) => {
      if (item.kind === "discussion" && item.discussionId) {
        setOpenDiscussionId(item.discussionId);
        return;
      }
      if (item.kind === "subagent" && item.parentToolUseId) {
        setSubagentDetail(item.parentToolUseId);
        return;
      }
      jumpToCollabAnchor(item.anchorKey);
    },
    [jumpToCollabAnchor],
  );

  const collabTimelineItems = useMemo(
    () => collectSessionCollabOutline(items).items,
    [items],
  );
  const publishSummaryHost = useSetAtom(setSessionSummaryHostAtom);
  const clearSummaryHost = useSetAtom(clearSessionSummaryHostAtom);
  useEffect(() => {
    publishSummaryHost({
      sessionId,
      timelineItems: collabTimelineItems,
      sessionBoardId,
      hasCrewBoards,
    });
    return () => {
      clearSummaryHost(sessionId);
    };
  }, [
    sessionId,
    collabTimelineItems,
    sessionBoardId,
    hasCrewBoards,
    publishSummaryHost,
    clearSummaryHost,
  ]);

  const summaryAction = useAtomValue(sessionSummaryActionAtom);
  const summaryActionMountAtRef = useRef(Date.now());
  useEffect(() => {
    if (!summaryAction || summaryAction.sessionId !== sessionId) return;
    if (summaryAction.requestId < summaryActionMountAtRef.current) return;
    handleCollabSelect(summaryAction.item);
  }, [handleCollabSelect, sessionId, summaryAction]);

  /** 输入框待发附件 chip → 分屏预览（尚未落盘，用内存 base64） */
  const openPendingAttachmentPreview = useCallback(
    (attachment: PendingAttachment): void => {
      if (!splitDockMode) setSplitDockMode(true);
      setFilePreviewRequest({
        sessionId: sessionIdRef.current,
        path: attachment.filename,
        title: attachment.filename,
        pendingAttachment: {
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          data: attachment.data,
        },
      });
    },
    [setFilePreviewRequest, setSplitDockMode, splitDockMode],
  );

  const sidecarContextText = useMemo(() => {
    return items
      .slice(-8)
      .map((item) => {
        const raw = item as unknown as {
          message?: { role?: string; content?: unknown };
          text?: string;
        };
        const content = raw.message?.content;
        const text = Array.isArray(content)
          ? content
              .map((block) =>
                typeof block === "string"
                  ? block
                  : block && typeof block === "object" && "text" in block
                    ? String((block as { text?: unknown }).text ?? "")
                    : "",
              )
              .filter(Boolean)
              .join("\n")
          : typeof content === "string"
            ? content
            : (raw.text ?? "");
        return text.trim();
      })
      .filter(Boolean)
      .join("\n\n");
  }, [items]);

  const landingComposer = (
    <ChatInput
      ref={chatInputRef}
      onSubmit={() => void send()}
      placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
      onDraftChange={setHasDraft}
      attachments={pendingAttachments}
      onAttachmentsChange={setPendingAttachments}
      onPreviewAttachment={openPendingAttachmentPreview}
      mentionRoles={executionMode === "chat" ? mentionOptions : undefined}
      topBar={activeMentionBar}
      footer={landingFooter}
      onMentionOpenChange={setMentionPickerOpen}
    />
  );

  const richPreviewProviderValue = useMemo(
    () => ({
      openRichInSplit: (payload: {
        kind: RichPreviewKind;
        code: string;
        title?: string;
      }): void => {
        if (!splitDockMode) setSplitDockMode(true);
        setRichPreviewRequest({
          sessionId: sessionIdRef.current,
          kind: payload.kind,
          code: payload.code,
          title: payload.title,
        });
      },
      openMermaidInSplit: (code: string, title?: string): void => {
        if (!splitDockMode) setSplitDockMode(true);
        setRichPreviewRequest({
          sessionId: sessionIdRef.current,
          kind: "mermaid",
          code,
          title: title ?? "Mermaid",
        });
      },
    }),
    [setRichPreviewRequest, setSplitDockMode, splitDockMode],
  );

  return (
    <MessageRichPreviewProvider value={richPreviewProviderValue}>
      <MessageFilePathProvider value={filePathProviderValue}>
        <div className="session-body flex h-full min-h-0">
          {session.fusionRoomId ? (
            <CollaborationRoomsPage
              roomId={session.fusionRoomId}
              sourceSessionId={sessionId}
              refreshKey={fusionRoomRefreshKey}
              onRoomsChanged={() =>
                setFusionRoomRefreshKey((value) => value + 1)
              }
              onNewRoom={() => undefined}
              onCollaborationExited={() =>
                setFusionRoomRefreshKey((value) => value + 1)
              }
              onOpenAttachment={openAttachmentPreview}
              onPreviewAttachment={openPendingAttachmentPreview}
            />
          ) : (
            <>
              {/* 左：对话 + 输入（测量锚点 rootRef 只包对话列，避免右栏影响下箭头） */}
              <div
                ref={rootRef}
                className={cn(
                  "session-chat-col relative min-h-0 min-w-0 flex-1",
                  composerCompact && "is-composer-compact",
                )}
                data-composer-density={
                  composerCompact ? "compact" : "comfortable"
                }
                data-mention-open={mentionPickerOpen ? "true" : "false"}
                data-bottom-banner-open={
                  hasBlockingBottomBanner ? "true" : "false"
                }
              >
                <SessionBotBar
                  sessionId={sessionId}
                  botProfileIds={session.botProfileIds}
                  fusionRoomId={session.fusionRoomId}
                  onOpenBot={(bot) => {
                    setSidecarBots((current) => {
                      if (
                        current.some(
                          (item) => item.bot.profile.id === bot.profile.id,
                        )
                      ) {
                        return current;
                      }
                      const stackIndex = sidecarStackIndexRef.current++;
                      return [...current, { bot, stackIndex }];
                    });
                  }}
                  variant="rail"
                />
                {items.length === 0 && !running && scrollReady ? (
                  <NewConversationLanding
                    composer={landingComposer}
                    workspaceSlot={workspaceSlot}
                    onPickSuggestion={pickSuggestion}
                    onBack={onBack}
                  />
                ) : (
                  <div
                    className={`relative h-full min-h-0 chat-page-enter ${pageMounted && scrollReady ? "is-mounted" : ""}`}
                  >
                    {/* 消息区：全高；线程有 max-width 居中；底栏输入/token 铺满对话列 */}
                    <Conversation
                      className="absolute inset-0 min-h-0"
                      contextRef={scrollContextRef}
                      // 自动布局滚动由 ScrollPositionManager 统一协调；第三方内部观察器已断开。
                      resize="instant"
                    >
                      <ConversationContent className="session-conversation-pad pt-2">
                        <div className="tagent-thread">
                          {topVirtualSpacerHeight > 0 ? (
                            <div
                              aria-hidden="true"
                              style={{ height: topVirtualSpacerHeight }}
                            />
                          ) : null}
                          {/* 虚拟化加载提示：未全挂时常驻显示（说清楚在加载、剩多少条），不闪烁 */}
                          {!allMounted && turnCount > 0 && (
                            <div
                              className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
                              aria-live="polite"
                            >
                              {allowFullMount ? (
                                <>
                                  <span className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
                                  <span>
                                    正在加载更早的{" "}
                                    {turnCount - effectiveVisible} 轮…
                                  </span>
                                </>
                              ) : (
                                <span>
                                  向上滚动加载更早的{" "}
                                  {turnCount - effectiveVisible} 轮
                                </span>
                              )}
                            </div>
                          )}
                          {(() => {
                            const runActive = running || runStartedAt != null;
                            const runTurnKey = resolveRunTurnKey(
                              visibleTurns,
                              sessionId,
                              runActive,
                            );
                            if (runTurnKey)
                              lastAssistantTurnKeyRef.current = runTurnKey;

                            let lastAssistantIdx = -1;
                            for (let i = visibleTurns.length - 1; i >= 0; i--) {
                              if (visibleTurns[i]!.kind === "assistant-turn") {
                                lastAssistantIdx = i;
                                break;
                              }
                            }
                            return visibleTurns.map((turn, turnIndex) => {
                              // 最新 assistant-turn 且本轮未硬停：过程区「一条路」展开。
                              // 用 startedAt 而非仅 running——turn_end 软停会短暂 running=false，
                              // 若据此收过程/拆回答会整段跳变；硬停才清 startedAt。
                              //
                              // 已记完成耗时的一轮禁止再标 live：send() 先 startRun、用户气泡
                              // 要等 IPC/流式回声才进 items。中间那一帧 last turn 仍是上一轮
                              // 助手，若仅看 runActive 会把已完成轮重新展开过程区，视口被顶到
                              // 上一轮用户气泡，再闪回底部。
                              const isLiveTurn =
                                runActive &&
                                turnIndex === visibleTurns.length - 1 &&
                                turn.kind === "assistant-turn" &&
                                completedDurations[turn.key] == null;
                              // 简洁：末尾 assistant 跑完可保持展开；发新一轮后 isLatest=false → 折叠
                              const isLatestAssistantTurn =
                                turn.kind === "assistant-turn" &&
                                turnIndex === lastAssistantIdx &&
                                turnIndex === visibleTurns.length - 1;
                              const stoppedSyntheticKey =
                                turn.kind === "user" &&
                                shouldRenderStoppedSyntheticShell(
                                  visibleTurns,
                                  turnIndex,
                                  completedDurations,
                                )
                                  ? syntheticLiveTurnKeyForUser(turn.key)
                                  : null;
                              return (
                                <Fragment key={turn.key}>
                                  <TurnView
                                    turn={turn}
                                    isLiveTurn={isLiveTurn}
                                    runStartedAt={
                                      isLiveTurn ? runStartedAt : undefined
                                    }
                                    isLatestAssistantTurn={
                                      isLatestAssistantTurn
                                    }
                                    streamState={
                                      isLiveTurn ? streamState : undefined
                                    }
                                    fallbackModelId={
                                      isLiveTurn &&
                                      effectiveSelection?.modelId &&
                                      !isMoaModelId(effectiveSelection.modelId)
                                        ? effectiveSelection.modelId
                                        : undefined
                                    }
                                    onRefillToInput={pickSuggestion}
                                    mentionLabels={
                                      isLiveTurn && liveMentionLabels.length > 0
                                        ? liveMentionLabels
                                        : undefined
                                    }
                                    mentionRoles={mentionRoles}
                                    completedDuration={
                                      completedDurations[turn.key]
                                    }
                                    finalOutputState={
                                      turn.kind === "assistant-turn" &&
                                      turnIndex === lastAssistantIdx
                                        ? finalOutputState
                                        : null
                                    }
                                    subagentCards={subagentCards}
                                    onOpenSubagent={(parentToolUseId) =>
                                      setSubagentDetail(parentToolUseId)
                                    }
                                    onOpenDiscussion={(discussionId) =>
                                      setOpenDiscussionId(discussionId)
                                    }
                                    sessionId={sessionId}
                                    onOpenAttachment={openAttachmentPreview}
                                    animateEnter={turn.key === enterKey}
                                  />
                                  {stoppedSyntheticKey ? (
                                    <TurnView
                                      turn={{
                                        kind: "assistant-turn",
                                        key: stoppedSyntheticKey,
                                        items: [],
                                        isStreaming: false,
                                      }}
                                      completedDuration={
                                        completedDurations[stoppedSyntheticKey]
                                      }
                                      mentionRoles={mentionRoles}
                                      sessionId={sessionId}
                                      subagentCards={subagentCards}
                                      onOpenSubagent={(parentToolUseId) =>
                                        setSubagentDetail(parentToolUseId)
                                      }
                                      animateEnter={
                                        stoppedSyntheticKey === enterKey
                                      }
                                    />
                                  ) : null}
                                </Fragment>
                              );
                            });
                          })()}
                          {(() => {
                            const runActive = running || runStartedAt != null;
                            const lastTurn =
                              visibleTurns[visibleTurns.length - 1];
                            const needsSyntheticLiveTurn =
                              runActive && lastTurn?.kind !== "assistant-turn";
                            if (!needsSyntheticLiveTurn) return null;
                            const liveKey = resolveRunTurnKey(
                              visibleTurns,
                              sessionId,
                              true,
                            );
                            if (!liveKey) return null;
                            return (
                              <TurnView
                                key={liveKey}
                                sessionId={sessionId}
                                turn={{
                                  kind: "assistant-turn",
                                  key: liveKey,
                                  items: [],
                                  isStreaming: true,
                                }}
                                isLiveTurn
                                runStartedAt={runStartedAt}
                                isLatestAssistantTurn
                                streamState={streamState}
                                fallbackModelId={
                                  hasStreamContent(streamState) &&
                                  effectiveSelection?.modelId &&
                                  !isMoaModelId(effectiveSelection.modelId)
                                    ? effectiveSelection.modelId
                                    : undefined
                                }
                                finalOutputState={finalOutputState}
                                mentionLabels={
                                  liveMentionLabels.length > 0
                                    ? liveMentionLabels
                                    : undefined
                                }
                                mentionRoles={mentionRoles}
                                subagentCards={subagentCards}
                                onOpenSubagent={(parentToolUseId) =>
                                  setSubagentDetail(parentToolUseId)
                                }
                                animateEnter={liveKey === enterKey}
                              />
                            );
                          })()}
                        </div>
                        {/* 真实滚动底部：让最新消息停在 fixed composer 上方，而不是停在输入框下面。 */}
                        <div
                          className="session-conversation-bottom-spacer"
                          aria-hidden="true"
                        />
                      </ConversationContent>
                      {/* 切会话恢复滚动：钉底等窗口就绪；中间位才等全挂 */}
                      <ScrollPositionManager
                        id={sessionId}
                        ready={scrollReady}
                        restoreReady={allowFullMount ? allMounted : windowReady}
                        layoutKey={effectiveVisible}
                        live={running || runStartedAt != null}
                      />
                      <ScrollMinimap
                        items={minimapItems}
                        onEnsureMessage={ensureMinimapMessageMounted}
                      />
                      <ConversationScrollButton />
                    </Conversation>

                    {/*
        底栏坐标系（对齐 General）：
        窗底 ── status(7) ── token 栏 ── 间隙 ── 输入框底（= band = rail/sidebar 底）
        stack 锚在 status；输入用 margin-bottom 抬到 band，token 不把输入顶上去。
        权限确认面板挂在 composer 内部，以绝对定位覆盖输入框，避免用户误把内容写进输入框。
      */}
                    <div
                      ref={bottomStackRef}
                      className="session-bottom-stack absolute inset-x-0"
                    >
                      {/* 底部统一模糊带：一块 backdrop-filter + 向下渐浓底色，覆盖「输入框顶→窗口底」
            整条底层，宽 = 输入框宽（gutter）。定位用 --session-composer-top，功能栏展开时
            该变量被抬高，背板顶自动上移、高度自动变大。输入框 / token 栏 / 功能栏都不再
            各自 backdrop-filter，共用这一块，避免两层模糊叠成糊块。z-index:-1 沉到 stack
            内最底（在 token(z1)/输入框(z2) 与 MessageQueue/PermissionBanner 之下）。 */}
                      <div
                        className="composer-blur-underlay"
                        aria-hidden="true"
                      />
                      <MessageQueue
                        queue={messageQueue}
                        onRemove={removeQueueItem}
                        onClear={clearQueue}
                        onSteer={steerQueueItem}
                        onEdit={editQueueItem}
                        busy={queueActionBusy}
                        running={running || runStartedAt != null}
                      />
                      {backgroundCrewBanner && executionMode === "chat" ? (
                        <div
                          className="kanban-crew-bg-banner pointer-events-auto mx-3 mb-2 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11.5px] leading-snug text-foreground/90 shadow-sm backdrop-blur-md"
                          role="status"
                          aria-live="polite"
                        >
                          <span className="min-w-0 flex-1">
                            班组仍在后台执行（{backgroundCrewBanner.running}{" "}
                            个进行中 /{" "}
                            {backgroundCrewBanner.ready +
                              backgroundCrewBanner.pending}{" "}
                            排队），Chat 模式不会杀工人
                          </span>
                          <button
                            type="button"
                            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                            onClick={() => {
                              setBackgroundCrewBanner(null);
                              setCrewPanelOpen(true);
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
                          const prev = executionMode;
                          setExecutionMode(m);
                          setPendingModeSuggestion(null);
                          const res =
                            await window.electronAPI.setSessionExecutionMode(
                              sessionId,
                              m,
                              source,
                            );
                          if (!res.ok) {
                            setExecutionMode(prev);
                            console.error(
                              "[Chat] setSessionExecutionMode (suggestion) failed:",
                              res.error,
                            );
                          } else {
                            await applyBackgroundCrewFromModeSwitch(m, res);
                          }
                        }}
                      />
                      <SessionErrorBanner
                        sessionId={sessionId}
                        canRetry={
                          !running &&
                          Boolean(getLastRealUserPrompt()) &&
                          Boolean(effectiveSelection)
                        }
                        onRetry={retryLastUserPrompt}
                      />
                      <div
                        ref={composerClusterRef}
                        className={`session-composer-cluster ${showTokenBar ? "has-token-bar" : ""}`}
                      >
                        <PermissionBanner sessionId={sessionId} />
                        <AskUserQuestionBanner sessionId={sessionId} />
                        <ExitPlanModeBanner sessionId={sessionId} />

                        <div className="composer-float-row">
                          <ComposerRunTimer startedAt={runStartedAt} />
                          {sessionPlanProgress &&
                          !hasPendingExitPlan &&
                          (running || runStartedAt != null || planStillOpen) ? (
                            <PlanProgressCard progress={sessionPlanProgress} />
                          ) : null}
                          <ComposerActivityIsland
                            items={visibleComposerActivityItems}
                            pillLabel={composerActivity.pillLabel}
                            headerLabel={composerActivity.headerLabel}
                            onStopProcess={(processId) => {
                              void window.electronAPI.killSessionProcess?.(
                                sessionId,
                                processId,
                              );
                            }}
                          />
                        </div>
                        <div
                          ref={composerInputDockRef}
                          className="session-input-dock"
                          data-permission-mode={permissionMode}
                          data-execution-mode={executionMode}
                        >
                          <ChatInput
                            ref={chatInputRef}
                            onSubmit={() => void send()}
                            placeholder={
                              running || runStartedAt != null
                                ? "运行中回车会加入队列，再选排队或引导"
                                : executionMode === "chat"
                                  ? "输入消息… @ 点名角色或 Bot（Enter 发送）"
                                  : "输入消息…（Enter 发送，Shift+Enter 换行）"
                            }
                            onDraftChange={setHasDraft}
                            attachments={pendingAttachments}
                            onAttachmentsChange={setPendingAttachments}
                            onPreviewAttachment={openPendingAttachmentPreview}
                            mentionRoles={
                              executionMode === "chat"
                                ? mentionOptions
                                : undefined
                            }
                            topBar={activeMentionBar}
                            onMentionOpenChange={setMentionPickerOpen}
                            footer={
                              /* h-7 固定底栏；窄宽时 is-composer-compact 走图标优先方案 */
                              <div
                                className={cn(
                                  "composer-footer-bar flex h-7 items-center justify-between gap-1 px-2 pb-2 pt-0.5",
                                  composerCompact &&
                                    "composer-footer-bar--compact",
                                )}
                              >
                                <div className="composer-footer-bar__left flex h-7 min-w-0 items-center gap-0.5">
                                  {/* 加号最左 */}
                                  <AppTooltip label="添加附件">
                                    {/* size-7 与 size="icon" 冲突：Tailwind v3.4 里 h/w 排在 size 之后，
                          size="icon" 的 h-9 w-9 会盖掉 size-7，+ 按钮变成 36px 高出 h-7 底栏，
                          使同行运行模式 pill 显得偏低。改用 icon-sm（h-7 w-7）与底栏等高。 */}
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      className="shrink-0 rounded-xl text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                                      onClick={handleOpenFileDialog}
                                      aria-label="添加附件"
                                    >
                                      <Plus className="size-4" />
                                    </Button>
                                  </AppTooltip>
                                  {/* 运行模式：Chat|Work + 权限档 + 子代理，一个入口 */}
                                  <RunModeSelector
                                    compact={composerCompact}
                                    executionMode={executionMode}
                                    onExecutionModeChange={(m) => {
                                      void (async () => {
                                        const prev = executionMode;
                                        setExecutionMode(m);
                                        setPendingModeSuggestion(null);
                                        const res =
                                          await window.electronAPI.setSessionExecutionMode(
                                            sessionId,
                                            m,
                                            "user",
                                          );
                                        if (!res.ok) {
                                          setExecutionMode(prev);
                                          console.error(
                                            "[Chat] setSessionExecutionMode failed:",
                                            res.error,
                                          );
                                        } else {
                                          void window.electronAPI.dismissExecutionModeSuggestion?.(
                                            sessionId,
                                          );
                                          await applyBackgroundCrewFromModeSwitch(
                                            m,
                                            res,
                                          );
                                          if (m === "work" && !crewExternalized)
                                            setCrewPanelOpen(true);
                                        }
                                      })();
                                    }}
                                    permissionMode={permissionMode}
                                    onPermissionModeChange={(m) => {
                                      setPermissionMode(m);
                                      void window.electronAPI.setSessionPermissionMode(
                                        sessionId,
                                        m,
                                      );
                                    }}
                                    subagentEagerness={subagentEagerness}
                                    onSubagentEagernessChange={(level) => {
                                      setSubagentEagerness(level);
                                      void window.electronAPI.updateSessionMeta(
                                        sessionId,
                                        {
                                          subagentEagerness: level,
                                        },
                                      );
                                    }}
                                  />
                                </div>
                                <div className="composer-footer-bar__right flex h-7 min-w-0 shrink items-center gap-0.5">
                                  <KnowledgeBaseSelector
                                    sessionId={sessionId}
                                  />
                                  <ModelSelector
                                    selection={effectiveSelection}
                                    lockedKind={lockedKind}
                                    onSelect={(nextSelection) => {
                                      setSelectionOverride(nextSelection);
                                      setSelectedModelSelection(nextSelection);
                                    }}
                                    reasoningEffort={reasoningEffort}
                                    onReasoningEffortChange={(effort) => {
                                      setReasoningEffort(effort);
                                      void window.electronAPI.updateSessionMeta(
                                        sessionId,
                                        {
                                          reasoningEffort: effort,
                                        },
                                      );
                                    }}
                                  />
                                  {/*
                      发送/停止同槽复用：
                      · 运行中 + 无草稿 → 停止键
                      · 运行中 + 有草稿 → Enter/发送=入队（队列里再选排队或引导）
                      · 空闲 + 有草稿 → 发送键
                      · 空闲 + 无草稿 → 发送键（disabled）
                    */}
                                  {running && !hasSendable ? (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-8 rounded-glass-popover text-destructive hover:bg-destructive/10"
                                      onClick={() => {
                                        void handleUserStop();
                                      }}
                                      aria-label="停止"
                                    >
                                      <Square className="size-4 fill-current" />
                                    </Button>
                                  ) : (
                                    <SendSplitButton
                                      presets={consultPresetsForMenu}
                                      channel={selectionChannel}
                                      hasDraft={hasSendable}
                                      onSend={() => void send()}
                                      onConsultPreset={(id) =>
                                        void sendConsult(id)
                                      }
                                      onDiscussionPreset={(id) =>
                                        void sendDiscussion(id)
                                      }
                                    />
                                  )}
                                </div>
                              </div>
                            }
                          />
                        </div>
                      </div>
                      {/* token 栏：cluster 外部，stack 最底，落在 band 与窗边之间；kscc 隐藏占用圆环 */}
                      {showTokenBar && (
                        <TokenStatsBar
                          usage={contextUsage}
                          totals={tokenTotals}
                          channelId={effectiveSelection?.channelId}
                          isCompacting={isCompactingUi}
                          onCompact={() => void compactContext()}
                          compact={composerCompact}
                          hideContext={lockedKind === "kscc"}
                        />
                      )}
                    </div>
                  </div>
                )}

                {/* 右缘：班组面板关闭时的轻入口（分屏模式隐藏，班组走 dock） */}
                {!crewExternalized &&
                !crewPanelOpen &&
                (hasCrewBoards || sessionBoardId) ? (
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
              ) : null}{" "}
            </>
          )}

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

          {/* 圆桌讨论全屏讨论室：从主时间线入口卡全屏切换（与 SubagentDetailView 同层级覆盖 Chat 区域） */}
          {openDiscussionId && openDiscussionPanel && (
            <div className="subagent-detail-overlay">
              <MoaDiscussionRoom
                panel={openDiscussionPanel}
                onBack={() => setOpenDiscussionId(null)}
                onInterject={(text) => {
                  // 用户插话 → IPC push pending → runMoADiscussion 每轮开始前 drain 注入本轮（§5.3）。
                  // 失败（讨论已结束 / 过期 discussionId）静默 warn：不阻断用户继续输入。
                  const p = window.electronAPI.discussionInterject?.({
                    sessionId,
                    discussionId: openDiscussionId!,
                    text,
                  });
                  p?.catch((err) =>
                    console.warn("[discussion] interject failed", err),
                  );
                }}
                onStop={() => {
                  // 用户喊停 → IPC abort controller → runMoADiscussion cancelled 路径推 cancelled 卡
                  // （主进程另推 turn_end 清 running）；关闭讨论室，主时间线卡显示已取消（§5.3）。
                  void window.electronAPI.discussionStop?.({
                    sessionId,
                    discussionId: openDiscussionId!,
                  });
                  setOpenDiscussionId(null);
                }}
              />
            </div>
          )}
          {sidecarBots.map(({ bot, stackIndex }) => (
            <BotSidecarPanel
              key={bot.profile.id}
              sessionId={sessionId}
              bot={bot}
              stackIndex={stackIndex}
              contextText={sidecarContextText}
              fallbackChannelId={
                effectiveSelection?.channelId ?? session.channelId
              }
              fallbackModelId={effectiveSelection?.modelId ?? session.modelId}
              onClose={() =>
                setSidecarBots((current) =>
                  current.filter(
                    (item) => item.bot.profile.id !== bot.profile.id,
                  ),
                )
              }
            />
          ))}
        </div>
      </MessageFilePathProvider>
    </MessageRichPreviewProvider>
  );
}

/** turn 渲染：user / assistant-turn / 独立状态行 */
function TurnView({
  turn,
  isLiveTurn = false,
  runStartedAt,
  isLatestAssistantTurn = false,
  streamState,
  fallbackModelId,
  onRefillToInput,
  mentionLabels,
  mentionRoles,
  completedDuration,
  finalOutputState,
  subagentCards,
  onOpenSubagent,
  onOpenDiscussion,
  sessionId,
  onOpenAttachment,
  animateEnter = false,
}: {
  turn: ReturnType<typeof groupItemsIntoTurns>[number];
  isLiveTurn?: boolean;
  /** 会话本轮统一起点，供消息内运行计时与底部胶囊共用。 */
  runStartedAt?: number | null;
  /** 当前会话末尾 assistant-turn（简洁模式跑完保持展开用） */
  isLatestAssistantTurn?: boolean;
  streamState?: SessionStreamState;
  /** 会话选中模型：开流铭牌兜底 */
  fallbackModelId?: string;
  onRefillToInput?: (text: string) => void;
  mentionLabels?: string[];
  mentionRoles?: Array<{ id: string; displayName: string }>;
  completedDuration?: TurnDuration;
  finalOutputState?: "waiting" | "missing" | null;
  subagentCards?: Map<string, TaskCardState>;
  onOpenSubagent?: (parentToolUseId: string) => void;
  /** 点击圆桌讨论入口卡 → 全屏讨论室（Chat 侧 setOpenDiscussionId） */
  onOpenDiscussion?: (discussionId: string) => void;
  /** 当前会话 id（MoA 圆桌卡建看板 CTA 用） */
  sessionId: string;
  onOpenAttachment?: (attachment: FileAttachment) => void;
  /** 本轮新出现的末尾消息：挂 message-enter 淡入上滑，取代「跳一下」。 */
  animateEnter?: boolean;
}): JSX.Element {
  const enterClass = animateEnter ? "message-enter" : undefined;
  if (turn.kind === "user") {
    return (
      <div className={enterClass} data-message-id={turn.key}>
        <MessageView
          message={turn.message}
          onRefillToInput={onRefillToInput}
          mentionRoles={mentionRoles}
          onOpenAttachment={onOpenAttachment}
        />
      </div>
    );
  }
  if (turn.kind === "assistant-turn") {
    return (
      <div className={enterClass} data-message-id={turn.key}>
        <AssistantTurnView
          sessionId={sessionId}
          turn={turn}
          isLiveTurn={isLiveTurn}
          runStartedAt={runStartedAt}
          isLatestAssistantTurn={isLatestAssistantTurn}
          streamState={streamState}
          fallbackModelId={fallbackModelId}
          mentionLabels={mentionLabels}
          completedDuration={completedDuration}
          finalOutputState={finalOutputState}
          subagentCards={subagentCards}
          onOpenSubagent={onOpenSubagent ?? (() => {})}
        />
      </div>
    );
  }
  return (
    <ItemView
      item={turn.item as DisplayItem}
      sessionId={sessionId}
      onOpenDiscussion={onOpenDiscussion}
      onOpenAttachment={onOpenAttachment}
    />
  );
}

/** 显示项渲染（standalone：压缩行 / 任务卡 / MoA 圆桌卡 / 圆桌讨论入口卡 / 兜底） */
function ItemView({
  item,
  sessionId,
  onOpenDiscussion,
  onOpenAttachment,
}: {
  item: DisplayItem;
  sessionId: string;
  onOpenDiscussion?: (discussionId: string) => void;
  onOpenAttachment?: (attachment: FileAttachment) => void;
}): JSX.Element {
  // MoA 圆桌卡（standalone，挂主时间线）
  if (item.moaRoundtable) {
    return (
      <div data-message-id={item.key}>
        <MoaRoundtableCard panel={item.moaRoundtable} sessionId={sessionId} />
      </div>
    );
  }
  // 圆桌讨论入口卡（standalone，挂主时间线；点击进全屏讨论室）
  if (item.moaDiscussion) {
    return (
      <div data-message-id={item.key}>
        <MoaDiscussionCard
          panel={item.moaDiscussion}
          onOpen={() => onOpenDiscussion?.(item.moaDiscussion!.discussionId)}
        />
      </div>
    );
  }
  // 子代理 taskCard 已并入 assistant-turn + SubagentEntryCard，standalone 不再渲染第二张卡
  // （历史兜底：若仍有孤立 taskCard，也静默跳过，避免双卡 + 拆 turn 铭牌污染）
  if (item.taskCard && !item.message) {
    return <></>;
  }

  // 上下文压缩状态行
  if (item.compactStatus === "compacting") {
    return (
      <div
        data-message-id={item.key}
        className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
      >
        <span className="size-1.5 animate-pulse rounded-full bg-primary/60" />
        {COMPACTION_IN_PROGRESS_LABEL}
      </div>
    );
  }
  if (item.compactStatus === "complete") {
    return (
      <div
        data-message-id={item.key}
        className="relative flex items-center justify-center py-2"
      >
        <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
        <span className="mx-3 text-xs text-muted-foreground select-none">
          {getCompactBoundaryLabel(
            item.compactTrigger ? { trigger: item.compactTrigger } : undefined,
          )}
        </span>
        <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
      </div>
    );
  }

  // 完整消息（IR）→ MessageView（挂 data-message-id 供 ScrollMinimap 定位）
  if (item.message) {
    return (
      <div data-message-id={item.key}>
        <MessageView
          message={item.message}
          onOpenAttachment={onOpenAttachment}
        />
      </div>
    );
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
  );
}

/**
 * TaskCardView — 子代理任务卡片
 *
 * 圆角边框 + 状态色圆点（running 脉冲）+ 可选进度文案 / 收口摘要。
 * 放在消息流中，承载 task_started → task_progress → task_notification 生命周期。
 */
const TASK_CARD_STATUS: Record<
  TaskCardState["status"],
  {
    label: string;
    box: string;
    dot: string;
    text: string;
  }
> = {
  running: {
    label: "运行中",
    box: "border-muted-foreground/20 bg-muted/20",
    dot: "bg-muted-foreground/60 animate-pulse",
    text: "text-muted-foreground",
  },
  completed: {
    label: "已完成",
    box: "border-emerald-500/30 bg-emerald-500/5",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  failed: {
    label: "失败",
    box: "border-destructive/30 bg-destructive/5",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  stopped: {
    label: "已停止",
    box: "border-muted-foreground/20 bg-muted/20",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground/70",
  },
};

function TaskCardView({ card }: { card: TaskCardState }): JSX.Element {
  const s = TASK_CARD_STATUS[card.status];
  const isRunning = card.status === "running";
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${s.box}`}
    >
      <span className={`mt-1 size-2 shrink-0 rounded-full ${s.dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-medium text-foreground/80">子代理</span>
          <span className={s.text}>{s.label}</span>
          {isRunning && card.lastToolName && (
            <span className="truncate text-muted-foreground/60">
              · {card.lastToolName}
            </span>
          )}
        </div>
        {card.description && (
          <div className="mt-0.5 truncate text-xs text-foreground/70">
            {card.description}
          </div>
        )}
        {isRunning && card.progressText && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {card.progressText}
          </div>
        )}
        {!isRunning && card.summary && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {card.summary}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Typewriter 逐字显示：端点（aicode/minimax）流式粒度粗，每 ~500ms 发一大块，
 * 块到达后不瞬间全部显示，而是用 rAF 在块间隔内逐字挤出，视觉连续丝滑。
 *
 * 速度自适应：按"剩余字符 / 剩余预估时间"算每帧步长，保证下一块到达前刚好显示完。
 * 收尾：turn 结束后 streamingText 不再增长，剩余字符快速追完。
 */
function TypewriterText({ text }: { text: string }): JSX.Element {
  const [displayed, setDisplayed] = useState("");
  const rafRef = useRef<number | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    // text 增长时若 rAF 没在跑，启动；rAF 循环读 textRef 最新值，自动追上新块
    if (rafRef.current != null) return;
    const step = () => {
      const full = textRef.current;
      setDisplayed((cur) => {
        if (cur.length >= full.length) {
          rafRef.current = null;
          return cur; // 已追上，停 rAF，等下一块触发 effect 重启
        }
        // 每帧追加：剩余字符的 1/8（约 8 帧 ≈ 130ms 追完一段），最少 1 字
        const remain = full.length - cur.length;
        const add = Math.max(1, Math.ceil(remain / 8));
        return full.slice(0, cur.length + add);
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [text]);

  // 新消息/切换会话时 text 重置为空，displayed 同步重置
  useEffect(() => {
    if (text === "") setDisplayed("");
  }, [text]);

  return <MessageResponse>{displayed}</MessageResponse>;
}

/** 取消息首个 text 块的文本（供 minimap preview） */
function firstText(m: TAgentMessage): string | undefined {
  const block = m.content.find((b) => b.type === "text") as
    { type: "text"; text: string } | undefined;
  return block?.text;
}

/** 判断历史行是否已是 TAgentMessage IR（pi 落盘）而非 Claude SDKMessage（有 message 包装）。
 *  IR：顶层 type='assistant'|'user' + content 数组、无 message 字段；SDKMessage：有 message 包装。 */
function isIRMessage(raw: unknown): boolean {
  if (raw == null || typeof raw !== "object") return false;
  const r = raw as { type?: unknown; message?: unknown; content?: unknown };
  return (
    (r.type === "assistant" || r.type === "user") &&
    r.message === undefined &&
    Array.isArray(r.content)
  );
}
