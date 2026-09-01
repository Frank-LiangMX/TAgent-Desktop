/**
 * 协作室主区页面 — Stage 3
 *
 * 选中房间 → 头部（标题/状态/目标/成员数/并发 x/y/排队/添加成员）+
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
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { motion } from "motion/react";
import { Plus, Square } from "lucide-react";
import {
  ArrowRight,
  CaretDown,
  At,
  Database,
  FolderOpen,
  Link,
  ListChecks,
  SignOut,
  Target,
  UsersThree,
} from "@phosphor-icons/react";
import type {
  Channel,
  CliWorkersConfig,
  CollaborationArtifact,
  CollaborationHumanMember,
  CollaborationRoleSnapshot,
  CollaborationMailboxEnvelope,
  CollaborationMember,
  CollaborationMemberBackend,
  CollaborationHistoryCursor,
  CollaborationMessage,
  CollaborationMessagesPage,
  CollaborationRoom,
  CollaborationRoomStatus,
  CollaborationRoomTask,
  BoardProjectedSummary,
  BoardProjectedTask,
  CollaborationWorkspaceBindingView,
  CollaborationRun,
  CollaborationRunsPage,
  CollaborationRunSummary,
  CollaborationUserApprovalRequest,
  FileAttachment,
  LocalCollaborationContinuationItem,
} from "@tagent/shared";
import {
  AppTooltip,
  Button,
  DestructiveConfirmDialog,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@tagent/ui";
import {
  ChatInput,
  type ChatInputHandle,
  type PendingAttachment,
} from "../chat/ChatInput";
import { SendSplitButton } from "../chat/ConsultMenu";
import BlurText from "../chat/BlurText";
import { CollaborationTextPrompt } from "./CollaborationTextPrompt";
import { CollaborationMemberSettings } from "./CollaborationMemberSettings";
import { CollaborationAddMemberDialog } from "./CollaborationAddMemberDialog";
import { CollaborationTimeline } from "./CollaborationTimeline";
import { CollaborationContinuationList } from "./CollaborationContinuationList";
import { CollaborationWorkPanel } from "./CollaborationWorkPanel";
import { MemberAvatar } from "./CollaborationAvatars";
import { FusionRoomRemotePage } from "./FusionRoomRemotePage";
import { FusionRoomRemoteConnectDialog } from "./FusionRoomRemoteConnectDialog";
import type { FusionRoomRemoteSession } from "./fusion-room-remote-session";
import { cn } from "../../lib/utils";

type TextPromptKind = "edit-goal" | null;

const EASE = [0.16, 1, 0.3, 1] as const;
const COLLABORATION_HISTORY_PAGE_SIZE = 120;

/** 协作室的全员 mention 不是成员 ID，而是结构化路由的特殊目标。 */
const COLLABORATION_ALL_MENTION_ID = "all";
const COLLABORATION_ALL_MENTION = {
  id: COLLABORATION_ALL_MENTION_ID,
  displayName: "所有人",
  description: "唤醒房间内全部成员（含协调者）",
} as const;

/** 欢迎页能力点卡片 */
const WELCOME_FEATURES = [
  {
    icon: UsersThree,
    title: "多成员并行",
    desc: "一条消息可同时唤醒多个成员，各自独立执行、互不阻塞。",
  },
  {
    icon: At,
    title: "@点名路由",
    desc: "不 @ 由协调者回复；@成员名 精确投递，@所有人 唤醒全部。",
  },
  {
    icon: Database,
    title: "持久房间",
    desc: "消息与运行状态落盘，重启不丢历史、不会出现假 running。",
  },
] as const;

/** 房间状态 → 中文标签 */
function roomStatusLabel(status: CollaborationRoomStatus): string {
  switch (status) {
    case "active":
      return "空闲";
    case "paused":
      return "已暂停";
    case "archived":
      return "已归档";
    case "completed":
      return "已完成";
  }
}

/** 成员显示状态：以 runs 为准（running/queued/awaiting_peer），否则看成员 status */
function memberDisplayStatus(
  member: CollaborationMember,
  runs: CollaborationRun[],
): "running" | "queued" | "awaiting_peer" | "idle" | "offline" | "removed" {
  if (member.status === "removed") return "removed";
  if (runs.some((r) => r.memberId === member.id && r.status === "running"))
    return "running";
  if (runs.some((r) => r.memberId === member.id && r.status === "queued"))
    return "queued";
  if (
    runs.some((r) => r.memberId === member.id && r.status === "awaiting_peer")
  )
    return "awaiting_peer";
  return member.status === "offline" ? "offline" : "idle";
}

/** 成员显示状态 → 中文标签 */
function memberStatusLabel(
  status: ReturnType<typeof memberDisplayStatus>,
): string {
  switch (status) {
    case "running":
      return "思考中";
    case "queued":
      return "排队中";
    case "awaiting_peer":
      return "等待成员";
    case "idle":
      return "空闲";
    case "offline":
      return "离线";
    case "removed":
      return "已移除";
  }
}

interface CollaborationRoomsPageProps {
  /** 当前选中房间 ID（null = 未选中 → 空态） */
  roomId: string | null;
  /** 外部变更 bump，触发重新拉取房间/消息 */
  refreshKey: number;
  /** 房间/消息变更时通知 App（rename/pause/archive/send 后） */
  onRoomsChanged: () => void;
  /** 空态「新建协作室」CTA */
  onNewRoom: () => void;
  /** 打开指定设置 tab（如「去渠道设置」CTA 跳转到 channels） */
  onOpenSettings?: (tab: "channels") => void;
  /** 空态「连接远程融合会话」CTA（由 wrapper 接管打开连接对话框） */
  onOpenRemoteSession?: () => void;
  /**
   * 绑定的来源单会话 ID（14 §1 桥接）：由 Chat 传入 session.id。
   * 当 room.sourceSessionId 与之相等（或未传时只要 room.sourceSessionId 存在）时
   * 头部显示「结束协作」按钮，调 exitCollaborationWithBridge 写回原会话并切回普通会话壳。
   */
  sourceSessionId?: string;
  /** 结束协作成功后通知 Chat（如 bump fusionRoomRefreshKey；meta 变更后 Chat 会自动切回普通会话壳） */
  onCollaborationExited?: () => void;
  /** 远程 Fusion 房间会话；存在时改渲染 FusionRoomRemotePage，本地页面逻辑不复用 */
  remoteSession?: FusionRoomRemoteSession;
  /** 远程会话关闭回调（FusionRoomRemotePage 顶栏返回 / 断开时调用） */
  onRemoteSessionClose?: () => void;
  /** 复用单会话附件预览 */
  onOpenAttachment?: (attachment: FileAttachment) => void;
  /** 复用单会话待发送附件分屏预览 */
  onPreviewAttachment?: (attachment: PendingAttachment) => void;
}

/**
 * 协作室主区对外门面：根据是否处于远程会话分发到远程 Fusion 房间视图或本地协作室页面。
 *
 * 远程会话来源有二，按优先级取用：
 *   1. 外部 props.remoteSession（由父组件完全掌控生命周期，关闭时回退 onRemoteSessionClose）；
 *   2. 本组件自管 ownedRemoteSession（由「连接远程融合会话」对话框创建，关闭时清理本地态）。
 * 两者互斥：存在任意远程会话 → 渲染 FusionRoomRemotePage（远程房间流式/控制台）；否则渲染本地
 * LocalCollaborationRoomsPage（原有本地房间逻辑未改动）并挂载连接对话框，避免在本地页面里塞入
 * 远程分支造成状态/生命周期耦合。
 */
export function CollaborationRoomsPage(
  props: CollaborationRoomsPageProps,
): JSX.Element {
  const [ownedRemoteSession, setOwnedRemoteSession] =
    useState<FusionRoomRemoteSession | null>(null);
  const [remoteConnectOpen, setRemoteConnectOpen] = useState(false);

  // 外部会话优先；外部未提供时使用本组件通过对话框创建的自管会话。
  const activeRemoteSession = props.remoteSession ?? ownedRemoteSession;

  // 关闭远程会话：外部会话交还父组件（onRemoteSessionClose）；自管会话清空本地态
  // （FusionRoomRemotePage 卸载时其 effect 会调用 session.close() 释放连接）。
  const handleRemoteClose = useCallback(() => {
    if (props.remoteSession) {
      props.onRemoteSessionClose?.();
      return;
    }
    setOwnedRemoteSession(null);
  }, [props.remoteSession, props.onRemoteSessionClose]);

  // 空态「连接远程融合会话」：先通知外部回调，再打开本组件对话框。
  const handleOpenRemoteSession = useCallback(() => {
    props.onOpenRemoteSession?.();
    setRemoteConnectOpen(true);
  }, [props.onOpenRemoteSession]);

  const handleConnected = useCallback((session: FusionRoomRemoteSession) => {
    setOwnedRemoteSession(session);
    setRemoteConnectOpen(false);
  }, []);

  if (activeRemoteSession) {
    return (
      <FusionRoomRemotePage
        session={activeRemoteSession}
        onClose={handleRemoteClose}
      />
    );
  }

  return (
    <>
      <LocalCollaborationRoomsPage
        {...props}
        onOpenRemoteSession={handleOpenRemoteSession}
      />
      <FusionRoomRemoteConnectDialog
        open={remoteConnectOpen}
        onOpenChange={setRemoteConnectOpen}
        onConnected={handleConnected}
      />
    </>
  );
}

function LocalCollaborationRoomsPage({
  roomId,
  refreshKey,
  onRoomsChanged,
  onNewRoom,
  onOpenSettings,
  onOpenRemoteSession,
  sourceSessionId,
  onCollaborationExited,
  onOpenAttachment,
  onPreviewAttachment,
}: CollaborationRoomsPageProps): JSX.Element {
  const [room, setRoom] = useState<CollaborationRoom | null>(null);
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [humanMembers, setHumanMembers] = useState<CollaborationHumanMember[]>(
    [],
  );
  const [workspaceBindings, setWorkspaceBindings] = useState<
    CollaborationWorkspaceBindingView[]
  >([]);
  const [runs, setRuns] = useState<CollaborationRun[]>([]);
  const [runSummary, setRunSummary] =
    useState<CollaborationRunSummary | null>(null);
  /** 历史分页：undefined 表示尚未初始化，null 表示该方向已经没有更早记录。 */
  const [messageCursor, setMessageCursor] =
    useState<CollaborationHistoryCursor | null>(null);
  const [runCursor, setRunCursor] =
    useState<CollaborationHistoryCursor | null>(null);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [cliWorkers, setCliWorkers] = useState<CliWorkersConfig | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [stoppingRuns, setStoppingRuns] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [inviteUserId, setInviteUserId] = useState("");
  const [invitingUser, setInvitingUser] = useState(false);
  const [showAddMemberDialog, setShowAddMemberDialog] = useState(false);
  const [textPrompt, setTextPrompt] = useState<TextPromptKind>(null);
  /** 「结束协作」确认框：明示退出须用户确认，勿静默（14 §1）。 */
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  /** composer 中选中的成员 mention 芯片 id（结构化路由用；无芯片时不传 → 文本兜底） */
  const [composerMentionIds, setComposerMentionIds] = useState<string[]>([]);
  const [hasDraft, setHasDraft] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [mailbox, setMailbox] = useState<CollaborationMailboxEnvelope[]>([]);
  const [streamByRun, setStreamByRun] = useState<Record<string, string>>({});
  /** S5：室级任务/产物（主进程真值，CHANGED 后重新拉取；渲染层不是真值源） */
  const [tasks, setTasks] = useState<CollaborationRoomTask[]>([]);
  const [artifacts, setArtifacts] = useState<CollaborationArtifact[]>([]);
  /** S5 看板桥：挂载看板的只读投影（看板仍是唯一真值） */
  const [boardTasks, setBoardTasks] = useState<BoardProjectedTask[]>([]);
  const [boardSummary, setBoardSummary] =
    useState<BoardProjectedSummary | null>(null);
  const [approvals, setApprovals] = useState<
    CollaborationUserApprovalRequest[]
  >([]);
  /** P2-1：可观察「待确认续跑」项（主进程纯函数派生，CHANGED 后重新拉取） */
  const [continuations, setContinuations] = useState<
    LocalCollaborationContinuationItem[]
  >([]);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(
    null,
  );
  /** S5：右侧工作面板展开态（默认收起；需要时从头部打开） */
  const [workPanelOpen, setWorkPanelOpen] = useState(false);
  /** S4.5：本地已「停止」关闭的深度停止信封 id（仅前端态，不持久化、不触后端） */
  const [dismissedDepthStopIds, setDismissedDepthStopIds] = useState<
    Set<string>
  >(new Set());
  /** S4.5：正在继续的深度停止信封 id（主操作 loading 态） */
  const [continuingDepthStopId, setContinuingDepthStopId] = useState<
    string | null
  >(null);
  /** S4.5：按信封 id 记录的继续失败原因（主操作 error 态） */
  const [depthStopErrorByEnvelope, setDepthStopErrorByEnvelope] = useState<
    Record<string, string>
  >({});
  /** P2-1：正在确认继续的 blocked run id（主操作 loading 态） */
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  /** P2-1：按 run id 记录的确认继续失败原因（主操作 error 态） */
  const [resumeErrorByRun, setResumeErrorByRun] = useState<
    Record<string, string>
  >({});
  const inputRef = useRef<ChatInputHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 切房间时清空深度停止与续跑的前端态（dismissed / loading / error）。
  // 仅依赖 roomId：刷新（refreshKey 变化）时保留 dismissed，避免广播刷新后已关闭的卡片复活。
  useEffect(() => {
    setDismissedDepthStopIds(new Set());
    setContinuingDepthStopId(null);
    setDepthStopErrorByEnvelope({});
    setResumingRunId(null);
    setResumeErrorByRun({});
    setRetryingId(null);
    setPendingAttachments([]);
    setWorkspaceBindings([]);
    setHasDraft(false);
    setComposerMentionIds([]);
    setMessageCursor(null);
    setRunCursor(null);
    setLoadingOlderHistory(false);
  }, [roomId]);

  // 选中房间 / 外部变更 → 重新拉取
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      if (!roomId) {
        setRoom(null);
        setMessages([]);
        setMembers([]);
        setWorkspaceBindings([]);
        setRuns([]);
        setRunSummary(null);
        setMessageCursor(null);
        setRunCursor(null);
        setMailbox([]);
        setTasks([]);
        setArtifacts([]);
        setBoardTasks([]);
        setBoardSummary(null);
        setApprovals([]);
        setContinuations([]);
        setStreamByRun({});
        return;
      }
      try {
        const [
          r,
          msgsPage,
          mems,
          humans,
          workspaceBindingsResult,
          runsPage,
          runSummaryResult,
          box,
          tks,
          arts,
          aps,
          conts,
        ] = await Promise.all([
            window.electronAPI.getCollaborationRoom(roomId),
            window.electronAPI.listCollaborationMessages({
              roomId,
              limit: COLLABORATION_HISTORY_PAGE_SIZE,
            }),
            window.electronAPI.listCollaborationMembers(roomId),
            window.electronAPI.listCollaborationHumanMembers(roomId),
            window.electronAPI.listCollaborationWorkspaceBindings(roomId),
            window.electronAPI.listCollaborationRuns({
              roomId,
              limit: COLLABORATION_HISTORY_PAGE_SIZE,
            }),
            window.electronAPI.getCollaborationRunSummary(roomId),
            window.electronAPI.listCollaborationMailbox(roomId),
            window.electronAPI.listCollaborationRoomTasks(roomId),
            window.electronAPI.listCollaborationArtifacts(roomId),
            window.electronAPI.listCollaborationUserApprovals(roomId),
            window.electronAPI.listCollaborationContinuations(roomId),
          ]);
        if (cancelled) return;
        const messagesPage = msgsPage as CollaborationMessagesPage;
        const loadedRunsPage = runsPage as CollaborationRunsPage;
        setRoom(r ?? null);
        setMessages(Array.isArray(messagesPage?.items) ? messagesPage.items : []);
        setMessageCursor(messagesPage?.nextCursor ?? null);
        setMembers(Array.isArray(mems) ? mems : []);
        setHumanMembers(Array.isArray(humans) ? humans : []);
        setWorkspaceBindings(
          Array.isArray(workspaceBindingsResult)
            ? workspaceBindingsResult
            : [],
        );
        setRuns(
          Array.isArray(loadedRunsPage?.items) ? loadedRunsPage.items : [],
        );
        setRunCursor(loadedRunsPage?.nextCursor ?? null);
        setRunSummary(
          runSummaryResult && typeof runSummaryResult === "object"
            ? (runSummaryResult as CollaborationRunSummary)
            : null,
        );
        setMailbox(Array.isArray(box) ? box : []);
        setTasks(Array.isArray(tks) ? tks : []);
        setArtifacts(Array.isArray(arts) ? arts : []);
        setApprovals(Array.isArray(aps) ? aps : []);
        setContinuations(Array.isArray(conts) ? conts : []);
        const live = new Set(
          (Array.isArray(loadedRunsPage?.items)
            ? loadedRunsPage.items
            : [])
            .filter((run) => run.status === "running")
            .map((run) => run.id),
        );
        setStreamByRun((prev) => {
          const next: Record<string, string> = {};
          for (const [id, text] of Object.entries(prev)) {
            if (live.has(id)) next[id] = text;
          }
          return next;
        });
      } catch (err) {
        if (cancelled) return;
        console.error("[协作室主区] 加载失败:", err);
        setRoom(null);
        setMessages([]);
        setMembers([]);
        setRuns([]);
        setRunSummary(null);
        setMessageCursor(null);
        setRunCursor(null);
        setMailbox([]);
        setTasks([]);
        setArtifacts([]);
        setBoardTasks([]);
        setBoardSummary(null);
        setApprovals([]);
        setContinuations([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, refreshKey]);

  // 挂载看板使用独立只读投影，避免把看板任务伪装成 room task。
  // 看板任务状态变化会通过 collaboration-room:changed 触发 refreshKey，从而重新读取权威数据。
  useEffect(() => {
    let cancelled = false;
    const attachedBoardId = room?.attachedBoardId;
    if (!roomId || !attachedBoardId) {
      setBoardTasks([]);
      setBoardSummary(null);
      return () => {
        cancelled = true;
      };
    }

    void (async (): Promise<void> => {
      try {
        const [projectedTasks, summary] = await Promise.all([
          window.electronAPI.listCollaborationBoardTasks(roomId),
          window.electronAPI.getCollaborationBoardSummary(roomId),
        ]);
        if (cancelled) return;
        setBoardTasks(Array.isArray(projectedTasks) ? projectedTasks : []);
        setBoardSummary(
          summary && typeof summary === "object"
            ? (summary as BoardProjectedSummary)
            : null,
        );
      } catch (err) {
        if (cancelled) return;
        console.error("[协作室看板投影] 加载失败:", err);
        setBoardTasks([]);
        setBoardSummary(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId, room?.attachedBoardId, refreshKey]);

  /** 向上加载更早历史；消息和 run 各自使用游标，某一类读完后不再重复请求。 */
  const loadOlderHistory = useCallback(async (): Promise<void> => {
    if (!roomId || loadingOlderHistory || (!messageCursor && !runCursor)) return;
    setLoadingOlderHistory(true);
    try {
      const [messagesPage, runsPage] = await Promise.all([
        messageCursor
          ? window.electronAPI.listCollaborationMessages({
              roomId,
              limit: COLLABORATION_HISTORY_PAGE_SIZE,
              before: messageCursor,
            })
          : Promise.resolve(null),
        runCursor
          ? window.electronAPI.listCollaborationRuns({
              roomId,
              limit: COLLABORATION_HISTORY_PAGE_SIZE,
              before: runCursor,
            })
          : Promise.resolve(null),
      ]);
      if (messagesPage) {
        setMessages((previous) => [...messagesPage.items, ...previous]);
        setMessageCursor(messagesPage.nextCursor ?? null);
      }
      if (runsPage) {
        setRuns((previous) => [...runsPage.items, ...previous]);
        setRunCursor(runsPage.nextCursor ?? null);
      }
    } catch (err) {
      console.error("[协作室主区] 加载更早历史失败:", err);
      toast.error("加载更早记录失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoadingOlderHistory(false);
    }
  }, [loadingOlderHistory, messageCursor, roomId, runCursor]);

  // 挂载时加载渠道列表（用于成员渠道名展示 / 「无渠道」判定）
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const [list, workerConfig] = await Promise.all([
          window.electronAPI.listChannels(),
          window.electronAPI.listCliWorkersConfig(),
        ]);
        if (cancelled) return;
        setChannels(Array.isArray(list) ? list : []);
        setCliWorkers(workerConfig ?? null);
      } catch (err) {
        if (cancelled) return;
        console.error("[协作室主区] 加载渠道失败:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 流式增量：独立通道，不 bump refreshKey
  useEffect(() => {
    const off = window.electronAPI.onCollaborationTextDelta?.((payload) => {
      if (!roomId || payload.roomId !== roomId) return;
      setStreamByRun((prev) => ({ ...prev, [payload.runId]: payload.text }));
    });
    return () => {
      off?.();
    };
  }, [roomId]);

  // 新消息 / 流式 → 滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, runs.length, streamByRun]);

  // 房间并发统计（头部 x/y + 排队）
  const runningCount =
    runSummary?.running ?? runs.filter((r) => r.status === "running").length;
  const queuedCount =
    runSummary?.queued ?? runs.filter((r) => r.status === "queued").length;
  const hasSendable = hasDraft || pendingAttachments.length > 0;
  const stoppableRuns = runs.filter(
    (r) => r.status === "running" || r.status === "queued",
  );
  const pendingMailbox = mailbox.filter(
    (e) => e.state === "pending" || e.state === "delivered",
  );
  const maxConcurrent = room?.maxConcurrentRuns ?? 0;
  const memberName = (memberId: string): string =>
    members.find((m) => m.id === memberId)?.displayName ?? "成员";
  const activeMembers = members.filter((member) => member.status !== "removed");

  // 成员是否具备可执行后端：channel 后端需绑定渠道；cli 后端需 cliWorkerId
  const memberHasExecutableBackend = (m: CollaborationMember): boolean =>
    m.backend === "codex"
      ? true
      : m.backend === "cli"
        ? Boolean(m.cliWorkerId)
        : Boolean(m.channelId);

  // 渠道显示名（未找到则回退 channelId）
  const channelLabel = (m: CollaborationMember): string => {
    if (m.backend === "codex") return "Codex";
    if (m.backend === "cli") return m.cliWorkerId ? "CLI" : "未绑定";
    if (!m.channelId) return "未绑定";
    return channels.find((c) => c.id === m.channelId)?.name ?? m.channelId;
  };

  // 房间是否存在无可用后端的成员（用于提示去渠道设置）
  const anyMemberMissingBackend = activeMembers.some(
    (m) => !memberHasExecutableBackend(m),
  );
  // 是否所有成员都无可用后端 → 发消息必然失败，禁发并 CTA
  const allMembersMissingBackend =
    activeMembers.length > 0 &&
    activeMembers.every((m) => !memberHasExecutableBackend(m));

  const handleOpenFileDialog = useCallback(async (): Promise<void> => {
    const result = await (window.electronAPI as any).openFileDialog();
    const files = Array.isArray(result?.files)
      ? result.files.filter(
          (file: any) => typeof file.data === "string" && file.data,
        )
      : [];
    if (files.length === 0) {
      if (result?.files?.some((file: any) => !file.data)) {
        toast.error("大文件暂不支持作为协作室附件发送");
      }
      return;
    }
    setPendingAttachments((previous) => [
      ...previous,
      ...files.map((file: any) => {
        const mediaType = file.mediaType || "application/octet-stream";
        return {
          id: `collab-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filename: file.filename || "未命名附件",
          mediaType,
          size: file.size ?? 0,
          previewUrl: mediaType.startsWith("image/")
            ? `data:${mediaType};base64,${file.data}`
            : undefined,
          data: file.data,
        } satisfies PendingAttachment;
      }),
    ]);
  }, []);

  const send = useCallback(async (): Promise<void> => {
    if (!room || room.status === "archived") return;
    const text = inputRef.current?.getText().trim() ?? "";
    if (!text && pendingAttachments.length === 0) return;
    try {
      await window.electronAPI.appendCollaborationUserMessage({
        roomId: room.id,
        content: text,
        attachments:
          pendingAttachments.length > 0
            ? pendingAttachments.map(({ filename, mediaType, data }) => ({
                filename,
                mediaType,
                data,
              }))
            : undefined,
        mentions:
          composerMentionIds.length > 0
            ? composerMentionIds.map((id) =>
                id === COLLABORATION_ALL_MENTION_ID
                  ? { kind: "all" as const, displayNameSnapshot: "所有人" }
                  : { kind: "agent" as const, memberId: id },
              )
            : undefined,
      });
      inputRef.current?.clear();
      setComposerMentionIds([]);
      setPendingAttachments([]);
      onRoomsChanged();
    } catch (err) {
      toast.error("发送失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [room, composerMentionIds, onRoomsChanged, pendingAttachments]);

  const handleCancelRun = useCallback(
    async (runId: string): Promise<void> => {
      if (!room) return;
      setCancellingId(runId);
      try {
        await window.electronAPI.cancelCollaborationRun({
          roomId: room.id,
          runId,
        });
        onRoomsChanged();
      } catch (err) {
        toast.error("取消失败", {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setCancellingId(null);
      }
    },
    [room, onRoomsChanged],
  );

  const handleRetryRun = useCallback(
    async (runId: string, memberId?: string): Promise<void> => {
      if (!room || retryingId) return;
      setRetryingId(runId);
      try {
        const result = await window.electronAPI.retryCollaborationRun({
          roomId: room.id,
          runId,
          memberId,
          idempotencyKey: `retry-run:${runId}:${memberId ?? "same"}`,
        });
        if (!result.ok) {
          toast.error("重试失败", { description: result.reason });
          return;
        }
        onRoomsChanged();
      } catch (err) {
        toast.error("重试失败", {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setRetryingId(null);
      }
    },
    [room, retryingId, onRoomsChanged],
  );

  /** 会话同款停止键：一次停止当前房间内所有可取消的 run。 */
  const handleStopRuns = useCallback(async (): Promise<void> => {
    if (!room || stoppingRuns) return;
    const cancellableCount =
      (runSummary?.running ?? 0) + (runSummary?.queued ?? 0);
    if (cancellableCount === 0 && stoppableRuns.length === 0) return;
    setStoppingRuns(true);
    try {
      await window.electronAPI.cancelAllCollaborationRuns(room.id);
      onRoomsChanged();
    } catch (err) {
      toast.error("停止失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setStoppingRuns(false);
    }
  }, [room, runSummary, stoppableRuns.length, stoppingRuns, onRoomsChanged]);

  const handleResolveApproval = useCallback(
    async (
      requestId: string,
      decision: "approved" | "denied",
      response?: string,
    ): Promise<void> => {
      if (!room) return;
      setResolvingApprovalId(requestId);
      try {
        const result =
          await window.electronAPI.resolveCollaborationUserApproval({
            roomId: room.id,
            requestId,
            decision,
            response,
          });
        if (!result.ok) {
          toast.error("审批操作失败", { description: result.reason });
          return;
        }
        onRoomsChanged();
      } catch (err) {
        toast.error("审批操作失败", {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setResolvingApprovalId(null);
      }
    },
    [room, onRoomsChanged],
  );

  // S4.5：继续一次已达 A2A 深度上限的交接。主操作 → IPC；带 loading（continuing）/ error（行内）
  // 状态；成功后刷新房间（CHANGED 广播也会 bump，这里显式确保即时）。IPC 逻辑失败返回
  // { ok: false, reason }（不抛），仅 unexpected IPC 错误走 catch。
  const handleContinueDepthStop = useCallback(
    async (envelopeId: string): Promise<void> => {
      if (!room) return;
      setContinuingDepthStopId(envelopeId);
      setDepthStopErrorByEnvelope((prev) => {
        if (!(envelopeId in prev)) return prev;
        const next = { ...prev };
        delete next[envelopeId];
        return next;
      });
      try {
        const res = await window.electronAPI.continueCollaborationDepthStop({
          roomId: room.id,
          envelopeId,
          idempotencyKey: `continue-depth-stop:${envelopeId}`,
        });
        if (res.ok) {
          onRoomsChanged();
        } else {
          setDepthStopErrorByEnvelope((prev) => ({
            ...prev,
            [envelopeId]: res.reason,
          }));
        }
      } catch (err) {
        setDepthStopErrorByEnvelope((prev) => ({
          ...prev,
          [envelopeId]: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        setContinuingDepthStopId(null);
      }
    },
    [room, onRoomsChanged],
  );

  // S4.5：仅本地关闭该深度停止提示（次操作）。不调 IPC、不改后端状态；刷新保留、切房间清空。
  const handleDismissDepthStop = useCallback((envelopeId: string): void => {
    setDismissedDepthStopIds((prev) => {
      if (prev.has(envelopeId)) return prev;
      const next = new Set(prev);
      next.add(envelopeId);
      return next;
    });
  }, []);

  // P2-1：确认继续一个 blocked run —— 主进程新建新 turn（新 runId/fence）续跑，不复活旧 fence。
  // 主操作 → IPC；带 loading（resuming）/ error（行内 + toast）状态；成功后刷新房间（CHANGED 广播
  // 也会 bump，这里显式确保即时）。传稳定 idempotencyKey（resume-blocked:<runId>）使重复点击幂等：
  // 同键重复调用主进程返回同一 newRunId，不二次新建。IPC 逻辑失败返回 { ok: false, reason }（不抛），
  // 仅 unexpected IPC 错误走 catch。旧 blocked run 保持 blocked，故列表项在刷新后仍可见（设计如此，
  // 与远程 Fusion 一致）；重复点击因幂等键而 no-op。
  const handleConfirmResumeBlockedRun = useCallback(
    async (runId: string): Promise<void> => {
      if (!room) return;
      setResumingRunId(runId);
      setResumeErrorByRun((prev) => {
        if (!(runId in prev)) return prev;
        const next = { ...prev };
        delete next[runId];
        return next;
      });
      try {
        const res =
          await window.electronAPI.confirmResumeCollaborationBlockedRun({
            roomId: room.id,
            runId,
            idempotencyKey: `resume-blocked:${runId}`,
          });
        if (res.ok) {
          onRoomsChanged();
        } else {
          setResumeErrorByRun((prev) => ({ ...prev, [runId]: res.reason }));
          toast.error("续跑失败", { description: res.reason });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setResumeErrorByRun((prev) => ({ ...prev, [runId]: msg }));
        toast.error("续跑失败", { description: msg });
      } finally {
        setResumingRunId(null);
      }
    },
    [room, onRoomsChanged],
  );

  // S5：从工作面板定位到时间线 run / 消息。通过 scrollRef 在时间线内查询 [data-run-id] /
  // [data-message-id] 元素并滚动入视 + 短时高亮闪示，便于用户在长时间线里找到关联项。
  // 不传引用给时间线组件，避免侵入其 props；定位完全在页面侧用 scrollRef 完成。
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locateTimeline = useCallback((selector: string): void => {
    const el = scrollRef.current?.querySelector(selector);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("collab-locate-flash");
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(
      () => el.classList.remove("collab-locate-flash"),
      1600,
    );
  }, []);
  const handleLocateRun = useCallback(
    (runId: string): void =>
      locateTimeline(`[data-run-id="${CSS.escape(runId)}"]`),
    [locateTimeline],
  );
  const handleLocateMessage = useCallback(
    (messageId: string): void =>
      locateTimeline(`[data-message-id="${CSS.escape(messageId)}"]`),
    [locateTimeline],
  );

  const confirmAddMember = useCallback(
    async (patch: {
      displayName: string;
      channelId: string;
      modelId: string;
      backend: CollaborationMemberBackend;
      cliWorkerId?: string;
      permissionProfile?: "read-only" | "workspace-write";
      isCoordinator: boolean;
      roleId?: string;
      roleSnapshot?: CollaborationRoleSnapshot;
      botProfileId?: string;
    }): Promise<void> => {
      if (!room) return;
      setShowAddMemberDialog(false);
      setAddingMember(true);
      try {
        await window.electronAPI.addCollaborationMember({
          roomId: room.id,
          displayName: patch.displayName,
          channelId: patch.channelId || undefined,
          modelId: patch.modelId || undefined,
          backend: patch.backend,
          cliWorkerId: patch.cliWorkerId,
          permissionProfile: patch.permissionProfile,
          isCoordinator: patch.isCoordinator,
          roleId: patch.roleId,
          roleSnapshot: patch.roleSnapshot,
          botProfileId: patch.botProfileId,
        });
        onRoomsChanged();
      } catch (err) {
        console.error("[协作室] 添加成员失败:", err);
        toast.error("添加成员失败", {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setAddingMember(false);
      }
    },
    [room, onRoomsChanged],
  );

  const inviteHuman = useCallback(async (): Promise<void> => {
    if (!room || !inviteUserId.trim() || invitingUser) return;
    setInvitingUser(true);
    try {
      await window.electronAPI.inviteCollaborationHumanMember({
        roomId: room.id,
        userId: inviteUserId.trim(),
        displayName: inviteUserId.trim(),
      });
      setInviteUserId("");
      onRoomsChanged();
      toast.success("已发出邀请", {
        description: "对方接受后才能发送房间消息。",
      });
    } catch (err) {
      toast.error("邀请用户失败", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setInvitingUser(false);
    }
  }, [inviteUserId, invitingUser, onRoomsChanged, room]);

  const consentBot = useCallback(
    async (memberId: string, consent: boolean): Promise<void> => {
      if (!room) return;
      try {
        await window.electronAPI.setCollaborationBotOwnerConsent({
          roomId: room.id,
          memberId,
          consent,
        });
        onRoomsChanged();
      } catch (err) {
        toast.error("Bot 授权操作失败", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [onRoomsChanged, room],
  );
  // P2-2：编辑房间目标。权限与 rename 一致（沿用现有 rename 可见性，不扩大权限）；
  // 空字符串允许（清空目标）；与当前值相同则 no-op。归档房间入口 disabled（与 rename 一致）。
  const confirmEditGoal = useCallback(
    async (next: string): Promise<void> => {
      if (!room) return;
      setTextPrompt(null);
      if (next === room.goal) return;
      try {
        await window.electronAPI.updateCollaborationRoom({
          roomId: room.id,
          goal: next,
        });
        onRoomsChanged();
      } catch (err) {
        console.error("[协作室] 编辑目标失败:", err);
        toast.error("编辑目标失败", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [room, onRoomsChanged],
  );

  const confirmRemoveMember = useCallback(
    async (memberId: string): Promise<void> => {
      if (!room) return;
      try {
        await window.electronAPI.removeCollaborationMember({
          roomId: room.id,
          memberId,
        });
        onRoomsChanged();
        const remainingBotCount = members.filter(
          (member) => member.status !== "removed" && member.id !== memberId,
        ).length;
        toast.success("成员已移除", {
          description:
            remainingBotCount <= 1
              ? "当前仅剩一个 Bot；协作室不会自动退出，需要时请点击「结束协作」。"
              : "历史消息和加入时配置副本仍会保留。",
        });
      } catch (err) {
        toast.error("移除成员失败", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [members, room, onRoomsChanged],
  );
  const confirmMemberSettings = useCallback(
    async (patch: {
      memberId: string;
      displayName: string;
      channelId: string;
      modelId: string;
      backend?: CollaborationMemberBackend;
      cliWorkerId?: string;
      permissionProfile?: "read-only" | "workspace-write";
    }): Promise<void> => {
      if (!room) return;
      try {
        await window.electronAPI.updateCollaborationMember({
          roomId: room.id,
          memberId: patch.memberId,
          displayName: patch.displayName,
          channelId: patch.channelId,
          modelId: patch.modelId,
          backend: patch.backend,
          cliWorkerId: patch.cliWorkerId,
          permissionProfile: patch.permissionProfile,
        });
        onRoomsChanged();
      } catch (err) {
        toast.error("更新成员失败", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [room, onRoomsChanged],
  );

  const handleImportWorkspace = useCallback(async (): Promise<void> => {
    const roomId = room?.id;
    if (!roomId) return;
    try {
      const result = await window.electronAPI.importCollaborationWorkspace({
        roomId,
      });
      if (!result.ok) {
        if (result.reason !== "已取消导入") toast.error(result.reason);
        return;
      }
      toast.success("已导入 " + result.files + " 个文件到房间工作区");
      onRoomsChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入工作区失败");
    }
  }, [onRoomsChanged, room?.id]);
  /**
   * 明示退出协作（14 §1）：用户确认后调 exit-with-bridge，主进程精炼协作结论写回原
   * session 面板（系统通知卡）+ 清 fusionRoomId + 房间 paused（保留历史）。成功后由主进程
   * 推送 session_meta_changed（usePersistedSessionMeta 重读 → fusionRoomId 清空 → Chat
   * 切回普通会话壳，面板可见回写 system 卡）+ onCollaborationExited 兜底 bump。失败抛错由
   * DestructiveConfirmDialog 内联提示。
   */
  const handleExitCollaboration = useCallback(async (): Promise<void> => {
    const sourceId = room?.sourceSessionId;
    if (!sourceId) return;
    await window.electronAPI.exitCollaborationWithBridge({
      sessionId: sourceId,
      userConfirmed: true,
    });
    onCollaborationExited?.();
    toast.success("已结束协作", {
      description: "已把协作结论写回原会话，回到普通会话。",
    });
  }, [onCollaborationExited, room?.sourceSessionId]);

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
            initial={{ opacity: 0, filter: "blur(8px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
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
            initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
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
              show: {
                transition: { staggerChildren: 0.08, delayChildren: 0.5 },
              },
            }}
          >
            {WELCOME_FEATURES.map((f) => (
              <motion.div
                key={f.title}
                className="group flex items-start gap-3 rounded-xl border border-border/55 bg-muted/25 px-3.5 py-3 text-left transition-all hover:border-border hover:bg-accent/70 hover:shadow-sm"
                variants={{
                  hidden: { opacity: 0, y: 14, filter: "blur(4px)" },
                  show: {
                    opacity: 1,
                    y: 0,
                    filter: "blur(0px)",
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
                  <span className="block text-xs font-medium text-foreground/90">
                    {f.title}
                  </span>
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={onOpenRemoteSession}
            >
              <Link size={16} weight="regular" />
              连接远程融合会话
            </Button>
            <p className="text-xs text-muted-foreground">
              或从左侧选择一个已有房间，也可连接其他设备上的远程融合会话。
            </p>
          </motion.div>
        </div>
      </div>
    );
  }

  const archived = room.status === "archived";
  const paused = room.status === "paused";
  /**
   * 是否显示「结束协作」：房间由当前单会话桥接而来（room.sourceSessionId 存在且与传入的
   * sourceSessionId 相等；未传 sourceSessionId 时只要存在即显示）。与「归档」语义区分：
   * 结束协作会精炼结论写回原会话并切回普通会话壳，归档只改房间状态。
   */
  const canExitCollaboration = Boolean(
    room.sourceSessionId &&
    (!sourceSessionId || room.sourceSessionId === sourceSessionId),
  );
  const usesSourceSessionWorkspace = Boolean(
    room.sourceSessionId && room.workspaceId,
  );

  return (
    <div className="session-body flex h-full min-h-0 flex-col">
      {/* 头部 */}
      <header className="collab-room-header flex flex-col gap-1 border-b border-border/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h1
            className="flex-1 truncate text-base font-semibold text-foreground"
            title={room.title}
          >
            {room.title}
          </h1>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] transition-colors",
              room.status === "paused" && "bg-amber-500/15 text-amber-600",
              room.status === "active" && "bg-emerald-500/15 text-emerald-600",
              room.status === "archived" && "bg-muted text-muted-foreground",
              room.status === "completed" && "bg-blue-500/15 text-blue-600",
            )}
          >
            {roomStatusLabel(room.status)}
          </span>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="查看工作区绑定"
              >
                <FolderOpen size={13} weight="regular" />
                <span>工作区</span>
                <span className="tabular-nums text-[10px] text-muted-foreground/75">
                  {workspaceBindings.length}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="w-[min(420px,calc(100vw-32px))] overflow-hidden p-0"
            >
              <div className="border-b border-border/60 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-foreground">
                    工作区绑定
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {workspaceBindings.length
                      ? workspaceBindings.length + " 个目录"
                      : "未绑定"}
                  </span>
                </div>
                <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  按用户区分个人目录；协作室共享目录单独标注。
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto p-1.5">
                {workspaceBindings.length ? (
                  workspaceBindings.map((binding) => (
                    <div
                      key={binding.id}
                      className="rounded-md px-2.5 py-2 transition-colors hover:bg-accent/60"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            binding.status === "active"
                              ? "bg-emerald-500"
                              : "bg-amber-500",
                          )}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 truncate text-xs font-medium text-foreground">
                          {binding.displayName}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {binding.label}
                        </span>
                      </div>
                      <div
                        className="mt-1 truncate pl-3.5 font-mono text-[10px] leading-4 text-muted-foreground"
                        title={binding.directory ?? "目录不可用"}
                      >
                        {binding.directory ?? "目录不可用"}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="px-2.5 py-3 text-xs text-muted-foreground">
                    当前协作室没有可展示的工作区目录。
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>
          <div className="collab-room-actions ml-auto flex items-center gap-0.5 border-l border-border/35 pl-1">
            {canExitCollaboration ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 border-destructive/30 px-2 text-[11px] text-destructive hover:bg-destructive/10"
                onClick={() => setExitConfirmOpen(true)}
                title="结束协作，把结论写回原会话并回到普通会话"
              >
                <SignOut size={13} weight="regular" />
                结束协作
              </Button>
            ) : null}
            <CollaborationAddMemberDialog
              open={showAddMemberDialog}
              onOpenChange={setShowAddMemberDialog}
              disabled={addingMember || archived}
              channels={channels}
              cliWorkers={cliWorkers}
              onSave={(patch) => void confirmAddMember(patch)}
            />
            {room.roomWorkspace && !usesSourceSessionWorkspace ? (
              <AppTooltip label="导入个人工作区" side="bottom">
                <button
                  type="button"
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="导入个人工作区"
                  onClick={() => void handleImportWorkspace()}
                >
                  <FolderOpen size={14} />
                </button>
              </AppTooltip>
            ) : null}
            <AppTooltip
              label={workPanelOpen ? "收起工作面板" : "展开工作面板"}
              side="bottom"
            >
              <button
                type="button"
                className={cn(
                  "flex size-7 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
                  workPanelOpen ? "text-primary" : "text-muted-foreground",
                )}
                aria-label={workPanelOpen ? "收起工作面板" : "展开工作面板"}
                aria-pressed={workPanelOpen}
                onClick={() => setWorkPanelOpen((v) => !v)}
              >
                <ListChecks size={14} />
              </button>
            </AppTooltip>
          </div>
        </div>
        <details className="collab-room-info">
          <summary className="collab-room-info__summary">
            <span className="font-medium text-foreground/80">房间信息</span>
            <span className="collab-room-info__summary-meta">
              {members.length} 个成员 · 运行 {runningCount}/{maxConcurrent}
            </span>
            <CaretDown
              size={13}
              aria-hidden="true"
              className="collab-room-info__chevron"
            />
          </summary>
          <div className="collab-room-info__body">
            <div className="collab-room-info__overview">
              <div className="collab-room-info__goal">
                <span className="collab-room-info__eyebrow">房间目标</span>
                <span
                  className={cn(
                    "collab-room-info__goal-text",
                    !room.goal && "is-empty",
                  )}
                  title={room.goal || undefined}
                >
                  {room.goal || "未设置目标"}
                </span>
                <AppTooltip label="编辑目标" side="bottom">
                  <button
                    type="button"
                    className="collab-room-info__edit"
                    aria-label="编辑目标"
                    disabled={archived}
                    onClick={() => setTextPrompt("edit-goal")}
                  >
                    <Target size={13} />
                  </button>
                </AppTooltip>
              </div>
              <div
                className="collab-room-info__stats"
                aria-label="房间运行概览"
              >
                <span className="collab-room-info__stat">
                  <strong>{members.length}</strong>
                  <small>成员</small>
                </span>
                <span className="collab-room-info__stat">
                  <strong>
                    {runningCount}/{maxConcurrent}
                  </strong>
                  <small>运行</small>
                </span>
                {queuedCount > 0 ? (
                  <span className="collab-room-info__stat is-warning">
                    <strong>{queuedCount}</strong>
                    <small>排队</small>
                  </span>
                ) : null}
              </div>
            </div>

            <section
              className="collab-room-info__people"
              aria-labelledby="collab-people-label"
            >
              <div className="collab-room-info__section-head">
                <span id="collab-people-label">参与者</span>
                <span>
                  {
                    humanMembers.filter((human) => human.status === "active")
                      .length
                  }{" "}
                  人在线
                </span>
              </div>
              <div className="collab-room-info__people-list">
                {humanMembers.map((human) => (
                  <span
                    key={human.id}
                    className={cn(
                      "collab-room-person-chip",
                      human.status === "active" && "is-online",
                      human.status === "invited" && "is-invited",
                      human.status === "removed" && "is-removed",
                    )}
                    title={`${human.userId} · ${human.status}`}
                  >
                    <span
                      className="collab-room-person-chip__dot"
                      aria-hidden="true"
                    />
                    <span>{human.displayName}</span>
                    {human.userId === room.ownerUserId ? (
                      <span className="collab-room-person-chip__role">
                        房主
                      </span>
                    ) : null}
                  </span>
                ))}
                {members.map((m) => {
                  const st = memberDisplayStatus(m, runs);
                  const hasBackend = memberHasExecutableBackend(m);
                  return (
                    <CollaborationMemberSettings
                      key={m.id}
                      member={m}
                      channels={channels}
                      cliWorkers={cliWorkers}
                      onSave={(patch) => void confirmMemberSettings(patch)}
                      onRemove={(memberId) =>
                        void confirmRemoveMember(memberId)
                      }
                    >
                      <button
                        type="button"
                        className={cn(
                          "collab-room-person-chip collab-room-bot-chip",
                          st === "running" && "is-running",
                          st === "queued" && "is-queued",
                          st === "awaiting_peer" && "is-waiting",
                          !hasBackend && "is-missing-backend",
                          st === "removed" && "is-removed",
                        )}
                        aria-label={`编辑成员 ${m.displayName}`}
                        title={`${m.displayName} · ${memberStatusLabel(st)} · ${channelLabel(m)}`}
                      >
                        <MemberAvatar
                          member={m}
                          channels={channels}
                          size={18}
                        />
                        <span>{m.displayName}</span>
                        {m.isCoordinator ? (
                          <span className="collab-room-person-chip__role">
                            协调
                          </span>
                        ) : null}
                        {!hasBackend && st !== "removed" ? (
                          <span className="collab-room-person-chip__warning">
                            无渠道
                          </span>
                        ) : null}
                        <span
                          className={cn(
                            "collab-status-dot inline-block size-1.5 rounded-full",
                            st === "running" && "animate-pulse bg-emerald-500",
                            st === "queued" && "bg-amber-500",
                            st === "awaiting_peer" &&
                              "animate-pulse bg-sky-500",
                            st === "idle" && "bg-muted-foreground/40",
                            st === "offline" && "bg-muted-foreground/20",
                            st === "removed" && "bg-muted-foreground/30",
                          )}
                        />
                      </button>
                    </CollaborationMemberSettings>
                  );
                })}
                {room.ownerUserId === "local-user" ? (
                  <div className="collab-room-invite">
                    <Input
                      value={inviteUserId}
                      onChange={(event) => setInviteUserId(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void inviteHuman();
                      }}
                      placeholder="邀请用户 ID"
                      className="collab-room-invite__input"
                      aria-label="输入用户 ID 邀请"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="collab-room-invite__button"
                      disabled={!inviteUserId.trim() || invitingUser}
                      onClick={() => void inviteHuman()}
                    >
                      邀请
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>

            {members.some(
              (member) =>
                member.botProfileId &&
                member.botOwnerUserId !== (room.ownerUserId ?? "local-user"),
            ) ? (
              <section
                className="collab-room-info__notice"
                aria-label="Bot 授权"
              >
                <div className="collab-room-info__section-head">
                  <span>Bot 授权</span>
                  <span>需要处理</span>
                </div>
                <div className="collab-room-info__notice-list">
                  {members
                    .filter(
                      (member) =>
                        member.botProfileId &&
                        member.botOwnerUserId !==
                          (room.ownerUserId ?? "local-user"),
                    )
                    .map((member) => (
                      <span
                        key={member.id}
                        className="inline-flex items-center gap-1.5"
                      >
                        <span>{member.displayName}</span>
                        {member.ownerConsent ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-[11px] text-emerald-700 dark:text-emerald-300"
                            onClick={() => void consentBot(member.id, false)}
                          >
                            已授权 · 撤回
                          </Button>
                        ) : member.botOwnerUserId === "local-user" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 px-1.5 text-[11px]"
                            onClick={() => void consentBot(member.id, true)}
                          >
                            授权运行
                          </Button>
                        ) : (
                          <span className="text-amber-700 dark:text-amber-300">
                            等待所有人授权
                          </span>
                        )}
                      </span>
                    ))}
                </div>
              </section>
            ) : null}

            {pendingMailbox.length > 0 ? (
              <ul className="collab-room-info__mailbox" aria-label="待处理信箱">
                {pendingMailbox.slice(0, 4).map((env) => (
                  <li
                    key={env.id}
                    className="truncate rounded-md bg-sky-500/10 px-2 py-1 text-[11px] text-sky-700 dark:text-sky-300"
                    title={env.payload}
                  >
                    <span className="font-medium">
                      {env.type === "question"
                        ? "待回复"
                        : env.type === "reply"
                          ? "回复"
                          : "通知"}
                    </span>
                    {" · "}
                    {memberName(env.fromMemberId)} →{" "}
                    {memberName(env.toMemberId)}
                    {" · "}
                    {env.payload}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>
      </header>

      {/* S5：主区改为「左：时间线+输入 | 右：工作面板」行布局。输入栈移入左列（session-chat-col），
           使其只覆盖左列宽度、不遮挡右侧面板；面板收起时左列自动占满。 */}
      <div className="flex min-h-0 flex-1">
        <div className="session-chat-col relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* P2-1：待确认续跑（blocked run / 待审批 / 深度停止 / outbox 等可观察项）。
               blocked_run 出「确认继续」按钮 → confirm-resume-blocked IPC（主进程新建 turn，
               新 runId/fence，不复活旧 fence）；pending_approval / depth_stop 只读提示下钻到
               时间线既有审批 / 深度停止卡片；awaiting_peer / awaiting_user / mailbox_outbox 纯观察。 */}
          <CollaborationContinuationList
            continuations={continuations}
            resumingRunId={resumingRunId}
            resumeErrorByRun={resumeErrorByRun}
            onConfirmResume={(runId) =>
              void handleConfirmResumeBlockedRun(runId)
            }
          />
          {/* 时间线（S3.5-c：一 run 一卡，对齐会话信息流） */}
          <CollaborationTimeline
            key={room.id}
            messages={messages}
            runs={runs}
            members={members}
            channels={channels}
            streamByRun={streamByRun}
            cancellingId={cancellingId}
            retryingId={retryingId}
            onCancelRun={(runId) => void handleCancelRun(runId)}
            onRetryRun={(runId, memberId) =>
              void handleRetryRun(runId, memberId)
            }
            scrollRef={scrollRef}
            mailbox={mailbox}
            maxDepth={room.maxA2ADepth}
            handoffEnabled={room.a2aHandoffEnabled}
            dismissedDepthStopIds={dismissedDepthStopIds}
            continuingDepthStopId={continuingDepthStopId}
            depthStopErrorByEnvelope={depthStopErrorByEnvelope}
            onContinueDepthStop={(envelopeId) =>
              void handleContinueDepthStop(envelopeId)
            }
            onDismissDepthStop={handleDismissDepthStop}
            approvals={approvals}
            resolvingApprovalId={resolvingApprovalId}
            onResolveApproval={(requestId, decision, response) =>
              void handleResolveApproval(requestId, decision, response)
            }
            onOpenAttachment={onOpenAttachment}
            hasMoreOlder={Boolean(messageCursor || runCursor)}
            loadingOlder={loadingOlderHistory}
            onLoadOlder={loadOlderHistory}
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
                    所有成员都未绑定可用渠道（kscc /
                    外部渠道），发送后无法跑起任何回复。
                  </p>
                  <button
                    type="button"
                    className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                    onClick={() => onOpenSettings?.("channels")}
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
                    onClick={() => onOpenSettings?.("channels")}
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
                    attachments={pendingAttachments}
                    onAttachmentsChange={setPendingAttachments}
                    onPreviewAttachment={onPreviewAttachment}
                    mentionRoles={[
                      ...(activeMembers.length > 0
                        ? [COLLABORATION_ALL_MENTION]
                        : []),
                      ...activeMembers.map((m) => ({
                        id: m.id,
                        displayName: m.displayName,
                      })),
                    ]}
                    onMentionChange={setComposerMentionIds}
                    footer={
                      <div className="composer-footer-bar flex h-7 items-center justify-between gap-1 px-2 pb-2 pt-0.5">
                        <div className="composer-footer-bar__left flex h-7 min-w-0 items-center gap-0.5">
                          <AppTooltip label="添加附件">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="shrink-0 rounded-xl text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                              onClick={() => void handleOpenFileDialog()}
                              aria-label="添加附件"
                            >
                              <Plus className="size-4" />
                            </Button>
                          </AppTooltip>
                        </div>
                        <div className="composer-footer-bar__right flex h-7 min-w-0 shrink items-center gap-0.5">
                        {(stoppableRuns.length > 0 ||
                          (runSummary?.running ?? 0) +
                            (runSummary?.queued ?? 0) >
                            0) &&
                          !hasSendable ? (
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
                            hasDraft={hasSendable}
                            onSend={() => void send()}
                            onConsultPreset={() => undefined}
                          />
                        )}
                        </div>
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
            boardTasks={boardTasks}
            boardSummary={boardSummary}
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
        open={textPrompt === "edit-goal"}
        title="编辑房间目标"
        label="留空可清除目标。"
        defaultValue={room.goal}
        multiline
        allowEmpty
        rows={4}
        confirmLabel="保存"
        onCancel={() => setTextPrompt(null)}
        onConfirm={(goal) => void confirmEditGoal(goal)}
      />
      <DestructiveConfirmDialog
        open={exitConfirmOpen}
        onOpenChange={setExitConfirmOpen}
        title="结束协作？"
        description={
          <>
            <p className="mb-1">
              将把协作结论精炼写回原会话；协作室记录保留（暂停）。
            </p>
            <p>本标签回到普通会话，可继续单会话对话。</p>
          </>
        }
        confirmLabel="结束并写回"
        pendingLabel="正在结束协作…"
        onConfirm={handleExitCollaboration}
      />
    </div>
  );
}
