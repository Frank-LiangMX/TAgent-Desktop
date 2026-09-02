/**
 * 协作室服务（Stage 3：多成员并行 + 协调者路由）
 *
 * 在 repository 之上做：输入校验、ID 生成、默认值、状态转换、mention 解析、run 触发与调度。
 *
 * Stage 3 新增（在 S2 单成员闭环之上）：
 * - appendUserMessage 落盘用户消息前用 resolveCollaborationMentions 把结构化 mentions /
 *   @displayName 解析为 targetMemberIds（@all → 全部成员；无 @ → []，由 trigger 路由协调者）。
 * - triggerRunForMessage 按解析目标创建多个 run（各幂等键含 memberId+messageId），经
 *   RoomScheduler 启动：房间级 maxConcurrentRuns + 成员内串行 + FIFO 公平队列。
 * - 多目标并行扇出；一方 failed 不取消另一方；结果各自落盘 member 消息。
 * - addMember：向已有房间加成员（displayName + 自动绑默认渠道）。
 *
 * Stage 2 保留：
 * - run 状态机：queued → running → done | failed | cancelled（CAS 转换，race-safe）。
 * - run 完成后落盘成员消息（done）或系统警告（failed），并广播 CHANGED。
 * - cancelRun：排队中→dequeue；running→abort 后端调用；均置 cancelled + 同步成员状态。
 * - recoverInterruptedRuns：启动时安全恢复未启动的 queued run；running/awaiting run 标记为 blocked，
 *   进入用户确认续跑流程，避免重启后「假 running」或自动重放未知副作用（02-RUNTIME-A2A-SPEC §14）。
 * - 幂等：同一 (triggerMessageId, memberId) 只产生一个 run（collaborationRunIdempotencyKey）。
 *
 * adapter 可注入（测试用 mock；默认 ChannelBackendAdapter 真实调用外部渠道模型）。
 *
 * 设计参考：apps/electron/src/main/lib/ipc/channel-service.ts（class + static create）
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  basename,
} from "node:path";
import {
  COLLABORATION_LOGICAL_SESSION_ID_PREFIX,
  COLLABORATION_MEMBER_ID_PREFIX,
  COLLABORATION_MESSAGE_ID_PREFIX,
  COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS,
  COLLABORATION_ROOM_ID_PREFIX,
  COLLABORATION_ROOM_MAX_MEMBERS,
  COLLABORATION_RUN_ID_PREFIX,
  COLLABORATION_ROOM_TASK_ID_PREFIX,
  COLLABORATION_ROOM_TASK_SUMMARY_MAX_LENGTH,
  COLLABORATION_ARTIFACT_ID_PREFIX,
  COLLABORATION_ARTIFACT_MAX_CONTENT_BYTES,
  COLLABORATION_ARTIFACT_SUMMARY_MAX_LENGTH,
  collaborationRunIdempotencyKey,
  type CollaborationMessage,
  collaborationContinuationIdempotencyKey,
  collaborationEnvelopeIdempotencyKey,
  canContinueCollaborationDepthStop,
  listLocalCollaborationContinuations,
  collaborationLoopFingerprint,
  isCollaborationDuplicateReply,
  isCollaborationSelfSend,
  isCollaborationRoomStatus,
  isCollaborationRoomTaskStatus,
  nextCollaborationA2ADepth,
  nextCollaborationMentionAliases,
  recommendedCollaborationHandoffDepth,
  COLLABORATION_SUMMARY_DEFAULT_EVERY_UTTERANCES,
  latestCollaborationRoomSummaryText,
  projectCollaborationTurnContext,
  resolveCollaborationMentions,
  sanitizeAssistantTextForDisplay,
  transitionCollaborationMailboxState,
  transitionCollaborationRoomTaskStatus,
  validateCreateCollaborationRoomInput,
  validateCollaborationRoomBudget,
  mapKanbanTaskToProjected,
  summarizeProjectedBoardTasks,
  createRoomBotSeatFromProfile,
  type CollaborationArtifact,
  type FileAttachment,
  type CollaborationMailboxEnvelope,
  type CollaborationMember,
  type CollaborationMemberCapabilities,
  type CollaborationRoom,
  type CollaborationHumanMember,
  type CollaborationRoomChangedPayload,
  type CollaborationRoomTask,
  type CollaborationWorkspaceBindingView,
  type CollaborationUserApprovalRequest,
  type CollaborationRoomTaskStatus,
  type CollaborationTextDeltaPayload,
  type CollaborationRun,
  type CollaborationRunStatus,
  type CollaborationSerializedRunError,
  type LocalCollaborationContinuationItem,
  type ConfirmResumeBlockedRunInput,
  type ConfirmResumeBlockedRunResult,
  type RetryCollaborationRunInput,
  type RetryCollaborationRunResult,
  type CreateCollaborationMemberInput,
  type RemoveCollaborationMemberInput,
  type CreateCollaborationRoomInput,
  type InviteCollaborationHumanMemberInput,
  type JoinCollaborationHumanMemberInput,
  type LeaveCollaborationHumanMemberInput,
  type RemoveCollaborationHumanMemberInput,
  type SetCollaborationBotOwnerConsentInput,
  type UpdateCollaborationRoomInput,
  type UpdateCollaborationMemberInput,
  type AppendCollaborationUserMessageInput,
  type CreateCollaborationRoomTaskInput,
  type UpdateCollaborationRoomTaskInput,
  type MemberBackendAdapter,
  type MemberSessionLifecycleAdapter,
  type MemberSessionHandle,
  type MemberTurnInput,
  type ReadCollaborationArtifactResult,
  type SourceSessionExcerptReader,
  type BoardProjectedSummary,
  type BoardProjectedTask,
  type ListCollaborationMessagesInput,
  type ListCollaborationRunsInput,
  type CollaborationMessagesPage,
  type CollaborationRunsPage,
  type CollaborationRunSummary,
} from "@tagent/shared";
import {
  COLLABORATION_WORKSPACE_COMMAND_TIMEOUT_MS,
  COLLABORATION_WORKSPACE_COMMAND_TOTAL_OUTPUT_BYTES,
  COLLABORATION_WORKSPACE_READ_MAX_BYTES,
  COLLABORATION_WORKSPACE_SEARCH_MAX_DEPTH,
  COLLABORATION_WORKSPACE_SEARCH_MAX_RESULTS,
  COLLABORATION_WORKSPACE_WRITE_MAX_BYTES,
  COLLABORATION_WORKSPACE_PATCH_MAX_BYTES,
} from "@tagent/shared";
import {
  runWorkspaceCommand,
  type WorkspaceCommandRunResult,
} from "./workspace-command-runner";
import {
  appendMembers,
  appendMessage as appendMessageToRepository,
  appendMailboxEnvelope,
  appendArtifact,
  getArtifact,
  getCollaborationSummary,
  getMailboxEnvelope,
  getMember,
  getRoom,
  getRun,
  getRoomTask,
  listActiveMailboxForMember,
  listArtifactsByRoom,
  listMailboxByRequest,
  listMailboxByRoom,
  listMembersByRoom,
  listMessagesByRoom,
  listMessagesByRoomPage,
  appendRoomEvent,
  listRoomEvents,
  listRunsByRoom,
  listRunsByRoomPage,
  listRunsByStatus,
  listRoomTasksByRoom,
  loadMembers,
  loadRooms,
  getUserApprovalRequest,
  listUserApprovalRequests,
  upsertMailboxEnvelope,
  upsertMember,
  upsertRoom,
  upsertRun,
  upsertRoomTask,
  upsertUserApprovalRequest,
  saveRoomTaskIfCurrent,
  findRunByIdempotencyKey,
  findMessageByIdempotencyKey,
} from "./collaboration-room-repository";
import {
  abortCodexRoomSession,
  channelSupportsRoomToolBridge,
  MemberBackendResolveError,
  pickDefaultMemberChannelBinding,
} from "./member-backend-adapter";
import { createDefaultChannelMemberStack } from "./member-backend-factory";
import {
  CollaborationSummaryRunner,
  type CollaborationSummaryModelCaller,
} from "./collaboration-room-summary";
import {
  RoomScheduler,
  type RoomSchedulerEntry,
} from "./collaboration-room-scheduler";
import { resolveWorkspaceById } from "../workspace/workspace-manager";
import {
  FileFusionRoomWorkspaceLeaseStore,
  type WorkspaceLease,
} from "./fusion-room-workspace-lease-store";
import { getCollaborationRoomWorkspaceDir } from "../config/config-paths";
import * as kanbanStore from "../kanban/kanban-store";
import { getActiveBotMemories } from "../bot/bot-memory-service";
import { getBotProfileRecord } from "../bot/bot-profile-service";
import { getSessionMeta, updateSessionMeta } from "../agent/session-store";
import {
  getAttachmentAbsolutePath,
  saveAttachment,
} from "../attachment-service";

/** CHANGED 广播类型（主进程 → renderer） */
export type CollaborationRoomBroadcast = (
  roomId: string,
  kind: CollaborationRoomChangedPayload["kind"],
) => void;

/** 流式正文增量回调（独立于 CHANGED，避免每 token 全量刷新） */
export type CollaborationTextDeltaHandler = (
  payload: CollaborationTextDeltaPayload,
) => void;

/** 服务构造选项（adapter / broadcast 可注入） */
export interface CollaborationRoomServiceOptions {
  /**
   * 成员后端适配器（默认带 lifecycle 的 ChannelBackendAdapter；测试可注入 mock）。
   *
   * 注入 adapter 但**不**注入 {@link lifecycle} → 保持旧行为（无 lifecycle），兼容既有测试：
   * cancelRun 只 abort 本地 controller，不调 interruptSession。
   */
  adapter?: MemberBackendAdapter;
  /**
   * 成员会话生命周期适配器（测试可注入 Fake）。默认与默认 adapter 共享同一
   * {@link ChannelMemberSessionLifecycleAdapter}（生产装配）；注入后 cancelRun 走
   * `interruptSession` 取消进行中的 turn。仅注入本字段而不注入 adapter 时，默认 adapter
   * 仍绑定到默认栈自身的 lifecycle，故一般与 mock adapter 成对注入以观察中断行为。
   */
  lifecycle?: MemberSessionLifecycleAdapter;
  /** CHANGED 广播（默认 noop；IPC 层注入真实广播） */
  broadcast?: CollaborationRoomBroadcast;
  /** 流式正文增量（默认 noop） */
  onTextDelta?: CollaborationTextDeltaHandler;
  /** 房间摘要模型调用（注入假实现可测 S1–S8；默认复用协调者 channel/model） */
  summaryModelCaller?: CollaborationSummaryModelCaller;
  /** 发布版本地模式：拒绝远程用户和非本机 Bot 所有权。 */
  localOnly?: boolean;
  /** 由单会话桥接服务注入的受控原会话摘录读取器。 */
  sourceSessionExcerptReader?: SourceSessionExcerptReader;
}

/** Stage 1/2 静态成员的默认能力（全 false，S3+ 由真实 probe 填充） */
const DEFAULT_MEMBER_CAPABILITIES: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
};

function genId(prefix: string): string {
  return `${prefix}${randomUUID()}`;
}

function noopBroadcast(): void {
  /* noop：测试 / 未注入广播时用 */
}

const LOCAL_HUMAN_USER_ID = "local-user";

function buildRoomWorkspace(roomId: string, now: number) {
  return {
    id: "rws_" + roomId,
    roomId,
    status: "active" as const,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 解析房间成员实际可访问的文件根目录。
 *
 * 从单会话升级的房间虽然也有 roomWorkspace 元数据，但它应继续绑定来源会话的
 * 项目工作区；否则 roomWorkspace 会把成员悄悄带到一个空的隔离目录，原会话里的
 * 项目文件就会“消失”。独立创建的房间仍使用隔离的服务工作区。
 */
function resolveRoomWorkspaceRoot(room: CollaborationRoom): string | undefined {
  const isSourceSessionWorkspace = Boolean(
    room.sourceSessionId && room.workspaceId,
  );
  if (isSourceSessionWorkspace) {
    const workspace = resolveWorkspaceById(room.workspaceId!);
    if (
      !workspace?.projectDirectory ||
      !existsSync(workspace.projectDirectory)
    ) {
      // 来源工作区失效时 fail-closed，绝不能回退到空的房间目录并误写错位置。
      return undefined;
    }
    return realpathSafe(workspace.projectDirectory);
  }

  if (room.roomWorkspace) {
    if (room.roomWorkspace.roomId !== room.id) return undefined;
    const root = getCollaborationRoomWorkspaceDir(room.id);
    for (const child of ["shared", "members", "tasks", "artifacts", "audit"]) {
      const dir = join(root, child);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    return realpathSafe(root);
  }
  if (room.workspaceId) {
    const workspace = resolveWorkspaceById(room.workspaceId);
    if (
      !workspace?.projectDirectory ||
      !existsSync(workspace.projectDirectory)
    ) {
      return undefined;
    }
    return realpathSafe(workspace.projectDirectory);
  }
  return undefined;
}

/**
 * 给成员明确注入宿主已经绑定的工作区，而不是只把 workspaceId 留在运行时字段里。
 * 绝对路径由宿主解析，模型只能通过 workspace_* 工具访问受守卫的相对路径。
 */
function buildRoomWorkspaceContextPrompt(
  room: CollaborationRoom,
  workspaceRoot: string | undefined,
): string {
  if (!workspaceRoot) {
    return [
      "## 工作区上下文（宿主提供）",
      "当前协作室没有可访问的工作区。不要假设项目文件存在，也不要编造文件路径；如果任务需要文件操作，应先告知用户工作区不可用。",
    ].join("\n");
  }

  const isSourceSessionWorkspace = Boolean(
    room.sourceSessionId && room.workspaceId,
  );
  return [
    "## 工作区上下文（宿主提供）",
    "当前可访问的工作区根目录：" + workspaceRoot,
    isSourceSessionWorkspace
      ? "这是从来源单会话继承的项目工作区，协作室成员共享这份项目目录。"
      : "这是当前协作室的隔离服务工作区，不等同于用户个人项目目录。",
    "文件工具的 path 必须使用相对于该根目录的路径；需要了解项目结构时先使用 workspace_search。不要根据前情提要或其他成员正文臆造工作区路径。",
  ].join("\n");
}
function resolveHumanActorUserId(value?: string): string {
  return value?.trim() || LOCAL_HUMAN_USER_ID;
}

function defaultHumanMemberForRoom(
  room: CollaborationRoom,
): CollaborationHumanMember {
  const ownerUserId = room.ownerUserId?.trim() || LOCAL_HUMAN_USER_ID;
  return {
    id: "hm_legacy_" + room.id + "_" + ownerUserId,
    roomId: room.id,
    userId: ownerUserId,
    displayName: ownerUserId === LOCAL_HUMAN_USER_ID ? "我" : ownerUserId,
    workspaceId: room.workspaceId,
    status: "active",
    joinedAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}
export class CollaborationRoomService {
  private readonly adapter: MemberBackendAdapter;
  /**
   * 成员会话生命周期适配器（P1-2c）。默认装配（与默认 adapter 共享同一 lifecycle）；
   * 调用方只注入 adapter 不注入 lifecycle 时为 undefined（旧行为，兼容既有测试）。
   * cancelRun 据此走 interruptSession 取消进行中的 turn。
   */
  private readonly lifecycle: MemberSessionLifecycleAdapter | undefined;
  private readonly broadcast: CollaborationRoomBroadcast;
  private readonly onTextDelta: CollaborationTextDeltaHandler;
  private readonly localOnly: boolean;
  private sourceSessionExcerptReader: SourceSessionExcerptReader | undefined;
  /** 房间运行调度器（房间并发 + 成员串行 + FIFO 队列） */
  private readonly scheduler: RoomScheduler;
  /** 持久化工作区租约：文件操作按路径串行，命令按整个工作区串行。 */
  private readonly workspaceLeases: FileFusionRoomWorkspaceLeaseStore;
  /** 房间共享摘要 runner（§6.6：不占 maxConcurrentRuns 槽，fail-closed 不阻塞发言） */
  private readonly summaryRunner: CollaborationSummaryRunner;
  /** 运行中 run 的 AbortController（cancelRun 用） */
  private readonly abortControllers: Map<string, AbortController> = new Map();
  /** 运行中 run 的执行 Promise（测试可 await；完成后自动清除） */
  private readonly inflight: Map<string, Promise<void>> = new Map();
  /** 有根消息预算时，同一 root 在本进程内串行占用预算检查窗口，避免并行 run 读到同一旧余额。 */
  private readonly rootBudgetTails = new Map<string, Promise<void>>();

  private constructor(opts: CollaborationRoomServiceOptions) {
    // P1-2c：默认装配带 lifecycle 的 Channel 栈（adapter 已 bindTurnAbort 到该 lifecycle，
    // 使 interruptSession 可取消进行中的 turn）。调用方只传 adapter 不传 lifecycle → 旧行为
    // （无 lifecycle），兼容既有只注入 mock adapter 的测试。
    const defaultStack = createDefaultChannelMemberStack();
    this.adapter = opts.adapter ?? defaultStack.adapter;
    this.lifecycle =
      opts.lifecycle ?? (opts.adapter ? undefined : defaultStack.lifecycle);
    this.broadcast = opts.broadcast ?? noopBroadcast;
    this.onTextDelta = opts.onTextDelta ?? (() => undefined);
    this.localOnly = opts.localOnly === true;
    this.sourceSessionExcerptReader = opts.sourceSessionExcerptReader;
    this.summaryRunner = new CollaborationSummaryRunner({
      modelCaller: opts.summaryModelCaller,
    });
    this.workspaceLeases = new FileFusionRoomWorkspaceLeaseStore();
    this.scheduler = this.createScheduler();
  }

  static create(
    opts?: CollaborationRoomServiceOptions,
  ): CollaborationRoomService {
    return new CollaborationRoomService(opts ?? {});
  }

  /** 接通 P2 桥接 host tool；reader 只由主进程注入，模型不可替换。 */
  setSourceSessionExcerptReader(
    reader: SourceSessionExcerptReader | undefined,
  ): void {
    this.sourceSessionExcerptReader = reader;
  }

  /**
   * 成员会话生命周期适配器（P1-2c）。默认装配时为 {@link ChannelMemberSessionLifecycleAdapter}
   *（与默认 adapter 共享同一实例）；只注入 adapter 不注入 lifecycle 的 legacy 配置为 undefined。
   * 暴露供测试断言默认装配，以及未来 interrupt/heartbeat 监控接线消费。
   */
  get memberLifecycle(): MemberSessionLifecycleAdapter | undefined {
    return this.lifecycle;
  }

  /** 构造默认调度器：读 room.maxConcurrentRuns；start 回调 fire-and-forget executeRun + 记 inflight */
  private createScheduler(): RoomScheduler {
    return new RoomScheduler({
      isRoomRunnable: (roomId) => getRoom(roomId)?.status === "active",
      getMaxConcurrentRuns: (roomId) => {
        const room = getRoom(roomId);
        return Math.max(
          1,
          room?.maxConcurrentRuns ??
            COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS,
        );
      },
      start: (entry: RoomSchedulerEntry) => {
        // queued run 可能经历了成员配置/房间预算/目标消息变化；启动时重新读取
        // 权威快照，不能把入队时的旧对象直接带进执行层。
        const latestRoom = getRoom(entry.roomId) ?? entry.room;
        const latestMember = getMember(entry.memberId) ?? entry.member;
        const latestTrigger =
          listMessagesByRoom(entry.roomId).find(
            (message) => message.id === entry.run.triggerMessageId,
          ) ?? entry.triggerMessage;
        const latestRun = getRun(entry.runId) ?? entry.run;
        const exec = this.executeRun(
          latestRoom,
          latestMember,
          latestRun,
          latestTrigger,
        ).catch((err) => {
          // executeRun 内部已处理所有终态；此处兜底防止 unhandledRejection
          console.error(
            `[协作室] executeRun 未捕获错误 run=${entry.run.id}:`,
            err,
          );
        });
        this.inflight.set(entry.run.id, exec);
      },
    });
  }

  /** 读取房间事件账本；客户端只读投影，不能直接写 events.json。 */
  listRoomEvents(roomId: string) {
    return listRoomEvents(roomId);
  }

  private recordRoomEvent(input: Parameters<typeof appendRoomEvent>[0]): void {
    try {
      appendRoomEvent(input);
    } catch (error) {
      // 本地旧 JSON 投影已经落盘时，事件账本失败不能让用户消息丢失；
      // 服务端实现必须把 event append 与 projection 放进同一事务/版本 gate。
      console.error("[协作室] RoomEvent 记录失败:", error);
    }
  }

  /** 记录一次成员 turn 的 usage；即使终态被取消，已发生的模型消耗也保留审计事件。 */
  private recordRunUsage(
    room: CollaborationRoom,
    member: CollaborationMember,
    run: CollaborationRun,
    usage: NonNullable<CollaborationRun["usage"]>,
  ): void {
    const payer =
      member.botOwnerUserId?.trim() ||
      room.ownerUserId?.trim() ||
      LOCAL_HUMAN_USER_ID;
    this.recordRoomEvent({
      roomId: room.id,
      type: "usage.recorded",
      actorUserId: payer,
      entityId: run.id,
      causationId: run.id,
      idempotencyKey: "usage:" + run.id + ":" + (run.fence ?? 0),
      payload: {
        runId: run.id,
        memberId: member.id,
        botOwnerUserId: member.botOwnerUserId,
        backend: member.backend,
        channelId: member.channelId,
        modelId: member.modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        wallTimeMs: usage.wallTimeMs,
        toolCalls: usage.toolCalls,
        costUsd: usage.costUsd,
      },
    });
  }
  private appendRoomMessage(message: CollaborationMessage): void {
    appendMessageToRepository(message);
    this.recordRoomEvent({
      roomId: message.roomId,
      type: "message.appended",
      actorUserId: message.authorId || "system",
      entityId: message.id,
      idempotencyKey: "message-appended:" + message.id,
      payload: {
        messageId: message.id,
        authorType: message.authorType,
        authorId: message.authorId,
        kind: message.kind,
        content: message.content,
        visibility: message.visibility,
        targetMemberIds: message.targetMemberIds,
        replyToMessageId: message.replyToMessageId,
        rootMessageId: message.rootMessageId,
        causationId: message.causationId,
        runId: message.runId,
        taskId: message.taskId,
        attachments: message.attachments,
        depth: message.depth,
        createdAt: message.createdAt,
      },
    });
  }
  // ===== Room =====

  /** 列出全部房间（默认不含 archived，按 updatedAt 倒序） */
  listRooms(includeArchived = false): CollaborationRoom[] {
    const rooms = loadRooms();
    const filtered = includeArchived
      ? rooms
      : rooms.filter((r) => r.status !== "archived");
    return filtered.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 取单个房间（不存在返回 undefined） */
  getRoomById(roomId: string): CollaborationRoom | undefined {
    return getRoom(roomId);
  }

  /**
   * 创建协作室房间（含可选静态成员）。
   *
   * 协调者解析：取第一个 isCoordinator=true 的成员；若无标记但提供了成员，
   * 指派第一个成员为协调者（满足「一个 room 一个协调者」不变量的骨架版）；
   * 空白团队（无成员）coordinatorMemberId 为空字符串。
   */
  /** 列出房间内真实用户成员；旧房间缺省派生 owner，不静默升权。 */
  listHumanMembers(roomId: string): CollaborationHumanMember[] {
    const room = getRoom(roomId);
    if (!room) throw new Error("房间不存在");
    const stored = room.humanMembers;
    return stored && stored.length > 0
      ? stored.slice().sort((a, b) => a.joinedAt - b.joinedAt)
      : [defaultHumanMemberForRoom(room)];
  }

  /**
   * 返回当前宿主可展示的工作区绑定，不把路径塞进共享房间实体。
   * 用户工作区按成员标注；独立协作室额外展示一个房间共享工作区。
   */
  listWorkspaceBindings(roomId: string): CollaborationWorkspaceBindingView[] {
    const room = getRoom(roomId);
    if (!room) throw new Error("房间不存在");

    const bindings: CollaborationWorkspaceBindingView[] = [];
    const members = this.listHumanMembers(room.id);
    for (const member of members) {
      if (!member.workspaceId) continue;
      const workspace = resolveWorkspaceById(member.workspaceId);
      const directory = workspace?.projectDirectory;
      bindings.push({
        id: "user:" + member.userId + ":" + member.workspaceId,
        userId: member.userId,
        displayName: member.displayName,
        label: "个人工作区",
        workspaceId: member.workspaceId,
        directory,
        kind: "user-project",
        status: directory ? "active" : "unavailable",
      });
    }

    if (room.roomWorkspace && !(room.sourceSessionId && room.workspaceId)) {
      const directory = getCollaborationRoomWorkspaceDir(room.id);
      bindings.push({
        id: "room:" + room.id,
        userId: "room",
        displayName: "协作室",
        label: "共享工作区",
        workspaceId: room.roomWorkspace.id,
        directory,
        kind: "room-shared",
        status: directory ? "active" : "unavailable",
      });
    }

    if (bindings.length === 0 && room.sourceSessionId && room.workspaceId) {
      const workspace = resolveWorkspaceById(room.workspaceId);
      const directory = workspace?.projectDirectory;
      bindings.push({
        id: "owner:" + (room.ownerUserId ?? LOCAL_HUMAN_USER_ID),
        userId: room.ownerUserId ?? LOCAL_HUMAN_USER_ID,
        displayName: room.ownerUserId === LOCAL_HUMAN_USER_ID ? "我" : "房主",
        label: "来源项目工作区",
        workspaceId: room.workspaceId,
        directory,
        kind: "user-project",
        status: directory ? "active" : "unavailable",
      });
    }

    return bindings;
  }

  private saveHumanMembers(
    room: CollaborationRoom,
    humanMembers: CollaborationHumanMember[],
  ): CollaborationRoom {
    const updated = { ...room, humanMembers, updatedAt: Date.now() };
    upsertRoom(updated);
    this.recordRoomEvent({
      roomId: room.id,
      type: "human-member.changed",
      actorUserId: room.ownerUserId ?? "local-user",
      entityId: room.id,
      payload: { members: humanMembers },
    });
    return updated;
  }
  private requireRoomOwner(
    room: CollaborationRoom,
    actorUserId?: string,
  ): string {
    const actor = resolveHumanActorUserId(actorUserId);
    const owner = room.ownerUserId?.trim() || LOCAL_HUMAN_USER_ID;
    if (actor !== owner) throw new Error("只有房主可以执行该房间操作");
    return actor;
  }

  /** 邀请用户；服务端模式由网关接管，发布版本地模式直接拒绝。 */
  inviteHumanMember(
    input: InviteCollaborationHumanMemberInput,
  ): CollaborationHumanMember {
    const room = getRoom(input.roomId);
    if (!room) throw new Error("房间不存在");
    if (room.status === "archived") throw new Error("已归档房间不能邀请用户");
    if (this.localOnly)
      throw new Error("当前发布版是本地融合模式，不支持邀请其他用户");
    this.requireRoomOwner(room, input.actorUserId);
    const userId = input.userId?.trim();
    const displayName = input.displayName?.trim() || userId;
    if (!userId) throw new Error("被邀请用户 ID 不能为空");
    if (!displayName) throw new Error("被邀请用户显示名不能为空");
    const now = Date.now();
    const members = this.listHumanMembers(room.id);
    if (userId === (room.ownerUserId?.trim() || LOCAL_HUMAN_USER_ID)) {
      return (
        members.find((member) => member.userId === userId) ??
        defaultHumanMemberForRoom(room)
      );
    }
    const existing = members.find((member) => member.userId === userId);
    if (existing && existing.status === "active")
      throw new Error("该用户已经在房间内");
    const next: CollaborationHumanMember = existing
      ? {
          ...existing,
          displayName,
          workspaceId: input.workspaceId ?? existing.workspaceId,
          status: "invited",
          leftAt: undefined,
          updatedAt: now,
        }
      : {
          id: genId("hm_"),
          roomId: room.id,
          userId,
          displayName,
          workspaceId: input.workspaceId,
          status: "invited",
          joinedAt: now,
          updatedAt: now,
        };
    this.saveHumanMembers(
      room,
      members.filter((member) => member.id !== existing?.id).concat(next),
    );
    this.appendSystemMessage(
      room.id,
      "已邀请用户「" + displayName + "」加入房间，等待对方接受。",
    );
    return next;
  }

  /** 接受邀请；actor 必须等于被邀请的 userId。 */
  joinHumanMember(
    input: JoinCollaborationHumanMemberInput,
  ): CollaborationHumanMember {
    const room = getRoom(input.roomId);
    if (!room) throw new Error("房间不存在");
    if (this.localOnly)
      throw new Error("当前发布版是本地融合模式，不支持接受远程邀请");
    const actor = resolveHumanActorUserId(input.actorUserId);
    const userId = input.userId?.trim();
    if (!userId || actor !== userId)
      throw new Error("只能由被邀请用户本人接受邀请");
    const members = this.listHumanMembers(room.id);
    const existing = members.find((member) => member.userId === userId);
    if (!existing) throw new Error("邀请不存在");
    if (existing.status === "removed")
      throw new Error("该用户已被移除，不能接受邀请");
    if (existing.status === "active") return existing;
    const updated: CollaborationHumanMember = {
      ...existing,
      status: "active",
      workspaceId: input.workspaceId ?? existing.workspaceId,
      leftAt: undefined,
      updatedAt: Date.now(),
    };
    this.saveHumanMembers(
      room,
      members.map((member) => (member.id === existing.id ? updated : member)),
    );
    this.appendSystemMessage(
      room.id,
      "用户「" + updated.displayName + "」已加入房间。",
    );
    return updated;
  }

  /** 用户主动离开；房主不能在未转移所有权前离开，避免孤儿房间。 */
  leaveHumanMember(
    input: LeaveCollaborationHumanMemberInput,
  ): CollaborationHumanMember {
    const room = getRoom(input.roomId);
    if (!room) throw new Error("房间不存在");
    const actor = resolveHumanActorUserId(input.actorUserId);
    const userId = input.userId?.trim();
    if (this.localOnly && userId && userId !== LOCAL_HUMAN_USER_ID)
      throw new Error("当前发布版不支持远程用户离开房间");
    if (!userId || actor !== userId) throw new Error("只能由用户本人离开房间");
    const owner = room.ownerUserId?.trim() || LOCAL_HUMAN_USER_ID;
    if (userId === owner)
      throw new Error("房主需先转移房间所有权，当前版本不能直接离开");
    const members = this.listHumanMembers(room.id);
    const existing = members.find((member) => member.userId === userId);
    if (!existing) throw new Error("用户不是该房间成员");
    if (existing.status === "left") return existing;
    const updated: CollaborationHumanMember = {
      ...existing,
      status: "left",
      leftAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.saveHumanMembers(
      room,
      members.map((member) => (member.id === existing.id ? updated : member)),
    );
    this.appendSystemMessage(
      room.id,
      "用户「" + updated.displayName + "」已离开房间。",
    );
    return updated;
  }

  /** 房主移除用户；保留记录以便历史消息审计。 */
  removeHumanMember(
    input: RemoveCollaborationHumanMemberInput,
  ): CollaborationHumanMember {
    const room = getRoom(input.roomId);
    if (!room) throw new Error("房间不存在");
    this.requireRoomOwner(room, input.actorUserId);
    const userId = input.userId?.trim();
    if (this.localOnly && userId && userId !== LOCAL_HUMAN_USER_ID)
      throw new Error("当前发布版不支持移除远程用户");
    const owner = room.ownerUserId?.trim() || LOCAL_HUMAN_USER_ID;
    if (!userId || userId === owner) throw new Error("不能移除房主");
    const members = this.listHumanMembers(room.id);
    const existing = members.find((member) => member.userId === userId);
    if (!existing) throw new Error("用户不是该房间成员");
    if (existing.status === "removed") return existing;
    const updated: CollaborationHumanMember = {
      ...existing,
      status: "removed",
      leftAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.saveHumanMembers(
      room,
      members.map((member) => (member.id === existing.id ? updated : member)),
    );
    this.appendSystemMessage(
      room.id,
      "用户「" + updated.displayName + "」已被房主移除。",
    );
    return updated;
  }

  /** Bot 所有人授权/撤回；撤回时立即取消该席位尚未完成的 run。 */
  setBotOwnerConsent(
    input: SetCollaborationBotOwnerConsentInput,
  ): CollaborationMember {
    const room = getRoom(input.roomId);
    if (!room) throw new Error("房间不存在");
    const member = getMember(input.memberId);
    if (!member || member.roomId !== room.id || !member.botProfileId) {
      throw new Error("Bot 房间席位不存在");
    }
    if (
      this.localOnly &&
      member.botOwnerUserId &&
      member.botOwnerUserId !== LOCAL_HUMAN_USER_ID
    ) {
      throw new Error("当前发布版不支持为其他用户的 Bot 授权");
    }
    const actor = resolveHumanActorUserId(input.actorUserId);
    if (!member.botOwnerUserId || actor !== member.botOwnerUserId) {
      throw new Error("只有 Bot 所有人可以授权该席位");
    }
    const updated: CollaborationMember = {
      ...member,
      ownerConsent: input.consent === true,
      updatedAt: Date.now(),
    };
    upsertMember(updated);
    if (!updated.ownerConsent) {
      for (const run of listRunsByRoom(room.id)) {
        if (
          run.memberId === updated.id &&
          (run.status === "queued" || run.status === "running")
        ) {
          this.cancelRun(run.id);
        }
      }
    }
    this.appendSystemMessage(
      room.id,
      "Bot「" +
        updated.displayName +
        "」已" +
        (updated.ownerConsent ? "获得" : "撤回") +
        "所有人授权。",
    );
    this.broadcast(room.id, "updated");
    return updated;
  }
  /**
   * 将一个已有的多 Bot 会话幂等迁移为 RoomSession。
   *
   * 迁移逻辑放在服务层，UI 升级按钮、旧会话首次发送和 IPC 都复用同一条路径，
   * 避免旧会话继续落入历史 advisor chain。
   */
  upgradeFusionSession(input: {
    sessionId: string;
    title?: string;
    goal?: string;
  }): CollaborationRoom {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) throw new Error("sessionId 不能为空");

    const meta = getSessionMeta(sessionId);
    if (!meta) throw new Error("会话不存在");

    if (meta.fusionRoomId) {
      const existing = this.getRoomById(meta.fusionRoomId);
      if (existing) return existing;
    }

    const botIds = [...new Set(meta.botProfileIds ?? [])].filter(Boolean);
    if (botIds.length < 2) {
      throw new Error("至少加入两个 Bot 后才能升级为协作室");
    }

    const records = botIds.map((id) => getBotProfileRecord(id));
    if (
      records.some((record) => !record || record.profile.status === "archived")
    ) {
      throw new Error("当前参与者中存在不存在或已归档的 Bot，不能升级");
    }

    const coordinatorId = meta.fusionCoordinatorBotProfileId ?? botIds[0]!;
    const room = this.createRoom({
      title: input.title?.trim() || meta.title + " · 协作",
      goal: input.goal?.trim() || "从会话「" + meta.title + "」派生的协作任务",
      workspaceId: meta.workspaceId,
      sourceSessionId: sessionId,
      members: records.map((record) => ({
        displayName: record!.profile.displayName,
        botProfileId: record!.profile.id,
        isCoordinator: record!.profile.id === coordinatorId,
      })),
    });

    updateSessionMeta(sessionId, {
      fusionMode: "multi-bot",
      fusionRoomId: room.id,
    });
    return room;
  }
  createRoom(input: CreateCollaborationRoomInput): CollaborationRoom {
    if (
      this.localOnly &&
      input.ownerUserId?.trim() &&
      input.ownerUserId.trim() !== LOCAL_HUMAN_USER_ID
    ) {
      throw new Error("当前发布版只支持本机用户作为房主");
    }
    const errors = validateCreateCollaborationRoomInput(input);
    if (errors.length > 0) {
      throw new Error(errors.join("；"));
    }

    const now = Date.now();
    const roomId = genId(COLLABORATION_ROOM_ID_PREFIX);

    // 构建静态成员
    const memberSpecs = input.members ?? [];
    const members: CollaborationMember[] = memberSpecs.map((spec) => {
      const member = buildMember(roomId, spec, now);
      return materializeBotProfileSnapshot(member, spec.botProfileId);
    });
    if (
      this.localOnly &&
      members.some(
        (member) =>
          member.botOwnerUserId &&
          member.botOwnerUserId !== LOCAL_HUMAN_USER_ID,
      )
    ) {
      throw new Error("当前发布版不支持加入其他用户所有的 Bot");
    }

    // 解析协调者
    let coordinatorMemberId = "";
    const markedCoordinator = members.find((m) => m.isCoordinator);
    if (markedCoordinator) {
      coordinatorMemberId = markedCoordinator.id;
    } else if (members.length > 0) {
      // 未显式标记但提供了成员：指派第一个为协调者
      members[0]!.isCoordinator = true;
      coordinatorMemberId = members[0]!.id;
    }

    const room: CollaborationRoom = {
      id: roomId,
      title: input.title.trim(),
      goal: input.goal?.trim() ?? "",
      ownerUserId: input.ownerUserId?.trim() || "local-user",
      humanMembers: [
        {
          id: "hm_owner_" + roomId,
          roomId,
          userId: input.ownerUserId?.trim() || "local-user",
          displayName: "房主",
          workspaceId: input.workspaceId,
          status: "active",
          joinedAt: now,
          updatedAt: now,
        },
      ],
      workspaceId: input.workspaceId,
      sourceSessionId: input.sourceSessionId?.trim() || undefined,
      coordinatorMemberId,
      status: "active",
      maxConcurrentRuns:
        input.maxConcurrentRuns ??
        COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS,
      // 只在新房间未指定时推荐；updateRoom 永远保留既存值，不能静默改写用户策略。
      maxA2ADepth:
        input.maxA2ADepth ??
        recommendedCollaborationHandoffDepth(members.length),
      // A2A 交接为协作室核心能力，默认启用；S4.5 深度停止卡据此决定是否呈现。
      a2aHandoffEnabled: true,
      summaryEveryUtterances:
        input.summaryEveryUtterances ??
        COLLABORATION_SUMMARY_DEFAULT_EVERY_UTTERANCES,
      budget: input.budget ?? {},
      roomWorkspace: buildRoomWorkspace(roomId, now),
      attachedBoardId: input.attachedBoardId,
      createdAt: now,
      updatedAt: now,
    };

    // 非房主 Bot 默认未获授权；房主自己的 Bot 可直接运行。
    for (const member of members) {
      if (member.botOwnerUserId) {
        member.ownerConsent =
          member.botOwnerUserId === (room.ownerUserId ?? "local-user");
      }
    }
    // 先写房间，再写成员；成员写失败时房间已落盘（可接受降级，见文件头注释）
    upsertRoom(room);
    appendMembers(members);
    this.recordRoomEvent({
      roomId: room.id,
      type: "room.created",
      actorUserId: room.ownerUserId ?? "local-user",
      entityId: room.id,
      idempotencyKey: "room-created:" + room.id,
      payload: { title: room.title, sourceSessionId: room.sourceSessionId },
    });

    return room;
  }

  /** 更新房间（rename / pause / archive / complete / resume / 调整上限） */
  updateRoom(input: UpdateCollaborationRoomInput): CollaborationRoom {
    const existing = getRoom(input.roomId);
    if (!existing) {
      throw new Error("房间不存在");
    }
    if (
      input.status !== undefined &&
      !isCollaborationRoomStatus(input.status)
    ) {
      throw new Error(`非法房间状态：${String(input.status)}`);
    }
    const budgetErrors = validateCollaborationRoomBudget(input.budget);
    if (budgetErrors.length > 0) throw new Error(budgetErrors.join("；"));

    const now = Date.now();
    const nextStatus = input.status ?? existing.status;
    const updated: CollaborationRoom = {
      ...existing,
      title: input.title !== undefined ? input.title.trim() : existing.title,
      goal: input.goal !== undefined ? input.goal.trim() : existing.goal,
      status: nextStatus,
      maxConcurrentRuns: input.maxConcurrentRuns ?? existing.maxConcurrentRuns,
      maxA2ADepth: input.maxA2ADepth ?? existing.maxA2ADepth,
      summaryEveryUtterances:
        input.summaryEveryUtterances ?? existing.summaryEveryUtterances,
      budget: input.budget ?? existing.budget,
      updatedAt: now,
      // 归档记时间；从 archived 恢复到 active 清掉归档时间
      archivedAt:
        nextStatus === "archived"
          ? (existing.archivedAt ?? now)
          : nextStatus === "active"
            ? undefined
            : existing.archivedAt,
    };

    upsertRoom(updated);
    this.recordRoomEvent({
      roomId: updated.id,
      type: "room.updated",
      actorUserId: updated.ownerUserId ?? "local-user",
      entityId: updated.id,
      payload: {
        status: updated.status,
        title: updated.title,
        goal: updated.goal,
      },
    });
    // 暂停只冻结新 run；恢复时唤醒原有排队项。并发上限调整也一并生效。
    if (updated.status === "active") {
      this.scheduler.wake();
    }
    return updated;
  }

  // ===== Message =====

  /** 列出某房间全部消息（内部上下文投影使用，按 createdAt 升序） */
  listMessages(roomId: string): CollaborationMessage[] {
    return listMessagesByRoom(roomId);
  }

  /** 分页列出某房间消息；renderer 首屏只读取最新一页。 */
  listMessagesPage(
    input: ListCollaborationMessagesInput,
  ): CollaborationMessagesPage {
    return listMessagesByRoomPage(
      input.roomId,
      input.limit,
      input.before,
    );
  }

  /**
   * 追加用户消息（Stage 3：落盘前解析 @mention → targetMemberIds，落盘后异步触发多成员 run）。
   *
   * - 目标解析：显式 input.targetMemberIds 优先（程序化调用）；否则 input.mentions 结构化优先，
   *   未提供时从文本 @displayName / @all 兜底解析（resolveCollaborationMentions）。
   *   无 @ 命中 → targetMemberIds=[]，由 trigger 路由协调者。
   * - 房间 active：落盘用户消息 → 异步 triggerRunForMessage（不阻塞 IPC，返回即结束）。
   * - 房间 paused/archived/completed：只落盘消息，不触发 run（pause 后不启动新 run）。
   *
   * authorId 暂用 'user' 占位（S3+ 接真实用户身份）；
   * rootMessageId 暂等于自身（S3+ 接回复链根解析）。
   */
  appendUserMessage(
    input: AppendCollaborationUserMessageInput,
  ): CollaborationMessage {
    const room = getRoom(input.roomId);
    if (!room) {
      throw new Error("房间不存在");
    }
    const text = input.content?.trim() ?? "";
    if (!text && !(input.attachments?.length ?? 0)) {
      throw new Error("消息内容不能为空");
    }
    const idempotencyKey = input.idempotencyKey?.trim();
    if (idempotencyKey) {
      const existing = findMessageByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.roomId !== room.id) {
          throw new Error("幂等键已被其他房间使用");
        }
        return existing;
      }
    }
    const actorUserId = resolveHumanActorUserId(input.actorUserId);
    const actor = this.listHumanMembers(room.id).find(
      (human) => human.userId === actorUserId && human.status === "active",
    );
    if (!actor) throw new Error("当前用户不是该房间的活跃成员");
    // 目标成员解析（S3.5-a）：显式 targetMemberIds 优先（程序化调用）；
    // 否则走 resolveCollaborationMentions（结构化 mentions 优先，未提供时文本兜底）
    const explicitTargets =
      input.targetMemberIds && input.targetMemberIds.length > 0
        ? input.targetMemberIds
        : null;
    const targetMemberIds =
      explicitTargets ??
      resolveCollaborationMentions({
        text,
        members: loadMembers(input.roomId),
        structured: input.mentions,
        sender: { type: "user" },
      }).targetMemberIds;

    const savedAttachments: FileAttachment[] = (input.attachments ?? []).map(
      (attachment) =>
        saveAttachment({
          sessionId: room.id,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          data: attachment.data,
        }),
    );
    const now = Date.now();
    const id = genId(COLLABORATION_MESSAGE_ID_PREFIX);
    const message: CollaborationMessage = {
      id,
      roomId: input.roomId,
      authorType: "user",
      authorId: actorUserId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      kind: "chat",
      content: text,
      ...(savedAttachments.length > 0 ? { attachments: savedAttachments } : {}),
      visibility: "room",
      targetMemberIds,
      replyToMessageId: input.replyToMessageId,
      rootMessageId: id,
      depth: 0,
      createdAt: now,
    };

    this.appendRoomMessage(message);

    // 房间 updatedAt 刷新（便于侧栏按最后活动排序）
    upsertRoom({ ...room, updatedAt: now });

    // active 房间异步触发成员 run（不阻塞 IPC）
    if (room.status === "active") {
      this.triggerRunForMessage(room, message);
      this.kickSummary(room);
    }

    return message;
  }

  // ===== Run（Stage 2） =====

  /** 列出某房间全部 run（内部调度/预算使用，按入队顺序） */
  listRuns(roomId: string): CollaborationRun[] {
    return listRunsByRoom(roomId);
  }

  /** 分页列出某房间 run；renderer 首屏只读取最新一页。 */
  listRunsPage(input: ListCollaborationRunsInput): CollaborationRunsPage {
    return listRunsByRoomPage(input.roomId, input.limit, input.before);
  }

  /** 获取房间全部 run 的状态摘要；不受 renderer 历史分页影响。 */
  getRunSummary(roomId: string): CollaborationRunSummary {
    const summary: CollaborationRunSummary = {
      total: 0,
      queued: 0,
      running: 0,
      awaitingPeer: 0,
      awaitingUser: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const run of listRunsByRoom(roomId)) {
      summary.total += 1;
      if (run.status === "awaiting_peer") summary.awaitingPeer += 1;
      else if (run.status === "awaiting_user") summary.awaitingUser += 1;
      else summary[run.status] += 1;
    }
    return summary;
  }

  /** 取消房间内全部仍可取消的 run；按全量持久化记录处理，不受历史分页影响。 */
  cancelAllRuns(roomId: string): number {
    let cancelled = 0;
    for (const run of listRunsByRoom(roomId)) {
      if (run.status !== "queued" && run.status !== "running") continue;
      if (this.cancelRun(run.id)?.status === "cancelled") cancelled += 1;
    }
    return cancelled;
  }

  /** 取单个 run（不存在返回 undefined） */
  getRunById(runId: string): CollaborationRun | undefined {
    return getRun(runId);
  }

  /**
   * 取消某 run（Stage 3：区分排队中 / 运行中）。
   * - 排队中（仍在调度器队列、未占 slot）：dequeue 移除 + 置 cancelled + 同步成员状态。
   * - 运行中：abort 后端调用；executeRun 的 finally 负责 release + 同步成员状态。
   * 已终态（done/failed/cancelled）的 run 不再变更，返回其当前状态。
   */
  cancelRun(runId: string): CollaborationRun | undefined {
    const run = getRun(runId);
    if (!run) return undefined;
    if (run.status !== "queued" && run.status !== "running") return run;

    // 置 cancelled（CAS：仅 queued/running 可转）
    const now = Date.now();
    const updated: CollaborationRun = {
      ...run,
      status: "cancelled",
      fence: (run.fence ?? 0) + 1,
      finishedAt: now,
    };
    upsertRun(updated);

    if (this.scheduler.dequeue(runId)) {
      // 仍在队列（未占 slot）：移除即可，executeRun 不会被调用，无需 release。
      // 同步成员状态（若仍有其他排队 run → queued，否则 idle）
      this.syncMemberStatus(run.memberId);
    } else {
      // 已 running：abort 后端调用；executeRun finally 会 release + syncMemberStatus
      const ctrl = this.abortControllers.get(runId);
      if (ctrl) ctrl.abort();
      // P1-2c：本地 controller.abort 已使 adapter 组合 signal abort（取消进行中的 turn）；
      // 再 interruptSession 是 lifecycle 原生取消契约，并标记 session interrupted 使 heartbeat
      // alive=false。仅 running 分支调用——排队中的 run 无 inflight turn，不应污染 session。
      this.interruptMemberSession(run);
    }

    this.broadcast(run.roomId, "run-cancelled");
    return updated;
  }

  /**
   * P1：重试一个失败/已取消 run。
   *
   * 重试永远创建新 run，不复活旧 run 的状态或 fence；可选 memberId 允许用户把失败任务
   * 交给房间内另一名仍可运行的成员。blocked run 不在此处处理，因为它可能存在未知外部
   * 副作用，必须走 confirmResumeBlockedRun 的显式确认闸门。
   */
  retryRun(
    input: RetryCollaborationRunInput,
  ): RetryCollaborationRunResult {
    const room = getRoom(input.roomId);
    if (!room || room.status !== "active") {
      return { ok: false, reason: "房间不存在或未激活" };
    }
    const oldRun = getRun(input.runId);
    if (!oldRun || oldRun.roomId !== input.roomId) {
      return { ok: false, reason: "run 不存在或不属于该房间" };
    }
    if (oldRun.status !== "failed" && oldRun.status !== "cancelled") {
      return {
        ok: false,
        reason: "只有 failed 或 cancelled run 可以重试；blocked run 请确认继续",
      };
    }

    const target = getMember(input.memberId?.trim() || oldRun.memberId);
    if (!target || target.roomId !== room.id || target.status === "removed") {
      return { ok: false, reason: "目标成员不存在或已移除" };
    }
    if (target.botOwnerUserId && target.ownerConsent !== true) {
      return { ok: false, reason: "目标 Bot 尚未获得所有者授权" };
    }
    const triggerMessage = listMessagesByRoom(room.id).find(
      (message) => message.id === oldRun.triggerMessageId,
    );
    if (!triggerMessage) {
      return { ok: false, reason: "触发消息已删除，无法重试" };
    }

    const callerKey = input.idempotencyKey?.trim();
    const idempotencyKey =
      callerKey || `retry-of:${oldRun.id}:${target.id}:${randomUUID()}`;
    const existing = findRunByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.roomId !== room.id) {
        return { ok: false, reason: "幂等键已被其他房间使用" };
      }
      return { ok: true, newRunId: existing.id };
    }

    const nextRun: CollaborationRun = {
      id: genId(COLLABORATION_RUN_ID_PREFIX),
      roomId: room.id,
      memberId: target.id,
      triggerMessageId: triggerMessage.id,
      idempotencyKey,
      taskId: oldRun.taskId,
      status: "queued",
      attempt: 0,
      fence: 0,
    };
    upsertRun(nextRun);
    this.scheduler.enqueue({
      runId: nextRun.id,
      roomId: room.id,
      memberId: target.id,
      room,
      member: target,
      run: nextRun,
      triggerMessage: triggerMessage,
    });
    if (!this.scheduler.isMemberRunning(target.id)) {
      this.setMemberStatus(target.id, "queued");
    }
    this.broadcast(room.id, "run-retried");
    return { ok: true, newRunId: nextRun.id };
  }

  /**
   * 取消时通知 lifecycle 中断该成员的进行中 session（P1-2c）。
   *
   * - 无 lifecycle / 无 member.logicalSessionId → no-op（旧行为：只靠本地 controller.abort）。
   * - 用 member.logicalSessionId 构造 handle（interruptSession 只按 sessionId 寻址；其余字段
   *   仅满足类型，未参与寻址）。backend 取 member.backend（CollaborationMemberBackend ⊂
   *   MemberSessionBackend），resumeMode='none'（与 Channel supportsResume=false 一致）。
   * - fire-and-forget：Channel/Fake 的 interruptSession 体同步执行（无 await），副作用立即生效；
   *   捕获任何错误（含未来可能的 NOT_FOUND / 未知 session）避免影响 cancel 本身。
   */
  private interruptMemberSession(run: CollaborationRun): void {
    const member = getMember(run.memberId);
    const logicalSessionId = member?.logicalSessionId?.trim();
    if (!logicalSessionId) return;
    if (member?.backend === "codex") {
      abortCodexRoomSession(logicalSessionId);
      return;
    }
    if (!this.lifecycle) return;
    const handle: MemberSessionHandle = {
      sessionId: logicalSessionId,
      logicalSessionId,
      backend: member!.backend,
      resumeMode: "none",
      createdAt: 0,
    };
    void this.lifecycle
      .interruptSession({ handle, reason: "cancel-run" })
      .catch((error) => {
        // 忽略 NOT_FOUND / 未知 session 等：cancel 已生效，不因 lifecycle 报错而失败。
        console.error("[协作室] interruptSession 失败（已忽略）:", error);
      });
  }

  /**
   * 启动恢复（02-RUNTIME-A2A-SPEC §14）：安全恢复未启动的 queued；running/awaiting run 不自动重放未知副作用。
   *
   * 不自动重放（避免重复副作用）；用户可重新发消息触发新 run（新 messageId → 新 run，幂等不冲突）。
   * queued 在 active / paused 房间都恢复入内存队列；paused 由调度器继续冻结，恢复 active 后再启动。
   * 成员状态回 idle，避免「假 running」。返回恢复的 run 数。
   */
  recoverInterruptedRuns(): number {
    const stuck = listRunsByStatus(["queued", "running"]);
    const awaiting = listRunsByStatus(["awaiting_peer"]);
    const recoverableOutbox = loadRooms().flatMap((room) =>
      listMailboxByRoom(room.id).filter(
        (envelope) =>
          envelope.delivery === "outbox" &&
          !envelope.deliveryRunId &&
          Boolean(envelope.attemptId),
      ),
    );
    if (
      stuck.length === 0 &&
      awaiting.length === 0 &&
      recoverableOutbox.length === 0
    )
      return 0;
    // 在 sweep 前取快照：只有已经 dispatched/accepted 且其目标 run 仍活跃的信封才是
    // 「副作用结果未知」，绝不能因下方把 run 标 failed 后再当作安全重放。
    const interruptedRunIds = new Set(
      stuck.filter((run) => run.status === "running").map((run) => run.id),
    );
    const now = Date.now();
    const error: CollaborationSerializedRunError = {
      message:
        "应用重启时发现仍在运行的 run，已标记中断（请重新发送消息以重试）",
      code: "INTERRUPTED",
    };
    let resumedQueued = 0;
    let failedStuck = 0;
    for (const run of stuck) {
      if (run.status === "queued") {
        const room = getRoom(run.roomId);
        const member = getMember(run.memberId);
        const triggerMessage = room
          ? listMessagesByRoom(room.id).find(
              (message) => message.id === run.triggerMessageId,
            )
          : undefined;
        if (
          (room?.status === "active" || room?.status === "paused") &&
          member &&
          member.status !== "removed" &&
          triggerMessage
        ) {
          const resumed: CollaborationRun = {
            ...run,
            status: "queued",
            attempt: (run.attempt ?? 0) + 1,
            fence: (run.fence ?? 0) + 1,
            startedAt: undefined,
            finishedAt: undefined,
            error: undefined,
          };
          upsertRun(resumed);
          this.scheduler.enqueue({
            runId: resumed.id,
            roomId: room.id,
            memberId: member.id,
            room,
            member,
            run: resumed,
            triggerMessage,
          });
          this.syncMemberStatus(member.id);
          resumedQueued++;
          continue;
        }
      }
      upsertRun({
        ...run,
        // running 的外部副作用未知：进入 blocked，交给用户确认后以新 turn 续跑；
        // 只有无法安全恢复的 queued 才标记 failed。
        status: run.status === "running" ? "blocked" : "failed",
        fence: (run.fence ?? 0) + 1,
        finishedAt: now,
        error,
      });
      this.syncMemberStatus(run.memberId);
      failedStuck++;
    }
    // 遗留 awaiting_peer：continuation 已丢，标 blocked 要求用户决定重试/完成
    // （02-RUNTIME-A2A-SPEC §14：未知副作用不可自动重放）
    for (const run of awaiting) {
      upsertRun({ ...run, status: "blocked", finishedAt: now, error });
      this.syncMemberStatus(run.memberId);
    }
    for (const room of loadRooms()) {
      for (const envelope of listMailboxByRoom(room.id)) {
        if (
          (envelope.delivery === "dispatched" ||
            envelope.delivery === "accepted") &&
          envelope.deliveryRunId &&
          interruptedRunIds.has(envelope.deliveryRunId)
        ) {
          upsertMailboxEnvelope({
            ...envelope,
            delivery: "outcome_unknown",
            stopReason: "outcome_unknown",
          });
        }
      }
    }
    // 仅 outbox 且尚未关联 target run 的窗口可安全重放：它尚未启动任何模型调用。
    // 一旦已 dispatched/accepted，就走上面的 outcome_unknown，绝不自动再投递。
    let replayedOutbox = 0;
    for (const envelope of recoverableOutbox) {
      const room = getRoom(envelope.roomId);
      const target = getMember(envelope.toMemberId);
      const trigger = room
        ? listMessagesByRoom(room.id).find(
            (message) => message.id === envelope.sourceMessageId,
          )
        : undefined;
      if (!room || !target || !trigger) continue;
      this.dispatchEnvelope(room, target, envelope, trigger);
      replayedOutbox++;
    }
    console.log(
      `[协作室] 启动恢复：${resumedQueued} 个 queued 恢复入队，${failedStuck} 个 run 标记 interrupted/failed，${awaiting.length} 个 awaiting_peer 标记 blocked，${replayedOutbox} 个 outbox 安全重投`,
    );
    return resumedQueued + failedStuck + awaiting.length + replayedOutbox;
  }

  // ===== A2A 信箱（S4 host 侧；02-RUNTIME-A2A-SPEC §5–§9） =====
  //
  // 本段实现宿主侧 A2A 协议入口（room_send / room_ask / room_reply）：纯逻辑守卫（S4-1）+
  // mailbox 落盘 + run 状态机迁移到 awaiting_peer + 广播。**adapter 工具回路（把工具暴露给
  // 成员 turn、peer reply 唤醒发送者新 turn）留 S4-3**；S4-2 的边界是「信箱语义 + 状态机」可
  // 独立验证（落盘正确、守卫阻断自环/超深度/重复回复、状态迁移合法）。
  //
  // 红线（02-spec §9 / 03-phases §12）：安全字段（rootMessageId/causationId/depth/fromMemberId）
  // 由宿主补齐，模型不得自行声明；此处 input 由调用方（未来 adapter 工具层）传入 run 上下文，
  // service 强制用 run 的 memberId 作为 fromMemberId，不接受外部伪造。

  /**
   * room_send：异步通知另一成员（不暂停发送者）。
   *
   * 守卫：自环（A→A）阻断；深度超限 fail closed；房间非 active 拒绝。
   * 落盘：pending 信封 + 一条 a2a_request 消息（visibility=participants）。
   * 不迁移 run 状态（send 不阻塞发送者）。
   */
  roomSend(input: {
    roomId: string;
    fromRunId: string;
    toMemberId: string;
    payload: string;
  }): { ok: true; envelopeId: string } | { ok: false; reason: string } {
    const room = getRoom(input.roomId);
    if (!room) return { ok: false, reason: "房间不存在" };
    if (room.status !== "active")
      return { ok: false, reason: `房间状态非 active：${room.status}` };

    const run = getRun(input.fromRunId);
    if (!run) return { ok: false, reason: "run 不存在" };
    if (run.status !== "running" && run.status !== "awaiting_peer") {
      return {
        ok: false,
        reason: `run 非 running/awaiting_peer：${run.status}`,
      };
    }
    const fromMember = getMember(run.memberId);
    if (!fromMember) return { ok: false, reason: "发送成员不存在" };
    if (isCollaborationSelfSend(fromMember.id, input.toMemberId)) {
      return { ok: false, reason: "成员不能给自己发 A2A" };
    }
    const toMember = getMember(input.toMemberId);
    if (!toMember || toMember.roomId !== room.id) {
      return { ok: false, reason: "接收成员不存在或不属于本房间" };
    }

    // send 不递增深度（仅 ask/reply 跨成员计深度），但仍校验发送者 run 自身深度未超房间上限，
    // 避免深层 run 继续向外发散。run 深度未知时按 0 兜底（宿主补齐）。
    const senderDepth = this.runDepth(run.id);
    const depthCheck = nextCollaborationA2ADepth(senderDepth, room.maxA2ADepth);
    if (!depthCheck.ok) {
      this.recordDepthStop(
        room,
        run,
        fromMember,
        toMember,
        input.payload,
        senderDepth,
        "message",
      );
      return { ok: false, reason: depthCheck.reason };
    }

    const now = Date.now();
    const rootMessageId = run.triggerMessageId;
    const causationId = run.id;
    const envelope: CollaborationMailboxEnvelope = {
      id: genId("env_"),
      roomId: room.id,
      fromMemberId: fromMember.id,
      toMemberId: toMember.id,
      type: "message",
      payload: input.payload,
      rootMessageId,
      causationId,
      depth: senderDepth,
      state: "pending",
      attemptId: randomUUID(),
      delivery: "outbox",
      sourceMessageId: run.triggerMessageId,
      createdAt: now,
    };
    appendMailboxEnvelope(envelope);
    const trigger = this.appendA2AMessage(
      room,
      fromMember,
      "a2a_request",
      input.payload,
      rootMessageId,
      causationId,
      run.id,
      [toMember.id],
      senderDepth,
    );
    this.dispatchEnvelope(room, toMember, envelope, trigger);
    this.broadcast(room.id, "mailbox-updated");
    return { ok: true, envelopeId: envelope.id };
  }

  /**
   * room_ask：向另一成员提问；当前 run 可结束为 awaiting_peer 释放执行槽。
   *
   * 守卫：自环阻断；深度 = parentDepth+1 超限 fail closed。parentDepth 由宿主从该 run
   * 已有 A2A 链推导（安全字段，不接受外部传入）。
   * 落盘：question 信封（pending）+ a2a_request 消息。
   * 状态机：调用方决定是否把 run 迁移到 awaiting_peer（见 markRunAwaitingPeer）。
   */
  roomAsk(input: {
    roomId: string;
    fromRunId: string;
    toMemberId: string;
    question: string;
  }):
    | { ok: true; envelopeId: string; requestId: string }
    | { ok: false; reason: string } {
    const room = getRoom(input.roomId);
    if (!room) return { ok: false, reason: "房间不存在" };
    if (room.status !== "active")
      return { ok: false, reason: `房间状态非 active：${room.status}` };

    const run = getRun(input.fromRunId);
    if (!run) return { ok: false, reason: "run 不存在" };
    if (run.status !== "running" && run.status !== "awaiting_peer") {
      return {
        ok: false,
        reason: `run 非 running/awaiting_peer：${run.status}`,
      };
    }
    const fromMember = getMember(run.memberId);
    if (!fromMember) return { ok: false, reason: "发送成员不存在" };
    if (isCollaborationSelfSend(fromMember.id, input.toMemberId)) {
      return { ok: false, reason: "成员不能给自己发 A2A" };
    }
    const toMember = getMember(input.toMemberId);
    if (!toMember || toMember.roomId !== room.id) {
      return { ok: false, reason: "接收成员不存在或不属于本房间" };
    }

    const parentDepth = this.runDepth(run.id);
    const depthRes = nextCollaborationA2ADepth(parentDepth, room.maxA2ADepth);
    if (!depthRes.ok) {
      this.recordDepthStop(
        room,
        run,
        fromMember,
        toMember,
        input.question,
        parentDepth,
        "question",
      );
      return { ok: false, reason: depthRes.reason };
    }

    // 循环指纹：检测 A↔B 近重复问答（02-RUNTIME-A2A-SPEC §9）。
    // - 正向：A→B 已问过同样问题（指纹碰撞）→ 阻断重复投递
    // - 反向：B→A 已问过同样问题（A→B→A 循环）→ 阻断
    const fp = collaborationLoopFingerprint({
      fromMemberId: fromMember.id,
      toMemberId: toMember.id,
      payload: input.question,
    });
    const reverseFp = collaborationLoopFingerprint({
      fromMemberId: toMember.id,
      toMemberId: fromMember.id,
      payload: input.question,
    });
    const roomEnvelopes = listMailboxByRoom(room.id);
    const loopHit = roomEnvelopes.some((e) => {
      if (e.type !== "question") return false;
      const eFp = collaborationLoopFingerprint({
        fromMemberId: e.fromMemberId,
        toMemberId: e.toMemberId,
        payload: e.payload,
      });
      // 正向重复（同 A→B 同问题）或反向循环（B→A 同问题）
      if (eFp === fp) return true;
      if (
        eFp === reverseFp &&
        e.fromMemberId === toMember.id &&
        e.toMemberId === fromMember.id
      )
        return true;
      return false;
    });
    if (loopHit) {
      return {
        ok: false,
        reason:
          "检测到 A↔B 近重复问答循环或重复投递，已阻断（请换一种方式询问或换成员）",
      };
    }

    const now = Date.now();
    const requestId = genId("req_");
    const rootMessageId = run.triggerMessageId;
    const causationId = run.id;
    const envelope: CollaborationMailboxEnvelope = {
      id: genId("env_"),
      roomId: room.id,
      fromMemberId: fromMember.id,
      toMemberId: toMember.id,
      type: "question",
      requestId,
      payload: input.question,
      rootMessageId,
      causationId,
      depth: depthRes.depth,
      state: "pending",
      attemptId: randomUUID(),
      delivery: "outbox",
      sourceMessageId: run.triggerMessageId,
      createdAt: now,
    };
    appendMailboxEnvelope(envelope);
    const trigger = this.appendA2AMessage(
      room,
      fromMember,
      "a2a_request",
      input.question,
      rootMessageId,
      causationId,
      run.id,
      [toMember.id],
      depthRes.depth,
    );
    this.dispatchEnvelope(room, toMember, envelope, trigger);
    this.broadcast(room.id, "mailbox-updated");
    return { ok: true, envelopeId: envelope.id, requestId };
  }

  /**
   * room_reply：回复一个 ask。幂等——同一 request 已有有效终态回复则阻断。
   *
   * 守卫：request 信封必须存在且为激活态（pending/delivered）；重复回复阻断；
   * 回复者必须是 request 的 toMemberId（防伪造）。
   * 落盘：reply 信封（置 answered）+ 原 question 信封置 answered + a2a_reply 消息。
   * 若原提问者 run 处于 awaiting_peer：CAS 为 done，并入队一条 continuation run
   *（幂等键 a2a-continue:{requestId}:{askerMemberId}）。不处于 awaiting_peer 则只落盘回复。
   */
  roomReply(input: {
    roomId: string;
    fromRunId: string;
    requestId: string;
    answer: string;
  }): { ok: true; envelopeId: string } | { ok: false; reason: string } {
    const room = getRoom(input.roomId);
    if (!room) return { ok: false, reason: "房间不存在" };

    const run = getRun(input.fromRunId);
    if (!run) return { ok: false, reason: "run 不存在" };
    const fromMember = getMember(run.memberId);
    if (!fromMember) return { ok: false, reason: "回复成员不存在" };

    // 找到该 request 的 question 信封
    const related = listMailboxByRequest(input.requestId);
    const questionEnv = related.find((e) => e.type === "question");
    if (!questionEnv) return { ok: false, reason: "request 不存在" };
    if (questionEnv.toMemberId !== fromMember.id) {
      return { ok: false, reason: "回复者与 request 接收者不匹配" };
    }
    // 幂等先于状态迁移：同 request 已有有效回复时给出更精确的原因
    if (
      isCollaborationDuplicateReply(input.requestId, fromMember.id, related)
    ) {
      return { ok: false, reason: "重复回复（该 request 已有有效回复）" };
    }
    if (!transitionCollaborationMailboxState(questionEnv.state, "answer").ok) {
      return {
        ok: false,
        reason: `question 信封状态不可回复：${questionEnv.state}`,
      };
    }

    const now = Date.now();
    const replyEnvelope: CollaborationMailboxEnvelope = {
      id: genId("env_"),
      roomId: room.id,
      fromMemberId: fromMember.id,
      toMemberId: questionEnv.fromMemberId,
      type: "reply",
      requestId: input.requestId,
      payload: input.answer,
      rootMessageId: questionEnv.rootMessageId,
      causationId: run.id,
      depth: questionEnv.depth,
      state: "answered",
      createdAt: now,
    };
    appendMailboxEnvelope(replyEnvelope);
    // 原 question 信封 → answered
    const t = transitionCollaborationMailboxState(questionEnv.state, "answer");
    if (t.ok) upsertMailboxEnvelope({ ...questionEnv, state: t.state });

    const replyMessage = this.appendA2AMessage(
      room,
      fromMember,
      "a2a_reply",
      input.answer,
      questionEnv.rootMessageId,
      questionEnv.id,
      run.id,
      [questionEnv.fromMemberId],
      questionEnv.depth,
    );
    this.broadcast(room.id, "mailbox-updated");
    this.enqueueAskerContinuation(
      room,
      questionEnv,
      input.requestId,
      replyMessage,
    );
    return { ok: true, envelopeId: replyEnvelope.id };
  }

  /**
   * 把一个 run 标记为 awaiting_peer（执行槽释放，保留 continuation 供 peer reply 唤醒）。
   * 仅 running → awaiting_peer 合法（CAS）；abort 物理 turn（不占槽）；成员回 idle。
   * executeRun 看到 abort 时若 run 已是 awaiting_peer，不得覆盖为 cancelled。
   */
  markRunAwaitingPeer(runId: string): CollaborationRun | undefined {
    const updated = this.casRun(runId, "running", "awaiting_peer", {});
    if (updated) {
      const ctrl = this.abortControllers.get(runId);
      if (ctrl) ctrl.abort();
      this.scheduler.release(runId, updated.roomId, updated.memberId);
      this.syncMemberStatus(updated.memberId);
      this.broadcast(updated.roomId, "run-awaiting-peer");
    }
    return updated;
  }

  /**
   * S4-3：peer reply 到达后，若原提问者 run 处于 awaiting_peer，入队 continuation。
   *
   * - 原 run CAS awaiting_peer → done（等待已结束；continuation 是新 turn，因 backend 无 resume）
   * - 幂等键含 requestId，同一 reply 不会二次唤醒
   * - 房间非 active / 原 run 不是 awaiting_peer / 成员缺失 → 静默跳过（reply 已落盘）
   */
  private enqueueAskerContinuation(
    room: CollaborationRoom,
    questionEnv: CollaborationMailboxEnvelope,
    requestId: string,
    replyMessage: CollaborationMessage,
  ): void {
    if (room.status !== "active") return;
    const askerRun = getRun(questionEnv.causationId);
    if (!askerRun || askerRun.status !== "awaiting_peer") return;
    const asker = getMember(askerRun.memberId);
    if (!asker || asker.roomId !== room.id) return;

    const idempotencyKey = collaborationContinuationIdempotencyKey(
      requestId,
      asker.id,
    );
    if (findRunByIdempotencyKey(idempotencyKey)) return;

    this.casRun(askerRun.id, "awaiting_peer", "done", {
      finishedAt: Date.now(),
    });

    const continuation: CollaborationRun = {
      id: genId(COLLABORATION_RUN_ID_PREFIX),
      roomId: room.id,
      memberId: asker.id,
      triggerMessageId: replyMessage.id,
      idempotencyKey,
      status: "queued",
      attempt: 0,
      fence: 0,
    };
    upsertRun(continuation);
    this.scheduler.enqueue({
      runId: continuation.id,
      roomId: room.id,
      memberId: asker.id,
      room,
      member: asker,
      run: continuation,
      triggerMessage: replyMessage,
    });
    if (!this.scheduler.isMemberRunning(asker.id)) {
      this.setMemberStatus(asker.id, "queued");
    }
    this.broadcast(room.id, "run-continued");
  }

  /** 列出某房间全部信箱信封（renderer 审计视图用） */
  listMailbox(roomId: string): CollaborationMailboxEnvelope[] {
    return listMailboxByRoom(roomId);
  }

  /** 列出某成员仍待处理的信封（pending/delivered） */
  listPendingMailboxForMember(
    memberId: string,
  ): CollaborationMailboxEnvelope[] {
    return listActiveMailboxForMember(memberId);
  }

  /** 列出某房间的用户审批请求（按创建时间升序）。 */
  listUserApprovals(roomId: string): CollaborationUserApprovalRequest[] {
    return listUserApprovalRequests(roomId);
  }

  /**
   * P2-1：列出某房间的可观察「待确认续跑」项（纯函数派生，不触发副作用）。
   *
   * 从已落盘的 runs / mailbox / approvals 派生 blocked_run / pending_approval /
   * awaiting_peer / awaiting_user / depth_stop / mailbox_outbox 等可观察项，规则对齐
   * 远程 Fusion 的 listFusionContinuations。房间不存在或未激活时返回空列表（不抛错）。
   */
  listContinuations(roomId: string): LocalCollaborationContinuationItem[] {
    const room = getRoom(roomId);
    if (!room) return [];
    return listLocalCollaborationContinuations({
      roomId,
      runs: listRunsByRoom(roomId),
      mailbox: listMailboxByRoom(roomId),
      approvals: listUserApprovalRequests(roomId),
      maxA2ADepth: room.maxA2ADepth,
      handoffEnabled: room.a2aHandoffEnabled,
    });
  }

  /**
   * 成员请求用户决定。请求落盘后当前 run 进入 awaiting_user 并释放执行槽，
   * 等待 renderer 通过 resolveUserApproval 决定；整个过程按 room/run/member 归属校验。
   */
  requestUserApproval(input: {
    roomId: string;
    fromRunId: string;
    question: string;
    reason?: string;
    options?: string;
  }):
    | { ok: true; request: CollaborationUserApprovalRequest }
    | { ok: false; reason: string } {
    const room = getRoom(input.roomId);
    const run = getRun(input.fromRunId);
    if (!room || !run || run.roomId !== input.roomId)
      return { ok: false, reason: "房间或 run 不存在" };
    if (run.status !== "running")
      return { ok: false, reason: "当前 run 不在 running 状态" };
    const member = getMember(run.memberId);
    if (!member || member.roomId !== room.id)
      return { ok: false, reason: "成员不存在或不属于该房间" };
    const question = input.question?.trim() ?? "";
    if (!question) return { ok: false, reason: "question 不能为空" };
    if (question.length > 2000)
      return { ok: false, reason: "question 不能超过 2000 个字符" };
    const reason = input.reason?.trim() || undefined;
    if (reason && reason.length > 2000)
      return { ok: false, reason: "reason 不能超过 2000 个字符" };
    let options: string[] | undefined;
    if (input.options?.trim()) {
      try {
        const parsed: unknown = JSON.parse(input.options);
        if (
          !Array.isArray(parsed) ||
          parsed.length > 8 ||
          parsed.some((v) => typeof v !== "string")
        ) {
          return {
            ok: false,
            reason: "options 必须是最多 8 项的 JSON 字符串数组",
          };
        }
        options = parsed.map((value) => value.trim());
        if (options.some((value) => !value || value.length > 200)) {
          return {
            ok: false,
            reason: "options 不能包含空项，且每项不超过 200 个字符",
          };
        }
      } catch {
        return { ok: false, reason: "options 不是合法 JSON" };
      }
    }
    const transitioned = this.casRun(run.id, "running", "awaiting_user", {});
    if (!transitioned) return { ok: false, reason: "run 状态已改变，请重试" };
    const request: CollaborationUserApprovalRequest = {
      id: genId("approval_"),
      roomId: room.id,
      memberId: member.id,
      runId: run.id,
      question,
      ...(reason ? { reason } : {}),
      ...(options ? { options } : {}),
      status: "pending",
      createdAt: Date.now(),
    };
    upsertUserApprovalRequest(request);
    const controller = this.abortControllers.get(run.id);
    if (controller) controller.abort();
    this.scheduler.release(run.id, room.id, member.id);
    this.setMemberStatus(member.id, "awaiting_user");
    this.broadcast(room.id, "run-awaiting-user");
    return { ok: true, request };
  }

  /**
   * 解决用户审批。approved 会把审批结果作为新的系统触发消息重新入队，
   * denied 则结束原 run；重复 resolve 返回当前记录，保证 IPC 重试幂等。
   */
  resolveUserApproval(input: {
    roomId: string;
    requestId: string;
    decision: "approved" | "denied";
    response?: string;
  }):
    | { ok: true; request: CollaborationUserApprovalRequest; runId?: string }
    | { ok: false; reason: string } {
    const request = getUserApprovalRequest(input.requestId);
    if (!request || request.roomId !== input.roomId)
      return { ok: false, reason: "审批请求不存在或不属于该房间" };
    if (request.status !== "pending") return { ok: true, request };
    const room = getRoom(request.roomId);
    const run = getRun(request.runId);
    const member = getMember(request.memberId);
    if (
      !room ||
      !run ||
      !member ||
      run.roomId !== room.id ||
      member.roomId !== room.id
    ) {
      return { ok: false, reason: "审批关联的房间、run 或成员不存在" };
    }
    const response = input.response?.trim() || undefined;
    if (response && response.length > 4000)
      return { ok: false, reason: "response 不能超过 4000 个字符" };
    const resolved: CollaborationUserApprovalRequest = {
      ...request,
      status: input.decision,
      ...(response ? { response } : {}),
      resolvedAt: Date.now(),
    };
    upsertUserApprovalRequest(resolved);

    if (input.decision === "denied") {
      const failed = this.casRun(run.id, "awaiting_user", "failed", {
        finishedAt: Date.now(),
        error: { code: "USER_DENIED", message: "用户拒绝了成员请求" },
      });
      if (failed) {
        this.appendSystemMessage(
          room.id,
          `用户拒绝了成员「${member.displayName}」的请求。`,
        );
        this.syncMemberStatus(member.id);
        this.broadcast(room.id, "run-finished");
      }
      return { ok: true, request: resolved };
    }

    const completed = this.casRun(run.id, "awaiting_user", "done", {
      finishedAt: Date.now(),
    });
    if (!completed) return { ok: true, request: resolved };
    const triggerMessage = this.appendSystemMessage(
      room.id,
      `用户已批准成员「${member.displayName}」的请求${response ? `：${response}` : "。"}`,
    );
    if (room.status !== "active") {
      this.syncMemberStatus(member.id);
      this.broadcast(room.id, "run-finished");
      return { ok: true, request: resolved };
    }
    const idempotencyKey = `user-approval:${request.id}:${member.id}`;
    const existing = findRunByIdempotencyKey(idempotencyKey);
    if (existing) return { ok: true, request: resolved, runId: existing.id };
    const continuation: CollaborationRun = {
      id: genId(COLLABORATION_RUN_ID_PREFIX),
      roomId: room.id,
      memberId: member.id,
      triggerMessageId: triggerMessage.id,
      idempotencyKey,
      status: "queued",
      attempt: 0,
      fence: 0,
    };
    upsertRun(continuation);
    this.scheduler.enqueue({
      runId: continuation.id,
      roomId: room.id,
      memberId: member.id,
      room,
      member,
      run: continuation,
      triggerMessage,
    });
    if (!this.scheduler.isMemberRunning(member.id))
      this.setMemberStatus(member.id, "queued");
    this.broadcast(room.id, "run-continued");
    return { ok: true, request: resolved, runId: continuation.id };
  }

  /**
   * 推导一个 run 当前的 A2A 深度（安全字段，宿主补齐）。
   *
   * 取该 run 作为 causationId 已落盘信封里的最大 depth；无则 0（首次跨成员调用）。
   * 用于 room_send/room_ask 的深度守卫，避免模型自行声明深度。
   */
  private runDepth(runId: string): number {
    const envelopes = listMailboxByRoom(getRun(runId)?.roomId ?? "");
    let max = 0;
    for (const e of envelopes) {
      if (e.causationId === runId && e.depth > max) max = e.depth;
    }
    return max;
  }

  /** S4.5：仅在真实越过房间深度策略时写入可呈现的停止信封，绝不伪装成普通失败。 */
  private recordDepthStop(
    room: CollaborationRoom,
    run: CollaborationRun,
    fromMember: CollaborationMember,
    toMember: CollaborationMember,
    payload: string,
    currentDepth: number,
    type: "message" | "question",
  ): void {
    const envelope: CollaborationMailboxEnvelope = {
      id: genId("env_"),
      roomId: room.id,
      fromMemberId: fromMember.id,
      toMemberId: toMember.id,
      type,
      payload,
      rootMessageId: run.triggerMessageId,
      causationId: run.id,
      depth: Math.max(currentDepth, room.maxA2ADepth),
      state: "cancelled",
      attemptId: randomUUID(),
      delivery: "failed",
      stopReason: "max_depth",
      continueUsed: false,
      sourceMessageId: run.triggerMessageId,
      createdAt: Date.now(),
    };
    appendMailboxEnvelope(envelope);
    this.appendSystemMessage(
      room.id,
      `成员「${fromMember.displayName}」向「${toMember.displayName}」的交接已达深度上限（${envelope.depth}/${room.maxA2ADepth}）。可继续一次或停止。`,
    );
    this.broadcast(room.id, "mailbox-updated");
  }

  /**
   * S4.5：把已写入的 outbox 信封关联到唯一目标 run。先落盘信封、再创建 queued run、
   * 最后标 dispatched；同一 attemptId 的幂等键确保崩溃重试不会重复唤醒成员。
   */
  private dispatchEnvelope(
    room: CollaborationRoom,
    target: CollaborationMember,
    envelope: CollaborationMailboxEnvelope,
    triggerMessage: CollaborationMessage,
    idempotencyKeyOverride?: string,
  ): void {
    if (!envelope.attemptId) return;
    const idempotencyKey = idempotencyKeyOverride ?? collaborationEnvelopeIdempotencyKey({
      fromMemberId: envelope.fromMemberId,
      toMemberId: target.id,
      rootMessageId: envelope.rootMessageId,
      causationId: `${envelope.causationId}:${envelope.attemptId}`,
    });
    const existing = findRunByIdempotencyKey(idempotencyKey);
    const run = existing ?? {
      id: genId(COLLABORATION_RUN_ID_PREFIX),
      roomId: room.id,
      memberId: target.id,
      triggerMessageId: triggerMessage.id,
      idempotencyKey,
      status: "queued" as const,
      attempt: 0,
      fence: 0,
    };
    if (!existing) {
      upsertRun(run);
      this.scheduler.enqueue({
        runId: run.id,
        roomId: room.id,
        memberId: target.id,
        room,
        member: target,
        run,
        triggerMessage,
      });
      if (!this.scheduler.isMemberRunning(target.id))
        this.setMemberStatus(target.id, "queued");
    }
    upsertMailboxEnvelope({
      ...envelope,
      delivery: "dispatched",
      deliveryRunId: run.id,
    });
  }

  /** queued → running 的同一临界点把 delivery 标为 accepted，避免把未启动误报为已执行。 */
  private markEnvelopeAccepted(runId: string, roomId: string): void {
    for (const envelope of listMailboxByRoom(roomId)) {
      if (
        envelope.deliveryRunId === runId &&
        envelope.delivery === "dispatched"
      ) {
        upsertMailboxEnvelope({ ...envelope, delivery: "accepted" });
      }
    }
  }

  /** S4.5 最小用户入口：深度停止只可继续一次；新 attempt 仍受硬上限 10 限制。 */
  continueDepthStop(
    envelopeId: string,
    idempotencyKey?: string,
  ): { ok: true; envelopeId: string } | { ok: false; reason: string } {
    const stopped = getMailboxEnvelope(envelopeId);
    if (!stopped) {
      return { ok: false, reason: "深度停止信封不存在" };
    }
    const normalizedKey = idempotencyKey?.trim();
    const scopedIdempotencyKey = normalizedKey
      ? `depth-stop:${stopped.roomId}:${stopped.id}:${normalizedKey}`
      : undefined;
    if (scopedIdempotencyKey) {
      const existingRun = findRunByIdempotencyKey(scopedIdempotencyKey);
      if (existingRun?.roomId === stopped.roomId) {
        const existingEnvelope = listMailboxByRoom(stopped.roomId).find(
          (envelope) => envelope.deliveryRunId === existingRun.id,
        );
        if (existingEnvelope) return { ok: true, envelopeId: existingEnvelope.id };
      }
    }
    if (!canContinueCollaborationDepthStop(stopped)) {
      return { ok: false, reason: "该深度停止不可继续或已使用过继续机会" };
    }
    const room = getRoom(stopped.roomId);
    const target = getMember(stopped.toMemberId);
    if (!room || !target || stopped.depth >= 10) {
      return {
        ok: false,
        reason: "继续条件不满足（房间/成员不存在或已达硬深度上限）",
      };
    }
    const source = listMessagesByRoom(room.id).find(
      (message) => message.id === stopped.sourceMessageId,
    );
    if (!source) return { ok: false, reason: "继续所需的源消息不存在" };
    const next: CollaborationMailboxEnvelope = {
      ...stopped,
      id: genId("env_"),
      depth: stopped.depth + 1,
      state: "pending",
      attemptId: randomUUID(),
      delivery: "outbox",
      deliveryRunId: undefined,
      stopReason: undefined,
      continueUsed: undefined,
      createdAt: Date.now(),
    };
    upsertMailboxEnvelope({ ...stopped, continueUsed: true });
    appendMailboxEnvelope(next);
    this.dispatchEnvelope(room, target, next, source, scopedIdempotencyKey);
    this.broadcast(room.id, "mailbox-updated");
    return { ok: true, envelopeId: next.id };
  }

  /**
   * P2-1：确认继续一个 blocked run —— 以**新** turn 续跑，**不复活旧 fence**。
   *
   * 设计红线（P2-1 brief / 02-RUNTIME-A2A-SPEC §14）：
   * - 校验 room active、run 存在且 `status==='blocked'`、member 未 removed、触发消息仍在；
   * - **禁止**把旧 run 改回 running（旧 run 保持 blocked，其 fence 作废）；
   * - 新建 run：新 id、新 fence（0）、同一 memberId + triggerMessageId；
   * - 新 run 幂等键必须不与旧 blocked run 的键（`triggerMessageId:memberId`）冲突：
   *   调用方提供 idempotencyKey 且不等于旧键 → 用之（同键重复调用返回同一 newRunId）；
   *   否则生成 `resume-of:<oldRunId>:<uuid>`，前缀保证不与旧键冲突；
   * - enqueue scheduler；广播 CHANGED（run-continued）。
   */
  confirmResumeBlockedRun(
    input: ConfirmResumeBlockedRunInput,
  ): ConfirmResumeBlockedRunResult {
    const room = getRoom(input.roomId);
    if (!room || room.status !== "active") {
      return { ok: false, reason: "房间不存在或未激活" };
    }
    const oldRun = getRun(input.runId);
    if (!oldRun || oldRun.roomId !== input.roomId) {
      return { ok: false, reason: "run 不存在或不属于该房间" };
    }
    if (oldRun.status !== "blocked") {
      return { ok: false, reason: "该 run 不在 blocked 状态" };
    }
    const member = getMember(oldRun.memberId);
    if (!member || member.status === "removed") {
      return { ok: false, reason: "成员已移除" };
    }
    const trigger = listMessagesByRoom(room.id).find(
      (message) => message.id === oldRun.triggerMessageId,
    );
    if (!trigger) {
      return { ok: false, reason: "触发消息已删除，无法续跑" };
    }

    // 新 run 幂等键：调用方键（不等于旧 blocked run 键）→ 同键返回同一 newRunId；
    // 否则生成 resume-of:<oldRunId>:<uuid>，前缀保证不与旧键（triggerMessageId:memberId）冲突。
    const oldKey = oldRun.idempotencyKey;
    const callerKey = input.idempotencyKey?.trim();
    const useCallerKey = Boolean(callerKey) && callerKey !== oldKey;
    const idempotencyKey = useCallerKey
      ? callerKey!
      : `resume-of:${oldRun.id}:${randomUUID()}`;
    if (useCallerKey) {
      const existing = findRunByIdempotencyKey(idempotencyKey);
      if (existing) return { ok: true, newRunId: existing.id };
    }

    const newRun: CollaborationRun = {
      id: genId(COLLABORATION_RUN_ID_PREFIX),
      roomId: room.id,
      memberId: member.id,
      triggerMessageId: trigger.id,
      idempotencyKey,
      status: "queued",
      attempt: 0,
      fence: 0,
    };
    upsertRun(newRun);
    this.scheduler.enqueue({
      runId: newRun.id,
      roomId: room.id,
      memberId: member.id,
      room,
      member,
      run: newRun,
      triggerMessage: trigger,
    });
    if (!this.scheduler.isMemberRunning(member.id)) {
      this.setMemberStatus(member.id, "queued");
    }
    this.broadcast(room.id, "run-continued");
    return { ok: true, newRunId: newRun.id };
  }

  /** 落盘一条 A2A 消息（room transcript 投影；visibility=participants） */
  private appendA2AMessage(
    room: CollaborationRoom,
    member: CollaborationMember,
    kind: "a2a_request" | "a2a_reply",
    content: string,
    rootMessageId: string,
    causationId: string,
    runId: string,
    targetMemberIds: string[],
    depth: number,
  ): CollaborationMessage {
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: "member",
      authorId: member.id,
      kind,
      content,
      visibility: "participants",
      targetMemberIds,
      replyToMessageId: undefined,
      rootMessageId,
      causationId,
      runId,
      depth,
      createdAt: Date.now(),
    };
    this.appendRoomMessage(message);
    return message;
  }

  /**
   * 为一条用户消息触发 run（Stage 3：多目标并行扇出，幂等）。
   *
   * - 解析目标成员：message.targetMemberIds 非空 → 这些成员（按顺序去重，跳过未知 ID）；
   *   否则 → 协调者（无协调者则首成员）；空团队返回 []。
   * - 每个目标创建一个 queued run（幂等键 triggerMessageId:memberId；已存在则跳过）。
   * - 经 scheduler 入队：房间级 maxConcurrentRuns + 成员内串行 + FIFO；超容量则排队。
   * - 一方 failed 不取消其他目标（各 run 独立状态机，结果各自落盘）。
   *
   * 返回本次新建的 run 列表（幂等跳过的不含；空团队返回 []）。
   */
  triggerRunForMessage(
    room: CollaborationRoom,
    triggerMessage: CollaborationMessage,
  ): CollaborationRun[] {
    const members = loadMembers(room.id);
    const targets = resolveTargetMembers(room, triggerMessage, members);
    if (targets.length === 0) {
      // 空白团队：无成员可回复，静默跳过（不创建 run、不写消息）。
      // demo 房间经 newCollaborationRoom 默认带成员，此处仅 S1 风格空白团队命中。
      console.warn(`[协作室] 房间 ${room.id} 无成员可回复，跳过 run 触发`);
      return [];
    }

    const created: CollaborationRun[] = [];
    for (const target of targets) {
      if (target.botOwnerUserId && target.ownerConsent !== true) {
        this.appendSystemMessage(
          room.id,
          `Bot「${target.displayName}」属于另一位用户，尚未获得 Bot 所有人授权，已拒绝本次运行。`,
        );
        continue;
      }
      // 幂等：同一 (trigger, member) 已有 run 则跳过（无论状态）
      const idempotencyKey = collaborationRunIdempotencyKey(
        triggerMessage.id,
        target.id,
      );
      if (findRunByIdempotencyKey(idempotencyKey)) continue;

      const run: CollaborationRun = {
        id: genId(COLLABORATION_RUN_ID_PREFIX),
        roomId: room.id,
        memberId: target.id,
        triggerMessageId: triggerMessage.id,
        idempotencyKey,
        status: "queued",
        attempt: 0,
        fence: 0,
      };
      upsertRun(run);
      created.push(run);

      this.scheduler.enqueue({
        runId: run.id,
        roomId: room.id,
        memberId: target.id,
        room,
        member: target,
        run,
        triggerMessage,
      });

      // 入队后若该成员未在 running，标记 queued（让 UI 看到"排队中"；
      // 若调度器已立即启动，executeRun 同步前缀已置 running，此处跳过不覆盖）
      if (!this.scheduler.isMemberRunning(target.id)) {
        this.setMemberStatus(target.id, "queued");
      }
    }
    return created;
  }

  /**
   * 统计同一根消息已经发生的执行用量。根消息来自触发消息的 rootMessageId，
   * 不把不同用户消息或不同房间的 run 混在一起；当前 run 由 excludeRunId 排除。
   */
  private async acquireRootBudgetGate(
    key: string,
    signal: AbortSignal,
  ): Promise<() => void> {
    const previous = this.rootBudgetTails.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const chain = previous.then(() => current);
    this.rootBudgetTails.set(key, chain);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      unlock();
      if (this.rootBudgetTails.get(key) === chain)
        this.rootBudgetTails.delete(key);
    };
    if (signal.aborted) {
      release();
      throw new Error("run 已取消");
    }
    let abortListener: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        abortListener = () => reject(new Error("run 已取消"));
        signal.addEventListener("abort", abortListener, { once: true });
        previous.then(resolve, reject);
      });
    } catch (error) {
      release();
      throw error;
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
    if (signal.aborted) {
      release();
      throw new Error("run 已取消");
    }
    return release;
  }
  private async acquirePersistentRootBudgetLease(
    room: CollaborationRoom,
    rootMessageId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceLease> {
    const scope = "__root-budget__:" + rootMessageId;
    const leaseMs = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(60_000, room.budget.maxWallTimeMs ?? 60 * 60 * 1000),
    );
    const deadline = Date.now() + 5_000;
    while (!signal.aborted) {
      const lease = this.workspaceLeases.acquire(
        room.id,
        [scope],
        "run:" + runId,
        { leaseMs },
      );
      if (lease) return lease;
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (signal.aborted) throw new Error("run 已取消");
    throw new Error("预算协调租约暂不可用，已安全拒绝本次 run");
  }
  private getRootUsageTotals(
    roomId: string,
    rootMessageId: string,
    excludeRunId?: string,
  ): { totalTokens: number; wallTimeMs: number; toolCalls: number } {
    const messages = new Map(
      listMessagesByRoom(roomId).map((message) => [message.id, message]),
    );
    let totalTokens = 0;
    let wallTimeMs = 0;
    let toolCalls = 0;
    for (const run of listRunsByRoom(roomId)) {
      if (run.id === excludeRunId || !run.usage) continue;
      const trigger = messages.get(run.triggerMessageId);
      const runRoot = trigger?.rootMessageId ?? trigger?.id;
      if (runRoot !== rootMessageId) continue;
      totalTokens += run.usage.totalTokens ?? 0;
      wallTimeMs += run.usage.wallTimeMs ?? 0;
      toolCalls += run.usage.toolCalls ?? 0;
    }
    return { totalTokens, wallTimeMs, toolCalls };
  }

  /**
   * 执行一次 turn（异步，由 scheduler 在容量允许时 fire-and-forget 启动）。
   *
   * 状态机：queued → running → done | failed | cancelled（CAS 转换，race-safe）。
   * 完成后落盘成员消息（done）或系统警告（failed），广播 CHANGED。
   * finally 释放调度器 slot（drain 后续排队 run）并同步成员状态；无论成功/失败/取消/被抢占都执行。
   */ private async executeRun(
    room: CollaborationRoom,
    member: CollaborationMember,
    run: CollaborationRun,
    triggerMessage: CollaborationMessage,
  ): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(run.id, controller);
    const startedAt = Date.now();
    let budgetExceeded = false;
    let toolCallCount = 0;
    let sourceExcerptUsedThisTurnTokens = 0;
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    let executionFence: number | undefined;
    let releaseRootBudget: (() => void) | undefined;
    let persistentRootBudgetLease: WorkspaceLease | undefined;
    const casThisRun = (
      expectedFrom: CollaborationRunStatus,
      to: CollaborationRunStatus,
      patch: Partial<CollaborationRun>,
    ) => this["casRun"](run.id, expectedFrom, to, patch, executionFence);

    try {
      // queued → running（scheduler 启动后；若已被取消则 CAS 失败 → 退出，finally 仍 release）
      const started = this["casRun"](run.id, "queued", "running", {
        startedAt,
      });
      if (!started) {
        return;
      }
      executionFence = started.fence ?? 0;
      // 授权可能在入队后被撤回；执行前重新读取成员快照，形成第二道 fail-closed 守卫。
      // 不使用 executeRun 入参里的旧 member，避免 TOCTOU：成员移除/授权撤回都不能继续调用模型。
      const currentMember = getMember(member.id);
      if (
        !currentMember ||
        currentMember.status === "removed" ||
        (currentMember.botOwnerUserId && currentMember.ownerConsent !== true)
      ) {
        const failed = casThisRun("running", "failed", {
          finishedAt: Date.now(),
          error: {
            message: "Bot 在执行前未通过成员状态或所有人授权校验",
            code: "BOT_AUTHORIZATION_REQUIRED",
          },
        });
        if (failed) {
          this.appendSystemMessage(
            room.id,
            currentMember?.botOwnerUserId
              ? "Bot「" +
                  currentMember.displayName +
                  "」在执行前未获得所有人授权，本次运行已拒绝。"
              : "成员在执行前已不可用，本次运行已拒绝。",
          );
          this.broadcast(room.id, "run-finished");
        }
        return;
      }
      this.setMemberStatus(member.id, "running");
      this.markEnvelopeAccepted(run.id, room.id);
      this.broadcast(room.id, "run-started");
      const rootMessageId = triggerMessage.rootMessageId || triggerMessage.id;
      if (
        room.budget.maxTurns !== undefined ||
        room.budget.maxUsageTokens !== undefined ||
        room.budget.maxWallTimeMs !== undefined
      ) {
        releaseRootBudget = await this.acquireRootBudgetGate(
          room.id + ":" + rootMessageId,
          controller.signal,
        );
        persistentRootBudgetLease = await this.acquirePersistentRootBudgetLease(
          room,
          rootMessageId,
          run.id,
          controller.signal,
        );
      }
      const priorRootUsage = this.getRootUsageTotals(
        room.id,
        rootMessageId,
        run.id,
      );
      if (
        (room.budget.maxTurns !== undefined &&
          priorRootUsage.toolCalls >= room.budget.maxTurns) ||
        (room.budget.maxUsageTokens !== undefined &&
          priorRootUsage.totalTokens >= room.budget.maxUsageTokens) ||
        (room.budget.maxWallTimeMs !== undefined &&
          priorRootUsage.wallTimeMs >= room.budget.maxWallTimeMs)
      ) {
        budgetExceeded = true;
        throw new Error("本根消息的协作室预算已耗尽");
      }
      if (room.budget.maxWallTimeMs !== undefined) {
        const remainingWallTime = Math.max(
          1,
          room.budget.maxWallTimeMs - priorRootUsage.wallTimeMs,
        );
        budgetTimer = setTimeout(() => {
          budgetExceeded = true;
          controller.abort();
        }, remainingWallTime);
      }

      // 组装上下文投影 + 调后端
      const allMembers = loadMembers(room.id);
      const messages = listMessagesByRoom(room.id);
      const pendingMailbox = listActiveMailboxForMember(member.id);
      const projected = projectCollaborationTurnContext({
        room,
        member,
        members: allMembers,
        messages,
        trigger: triggerMessage,
        botMemories: member.botProfileId
          ? getActiveBotMemories(member.botProfileId).map(
              (memory) => memory.text,
            )
          : [],
        memberSummary: member.summary,
        roomSummary: latestCollaborationRoomSummaryText(
          getCollaborationSummary(room.id),
        ),
        mailboxPreview: pendingMailbox
          .filter(
            (e) =>
              e.toMemberId === member.id &&
              (e.state === "pending" || e.state === "delivered"),
          )
          .slice(-6)
          .map((e) => ({
            fromName:
              allMembers.find((m) => m.id === e.fromMemberId)?.displayName ??
              "成员",
            type:
              e.type === "question"
                ? "提问"
                : e.type === "reply"
                  ? "回复"
                  : "通知",
            payload: e.payload,
          })),
      });
      const projectedPrompt = flattenProjectedTurn(projected.messages);
      const attachmentPrompt = triggerMessage.attachments?.length
        ? `\n\n[用户附件]\n${triggerMessage.attachments
            .map(
              (attachment) =>
                `- ${attachment.filename}: ${getAttachmentAbsolutePath(attachment.localPath)}`,
            )
            .join("\n")}`
        : "";
      const prompt = projectedPrompt + attachmentPrompt;
      const workspaceRoot = resolveRoomWorkspaceRoot(room);
      const workspaceId =
        room.sourceSessionId && room.workspaceId
          ? room.workspaceId
          : room.roomWorkspace?.id ?? room.workspaceId;
      const systemPrompt = [
        projected.systemPrompt,
        buildRoomWorkspaceContextPrompt(room, workspaceRoot),
      ]
        .filter(Boolean)
        .join("\n\n");
      let streamed = "";
      const input: MemberTurnInput = {
        roomId: room.id,
        memberId: member.id,
        runId: run.id,
        fence: executionFence,
        logicalSessionId: member.logicalSessionId,
        cliWorkerId: member.cliWorkerId,
        backend: member.backend,
        triggerMessageId: triggerMessage.id,
        workspaceId,
        workspaceRoot,
        permissionProfile: member.permissionProfile,

        capabilities: member.capabilities,
        channelId: member.channelId,
        modelId: member.modelId,
        systemPrompt,
        prompt,
        signal: controller.signal,
        onTextDelta: (delta: string) => {
          if (!delta) return;
          streamed += delta;
          this.onTextDelta({
            roomId: room.id,
            runId: run.id,
            memberId: member.id,
            text: streamed,
            at: Date.now(),
          });
        },
        hostToolHandler: async (call) => {
          toolCallCount += 1;
          if (
            room.budget.maxTurns !== undefined &&
            priorRootUsage.toolCalls + toolCallCount > room.budget.maxTurns
          ) {
            budgetExceeded = true;
            controller.abort();
            return {
              output: `已达到本根消息的 maxTurns 预算（${room.budget.maxTurns}）`,
              isError: true,
            };
          }
          switch (call.name) {
            case "room_send": {
              const result = this.roomSend({
                roomId: room.id,
                fromRunId: run.id,
                toMemberId: call.arguments.toMemberId ?? "",
                payload: call.arguments.message ?? "",
              });
              return result.ok
                ? { output: `通知已发送（envelope=${result.envelopeId}）` }
                : {
                    output: `room_send 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "room_ask": {
              const result = this.roomAsk({
                roomId: room.id,
                fromRunId: run.id,
                toMemberId: call.arguments.toMemberId ?? "",
                question: call.arguments.question ?? "",
              });
              if (!result.ok)
                return {
                  output: `room_ask 被拒绝：${result.reason}`,
                  isError: true,
                };
              // 先成功落盘 question，再 CAS 释放执行槽；CAS 失败不把半完成 ask 伪装为等待。
              const awaiting = this.markRunAwaitingPeer(run.id);
              return awaiting
                ? {
                    output: `提问已发送（request=${result.requestId}），正在等待对方回复。`,
                    awaitPeer: true,
                  }
                : {
                    output:
                      "room_ask 已落盘但当前 run 未能进入 awaiting_peer，已停止后续执行。",
                    isError: true,
                  };
            }
            case "room_reply": {
              const result = this.roomReply({
                roomId: room.id,
                fromRunId: run.id,
                requestId: call.arguments.requestId ?? "",
                answer: call.arguments.answer ?? "",
              });
              return result.ok
                ? { output: `回复已发送（envelope=${result.envelopeId}）` }
                : {
                    output: `room_reply 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "room_task_assign": {
              // 受控任务分派：只有协调者可以把未指派任务交给本房间成员；成功后
              // 宿主会把 assignment 事件作为新 trigger，自动启动目标成员。
              const result = this.roomTaskAssign({
                roomId: room.id,
                fromRunId: run.id,
                taskId: call.arguments.taskId ?? "",
                assigneeMemberId: call.arguments.assigneeMemberId ?? "",
              });
              return result.ok
                ? {
                    output: `任务已分派（task=${result.taskId}，负责人=${result.assigneeMemberId}，run=${result.runId ?? "queued"}）`,
                  }
                : {
                    output: `room_task_assign 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "room_task_update": {
              // 受控任务更新：宿主校验归属/挂板/负责人/状态机；summary 仅作可审计事件。
              // 成功/失败均回注安全文本；绝不暴露 filesystem/shell/database，也改不了权威字段。
              const result = this.roomTaskUpdate({
                roomId: room.id,
                fromRunId: run.id,
                taskId: call.arguments.taskId ?? "",
                status: call.arguments.status ?? "",
                summary: call.arguments.summary,
              });
              return result.ok
                ? {
                    output: `任务已更新（task=${result.taskId}，状态=${result.status}，version=${result.version}）`,
                  }
                : {
                    output: `room_task_update 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "room_publish_artifact": {
              // 受控产物发布：宿主校验房间/成员/run/权限/工作区/路径/hash 后落盘审计。
              // 安全字段（roomId/memberId/runId）取自 run 上下文；relativePath/content 由模型给出但
              // 经严格路径校验与尺寸上限；绝不暴露任意 filesystem/shell，只能在绑定工作区内写文本。
              const result = this.roomPublishArtifact({
                roomId: room.id,
                fromRunId: run.id,
                relativePath: call.arguments.relativePath ?? "",
                content: call.arguments.content ?? "",
                summary: call.arguments.summary,
                taskId: call.arguments.taskId,
              });
              return result.ok
                ? {
                    output: `产物已发布（artifact=${result.artifactId}，路径=${result.relativePath}，sha256=${result.sha256.slice(0, 12)}…，${result.byteSize}B）`,
                  }
                : {
                    output: `room_publish_artifact 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "room_request_user": {
              const result = this.requestUserApproval({
                roomId: room.id,
                fromRunId: run.id,
                question: call.arguments.question ?? "",
                reason: call.arguments.reason,
                options: call.arguments.options,
              });
              if (!result.ok)
                return {
                  output: `room_request_user 被拒绝：${result.reason}`,
                  isError: true,
                };
              return {
                output: `已提交用户审批（request=${result.request.id}），等待用户决定。`,
                awaitPeer: true,
              };
            }
            case "read_source_session_excerpt": {
              try {
                if (!member.isCoordinator) {
                  return {
                    output: "只有协调者 Bot 可以读取来源单会话摘录。",
                    isError: true,
                  };
                }
                const sourceSessionId = room.sourceSessionId?.trim();
                if (!sourceSessionId) {
                  return {
                    output: "当前协作室没有绑定来源单会话。",
                    isError: true,
                  };
                }
                if (!this.sourceSessionExcerptReader) {
                  return {
                    output: "当前运行时尚未装配来源单会话摘录读取器。",
                    isError: true,
                  };
                }
                const parsePositiveInt = (
                  raw: string | undefined,
                ): number | undefined => {
                  if (!raw?.trim()) return undefined;
                  const value = Number(raw);
                  return Number.isFinite(value) && value > 0
                    ? Math.trunc(value)
                    : undefined;
                };
                const recentMessageLimit = parsePositiveInt(
                  call.arguments.recentMessageLimit,
                );
                const maxTokens = parsePositiveInt(call.arguments.maxTokens);
                const query = call.arguments.query?.trim();
                const excerpt = await this.sourceSessionExcerptReader(
                  {
                    roomId: room.id,
                    sourceSessionId,
                    ...(query ? { query } : {}),
                    ...(recentMessageLimit !== undefined
                      ? { recentMessageLimit }
                      : {}),
                    ...(maxTokens !== undefined ? { maxTokens } : {}),
                  },
                  sourceExcerptUsedThisTurnTokens,
                );
                sourceExcerptUsedThisTurnTokens += Math.max(
                  0,
                  excerpt.tokenEstimate,
                );
                return {
                  output:
                    "来源会话摘录（token≈" +
                    excerpt.tokenEstimate +
                    (excerpt.truncated ? "，已截断" : "") +
                    "）：\\n" +
                    excerpt.excerpt,
                };
              } catch (error) {
                return {
                  output:
                    error instanceof Error ? error.message : String(error),
                  isError: true,
                };
              }
            }
            case "workspace_read_file": {
              const result = this.workspaceReadFile({
                roomId: room.id,
                fromRunId: run.id,
                path: call.arguments.path ?? "",
                maxBytes:
                  call.arguments.maxBytes !== undefined &&
                  call.arguments.maxBytes !== ""
                    ? Number(call.arguments.maxBytes)
                    : undefined,
              });
              return result.ok
                ? {
                    output: `文件已读取（路径=${result.path}，${result.byteSize}B${result.truncated ? "，已截断" : ""}）\n${result.content}`,
                  }
                : {
                    output: `workspace_read_file 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "workspace_search": {
              const result = this.workspaceSearch({
                roomId: room.id,
                fromRunId: run.id,
                path: call.arguments.path ?? "",
                pattern: call.arguments.pattern,
                maxResults:
                  call.arguments.maxResults !== undefined &&
                  call.arguments.maxResults !== ""
                    ? Number(call.arguments.maxResults)
                    : undefined,
              });
              return result.ok
                ? {
                    output: `搜索结果（基础路径=${result.basePath}${result.pattern ? `，过滤=${result.pattern}` : ""}，共 ${result.count} 项${result.truncated ? "，已截断" : ""}）\n${result.results.join("\n")}`,
                  }
                : {
                    output: `workspace_search 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "workspace_write_file": {
              const result = this.workspaceWriteFile({
                roomId: room.id,
                fromRunId: run.id,
                path: call.arguments.path ?? "",
                content: call.arguments.content ?? "",
              });
              return result.ok
                ? {
                    output: `文件已写入（路径=${result.path}，${result.byteSize}B，sha256=${result.sha256.slice(0, 12)}…）`,
                  }
                : {
                    output: `workspace_write_file 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "workspace_run_command": {
              const result = await this.workspaceRunCommand({
                roomId: room.id,
                fromRunId: run.id,
                command: call.arguments.command ?? "",
                args: call.arguments.args,
                cwd: call.arguments.cwd,
                timeoutMs:
                  call.arguments.timeoutMs !== undefined &&
                  call.arguments.timeoutMs !== ""
                    ? Number(call.arguments.timeoutMs)
                    : undefined,
              });
              return result.ok
                ? {
                    output:
                      `命令已执行（${result.command}，退出码=${result.exitCode ?? "SIGKILL"}` +
                      `${result.timedOut ? "，已超时" : ""}` +
                      `${result.truncated ? "，输出已截断" : ""}` +
                      `）\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
                  }
                : {
                    output: `workspace_run_command 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "workspace_apply_patch": {
              const result = this.workspaceApplyPatch({
                roomId: room.id,
                fromRunId: run.id,
                path: call.arguments.path ?? "",
                oldText: call.arguments.oldText ?? "",
                newText: call.arguments.newText ?? "",
              });
              return result.ok
                ? {
                    output: `文件补丁已应用（路径=${result.path}，${result.byteSize}B，sha256=${result.sha256.slice(0, 12)}…）`,
                  }
                : {
                    output: `workspace_apply_patch 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "workspace_delete_file": {
              const result = this.workspaceDeleteFile({
                roomId: room.id,
                fromRunId: run.id,
                path: call.arguments.path ?? "",
              });
              return result.ok
                ? { output: `文件已删除（路径=${result.path}）` }
                : {
                    output: `workspace_delete_file 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
            case "workspace_move_file": {
              const result = this.workspaceMoveFile({
                roomId: room.id,
                fromRunId: run.id,
                fromPath: call.arguments.fromPath ?? "",
                toPath: call.arguments.toPath ?? "",
              });
              return result.ok
                ? {
                    output: `文件已移动（${result.fromPath} → ${result.toPath}）`,
                  }
                : {
                    output: `workspace_move_file 被拒绝：${result.reason}`,
                    isError: true,
                  };
            }
          }
        },
      };
      const result = await this.adapter.runTurn(input);

      const usage = {
        ...(result.usage ?? {}),
        wallTimeMs: result.usage?.wallTimeMs ?? Date.now() - startedAt,
        toolCalls: toolCallCount,
      };
      this.recordRunUsage(room, member, run, usage);
      const rootUsage = {
        totalTokens: priorRootUsage.totalTokens + (usage.totalTokens ?? 0),
        wallTimeMs: priorRootUsage.wallTimeMs + (usage.wallTimeMs ?? 0),
        toolCalls: priorRootUsage.toolCalls + (usage.toolCalls ?? 0),
      };
      if (
        (room.budget.maxUsageTokens !== undefined &&
          rootUsage.totalTokens > room.budget.maxUsageTokens) ||
        (room.budget.maxWallTimeMs !== undefined &&
          rootUsage.wallTimeMs > room.budget.maxWallTimeMs) ||
        (room.budget.maxTurns !== undefined &&
          rootUsage.toolCalls > room.budget.maxTurns)
      ) {
        budgetExceeded = true;
      }
      if (budgetExceeded) {
        const error: CollaborationSerializedRunError = {
          code: "BUDGET_EXCEEDED",
          message: "协作室预算已耗尽，已阻止本次 run 完成",
        };
        casThisRun("running", "failed", {
          finishedAt: Date.now(),
          error,
          usage,
        });
        // 失败原因由时间线中的 run 卡统一展示，避免再写一条重复的 system 气泡。
        this.broadcast(room.id, "run-finished");
        return;
      }

      // 被取消则不写成员消息。awaiting_peer / 已被 continuation 收口的 run 不得覆盖为 cancelled。
      if (controller.signal.aborted) {
        const current = getRun(run.id);
        if (
          current?.status === "awaiting_peer" ||
          current?.status === "awaiting_user" ||
          current?.status === "done" ||
          current?.status === "blocked"
        ) {
          return;
        }
        casThisRun("running", "cancelled", { finishedAt: Date.now() });
        this.broadcast(room.id, "run-cancelled");
        return;
      }

      // 成员在 adapter 返回前被软删除时，不再写入新的正式消息。
      if (getMember(member.id)?.status === "removed") {
        casThisRun("running", "cancelled", { finishedAt: Date.now() });
        this.broadcast(room.id, "run-cancelled");
        return;
      }

      // running → done + 成员消息
      const finishedAt = Date.now();
      const completed = casThisRun("running", "done", {
        finishedAt,
        usage,
      });
      if (!completed) return;
      this.appendMemberMessage(
        room,
        member,
        triggerMessage,
        result.text,
        run.id,
      );
      this.updateMemberContextSummary(room.id, member.id);
      this.broadcast(room.id, "run-finished");
      this.kickSummary(room);
    } catch (err) {
      if (budgetExceeded) {
        const error: CollaborationSerializedRunError = {
          code: "BUDGET_EXCEEDED",
          message: "协作室预算已耗尽，已中止本次 run",
        };
        casThisRun("running", "failed", {
          finishedAt: Date.now(),
          error,
        });
        // 失败原因由时间线中的 run 卡统一展示，避免再写一条重复的 system 气泡。
        this.broadcast(room.id, "run-finished");
        return;
      }
      if (controller.signal.aborted) {
        const current = getRun(run.id);
        if (
          current?.status === "awaiting_peer" ||
          current?.status === "done" ||
          current?.status === "blocked"
        ) {
          return;
        }
        casThisRun("running", "cancelled", { finishedAt: Date.now() });
        this.broadcast(room.id, "run-cancelled");
        return;
      }
      // running → failed（一方失败不影响其他目标 run）。run.error 是失败原因的
      // 唯一可见出口，避免和 run 卡重复渲染一条 system 警告。
      const error = serializeRunError(err);
      casThisRun("running", "failed", {
        finishedAt: Date.now(),
        error,
      });
      this.broadcast(room.id, "run-finished");
    } finally {
      persistentRootBudgetLease?.release();
      releaseRootBudget?.();
      if (budgetTimer) clearTimeout(budgetTimer);
      this.abortControllers.delete(run.id);
      this.inflight.delete(run.id);
      // 释放调度器 slot → drain 启动后续排队 run；再同步成员状态（queued/idle）
      this.scheduler.release(run.id, room.id, member.id);
      this.syncMemberStatus(member.id);
    }
  }

  /**
   * 等待当前可运行的 run 进入终态（测试 / 关闭前 drain 用）。
   *
   * paused 房间里的 queued run 是刻意等待唤醒的，不应该把调用方永久卡住；
   * 因此这里以 inflight 为准。当前一批 run 完成后，scheduler 可能已经 drain 出下一批，
   * 下一轮会继续等待；如果只剩暂停队列，则立即返回，恢复房间后再由 scheduler.wake 启动。
   */
  async awaitAllRuns(): Promise<void> {
    while (true) {
      const snapshot = [...this.inflight.values()];
      if (snapshot.length === 0) return;
      await Promise.allSettled(snapshot);
    }
  }

  /** 仅等待指定房间当前在途的 run，供退出/关闭单个房间时收口使用。 */
  async awaitRunsForRoom(roomId: string): Promise<void> {
    while (true) {
      const snapshot = [...this.inflight.entries()]
        .filter(([runId]) => getRun(runId)?.roomId === roomId)
        .map(([, promise]) => promise);
      if (snapshot.length === 0) return;
      await Promise.allSettled(snapshot);
    }
  }

  // ===== Member =====

  /** 列出某房间全部成员 */
  listMembers(roomId: string): CollaborationMember[] {
    return listMembersByRoom(roomId);
  }

  /**
   * 向已有房间追加一个成员（Stage 3：「添加成员」最小按钮用）。
   *
   * - displayName 必填非空；房间须存在且未归档。
   * - 成员数含新增不超过 COLLABORATION_ROOM_MAX_MEMBERS。
   * - 未显式绑渠道时自动绑默认渠道（kscc 优先，再外部），与 createRoom 一致。
   * - 不影响协调者；新成员初始 status='offline'，发消息点名后才转入 queued/running。
   */
  addMember(
    roomId: string,
    input: CreateCollaborationMemberInput,
  ): CollaborationMember {
    const room = getRoom(roomId);
    if (!room) {
      throw new Error("房间不存在");
    }
    if (room.status === "archived") {
      throw new Error("已归档房间不能添加成员");
    }
    const displayName = input.displayName?.trim();
    if (!displayName) {
      throw new Error("成员显示名不能为空");
    }
    if (input.backend === "cli" && !input.cliWorkerId?.trim()) {
      throw new Error("CLI worker 成员必须选择一个 worker");
    }
    if (
      input.backend === "cli" &&
      input.permissionProfile !== "workspace-write"
    ) {
      throw new Error("CLI worker 成员必须明确使用 workspace-write 权限");
    }
    const existing = loadMembers(roomId).filter(
      (member) => member.status !== "removed",
    );
    if (existing.length >= COLLABORATION_ROOM_MAX_MEMBERS) {
      throw new Error(`成员数已达上限 ${COLLABORATION_ROOM_MAX_MEMBERS}`);
    }

    const now = Date.now();
    const member = materializeBotProfileSnapshot(
      buildMember(
        roomId,
        {
          ...input,
          displayName,
          isCoordinator:
            input.isCoordinator ||
            (existing.length === 0 && Boolean(input.botProfileId)),
        },
        now,
      ),
      input.botProfileId,
    );
    if (
      this.localOnly &&
      member.botOwnerUserId &&
      member.botOwnerUserId !== LOCAL_HUMAN_USER_ID
    ) {
      throw new Error("当前发布版不支持加入其他用户所有的 Bot");
    }
    member.ownerConsent =
      !member.botOwnerUserId ||
      member.botOwnerUserId === (room.ownerUserId ?? "local-user");
    appendMembers([member]);
    if (!room.coordinatorMemberId && member.isCoordinator) {
      upsertRoom({ ...room, coordinatorMemberId: member.id, updatedAt: now });
    }

    this.broadcast(roomId, "updated");
    return member;
  }

  /**
   * 更新已有成员（改显示名 / 渠道 / 模型）。
   * 不改 isCoordinator、logicalSessionId、权限档位（安全字段）。
   */
  updateMember(input: UpdateCollaborationMemberInput): CollaborationMember {
    const member = getMember(input.memberId);
    if (!member) {
      throw new Error("成员不存在");
    }
    if (member.roomId !== input.roomId) {
      throw new Error("成员不属于该房间");
    }
    const room = getRoom(input.roomId);
    if (!room) {
      throw new Error("房间不存在");
    }
    if (room.status === "archived") {
      throw new Error("已归档房间不能修改成员");
    }
    if (member.status === "removed") {
      throw new Error("已移除成员不能继续修改；请添加新的 Bot 快照");
    }
    const requestedBackend = input.backend;
    const requestedWorker = input.cliWorkerId?.trim() || undefined;
    const backendChanged =
      requestedBackend !== undefined && requestedBackend !== member.backend;
    const workerChanged =
      input.cliWorkerId !== undefined &&
      requestedWorker !== (member.cliWorkerId ?? "");
    const permissionChanged =
      input.permissionProfile !== undefined &&
      input.permissionProfile !== member.permissionProfile;
    if (
      member.botProfileId &&
      (((input.channelId !== undefined || input.modelId !== undefined) &&
        (input.channelId !== member.channelId ||
          input.modelId !== member.modelId)) ||
        backendChanged ||
        workerChanged ||
        permissionChanged)
    ) {
      throw new Error(
        "Bot 成员是加入时的配置副本；请移除后重新添加 Bot，不能原地改写执行后端或模型",
      );
    }
    const nextBackend = requestedBackend ?? member.backend;
    const nextCliWorkerId =
      nextBackend === "cli"
        ? (requestedWorker ?? member.cliWorkerId)
        : undefined;
    if (nextBackend === "cli" && !nextCliWorkerId) {
      throw new Error("CLI worker 成员必须选择一个 worker");
    }
    const nextPermissionProfile =
      input.permissionProfile ?? member.permissionProfile;
    if (nextBackend === "cli" && nextPermissionProfile !== "workspace-write") {
      throw new Error("CLI worker 成员必须明确使用 workspace-write 权限");
    }

    let displayName = member.displayName;
    let mentionAliases = member.mentionAliases;
    if (input.displayName !== undefined) {
      displayName = input.displayName.trim();
      if (!displayName) {
        throw new Error("成员显示名不能为空");
      }
      mentionAliases = nextCollaborationMentionAliases(
        member.mentionAliases,
        member.displayName,
        displayName,
      );
    }

    const channelChanged =
      input.channelId !== undefined &&
      input.channelId !== (member.channelId ?? "");
    const nextChannelId =
      nextBackend === "codex"
        ? undefined
        : input.channelId === undefined
          ? member.channelId
          : input.channelId || undefined;
    let nextModelId =
      nextBackend === "codex"
        ? input.modelId?.trim() || undefined
        : input.modelId === undefined
          ? member.modelId
          : input.modelId || undefined;
    // 换渠道且未同时指定模型 → 清掉旧模型，由 adapter 回落新渠道默认
    if (
      nextBackend !== "codex" &&
      channelChanged &&
      input.modelId === undefined
    ) {
      nextModelId = undefined;
    }

    const updated: CollaborationMember = {
      ...member,
      displayName,
      backend: nextBackend,
      cliWorkerId: nextCliWorkerId,
      permissionProfile: nextPermissionProfile,
      mentionAliases:
        mentionAliases && mentionAliases.length > 0
          ? mentionAliases
          : undefined,
      channelId: nextChannelId,
      modelId: nextModelId,
      backendResumeToken:
        nextBackend === "codex" && member.backend === "codex"
          ? member.backendResumeToken
          : undefined,
      capabilities: {
        ...member.capabilities,
        supportsToolBridge:
          nextBackend === "codex"
            ? true
            : channelSupportsRoomToolBridge(nextChannelId),
      },
      updatedAt: Date.now(),
    };
    upsertMember(updated);
    this.broadcast(input.roomId, "updated");
    return updated;
  }

  /**
   * 软删除成员：保留历史、run 与 Bot 加入时快照，但从新路由中移除。
   *
   * 删除前取消该成员仍处于 queued/running 的 run；若删除协调者，最早的剩余成员
   * 自动接任。替换 Bot 应通过 addMember 新增成员，因此不会改写旧成员的配置副本。
   */
  removeMember(input: RemoveCollaborationMemberInput): CollaborationMember {
    const member = getMember(input.memberId);
    if (!member) {
      throw new Error("成员不存在");
    }
    if (member.roomId !== input.roomId) {
      throw new Error("成员不属于该房间");
    }
    const room = getRoom(input.roomId);
    if (!room) {
      throw new Error("房间不存在");
    }
    if (room.status === "archived") {
      throw new Error("已归档房间不能删除成员");
    }
    if (member.status === "removed") return member;

    for (const run of listRunsByRoom(input.roomId)) {
      if (
        run.memberId === member.id &&
        (run.status === "queued" || run.status === "running")
      ) {
        this.cancelRun(run.id);
      }
    }

    const now = Date.now();
    const handoffSummary = buildMemberHandoffSummary(input.roomId, member);
    const removed: CollaborationMember = {
      ...member,
      status: "removed",
      removedAt: now,
      isCoordinator: false,
      handoffSummary,
      updatedAt: now,
    };
    upsertMember(removed);

    const remaining = loadMembers(input.roomId).filter(
      (candidate) => candidate.status !== "removed",
    );
    const coordinatorStillPresent =
      Boolean(room.coordinatorMemberId) &&
      remaining.some((candidate) => candidate.id === room.coordinatorMemberId);
    if (room.coordinatorMemberId === member.id || !coordinatorStillPresent) {
      const successor = remaining[0];
      if (successor) {
        const nextSuccessor = {
          ...successor,
          isCoordinator: true,
          updatedAt: now,
        };
        upsertMember(nextSuccessor);
        upsertRoom({
          ...room,
          coordinatorMemberId: successor.id,
          updatedAt: now,
        });
        this.appendSystemMessage(
          input.roomId,
          `成员「${member.displayName}」已移除，协调者已交接给「${successor.displayName}」。${handoffSummary ? ` 交接摘要：${handoffSummary}` : ""}`,
        );
      } else {
        upsertRoom({ ...room, coordinatorMemberId: "", updatedAt: now });
        this.appendSystemMessage(
          input.roomId,
          `成员「${member.displayName}」已移除，房间当前没有可接任的协调者。${handoffSummary ? ` 交接摘要：${handoffSummary}` : ""}`,
        );
      }
    } else {
      upsertRoom({ ...room, updatedAt: now });
      this.appendSystemMessage(
        input.roomId,
        `成员「${member.displayName}」已移除。${handoffSummary ? ` 交接摘要：${handoffSummary}` : ""}`,
      );
    }

    this.broadcast(input.roomId, "updated");
    return removed;
  }
  // ===== Room Task（S5：无看板时的轻量任务真值） =====
  //
  // 02-RUNTIME-A2A-SPEC §2.6 / 03-IMPLEMENTATION-PHASES §7：room task 仅在房间未挂载看板
  // （attachedBoardId 为空）时是任务真值。挂载看板后任务真值归看板，room 不再维护另一份
  // 独立任务状态（不变量 §15.7）；此处 create/update 一律 fail closed，list/get 仍开放
  // 供历史追溯。本切片不做看板桥；模型侧通过受控任务分派/更新与产物工具推进。

  /**
   * 创建轻量 room task（仅未挂载看板时）。
   *
   * - 房间须存在且未挂载看板：挂载后任务真值归看板，不能在房间内创建（不变量 §15.7）。
   * - 标题必填非空；负责人（若指定）须为本房间成员。
   * - 初始 status='todo'、version=1。
   * - 房间 active 时自动落一条系统 warning 并触发一次协作 run：有明确负责人时直达负责人，
   *   未指派时按普通无 @ 消息路由给协调者。这样从工作面板新建任务也会进入协作流程，
   *   不要求用户再回到聊天框手动 @。
   */
  createRoomTask(
    input: CreateCollaborationRoomTaskInput,
  ): CollaborationRoomTask {
    const room = getRoom(input.roomId);
    if (!room) {
      throw new Error("房间不存在");
    }
    if (this.roomHasAttachedBoard(room)) {
      throw new Error(
        "房间已挂载看板，任务真值由看板维护，不能在房间内创建任务",
      );
    }
    const title = input.title?.trim() ?? "";
    if (!title) {
      throw new Error("任务标题不能为空");
    }
    const assigneeMemberId = this.validateAssignee(
      input.assigneeMemberId,
      room.id,
    );

    const now = Date.now();
    const taskId = genId(COLLABORATION_ROOM_TASK_ID_PREFIX);
    const dependsOnTaskIds = this.validateTaskDependencies(
      room,
      taskId,
      input.dependsOnTaskIds,
    );
    let task: CollaborationRoomTask = {
      id: taskId,
      roomId: room.id,
      title,
      description: input.description?.trim() || undefined,
      status: this.hasPendingTaskDependencies(dependsOnTaskIds) ? "blocked" : "todo",
      assigneeMemberId,
      sourceMessageId: input.sourceMessageId || undefined,
      runId: input.runId || undefined,
      dependsOnTaskIds,
      acceptanceCriteria: input.acceptanceCriteria?.trim() || undefined,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    upsertRoomTask(task);
    // 创建任务也是房间活动，刷新侧栏排序和房间更新时间。
    upsertRoom({ ...room, updatedAt: now });
    this.broadcast(room.id, "updated");

    // 工作面板创建任务不是“只写数据库”的死路：把任务投影成系统 warning，
    // 再复用现有消息路由/调度器。未指定负责人时 targetMemberIds 为空，
    // triggerRunForMessage 会按既有规则投递协调者；指定负责人则视为显式目标。
    if (room.status === "active") {
      const trigger = this.appendTaskCreatedMessage(room, task);
      if (task.status !== "blocked") {
        const createdRuns = this.triggerRunForMessage(room, trigger);
        if (createdRuns[0]) {
          task = this.linkTaskToRun(task, createdRuns[0]);
        }
        this.kickSummary(room);
      }
    }

    return task;
  }

  /**
   * 将任务和实际触发的 run 建立审计关联。任务创建/分派先写入任务真值，
   * 再用 CAS 回填 runId；并发下失败则保留已存在的最新记录，不覆盖其他更新。
   */
  private linkTaskToRun(
    task: CollaborationRoomTask,
    run: CollaborationRun,
  ): CollaborationRoomTask {
    const current = getRoomTask(task.id);
    if (!current || current.roomId !== run.roomId || current.runId === run.id) {
      return current ?? task;
    }
    const linked: CollaborationRoomTask = {
      ...current,
      // runId 是执行索引，不是任务状态迁移；不推进任务 version，避免一次创建被算成两次编辑。
      runId: run.id,
      version: current.version,
      updatedAt: current.updatedAt,
    };
    if (!saveRoomTaskIfCurrent(current.id, current.version, linked)) {
      return getRoomTask(current.id) ?? current;
    }
    this.broadcast(current.roomId, "updated");
    return linked;
  }

  /**
   * 校验任务依赖属于当前房间，并在写入前阻断自环/循环依赖。
   * 依赖必须引用已经存在的任务，避免把拼写错误永久落成 blocked。
   */
  private validateTaskDependencies(
    room: CollaborationRoom,
    taskId: string,
    inputDependencies?: string[],
  ): string[] | undefined {
    const dependencies = dedupeDependsOn(inputDependencies);
    if (!dependencies) return undefined;

    const visiting = new Set<string>();
    const walk = (dependencyId: string, path: string[]): void => {
      const dependency = getRoomTask(dependencyId);
      if (!dependency) {
        throw new Error("前置任务不存在：" + dependencyId);
      }
      if (dependency.roomId !== room.id) {
        throw new Error("前置任务不属于当前房间：" + dependencyId);
      }
      if (dependency.id === taskId) {
        throw new Error("任务不能依赖自身");
      }
      if (visiting.has(dependency.id)) {
        throw new Error("任务依赖存在循环：" + [...path, dependency.id].join(" -> "));
      }
      visiting.add(dependency.id);
      for (const childId of dependency.dependsOnTaskIds ?? []) {
        walk(childId, [...path, dependency.id]);
      }
      visiting.delete(dependency.id);
    };

    for (const dependencyId of dependencies) {
      walk(dependencyId, []);
    }
    return dependencies;
  }

  /**
   * 判断任务是否仍在等待依赖。依赖都已通过创建时校验；状态不是 done 时保持 blocked。
   */
  private hasPendingTaskDependencies(
    dependsOnTaskIds?: string[],
  ): boolean {
    return (dependsOnTaskIds ?? []).some((dependencyId) => {
      const dependency = getRoomTask(dependencyId);
      return !dependency || dependency.status !== "done";
    });
  }

  /**
   * 某任务完成后释放直接依赖它的阻塞任务。CAS 保证并发完成事件只会释放一次；
   * 释放后的任务复用现有消息路由，因此负责人和协调者都不需要额外的调度分支。
   */
  private releaseReadyDependentTasks(
    room: CollaborationRoom,
    completedTaskId: string,
  ): void {
    if (room.status !== "active" || this.roomHasAttachedBoard(room)) return;

    let released = false;
    for (const task of listRoomTasksByRoom(room.id)) {
      if (task.status !== "blocked") continue;
      if (!(task.dependsOnTaskIds ?? []).includes(completedTaskId)) continue;
      if (this.hasPendingTaskDependencies(task.dependsOnTaskIds)) continue;

      const next: CollaborationRoomTask = {
        ...task,
        status: "todo",
        version: task.version + 1,
        updatedAt: Date.now(),
      };
      if (!saveRoomTaskIfCurrent(task.id, task.version, next)) continue;

      const trigger = this.appendTaskDependencyReadyMessage(room, next);
      const createdRuns = this.triggerRunForMessage(room, trigger);
      if (createdRuns[0]) {
        this.linkTaskToRun(next, createdRuns[0]);
      }
      released = true;
    }
    if (released) this.kickSummary(room);
    if (released) this.broadcast(room.id, "updated");
  }

  /** 列出某房间全部 room task（按 createdAt 升序，次按 id 稳定） */
  listRoomTasks(roomId: string): CollaborationRoomTask[] {
    return listRoomTasksByRoom(roomId);
  }

  /** 取单个 room task（不存在返回 undefined） */
  getRoomTaskById(taskId: string): CollaborationRoomTask | undefined {
    return getRoomTask(taskId);
  }

  /**
   * 更新轻量 room task（仅未挂载看板时）。
   *
   * - 任务须存在且属于 input.roomId（拒绝跨房间）。
   * - 房间已挂载看板 → 拒绝（不变量 §15.7）。
   * - status 变化须通过严格状态机（transitionCollaborationRoomTaskStatus）；不变则跳过。
   * - 新负责人（若指定）须为本房间成员；传空字符串解除指派。
   * - expectedVersion（若提供）须与当前 version 一致；写时 CAS 防覆盖。
   * - version 自增；updatedAt 刷新。
   */
  updateRoomTask(
    input: UpdateCollaborationRoomTaskInput,
  ): CollaborationRoomTask {
    const current = getRoomTask(input.taskId);
    if (!current) {
      throw new Error("任务不存在");
    }
    if (current.roomId !== input.roomId) {
      throw new Error("任务不属于该房间");
    }
    const room = getRoom(input.roomId);
    if (!room) {
      throw new Error("房间不存在");
    }
    if (this.roomHasAttachedBoard(room)) {
      throw new Error(
        "房间已挂载看板，任务真值由看板维护，不能在房间内修改任务",
      );
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== current.version
    ) {
      throw new Error("任务版本已过期，请刷新后重试");
    }

    // 状态迁移校验（严格状态机）
    const nextStatus =
      input.status !== undefined && input.status !== current.status
        ? this.validateTaskTransition(current.status, input.status)
        : current.status;

    // 标题（若改）
    const nextTitle =
      input.title !== undefined
        ? this.validateTaskTitle(input.title)
        : current.title;

    // 负责人（若改；空字符串解除指派）
    let nextAssignee = current.assigneeMemberId;
    if (input.assigneeMemberId !== undefined) {
      nextAssignee = this.validateAssignee(input.assigneeMemberId, room.id);
    }

    const now = Date.now();
    const next: CollaborationRoomTask = {
      ...current,
      title: nextTitle,
      description:
        input.description !== undefined
          ? input.description.trim() || undefined
          : current.description,
      status: nextStatus,
      assigneeMemberId: nextAssignee,
      acceptanceCriteria:
        input.acceptanceCriteria !== undefined
          ? input.acceptanceCriteria.trim() || undefined
          : current.acceptanceCriteria,
      runId:
        input.runId !== undefined ? input.runId || undefined : current.runId,
      version: current.version + 1,
      updatedAt: now,
    };

    if (!saveRoomTaskIfCurrent(input.taskId, current.version, next)) {
      throw new Error("任务已被其他操作更新，请刷新后重试");
    }
    this.broadcast(room.id, "updated");
    if (next.status === "done") {
      this.releaseReadyDependentTasks(room, next.id);
    }
    if (
      next.status === "in_progress" &&
      (current.status === "failed" ||
        current.status === "blocked" ||
        current.status === "done")
    ) {
      return this.retryTaskRun(room, next, current.status);
    }
    return next;
  }

  /**
   * 从任务面板显式恢复 failed/blocked/done 任务时启动新的成员 run。
   * todo → in_progress 不在这里触发：新任务创建和依赖释放已经负责首次启动，
   * 避免用户仅调整状态时重复开跑。
   */
  private retryTaskRun(
    room: CollaborationRoom,
    task: CollaborationRoomTask,
    previousStatus: CollaborationRoomTaskStatus,
  ): CollaborationRoomTask {
    if (room.status !== "active" || this.roomHasAttachedBoard(room)) {
      return task;
    }
    const trigger = this.appendTaskRetryMessage(room, task, previousStatus);
    const createdRuns = this.triggerRunForMessage(room, trigger);
    this.kickSummary(room);
    return createdRuns[0] ? this.linkTaskToRun(task, createdRuns[0]) : task;
  }

  /**
   * room_task_assign：协调者把未指派任务交给本房间成员，并自动触发目标成员 run。
   *
   * 这是“无 @ 建任务 → 协调者读到 → 协调者派发”的闭环。安全边界：房间必须 active、
   * run 必须属于协调者且处于 running/awaiting_peer、任务和目标成员必须同房间、
   * 任务不能已挂板或已有负责人；任务版本用 CAS 自增，分派事件带 run/task 因果链。
   */
  roomTaskAssign(input: {
    roomId: string;
    fromRunId: string;
    taskId: string;
    assigneeMemberId: string;
  }):
    | {
        ok: true;
        taskId: string;
        assigneeMemberId: string;
        version: number;
        runId?: string;
      }
    | { ok: false; reason: string } {
    const room = getRoom(input.roomId);
    if (!room) return { ok: false, reason: "房间不存在" };
    if (room.status !== "active")
      return { ok: false, reason: `房间状态非 active：${room.status}` };

    const run = getRun(input.fromRunId);
    if (!run) return { ok: false, reason: "run 不存在" };
    if (run.status !== "running" && run.status !== "awaiting_peer") {
      return {
        ok: false,
        reason: `run 非 running/awaiting_peer：${run.status}`,
      };
    }
    if (run.roomId !== room.id)
      return { ok: false, reason: "run 不属于该房间" };

    const fromMember = getMember(run.memberId);
    if (!fromMember || fromMember.roomId !== room.id) {
      return { ok: false, reason: "发起成员不存在或不属于本房间" };
    }
    if (room.coordinatorMemberId !== fromMember.id) {
      return { ok: false, reason: "只有协调者可以分派任务" };
    }

    const task = getRoomTask(input.taskId);
    if (!task) return { ok: false, reason: "任务不存在" };
    if (task.roomId !== room.id)
      return { ok: false, reason: "任务不属于该房间" };
    if (this.roomHasAttachedBoard(room)) {
      return {
        ok: false,
        reason: "房间已挂载看板，任务真值由看板维护，不能在房间内分派任务",
      };
    }
    if (task.assigneeMemberId) {
      return {
        ok: false,
        reason: "任务已有负责人，不能通过工具覆盖（请由用户/面板重新指派）",
      };
    }

    const assigneeMemberId = input.assigneeMemberId.trim();
    const assignee = getMember(assigneeMemberId);
    if (!assignee || assignee.roomId !== room.id) {
      return { ok: false, reason: "负责人不属于该房间" };
    }

    const next: CollaborationRoomTask = {
      ...task,
      assigneeMemberId: assignee.id,
      status: this.hasPendingTaskDependencies(task.dependsOnTaskIds)
        ? "blocked"
        : task.status,
      version: task.version + 1,
      updatedAt: Date.now(),
    };
    if (!saveRoomTaskIfCurrent(task.id, task.version, next)) {
      return { ok: false, reason: "任务已被其他操作更新，请刷新后重试" };
    }

    const assignment = this.appendTaskAssignmentMessage(
      room,
      fromMember,
      next,
      run,
    );
    const dispatched =
      next.status === "blocked"
        ? []
        : this.triggerRunForMessage(room, assignment);
    const linked = dispatched[0] ? this.linkTaskToRun(next, dispatched[0]) : next;
    this.broadcast(room.id, "updated");
    return {
      ok: true,
      taskId: linked.id,
      assigneeMemberId: assignee.id,
      version: linked.version,
      runId: dispatched[0]?.id,
    };
  }

  /**
   * room_task_update：成员运行时受控更新「分配给自己」的房间任务状态（S5 第二刀模型工具）。
   *
   * 这是模型在房间里能触发的受限副作用之一（02-RUNTIME-A2A-SPEC §2.6 / 03-IMPLEMENTATION-PHASES §7）。
   * 宿主严格校验、绝不就地伪造；安全字段（roomId/memberId）取自 run 上下文，不接受外部传入——
   * 模型无法伪造房间或发起人。
   *
   * 守卫（全部 fail-closed，返回 { ok: false, reason } 由宿主回注安全文本）：
   * - 房间须存在且 active；run 须 running/awaiting_peer；发起成员须存在且属于本房间。
   * - 任务须存在且属于本房间（拒绝跨房间：模型即便知道别房间 taskId 也碰不到）。
   * - 房间未挂载看板（attachedBoardId 为空）；挂板后任务真值归看板，房间内不再改（不变量 §15.7）。
   * - task.assigneeMemberId 恰等于发起成员：未指派 / 指派给别人的任务一律拒绝——模型不能改
   *   别人的任务，也不能把未指派任务据为己有（指派是宿主/用户行为，非模型行为）。
   * - status 须为合法枚举且经严格状态机（transitionCollaborationRoomTaskStatus）；自环拒绝。
   * - summary（可选）仅作为可审计 task_event 消息记录在时间线，绝不写入 title/description/
   *   acceptanceCriteria/assigneeMemberId 等权威字段；超长拒绝。task_event 与成员正文同级
   *   （系统提示已声明其他成员正文非指令），不会被当作指令注入。
   * - 此工具只能改 status + 记录 summary 事件；不能创建任务、改负责人、改验收标准、改标题/描述。
   *
   * 成功后 version 自增（CAS 防并发覆盖）并广播；返回 ok+version 供宿主回注安全文本。
   */
  roomTaskUpdate(input: {
    roomId: string;
    fromRunId: string;
    taskId: string;
    status: string;
    summary?: string;
  }):
    | {
        ok: true;
        taskId: string;
        status: CollaborationRoomTaskStatus;
        version: number;
      }
    | { ok: false; reason: string } {
    const room = getRoom(input.roomId);
    if (!room) return { ok: false, reason: "房间不存在" };
    if (room.status !== "active")
      return { ok: false, reason: `房间状态非 active：${room.status}` };

    const run = getRun(input.fromRunId);
    if (!run) return { ok: false, reason: "run 不存在" };
    if (run.status !== "running" && run.status !== "awaiting_peer") {
      return {
        ok: false,
        reason: `run 非 running/awaiting_peer：${run.status}`,
      };
    }
    const fromMember = getMember(run.memberId);
    if (!fromMember || fromMember.roomId !== room.id) {
      return { ok: false, reason: "发起成员不存在或不属于本房间" };
    }

    const task = getRoomTask(input.taskId);
    if (!task) return { ok: false, reason: "任务不存在" };
    if (task.roomId !== room.id)
      return { ok: false, reason: "任务不属于该房间" };
    if (this.roomHasAttachedBoard(room)) {
      return {
        ok: false,
        reason: "房间已挂载看板，任务真值由看板维护，不能在房间内修改任务",
      };
    }
    // 恰等于发起成员：未指派 / 别人的任务一律拒绝（模型不能改别人的任务，也不能认领未指派任务）
    if (!task.assigneeMemberId) {
      return {
        ok: false,
        reason: "任务未指派给任何成员，无法通过工具更新（指派由宿主/用户完成）",
      };
    }
    if (task.assigneeMemberId !== fromMember.id) {
      return { ok: false, reason: "你不是该任务的负责人，无法更新" };
    }

    // summary 仅作可审计事件，不进权威字段；超长拒绝
    const summary =
      input.summary !== undefined ? input.summary.trim() : undefined;
    if (
      summary &&
      summary.length > COLLABORATION_ROOM_TASK_SUMMARY_MAX_LENGTH
    ) {
      return {
        ok: false,
        reason: `说明过长（超过 ${COLLABORATION_ROOM_TASK_SUMMARY_MAX_LENGTH} 字），请精简`,
      };
    }

    // status 合法性 + 严格状态机（自环拒绝）
    if (!isCollaborationRoomTaskStatus(input.status)) {
      return { ok: false, reason: `非法任务状态：${String(input.status)}` };
    }
    // 捕获到 const 局部：避免 input.status（属性访问）的窄化在下方函数调用后被 TS 视作失效
    const targetStatus: CollaborationRoomTaskStatus = input.status;
    const transition = transitionCollaborationRoomTaskStatus(
      task.status,
      targetStatus,
    );
    if (!transition.ok) {
      return { ok: false, reason: transition.reason };
    }

    const now = Date.now();
    const next: CollaborationRoomTask = {
      ...task,
      status: targetStatus,
      version: task.version + 1,
      updatedAt: now,
    };
    if (!saveRoomTaskIfCurrent(task.id, task.version, next)) {
      return { ok: false, reason: "任务已被其他操作更新，请刷新后重试" };
    }

    // 记录可审计 task_event（summary 仅作时间线事件，非指令，不写入任务权威字段）
    this.appendTaskEventMessage(
      room,
      fromMember,
      task,
      targetStatus,
      summary,
      run,
    );

    this.broadcast(room.id, "updated");
    if (targetStatus === "done") {
      this.releaseReadyDependentTasks(room, task.id);
    }
    return {
      ok: true,
      taskId: task.id,
      status: targetStatus,
      version: next.version,
    };
  }

  // ===== Room Artifact（S5：room_publish_artifact 受控产物发布） =====
  //
  // 02-RUNTIME-A2A-SPEC §2.6 / §5 / §11：成员只能把「文本内容」写入「协作室绑定工作区的相对路径」，
  // 宿主校验路径、权限、按实际字节求 sha256 后落盘审计。绝不信任模型提供的绝对路径 / .. / 符号链接，
  // 也绝不暴露 filesystem/shell/database（不复用 Pi 会话的 Read/Bash/Edit/Write）。安全字段
  //（roomId/memberId/runId）取自 run 上下文；taskId 须经验证属于同一房间。

  /** 列出某房间全部产物（按 createdAt 升序，次按 id 稳定） */
  listArtifacts(roomId: string): CollaborationArtifact[] {
    return listArtifactsByRoom(roomId);
  }

  /** 取单个产物（不存在返回 undefined） */
  getArtifactById(artifactId: string): CollaborationArtifact | undefined {
    return getArtifact(artifactId);
  }

  /**
   * 预览产物文本（S5 面板）：宿主按 artifactId 反查记录后复用同一条安全路径解析再读盘。
   *
   * 渲染层只传 { roomId, artifactId }，绝不传路径——文件访问面与 room_publish_artifact
   * 完全一致：仍走 resolveArtifactTargetPath（拒绝绝对 / `..` / 反斜杠 / 符号链接逃逸），
   * 且须落在房间绑定工作区的真实根内。不扩权、不暴露任意文件读。
   *
   * 守卫（全部 fail-closed，返回 { ok: false, reason }）：
   * - 产物须存在且属于 input.roomId（拒绝跨房间预览：模型/渲染层即便知道别房间 artifactId 也碰不到）。
   * - 房间须存在且已绑定工作区，工作区项目目录存在、可解析为真实路径。
   * - 按 artifact.relativePath 复用 resolveArtifactTargetPath 解析；越界 / 符号链接一律拒绝。
   * - 目标须存在且为普通文件：目录 / 符号链接 / 不存在一律拒绝（防逃逸与误读）。
   * - 按 COLLABORATION_ARTIFACT_MAX_CONTENT_BYTES 上限有界读取（仅读首 cap 字节，避免大文件爆内存），
   *   超限置 truncated=true；sha256 取自产物审计记录，仅作展示，不据其阻断预览（盘上文件可能已被合法改动）。
   *
   * 不迁移 run 状态、不写盘、不广播；纯只读预览。
   */
  readArtifact(input: {
    roomId: string;
    artifactId: string;
  }): ReadCollaborationArtifactResult {
    const artifact = getArtifact(input.artifactId);
    if (!artifact) return { ok: false, reason: "产物不存在" };
    if (artifact.roomId !== input.roomId) {
      return { ok: false, reason: "产物不属于该房间" };
    }
    const room = getRoom(input.roomId);
    if (!room) return { ok: false, reason: "房间不存在" };
    const rootReal = resolveRoomWorkspaceRoot(room);
    if (!rootReal) {
      return { ok: false, reason: "房间服务工作区不存在或不可访问" };
    }

    // 复用同一条安全路径解析（与发布时一致）；越界 / 符号链接 / 绝对路径一律拒绝
    const target = resolveArtifactTargetPath(rootReal, artifact.relativePath);
    if (!target.ok) return { ok: false, reason: target.reason };

    if (!existsSync(target.absPath)) {
      return { ok: false, reason: "产物文件不存在（可能已被移动或删除）" };
    }
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(target.absPath);
    } catch {
      return { ok: false, reason: "产物文件不可访问" };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, reason: "产物路径是符号链接，禁止预览（防逃逸）" };
    }
    if (st.isDirectory())
      return { ok: false, reason: "产物路径是目录，无法预览" };

    // 有界读取：仅读首 cap 字节，避免大文件爆内存；超限标记 truncated
    const cap = COLLABORATION_ARTIFACT_MAX_CONTENT_BYTES;
    const size = st.size;
    const truncated = size > cap;
    const toRead = Math.min(size, cap);
    let fd: number | undefined;
    try {
      fd = openSync(target.absPath, "r");
      const buf = Buffer.alloc(toRead);
      const bytesRead = readSync(fd, buf, 0, toRead, 0);
      const content = buf.subarray(0, bytesRead).toString("utf8");
      return {
        ok: true,
        artifactId: artifact.id,
        relativePath: artifact.relativePath,
        content,
        byteSize: size,
        sha256: artifact.sha256,
        truncated,
      };
    } catch {
      return { ok: false, reason: "读取产物文件失败" };
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * room_publish_artifact：成员把文本内容写入协作室绑定工作区的相对路径，宿主校验后落盘审计。
   *
   * 守卫（全部 fail-closed，返回 { ok: false, reason } 由宿主回注安全文本）：
   * - 房间须存在且 active；run 须 running/awaiting_peer；发起成员须存在且属于本房间。
   * - 发起成员权限须为 workspace-write（read-only 成员不能发布产物；权限档位 enforce 第一刀）。
   * - 房间须已绑定工作区且工作区项目目录存在、可解析。
   * - summary（可选）超长拒绝；仅作审计，绝不作为指令。
   * - taskId（可选）须存在且属于同一房间（拒绝跨房间关联）。
   * - content 须为非空文本，UTF-8 字节数不超过 COLLABORATION_ARTIFACT_MAX_CONTENT_BYTES。
   * - relativePath 须为相对路径：拒绝绝对路径 / 反斜杠 / `..` 越界 / 符号链接逃逸（见
   *   resolveArtifactTargetPath）；越出工作区根一律拒绝。
   * - 目标已存在且是目录 → 拒绝（不能把目录覆盖成文件）；叶子已存在且是符号链接已被路径校验拒绝。
   *
   * 写入后按实际写入字节求 sha256（hex）与 byteSize，落 artifacts.json 审计记录，并追加一条
   * kind='artifact' 的可追溯房间消息（authorId=成员、runId、taskId、rootMessageId、causationId）。
   * 不迁移 run 状态（发布产物不暂停当前 turn）。
   */
  /**
   * 用户明确选择个人目录后，把其内容导入房间服务工作区。
   * 只允许活跃房间成员发起；跳过 .git/node_modules 和符号链接，避免把个人目录
   * 自动变成共享真值，也避免把宿主工作区外的链接带入房间。
   */
  importWorkspaceDirectory(input: {
    roomId: string;
    sourceDirectory: string;
    actorUserId?: string;
  }):
    | { ok: true; files: number; skipped: number; bytes: number }
    | { ok: false; reason: string } {
    const room = getRoom(input.roomId);
    if (!room) return { ok: false, reason: "房间不存在" };
    if (room.status !== "active")
      return { ok: false, reason: "只有 active 房间可以导入工作区" };
    const actor = resolveHumanActorUserId(input.actorUserId);
    const activeHuman = this.listHumanMembers(room.id).some(
      (member) => member.userId === actor && member.status === "active",
    );
    if (!activeHuman)
      return { ok: false, reason: "当前用户不是该房间的活跃成员" };
    if (room.sourceSessionId && room.workspaceId) {
      return {
        ok: false,
        reason: "来源会话房间已直接连接项目工作区，无需再次导入",
      };
    }
    if (!room.roomWorkspace) {
      return {
        ok: false,
        reason: "旧房间没有服务工作区，请先创建新的融合房间",
      };
    }
    const sourceReal = realpathSafe(resolve(input.sourceDirectory));
    const rootReal = resolveRoomWorkspaceRoot(room);
    if (!sourceReal || !rootReal)
      return { ok: false, reason: "源目录或房间工作区不可访问" };
    const relToRoot = relative(rootReal, sourceReal);
    if (
      relToRoot === "" ||
      (relToRoot !== ".." && !relToRoot.startsWith(".." + sep))
    ) {
      return { ok: false, reason: "不能把房间工作区自身或其子目录导入自身" };
    }
    if (!lstatSync(sourceReal).isDirectory()) {
      return { ok: false, reason: "源路径不是目录" };
    }

    const maxFiles = 10000;
    const maxBytes = 256 * 1024 * 1024;
    let files = 0;
    let skipped = 0;
    let bytes = 0;
    const walk = (sourceDir: string, relativeDir: string): void => {
      for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
        if (
          entry.name === ".git" ||
          entry.name === "node_modules" ||
          entry.name === ".tagent"
        ) {
          skipped += 1;
          continue;
        }
        const nextRelative = relativeDir
          ? join(relativeDir, entry.name)
          : entry.name;
        const sourcePath = join(sourceDir, entry.name);
        const targetPath = join(rootReal, nextRelative);
        const stat = lstatSync(sourcePath);
        if (stat.isSymbolicLink()) {
          skipped += 1;
          continue;
        }
        if (stat.isDirectory()) {
          if (!existsSync(targetPath))
            mkdirSync(targetPath, { recursive: true });
          walk(sourcePath, nextRelative);
          continue;
        }
        if (!stat.isFile()) {
          skipped += 1;
          continue;
        }
        if (files >= maxFiles || bytes + stat.size > maxBytes) {
          skipped += 1;
          continue;
        }
        if (existsSync(targetPath)) {
          skipped += 1;
          continue;
        }
        const parent = dirname(targetPath);
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        copyFileSync(sourcePath, targetPath);
        files += 1;
        bytes += stat.size;
      }
    };
    try {
      walk(sourceReal, "");
    } catch {
      return { ok: false, reason: "读取或复制个人工作区失败" };
    }
    this.appendSystemMessage(
      room.id,
      "用户「" +
        actor +
        "」导入了 " +
        files +
        " 个工作区文件（跳过 " +
        skipped +
        " 个）。",
    );
    this.broadcast(room.id, "updated");
    return { ok: true, files, skipped, bytes };
  }
  /**
   * 为用户下载产物解析一个经过房间/成员/路径校验的文件句柄目标。
   * 绝不接受渲染层传入的绝对路径；最终保存位置由 IPC 主进程的保存对话框决定。
   */
  getArtifactDownloadPath(input: {
    roomId: string;
    artifactId: string;
    actorUserId?: string;
  }):
    | { ok: true; absPath: string; relativePath: string }
    | { ok: false; reason: string } {
    const artifact = getArtifact(input.artifactId);
    if (!artifact) return { ok: false, reason: "产物不存在" };
    if (artifact.roomId !== input.roomId) {
      return { ok: false, reason: "产物不属于该房间" };
    }
    const room = getRoom(input.roomId);
    if (!room) return { ok: false, reason: "房间不存在" };
    const actor = resolveHumanActorUserId(input.actorUserId);
    const activeHuman = this.listHumanMembers(room.id).some(
      (member) => member.userId === actor && member.status === "active",
    );
    if (!activeHuman)
      return { ok: false, reason: "当前用户不是该房间的活跃成员" };
    const rootReal = resolveRoomWorkspaceRoot(room);
    if (!rootReal)
      return { ok: false, reason: "房间服务工作区不存在或不可访问" };
    const target = resolveArtifactTargetPath(rootReal, artifact.relativePath);
    if (!target.ok) return { ok: false, reason: target.reason };
    if (!existsSync(target.absPath))
      return { ok: false, reason: "产物文件不存在" };
    const stat = lstatSync(target.absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, reason: "产物不是可下载的普通文件" };
    }
    return {
      ok: true,
      absPath: target.absPath,
      relativePath: artifact.relativePath,
    };
  }
  roomPublishArtifact(input: {
    roomId: string;
    fromRunId: string;
    relativePath: string;
    content: string;
    summary?: string;
    taskId?: string;
  }):
    | {
        ok: true;
        artifactId: string;
        sha256: string;
        byteSize: number;
        relativePath: string;
      }
    | { ok: false; reason: string } {
    const room = getRoom(input.roomId);
    if (!room) return { ok: false, reason: "房间不存在" };
    if (room.status !== "active")
      return { ok: false, reason: `房间状态非 active：${room.status}` };

    const run = getRun(input.fromRunId);
    if (!run) return { ok: false, reason: "run 不存在" };
    if (run.status !== "running" && run.status !== "awaiting_peer") {
      return {
        ok: false,
        reason: `run 非 running/awaiting_peer：${run.status}`,
      };
    }
    const fromMember = getMember(run.memberId);
    if (!fromMember || fromMember.roomId !== room.id) {
      return { ok: false, reason: "发起成员不存在或不属于本房间" };
    }

    // 权限档位 enforce：只有 workspace-write 成员可发布产物
    if (fromMember.permissionProfile !== "workspace-write") {
      return { ok: false, reason: "成员权限非 workspace-write，不能发布产物" };
    }

    // 新房间使用服务工作区；旧房间兼容个人项目工作区。
    const rootReal = resolveRoomWorkspaceRoot(room);
    if (!rootReal) {
      return { ok: false, reason: "房间服务工作区不存在或不可访问" };
    }

    // summary 长度（先于路径/写入，便宜 fail-closed）
    const summary =
      input.summary !== undefined ? input.summary.trim() : undefined;
    if (summary && summary.length > COLLABORATION_ARTIFACT_SUMMARY_MAX_LENGTH) {
      return {
        ok: false,
        reason: `说明过长（超过 ${COLLABORATION_ARTIFACT_SUMMARY_MAX_LENGTH} 字），请精简`,
      };
    }

    // taskId 归属：非空时须存在且属于同一房间（拒绝跨房间关联）
    let taskId: string | undefined;
    if (input.taskId !== undefined && input.taskId.trim() !== "") {
      const task = getRoomTask(input.taskId.trim());
      if (!task) return { ok: false, reason: "关联任务不存在" };
      if (task.roomId !== room.id)
        return { ok: false, reason: "关联任务不属于该房间" };
      taskId = task.id;
    }

    // content 尺寸：非空文本，UTF-8 字节上限
    const contentBuf = Buffer.from(input.content ?? "", "utf8");
    if (contentBuf.byteLength === 0) {
      return { ok: false, reason: "产物内容不能为空" };
    }
    if (contentBuf.byteLength > COLLABORATION_ARTIFACT_MAX_CONTENT_BYTES) {
      return {
        ok: false,
        reason: `产物内容过大（超过 ${COLLABORATION_ARTIFACT_MAX_CONTENT_BYTES} 字节）`,
      };
    }

    // 路径校验：绝对 / 反斜杠 / `..` / 符号链接逃逸 / 越出根
    const target = resolveArtifactTargetPath(rootReal, input.relativePath);
    if (!target.ok) return { ok: false, reason: target.reason };
    const absPath = target.absPath;

    // 目标已存在且是目录 → 拒绝（叶子是符号链接已被路径校验拦截）
    if (existsSync(absPath) && lstatSync(absPath).isDirectory()) {
      return { ok: false, reason: "目标路径已存在且是目录，不能覆盖为文件" };
    }

    const claimed = this.acquireWorkspaceLease(
      input.roomId,
      [target.relativePath],
      input.fromRunId,
    );
    if (!claimed.ok) return claimed;

    try {
      // 写入：确保父目录存在（已在根内），按实际写入字节求 sha256
      const parentDir = dirname(absPath);
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      writeWorkspaceFileAtomically(absPath, contentBuf);
      const sha256 = createHash("sha256").update(contentBuf).digest("hex");
      const byteSize = contentBuf.byteLength;

      const now = Date.now();
      const artifact: CollaborationArtifact = {
        id: genId(COLLABORATION_ARTIFACT_ID_PREFIX),
        roomId: room.id,
        memberId: fromMember.id,
        runId: run.id,
        taskId,
        relativePath: target.relativePath,
        sha256,
        byteSize,
        summary,
        createdAt: now,
      };
      appendArtifact(artifact);
      this.appendArtifactMessage(room, fromMember, artifact, run);
      this.broadcast(room.id, "updated");
      return {
        ok: true,
        artifactId: artifact.id,
        sha256,
        byteSize,
        relativePath: artifact.relativePath,
      };
    } finally {
      claimed.lease.release();
    }
  }

  /** 严格状态迁移：非法则抛错，返回目标状态 */
  private validateTaskTransition(
    from: CollaborationRoomTaskStatus,
    to: CollaborationRoomTaskStatus,
  ): CollaborationRoomTaskStatus {
    if (!isCollaborationRoomTaskStatus(to)) {
      throw new Error(`非法任务状态：${String(to)}`);
    }
    const res = transitionCollaborationRoomTaskStatus(from, to);
    if (!res.ok) {
      throw new Error(res.reason);
    }
    return to;
  }

  private validateTaskTitle(title: string): string {
    const t = title.trim();
    if (!t) {
      throw new Error("任务标题不能为空");
    }
    return t;
  }

  /**
   * 校验负责人归属：空字符串 → undefined（解除指派）；非空须为本房间成员。
   * create/update 共用，拒绝跨房间成员。
   */
  private validateAssignee(
    assigneeMemberId: string | undefined,
    roomId: string,
  ): string | undefined {
    if (assigneeMemberId === undefined) return undefined;
    const id = assigneeMemberId.trim();
    if (!id) return undefined;
    const assignee = getMember(id);
    if (!assignee || assignee.roomId !== roomId) {
      throw new Error("负责人不属于该房间");
    }
    return id;
  }

  /** 房间是否已挂载看板（true 时 room task 不再是任务真值） */
  private roomHasAttachedBoard(room: CollaborationRoom): boolean {
    return Boolean(room.attachedBoardId);
  }

  // ===== Workspace 工具桥（受控文件/搜索/命令；只读成员可 read/search，write/run 需 workspace-write） =====
  //
  // 安全契约（与 room_publish_artifact 同源，复用 resolveArtifactTargetPath）：
  // - 房间未绑定工作区 → 所有 workspace 工具一律拒绝（fail closed）。
  // - 所有相对路径经 resolveArtifactTargetPath 解析：拒绝绝对 / 反斜杠 / `..` 越界 /
  //   符号链接逃逸，且必须落在绑定工作区真实根内。
  // - read/search 不要求写权限（read-only 成员可用）；write_file / run_command 仅
  //   workspace-write 成员可用（权限档位 enforce，与 room_publish_artifact 一致）。
  // - 安全字段（roomId/memberId/permissionProfile/workspaceId）全部取自 run 上下文，模型不可伪造。
  //
  // 渲染层不暴露任意写 IPC：这里只在模型经 hostToolHandler 发起调用时触达文件系统，
  // 绝不把通用 Read/Write/Bash 工具暴露给模型（不复用 Pi 会话工具）。

  /**
   * workspace 工具通用守卫（fail-closed）。返回工作区真实根 + room/member，供具体工具复用。
   *
   * needsWrite=true 时额外 enforce workspace-write 权限档位。
   */
  private workspaceGuard(input: {
    roomId: string;
    fromRunId: string;
    needsWrite: boolean;
  }):
    | {
        ok: true;
        room: CollaborationRoom;
        member: CollaborationMember;
        rootReal: string;
      }
    | { ok: false; reason: string } {
    const room = getRoom(input.roomId);
    if (!room) return { ok: false, reason: "房间不存在" };
    if (room.status !== "active")
      return { ok: false, reason: `房间状态非 active：${room.status}` };

    const run = getRun(input.fromRunId);
    if (!run) return { ok: false, reason: "run 不存在" };
    if (run.status !== "running" && run.status !== "awaiting_peer") {
      return {
        ok: false,
        reason: `run 非 running/awaiting_peer：${run.status}`,
      };
    }
    const member = getMember(run.memberId);
    if (!member || member.roomId !== room.id) {
      return { ok: false, reason: "发起成员不存在或不属于本房间" };
    }

    if (input.needsWrite && member.permissionProfile !== "workspace-write") {
      return {
        ok: false,
        reason: "成员权限非 workspace-write，不能写文件或执行命令",
      };
    }

    const rootReal = resolveRoomWorkspaceRoot(room);
    if (!rootReal) {
      return { ok: false, reason: "房间服务工作区不存在或不可访问" };
    }
    return { ok: true, room, member, rootReal };
  }

  /** 对工作区写入建立持久化租约；无法取得租约时 fail-closed，避免并发覆盖。 */
  private acquireWorkspaceLease(
    roomId: string,
    scopes: string[],
    owner: string,
  ):
    | {
        ok: true;
        lease: NonNullable<
          ReturnType<FileFusionRoomWorkspaceLeaseStore["acquire"]>
        >;
      }
    | { ok: false; reason: string } {
    const lease = this.workspaceLeases.acquire(roomId, scopes, owner);
    return lease
      ? { ok: true, lease }
      : { ok: false, reason: "工作区正在被其他成员修改，请稍后重试" };
  }

  /**
   * workspace_read_file：从绑定工作区读一个文本文件（只读，任意成员可用）。
   *
   * 有界读取：默认上限 COLLABORATION_WORKSPACE_READ_MAX_BYTES，超过时返回截断内容并标记
   * truncated。仅普通文件可读：目录 / 符号链接 / 不存在一律拒绝。
   */
  workspaceReadFile(input: {
    roomId: string;
    fromRunId: string;
    path: string;
    maxBytes?: number;
  }):
    | {
        ok: true;
        path: string;
        content: string;
        byteSize: number;
        truncated: boolean;
      }
    | { ok: false; reason: string } {
    const g = this.workspaceGuard({
      roomId: input.roomId,
      fromRunId: input.fromRunId,
      needsWrite: false,
    });
    if (!g.ok) return g;

    const target = resolveArtifactTargetPath(g.rootReal, input.path);
    if (!target.ok) return { ok: false, reason: target.reason };

    if (!existsSync(target.absPath)) return { ok: false, reason: "文件不存在" };
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(target.absPath);
    } catch {
      return { ok: false, reason: "文件不可访问" };
    }
    if (st.isSymbolicLink())
      return { ok: false, reason: "文件路径是符号链接，禁止读取（防逃逸）" };
    if (st.isDirectory())
      return { ok: false, reason: "目标路径是目录，无法读取文件内容" };

    const requestedBytes =
      input.maxBytes ?? COLLABORATION_WORKSPACE_READ_MAX_BYTES;
    if (!Number.isFinite(requestedBytes) || requestedBytes <= 0) {
      return { ok: false, reason: "maxBytes 必须是正数" };
    }
    const cap = Math.min(
      Math.floor(requestedBytes),
      COLLABORATION_WORKSPACE_READ_MAX_BYTES,
    );
    const size = st.size;
    const truncated = size > cap;
    const toRead = Math.min(size, cap);
    let fd: number | undefined;
    try {
      fd = openSync(target.absPath, "r");
      const buf = Buffer.alloc(toRead);
      const bytesRead = readSync(fd, buf, 0, toRead, 0);
      const content = buf.subarray(0, bytesRead).toString("utf8");
      return {
        ok: true,
        path: target.relativePath,
        content,
        byteSize: size,
        truncated,
      };
    } catch {
      return { ok: false, reason: "读取文件失败" };
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * workspace_search：在绑定工作区根内递归列出文件路径（只读成员可用）。
   *
   * basePath 指向目录则递归搜索；指向文件则返回该文件（若匹配 pattern）。pattern 为可选的
   * 大小写不敏感 glob（支持 `*` / `?`）；无 `*`/`?` 时按相对路径子串过滤；空 pattern 匹配全部。
   * 结果数不超 COLLABORATION_WORKSPACE_SEARCH_MAX_RESULTS，超限截断；深度不超
   * COLLABORATION_WORKSPACE_SEARCH_MAX_DEPTH。符号链接组件在路径解析阶段已被拒绝。
   */
  workspaceSearch(input: {
    roomId: string;
    fromRunId: string;
    path: string;
    pattern?: string;
    maxResults?: number;
  }):
    | {
        ok: true;
        basePath: string;
        pattern?: string;
        results: string[];
        count: number;
        truncated: boolean;
      }
    | { ok: false; reason: string } {
    const g = this.workspaceGuard({
      roomId: input.roomId,
      fromRunId: input.fromRunId,
      needsWrite: false,
    });
    if (!g.ok) return g;

    // 根搜索：path 为空、`.` 或 `./` 时都表示工作区根。
    // 模型探索项目时经常从 shell 习惯传 `.`；不能把它当成待解析的文件路径，
    // 否则 resolveArtifactTargetPath 会因规范化后没有 segment 而拒绝，导致模型反复试探。
    const trimmed = (input.path ?? "").trim();
    let baseReal = g.rootReal;
    let baseRel = "";
    const isRootPath =
      trimmed === "" ||
      (!trimmed.startsWith("/") &&
        trimmed
          .split("/")
          .every((segment) => segment === "" || segment === "."));
    if (!isRootPath) {
      const target = resolveArtifactTargetPath(g.rootReal, trimmed);
      if (!target.ok) return { ok: false, reason: target.reason };
      baseRel = target.relativePath;
      if (!existsSync(target.absPath))
        return { ok: false, reason: "搜索路径不存在" };
      try {
        if (lstatSync(target.absPath).isSymbolicLink()) {
          return { ok: false, reason: "搜索路径是符号链接，禁止（防逃逸）" };
        }
      } catch {
        return { ok: false, reason: "搜索路径不可访问" };
      }
      baseReal = target.absPath;
    }

    const pattern =
      input.pattern !== undefined && input.pattern.trim() !== ""
        ? input.pattern.trim()
        : undefined;
    const requestedResults =
      input.maxResults ?? COLLABORATION_WORKSPACE_SEARCH_MAX_RESULTS;
    if (!Number.isFinite(requestedResults) || requestedResults <= 0) {
      return { ok: false, reason: "maxResults 必须是正整数" };
    }
    const maxResults = Math.min(
      Math.floor(requestedResults),
      COLLABORATION_WORKSPACE_SEARCH_MAX_RESULTS,
    );

    const out: string[] = [];
    let truncated = false;
    const baseDepth = baseRel === "" ? 0 : baseRel.split("/").length;

    const walk = (dirReal: string, dirRel: string, depth: number): void => {
      if (truncated) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dirReal, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (truncated) break;
        const childReal = join(dirReal, entry.name);
        const childRel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
        if (entry.isSymbolicLink()) continue; // 拒搜符号链接，防逃逸
        if (entry.isDirectory()) {
          if (depth < COLLABORATION_WORKSPACE_SEARCH_MAX_DEPTH)
            walk(childReal, childRel, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (pattern && !simpleGlobMatch(pattern, entry.name)) continue;
        out.push(childRel);
        if (out.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    };

    // base 本身若是文件（非目录），直接尝试作为单条结果
    let isDir = true;
    try {
      isDir = lstatSync(baseReal).isDirectory();
    } catch {
      /* ignore */
    }
    if (isDir) {
      walk(baseReal, baseRel, 0);
    } else if (
      (!pattern || simpleGlobMatch(pattern, basename(baseReal))) &&
      !truncated
    ) {
      out.push(baseRel);
    }

    return {
      ok: true,
      basePath: baseRel === "" ? "." : baseRel,
      pattern,
      results: out,
      count: out.length,
      truncated,
    };
  }

  /**
   * workspace_write_file：向绑定工作区写一个文本文件（仅 workspace-write 成员）。
   *
   * 复用 resolveArtifactTargetPath 拒绝越界 / 符号链接；内容非空、UTF-8 字节上限内。
   * 返回规范相对路径、实际字节数与 sha256（供宿主回注）。不写审计产物记录（非 room artifact）。
   */
  workspaceWriteFile(input: {
    roomId: string;
    fromRunId: string;
    path: string;
    content: string;
  }):
    | { ok: true; path: string; byteSize: number; sha256: string }
    | { ok: false; reason: string } {
    const g = this.workspaceGuard({
      roomId: input.roomId,
      fromRunId: input.fromRunId,
      needsWrite: true,
    });
    if (!g.ok) return g;

    const target = resolveArtifactTargetPath(g.rootReal, input.path);
    if (!target.ok) return { ok: false, reason: target.reason };

    const contentBuf = Buffer.from(input.content ?? "", "utf8");
    if (contentBuf.byteLength === 0)
      return { ok: false, reason: "写入内容不能为空" };
    if (contentBuf.byteLength > COLLABORATION_WORKSPACE_WRITE_MAX_BYTES) {
      return {
        ok: false,
        reason: `写入内容过大（超过 ${COLLABORATION_WORKSPACE_WRITE_MAX_BYTES} 字节）`,
      };
    }

    if (existsSync(target.absPath) && lstatSync(target.absPath).isDirectory()) {
      return { ok: false, reason: "目标路径已存在且是目录，不能覆盖为文件" };
    }

    const claimed = this.acquireWorkspaceLease(
      input.roomId,
      [target.relativePath],
      input.fromRunId,
    );
    if (!claimed.ok) return claimed;
    try {
      const parentDir = dirname(target.absPath);
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      writeWorkspaceFileAtomically(target.absPath, contentBuf);
      const sha256 = createHash("sha256").update(contentBuf).digest("hex");
      return {
        ok: true,
        path: target.relativePath,
        byteSize: contentBuf.byteLength,
        sha256,
      };
    } finally {
      claimed.lease.release();
    }
  }

  /**
   * workspace_run_command：在绑定工作区根（或工作区内子目录）执行一条白名单命令
   * （仅 workspace-write 成员）。命令与参数经 workspace-command-runner 校验（allowlist +
   * spawn shell:false），cwd 经 resolveArtifactTargetPath 校验落在工作区内。超时、输出上限
   * 由执行器兜底。返回 stdout / stderr / exitCode / 是否超时或截断。
   */
  async workspaceRunCommand(input: {
    roomId: string;
    fromRunId: string;
    command: string;
    args?: string;
    cwd?: string;
    timeoutMs?: number | string;
  }): Promise<
    | {
        ok: true;
        command: string;
        stdout: string;
        stderr: string;
        exitCode: number | null;
        timedOut: boolean;
        truncated: boolean;
      }
    | { ok: false; reason: string }
  > {
    const g = this.workspaceGuard({
      roomId: input.roomId,
      fromRunId: input.fromRunId,
      needsWrite: true,
    });
    if (!g.ok) return g;

    let runCwd = g.rootReal;
    if (input.cwd && input.cwd.trim() !== "") {
      const c = resolveArtifactTargetPath(g.rootReal, input.cwd);
      if (!c.ok) return { ok: false, reason: c.reason };
      if (!existsSync(c.absPath) || !lstatSync(c.absPath).isDirectory()) {
        return { ok: false, reason: "cwd 目录不存在或不是目录" };
      }
      runCwd = c.absPath;
    }

    let timeoutMs: number | undefined;
    if (
      input.timeoutMs !== undefined &&
      String(input.timeoutMs).trim() !== ""
    ) {
      const n = Number(input.timeoutMs);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, reason: "timeoutMs 必须是正整数" };
      }
      timeoutMs = n;
    }

    const claimed = this.acquireWorkspaceLease(
      input.roomId,
      ["workspace"],
      input.fromRunId,
    );
    if (!claimed.ok) return claimed;

    try {
      const result: WorkspaceCommandRunResult = await runWorkspaceCommand(
        input.command,
        input.args,
        {
          cwd: runCwd,
          timeoutMs,
        },
      );
      if (!result.ok) return result;
      return {
        ok: true,
        command: input.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
      };
    } finally {
      claimed.lease.release();
    }
  }

  /** 对绑定工作区内的普通文本文件做唯一 oldText → newText 替换。 */
  workspaceApplyPatch(input: {
    roomId: string;
    fromRunId: string;
    path: string;
    oldText: string;
    newText: string;
  }):
    | { ok: true; path: string; byteSize: number; sha256: string }
    | { ok: false; reason: string } {
    const g = this.workspaceGuard({
      roomId: input.roomId,
      fromRunId: input.fromRunId,
      needsWrite: true,
    });
    if (!g.ok) return g;
    const target = resolveArtifactTargetPath(g.rootReal, input.path);
    if (!target.ok) return { ok: false, reason: target.reason };
    const claimed = this.acquireWorkspaceLease(
      input.roomId,
      [target.relativePath],
      input.fromRunId,
    );
    if (!claimed.ok) return claimed;
    try {
      if (!input.oldText) return { ok: false, reason: "oldText 不能为空" };
      const oldBytes = Buffer.byteLength(input.oldText, "utf8");
      const newBytes = Buffer.byteLength(input.newText ?? "", "utf8");
      if (
        oldBytes > COLLABORATION_WORKSPACE_PATCH_MAX_BYTES ||
        newBytes > COLLABORATION_WORKSPACE_PATCH_MAX_BYTES
      ) {
        return {
          ok: false,
          reason: `补丁文本超过 ${COLLABORATION_WORKSPACE_PATCH_MAX_BYTES} 字节上限`,
        };
      }
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(target.absPath);
      } catch {
        return { ok: false, reason: "文件不存在或不可访问" };
      }
      if (st.isSymbolicLink())
        return { ok: false, reason: "目标是符号链接，禁止修改" };
      if (!st.isFile()) return { ok: false, reason: "目标不是普通文件" };
      if (st.size > COLLABORATION_WORKSPACE_WRITE_MAX_BYTES)
        return { ok: false, reason: "文件超过可修改大小上限" };
      let content: string;
      try {
        content = readFileSync(target.absPath, "utf8");
      } catch {
        return { ok: false, reason: "读取文件失败" };
      }
      const patched = applyUniqueWorkspacePatch(
        content,
        input.oldText,
        input.newText ?? "",
        COLLABORATION_WORKSPACE_WRITE_MAX_BYTES,
      );
      if (!patched.ok) return patched;
      const next = patched.content;
      const nextBytes = Buffer.byteLength(next, "utf8");
      try {
        writeWorkspaceFileAtomically(target.absPath, Buffer.from(next, "utf8"));
      } catch {
        return { ok: false, reason: "写入补丁失败" };
      }
      return {
        ok: true,
        path: target.relativePath,
        byteSize: nextBytes,
        sha256: createHash("sha256").update(next, "utf8").digest("hex"),
      };
    } finally {
      claimed.lease.release();
    }
  }

  /** 删除绑定工作区内的普通文件；目录和符号链接一律拒绝。 */
  workspaceDeleteFile(input: {
    roomId: string;
    fromRunId: string;
    path: string;
  }): { ok: true; path: string } | { ok: false; reason: string } {
    const g = this.workspaceGuard({
      roomId: input.roomId,
      fromRunId: input.fromRunId,
      needsWrite: true,
    });
    if (!g.ok) return g;
    const target = resolveArtifactTargetPath(g.rootReal, input.path);
    if (!target.ok) return { ok: false, reason: target.reason };
    const claimed = this.acquireWorkspaceLease(
      input.roomId,
      [target.relativePath],
      input.fromRunId,
    );
    if (!claimed.ok) return claimed;
    try {
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(target.absPath);
      } catch {
        return { ok: false, reason: "文件不存在" };
      }
      if (st.isSymbolicLink())
        return { ok: false, reason: "目标是符号链接，禁止删除" };
      if (!st.isFile()) return { ok: false, reason: "只允许删除普通文件" };
      try {
        unlinkSync(target.absPath);
      } catch {
        return { ok: false, reason: "删除文件失败" };
      }
      return { ok: true, path: target.relativePath };
    } finally {
      claimed.lease.release();
    }
  }

  /** 移动/重命名绑定工作区内的普通文件；目标存在或父目录不存在均拒绝。 */
  workspaceMoveFile(input: {
    roomId: string;
    fromRunId: string;
    fromPath: string;
    toPath: string;
  }):
    | { ok: true; fromPath: string; toPath: string }
    | { ok: false; reason: string } {
    const g = this.workspaceGuard({
      roomId: input.roomId,
      fromRunId: input.fromRunId,
      needsWrite: true,
    });
    if (!g.ok) return g;
    const from = resolveArtifactTargetPath(g.rootReal, input.fromPath);
    if (!from.ok) return { ok: false, reason: from.reason };
    const to = resolveArtifactTargetPath(g.rootReal, input.toPath);
    if (!to.ok) return { ok: false, reason: to.reason };
    const claimed = this.acquireWorkspaceLease(
      input.roomId,
      [from.relativePath, to.relativePath],
      input.fromRunId,
    );
    if (!claimed.ok) return claimed;
    try {
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(from.absPath);
      } catch {
        return { ok: false, reason: "源文件不存在" };
      }
      if (st.isSymbolicLink() || !st.isFile())
        return { ok: false, reason: "源路径必须是普通文件" };
      if (existsSync(to.absPath))
        return { ok: false, reason: "目标路径已存在，拒绝覆盖" };
      const parent = dirname(to.absPath);
      try {
        if (!existsSync(parent) || !lstatSync(parent).isDirectory())
          return { ok: false, reason: "目标父目录不存在" };
        renameSync(from.absPath, to.absPath);
      } catch {
        return { ok: false, reason: "移动文件失败" };
      }
      return { ok: true, fromPath: from.relativePath, toPath: to.relativePath };
    } finally {
      claimed.lease.release();
    }
  }

  // ===== Board Projection（S5：看板桥，只读投影） =====
  //
  // 02-RUNTIME-A2A-SPEC §2.6 / ADR-0007 §15.7：挂载看板的房间以 attachedBoardId 引用
  // 看板真值；房间内模型/面板只能「读」投影，绝不能反向覆盖。本桥直接复用 kanban-store
  // 的只读读取（listTasksByBoard / getBoard），不缓存、不另造真值，返回形状经共享
  // mapKanbanTaskToProjected 投影为室内可消费的只读数据。房间未挂载 / 看板不存在一律
  // 返回空（fail-open 只读展示，不抛错）；挂板 fail-closed（不允许建/改 room task）由
  // createRoomTask / roomTaskUpdate 既有守卫保证，此处只做读取投影。

  /**
   * 投影挂载看板的任务为只读形状（房间可消费）。
   *
   * - 房间不存在 / 未挂载看板 → 返回 []（只读展示 fail-open）。
   * - 看板不存在 → 返回 []。
   * - 每次直读 kanban-store，无副作用、不写盘、不广播。
   */
  projectBoardTasks(roomId: string): BoardProjectedTask[] {
    const room = getRoom(roomId);
    if (!room?.attachedBoardId) return [];
    const board = kanbanStore.getBoard(room.attachedBoardId);
    if (!board) return [];
    return kanbanStore.listTasksByBoard(board.id).map(mapKanbanTaskToProjected);
  }

  /**
   * 投影挂载看板的统计摘要。
   *
   * 房间未挂载 / 看板不存在 → 返回 null（区别于空数组：渲染层可据此区分「无看板」与
   * 「空看板」）。
   */
  projectBoardSummary(roomId: string): BoardProjectedSummary | null {
    const room = getRoom(roomId);
    if (!room?.attachedBoardId) return null;
    const board = kanbanStore.getBoard(room.attachedBoardId);
    if (!board) return null;
    const projected = kanbanStore
      .listTasksByBoard(board.id)
      .map(mapKanbanTaskToProjected);
    return summarizeProjectedBoardTasks(
      board.id,
      board.title || board.rootGoal || board.id,
      board.createdAt,
      projected,
    );
  }

  /** 按任务 ID 读取看板任务（看板桥：IPC 侧反查任务所属看板用，只读） */
  getTaskByIdFromKanban(
    taskId: string,
  ): { taskId: string; boardId: string } | undefined {
    const task = kanbanStore.getTask(taskId);
    if (!task) return undefined;
    return { taskId: task.id, boardId: task.boardId };
  }

  /** 广播房间变更（看板桥：看板任务变化 → 让挂载该看板的房间刷新投影） */
  broadcastBoardChanged(roomId: string): void {
    this.broadcast(roomId, "updated");
  }

  // ===== 内部辅助 =====

  /** CAS 转换 run 状态：仅当当前状态 === expectedFrom 时才更新为 to，否则返回 undefined */
  private casRun(
    runId: string,
    expectedFrom: CollaborationRunStatus,
    to: CollaborationRunStatus,
    patch: Partial<CollaborationRun>,
    expectedFence?: number,
  ): CollaborationRun | undefined {
    const current = getRun(runId);
    if (!current || current.status !== expectedFrom) return undefined;
    if (expectedFence !== undefined && (current.fence ?? 0) !== expectedFence)
      return undefined;
    const updated: CollaborationRun = {
      ...current,
      ...patch,
      fence: patch.fence ?? (current.fence ?? 0) + 1,
      status: to,
    };
    upsertRun(updated);
    return updated;
  }

  /** 更新成员状态（合并 upsert，保留其他字段） */
  private setMemberStatus(
    memberId: string,
    status: CollaborationMember["status"],
  ): void {
    const member = getMember(memberId);
    if (!member) return;
    upsertMember({ ...member, status, updatedAt: Date.now() });
  }

  /**
   * run 终态后同步成员状态（Stage 3）：
   * - 该成员仍有 running run（被调度器刚启动）→ 保持 running（由对应 executeRun 设置，不覆盖）
   * - 否则有排队 run → queued
   * - 否则 → idle
   * 在 executeRun finally / cancelRun（排队取消）/ recoverInterruptedRuns 中调用。
   */
  private syncMemberStatus(memberId: string): void {
    if (this.scheduler.isMemberRunning(memberId)) return;
    const member = getMember(memberId);
    if (!member || member.status === "removed") return;
    const next = this.scheduler.hasQueuedForMember(memberId)
      ? "queued"
      : "idle";
    if (member.status !== next) {
      upsertMember({ ...member, status: next, updatedAt: Date.now() });
    }
  }

  /**
   * 触发房间共享摘要（§6.6）：不占 maxConcurrentRuns、非阻塞、fail-closed。
   * runner 内部失败/无渠道/超预算都只置 status='failed'，绝不抛错阻塞本方法/发言。
   */
  private kickSummary(room: CollaborationRoom): void {
    if (room.status !== "active") return;
    this.summaryRunner.run(room.id).catch((err) => {
      console.error("[协作室摘要] 后台总结触发失败（不影响成员发言）:", err);
    });
  }

  /**
   * 维护成员在本房间内的短上下文摘要。
   *
   * 这是逻辑会话状态，不是完整 transcript：完整历史仍在 messages.json，
   * 摘要只保留最近可见交互和未完成任务，重启后继续注入下一轮。
   */
  private updateMemberContextSummary(roomId: string, memberId: string): void {
    const member = getMember(memberId);
    if (!member || member.roomId !== roomId || member.status === "removed")
      return;
    const messages = listMessagesByRoom(roomId)
      .filter(
        (message) =>
          message.authorId === memberId ||
          message.targetMemberIds.includes(memberId),
      )
      .slice(-8)
      .map((message) => {
        const text = message.content.replace(/\s+/g, " ").trim().slice(0, 180);
        const kind =
          message.authorType === "user"
            ? "用户"
            : message.authorType === "member"
              ? "成员"
              : "系统";
        return text ? kind + "：" + text : "";
      })
      .filter(Boolean);
    const tasks = listRoomTasksByRoom(roomId)
      .filter(
        (task) => task.assigneeMemberId === memberId && task.status !== "done",
      )
      .slice(-4)
      .map((task) => task.title + "（" + task.status + "）");
    const parts = [
      messages.length > 0 ? "最近交互：" + messages.join("；") : "",
      tasks.length > 0 ? "未完成任务：" + tasks.join("、") : "",
    ].filter(Boolean);
    if (parts.length === 0) return;
    upsertMember({
      ...member,
      summary: parts.join("。 ").slice(0, 1400),
      updatedAt: Date.now(),
    });
  }

  /** 追加成员消息（done 后） */
  private appendMemberMessage(
    room: CollaborationRoom,
    member: CollaborationMember,
    triggerMessage: CollaborationMessage,
    text: string,
    runId: string,
  ): void {
    // 适配器最终结果与流式结果都经过一次展示层清洗，防止任何渠道把
    // antml/function/tool XML 协议文本落盘成成员正文。
    const content =
      sanitizeAssistantTextForDisplay(text ?? "") || "（成员未返回正文）";
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: "member",
      authorId: member.id,
      kind: "chat",
      content,
      visibility: "room",
      targetMemberIds: [],
      replyToMessageId: triggerMessage.id,
      rootMessageId: triggerMessage.rootMessageId,
      runId,
      depth: triggerMessage.depth,
      createdAt: Date.now(),
    };
    this.appendRoomMessage(message);
    this.broadcast(room.id, "member-message-appended");
  }

  /** 追加系统警告消息（failed / 无成员等） */
  private appendSystemMessage(
    roomId: string,
    content: string,
  ): CollaborationMessage {
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId,
      authorType: "system",
      authorId: "system",
      kind: "warning",
      content,
      visibility: "room",
      targetMemberIds: [],
      rootMessageId: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      depth: 0,
      createdAt: Date.now(),
    };
    this.appendRoomMessage(message);
    this.broadcast(roomId, "message-appended");
    return message;
  }

  /**
   * P2-UX 桥接服务用 thin wrapper：暴露 appendSystemMessage 供桥接层把单会话前情提要写进房间
   * 背景消息，**勿复制建房逻辑**（事件账本 + 广播仍走私有 appendSystemMessage）。
   */
  appendRoomSystemMessage(
    roomId: string,
    content: string,
  ): CollaborationMessage {
    return this.appendSystemMessage(roomId, content);
  }

  /**
   * 落盘一条 task_event 消息（room_task_update 的可审计事件）。
   *
   * summary 仅作为时间线记录（与成员正文同级，系统提示已声明非指令），绝不写入任务的权威字段。
   * content 形如「任务「标题」状态：todo → in_progress。说明：…」。
   */
  private appendTaskEventMessage(
    room: CollaborationRoom,
    member: CollaborationMember,
    task: CollaborationRoomTask,
    nextStatus: CollaborationRoomTaskStatus,
    summary: string | undefined,
    run: CollaborationRun,
  ): void {
    const content = [
      `任务「${task.title}」状态：${task.status} → ${nextStatus}`,
      summary ? `说明：${summary}` : "",
    ]
      .filter(Boolean)
      .join("。");
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: "member",
      authorId: member.id,
      kind: "task_event",
      content,
      visibility: "room",
      targetMemberIds: [],
      replyToMessageId: undefined,
      rootMessageId: run.triggerMessageId,
      causationId: run.id,
      runId: run.id,
      taskId: task.id,
      depth: 0,
      createdAt: Date.now(),
    };
    this.appendRoomMessage(message);
  }

  /**
   * 落盘一条“新任务待处理”系统通知。
   *
   * 这是工作面板创建任务与聊天触发链之间的桥：事件本身可在时间线审计，
   * 同时作为 triggerMessage 交给现有协调者路由。显式负责人是直接目标；
   * targetMemberIds 为空时沿用“无 @ → 协调者”的默认路由。
   */
  private appendTaskCreatedMessage(
    room: CollaborationRoom,
    task: CollaborationRoomTask,
  ): CollaborationMessage {
    const content = [
      `新任务待处理：「${task.title}」`,
      `任务 ID：${task.id}`,
      task.description ? `任务说明：${task.description}` : "",
      task.acceptanceCriteria ? `验收标准：${task.acceptanceCriteria}` : "",
      task.status === "blocked"
        ? "等待依赖任务完成：" + (task.dependsOnTaskIds ?? []).join("、")
        : task.assigneeMemberId
          ? "请直接开始处理该任务，并在完成后更新任务状态。"
          : "请判断合适的负责人并推进；如需用户指派，请明确提出。",
    ]
      .filter(Boolean)
      .join("\n");
    const id = genId(COLLABORATION_MESSAGE_ID_PREFIX);
    const message: CollaborationMessage = {
      id,
      roomId: room.id,
      authorType: "system",
      authorId: "system",
      // 任务状态变更专用 task_event 仍只由 room_task_update 产生；创建通知使用
      // warning，避免被误认成一次状态迁移。
      kind: "warning",
      content,
      visibility: "room",
      targetMemberIds: task.assigneeMemberId ? [task.assigneeMemberId] : [],
      rootMessageId: id,
      taskId: task.id,
      depth: 0,
      createdAt: Date.now(),
    };
    this.appendRoomMessage(message);
    return message;
  }

  /** 落盘一条任务重试事件；该事件同时作为新的成员 run trigger。 */
  private appendTaskRetryMessage(
    room: CollaborationRoom,
    task: CollaborationRoomTask,
    previousStatus: CollaborationRoomTaskStatus,
  ): CollaborationMessage {
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: "system",
      authorId: "system",
      kind: "task_event",
      content:
        "任务「" +
        task.title +
        "」已从" +
        previousStatus +
        "恢复为进行中，开始新的执行尝试。" +
        (task.assigneeMemberId
          ? "已通知负责人。"
          : "将交给协调者安排负责人。"),
      visibility: "room",
      targetMemberIds: task.assigneeMemberId ? [task.assigneeMemberId] : [],
      rootMessageId: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      taskId: task.id,
      depth: 0,
      createdAt: Date.now(),
    };
    this.appendRoomMessage(message);
    return message;
  }

  /** 落盘一条依赖已满足事件；该事件同时作为后续任务的 trigger。 */
  private appendTaskDependencyReadyMessage(
    room: CollaborationRoom,
    task: CollaborationRoomTask,
  ): CollaborationMessage {
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: "system",
      authorId: "system",
      kind: "task_event",
      content:
        "任务「" +
        task.title +
        "」的依赖已全部完成，已自动解除阻塞并进入待办。" +
        (task.assigneeMemberId
          ? "已通知负责人开始处理。"
          : "将交给协调者安排负责人。"),
      visibility: "room",
      targetMemberIds: task.assigneeMemberId ? [task.assigneeMemberId] : [],
      rootMessageId: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      taskId: task.id,
      depth: 0,
      createdAt: Date.now(),
    };
    this.appendRoomMessage(message);
    return message;
  }

  /** 落盘一条协调者分派任务事件；该事件同时作为目标成员的 trigger。 */
  private appendTaskAssignmentMessage(
    room: CollaborationRoom,
    coordinator: CollaborationMember,
    task: CollaborationRoomTask,
    run: CollaborationRun,
  ): CollaborationMessage {
    const assignee = task.assigneeMemberId ?? "";
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: "member",
      authorId: coordinator.id,
      kind: "task_event",
      content:
        "协调者已将任务「" +
        task.title +
        "」（任务 ID：" +
        task.id +
        "）分派给成员 " +
        assignee +
        (task.status === "blocked"
          ? "，当前等待依赖任务完成。"
          : "，请开始处理。"),
      visibility: "room",
      targetMemberIds: [assignee],
      rootMessageId: run.triggerMessageId,
      causationId: run.id,
      runId: run.id,
      taskId: task.id,
      depth: 0,
      createdAt: Date.now(),
    };
    this.appendRoomMessage(message);
    return message;
  }

  /**
   * 落盘一条 artifact 消息（room_publish_artifact 的可追溯审计事件）。
   *
   * kind='artifact'，与成员正文同级（系统提示已声明非指令）；携带 runId/taskId/rootMessageId/
   * causationId 供时间线与任务面板双向链接。summary 仅作时间线说明，绝不作为指令。
   */
  private appendArtifactMessage(
    room: CollaborationRoom,
    member: CollaborationMember,
    artifact: CollaborationArtifact,
    run: CollaborationRun,
  ): void {
    const content = [
      `产物「${artifact.relativePath}」已发布（sha256=${artifact.sha256.slice(0, 12)}…，${artifact.byteSize}B）`,
      artifact.summary ? `说明：${artifact.summary}` : "",
    ]
      .filter(Boolean)
      .join("。");
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: "member",
      authorId: member.id,
      kind: "artifact",
      content,
      visibility: "room",
      targetMemberIds: [],
      replyToMessageId: undefined,
      rootMessageId: run.triggerMessageId,
      causationId: run.id,
      runId: run.id,
      taskId: artifact.taskId,
      depth: 0,
      createdAt: Date.now(),
    };
    this.appendRoomMessage(message);
  }
}

/**
 * 解析一条用户消息的目标成员列表（Stage 3 路由）。
 *
 * - message.targetMemberIds 非空 → 按顺序解析为成员（去重，跳过未知 ID）。
 *   （targetMemberIds 由 appendUserMessage 从 @mention 解析落盘，或程序化传入）
 * - 否则（无 @ 命中）→ 协调者（无协调者则首成员）；空团队返回 []。
 *
 * 纯函数（不读 DB）；members 由调用方传入。幂等：同输入同输出。
 */
function resolveTargetMembers(
  room: CollaborationRoom,
  triggerMessage: CollaborationMessage,
  members: CollaborationMember[],
): CollaborationMember[] {
  const activeMembers = members.filter((member) => member.status !== "removed");
  if (activeMembers.length === 0) return [];
  if (triggerMessage.targetMemberIds.length > 0) {
    const seen = new Set<string>();
    const out: CollaborationMember[] = [];
    for (const id of triggerMessage.targetMemberIds) {
      if (seen.has(id)) continue;
      const m = activeMembers.find((mm) => mm.id === id);
      if (m) {
        seen.add(id);
        out.push(m);
      }
    }
    return out;
  }
  // 无点名 → 协调者 → 首成员
  if (room.coordinatorMemberId) {
    const coord = activeMembers.find((m) => m.id === room.coordinatorMemberId);
    if (coord) return [coord];
  }
  return activeMembers.slice(0, 1);
}

/**
 * S3.5-a：把投影结果 flatten 成现有 adapter 需要的单段 prompt（04 §5.3）。
 * S4-3 升级 tool bridge 时应改为直接传 messages 数组，不再 flatten。
 */
function flattenProjectedTurn(
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    source: string;
  }>,
): string {
  return messages
    .map((m) => {
      // 正文可能主动伪造边界标记；先替换再包裹，避免跨来源串线。
      const safeContent = m.content.replace(
        /\[\/?COLLAB_CONTEXT\b/giu,
        "[BLOCKED_CONTEXT_MARKER",
      );
      return (
        `[COLLAB_CONTEXT source="${m.source}" role="${m.role}" untrusted="true"]` +
        `\n${safeContent}\n[/COLLAB_CONTEXT]`
      );
    })
    .join("\n\n");
}
/** 序列化 run 错误（保留 code：MemberBackendResolveError 有 code） */
function serializeRunError(err: unknown): CollaborationSerializedRunError {
  if (err instanceof MemberBackendResolveError) {
    return { message: err.message, code: err.code };
  }
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

/** 依赖任务 ID 去重保序（trim + 跳过空串）；空结果返回 undefined，避免落盘空数组 */
function dedupeDependsOn(ids?: string[]): string[] | undefined {
  if (!ids || ids.length === 0) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const t = id?.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 生成成员移除/替换时的确定性交接摘要。
 *
 * 这里不调用模型，也不把摘要当作 prompt 指令；它只从已落盘的最近消息和未完成任务
 * 取短摘录，保证移除成员时仍能恢复“做到哪、卡在哪”的最小上下文。
 */
function buildMemberHandoffSummary(
  roomId: string,
  member: CollaborationMember,
): string {
  const messageHints = listMessagesByRoom(roomId)
    .filter(
      (message) =>
        message.authorId === member.id ||
        message.targetMemberIds.includes(member.id),
    )
    .slice(-4)
    .map((message) => message.content.replace(/\s+/g, " ").trim().slice(0, 140))
    .filter(Boolean);
  const taskHints = listRoomTasksByRoom(roomId)
    .filter(
      (task) => task.assigneeMemberId === member.id && task.status !== "done",
    )
    .slice(-4)
    .map((task) => `${task.title}（${task.status}）`);
  const parts = [
    messageHints.length > 0 ? `最近消息：${messageHints.join("；")}` : "",
    taskHints.length > 0 ? `未完成任务：${taskHints.join("、")}` : "",
  ].filter(Boolean);
  return parts.join("。 ").slice(0, 900);
}
/** 根据创建输入 + 房间 ID 构建一个静态成员记录 */
function buildMember(
  roomId: string,
  spec: CreateCollaborationMemberInput,
  now: number,
): CollaborationMember {
  const displayName = spec.displayName.trim();
  const backend = spec.backend ?? "channel";
  // 未显式绑渠道时：自动绑 kscc（可用）或首个可用外部渠道，保证「新建即能聊」
  const autoBind =
    !spec.channelId &&
    backend === "channel"
      ? pickDefaultMemberChannelBinding()
      : null;
  const channelId =
    backend === "codex" || backend === "cli"
      ? undefined
      : spec.channelId ?? autoBind?.channelId;
  const modelId =
    backend === "codex" ? spec.modelId?.trim() || undefined : spec.modelId ?? autoBind?.modelId;
  return {
    id: genId(COLLABORATION_MEMBER_ID_PREFIX),
    roomId,
    displayName,
    roleId: spec.roleId,
    roleSnapshot: spec.roleSnapshot ?? { roleId: spec.roleId, displayName },
    backend,
    channelId,
    modelId,
    cliWorkerId: spec.cliWorkerId,
    logicalSessionId: genId(COLLABORATION_LOGICAL_SESSION_ID_PREFIX),
    permissionProfile: spec.permissionProfile ?? "read-only",
    capabilities: {
      ...DEFAULT_MEMBER_CAPABILITIES,
      ...(spec.capabilities ?? {}),
      // Codex 通过 App Server Dynamic Tools 接入；其它后端仍按渠道能力保守探测。
      supportsToolBridge:
        (backend === "codex" || channelSupportsRoomToolBridge(channelId)) &&
        spec.capabilities?.supportsToolBridge !== false,
    },
    status: "offline",
    isCoordinator: spec.isCoordinator ?? false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 将长期 Bot 的当前 revision 投影为旧协作室成员记录。
 * 这是迁移桥：成员运行时仍复用既有 CollaborationMember/RoomService，
 * 但落盘字段已经是加入当时的 Bot 配置副本。
 */
function materializeBotProfileSnapshot(
  member: CollaborationMember,
  botProfileId?: string,
): CollaborationMember {
  if (!botProfileId) return member;
  const record = getBotProfileRecord(botProfileId);
  if (!record) throw new Error(`Bot 不存在：${botProfileId}`);
  const seat = createRoomBotSeatFromProfile(record, {
    id: member.id,
    roomId: member.roomId,
    logicalSessionId: member.logicalSessionId,
    createdAt: member.createdAt,
    isCoordinator: member.isCoordinator,
  });
  return {
    ...member,
    botProfileId: seat.botProfileId,
    botOwnerUserId: seat.ownerUserId,
    ownerConsent: true,
    configRevisionId: seat.configRevisionId,
    displayName: seat.displayNameSnapshot,
    roleId: seat.roleSnapshot.roleId,
    roleSnapshot: seat.roleSnapshot,
    backend: seat.backend,
    channelId: seat.channelId ?? member.channelId,
    modelId: seat.modelId ?? member.modelId,
    permissionProfile: seat.permissionProfile,
    capabilities: {
      ...seat.capabilities,
      supportsToolBridge:
        (seat.backend === "codex" ||
          channelSupportsRoomToolBridge(seat.channelId ?? member.channelId)) &&
        seat.capabilities.supportsToolBridge,
    },
  };
}
/** 纯函数：只允许把唯一出现的 oldText 替换为 newText，并限制结果大小。 */
export function applyUniqueWorkspacePatch(
  content: string,
  oldText: string,
  newText: string,
  maxBytes: number,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (!oldText) return { ok: false, reason: "oldText 不能为空" };
  if (
    Buffer.byteLength(oldText, "utf8") >
      COLLABORATION_WORKSPACE_PATCH_MAX_BYTES ||
    Buffer.byteLength(newText, "utf8") > COLLABORATION_WORKSPACE_PATCH_MAX_BYTES
  ) {
    return {
      ok: false,
      reason: `补丁文本超过 ${COLLABORATION_WORKSPACE_PATCH_MAX_BYTES} 字节上限`,
    };
  }
  const first = content.indexOf(oldText);
  if (first < 0) return { ok: false, reason: "oldText 在文件中不存在" };
  const second = content.indexOf(oldText, first + oldText.length);
  if (second >= 0)
    return { ok: false, reason: "oldText 在文件中不唯一，拒绝修改" };
  const next =
    content.slice(0, first) + newText + content.slice(first + oldText.length);
  if (Buffer.byteLength(next, "utf8") > maxBytes)
    return { ok: false, reason: "修改后文件超过大小上限" };
  return { ok: true, content: next };
}

// ===== workspace_search glob 匹配 =====

/**
 * 简单 glob 匹配（仅 `*` `?`，大小写不敏感），用于 workspace_search 过滤文件名。
 *
 * - `*` 匹配任意数量的字符（含零个），`?` 匹配单个字符。
 * - 不含 `*` `?` 时按子串匹配（大小写不敏感）。
 * - 纯函数，不读盘不依赖时间。
 */
function simpleGlobMatch(pattern: string, str: string): boolean {
  const lowerP = pattern.toLowerCase();
  const lowerS = str.toLowerCase();
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return lowerS.includes(lowerP);
  }
  const parts = lowerP.split(/(\*+|\?+)/);
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "" || part === undefined) continue;
    if (part.startsWith("*") || part.startsWith("?")) {
      // wildcard segment: * matches greedy, ? matches exactly one char
      const isStar = part.startsWith("*");
      if (isStar) {
        // * can match zero or more chars; try all positions
        const nextPart = parts[i + 1];
        if (!nextPart) return true; // trailing * matches everything
        const nextIdx = lowerS.indexOf(nextPart, idx);
        if (nextIdx === -1) return false;
        idx = nextIdx + nextPart.length;
        i++; // skip the next literal part we just consumed
      } else {
        // ? matches exactly one char
        for (let q = 0; q < part.length; q++) {
          if (idx >= lowerS.length) return false;
          idx++;
        }
      }
    } else {
      // literal
      if (!lowerS.startsWith(part, idx)) return false;
      idx += part.length;
    }
  }
  return idx <= lowerS.length;
}

// ===== room_publish_artifact 路径安全（纯函数，便于分层单测） =====
//
// 02-RUNTIME-A2A-SPEC §11：只允许已注册 workspace 的相对路径；符号链接逃逸、绝对路径和 `..`
// 由宿主拒绝。下列函数不读 DB、不依赖时间；rootAbs 由调用方解析为真实路径后传入。

/** realpath 兜底：解析失败（不存在/无权限）时返回空串，由调用方 fail-closed。 */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return "";
  }
}

/** file 是否在 root 内（含 root 自身）。用 path.relative，避免 startsWith 在尾斜杠/大小写/混分隔符下误判。 */
/** 在持有工作区租约的前提下，以临时文件 + rename 完成单文件替换，避免进程崩溃留下半截正文。 */
function writeWorkspaceFileAtomically(
  absPath: string,
  content: Uint8Array,
): void {
  const tempPath = join(dirname(absPath), `.tagent-write-${randomUUID()}.part`);
  writeFileSync(tempPath, content, { flag: "wx" });
  try {
    renameSync(tempPath, absPath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      /* best effort cleanup; lease expiry bounds the next retry */
    }
    throw error;
  }
}

function isPathInsideRoot(fileAbs: string, rootAbs: string): boolean {
  if (!fileAbs || !rootAbs) return false;
  let file = fileAbs;
  let root = rootAbs;
  if (process.platform === "win32") {
    file = file.toLowerCase();
    root = root.toLowerCase();
  }
  const rel = relative(root, file);
  if (!rel) return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * 检查 root → target 路径上是否存在符号链接组件。任一已存在的组件是符号链接即拒绝
 *（fail-closed：即便该链接指向工作区内也拒，避免经符号链接写入产物造成逃逸/意外覆盖）。
 * 不存在的组件后续会被创建为普通目录/文件，不会成为符号链接。
 *
 * 返回非空 reason 表示检测到符号链接；返回 null 表示安全。
 */
function assertNoSymlinkOnPath(
  rootAbs: string,
  targetAbs: string,
): string | null {
  const rel = relative(rootAbs, targetAbs);
  if (!rel) return null;
  const segments = rel.split(sep).filter((s) => s !== "" && s !== ".");
  let cur = rootAbs;
  for (const seg of segments) {
    cur = join(cur, seg);
    if (!existsSync(cur)) continue;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      return `路径组件「${seg}」是符号链接，禁止经符号链接写入产物（防逃逸）`;
    }
  }
  return null;
}

/**
 * 解析产物相对路径为目标绝对路径，校验全部路径安全约束。
 *
 * 约束（任一不满足 fail-closed）：
 * - 非空、不含 NUL、不含反斜杠（只允许正斜杠 `/` 分隔，避免 Win 盘符/分隔符歧义）；
 * - 非绝对路径（不以 `/` 开头、非 `//`、非 `C:` 盘符）；
 * - 不含 `..` 段（拒绝越界）；`.` 与空段被规范化忽略；
 * - resolve 后仍在 rootAbs 内（isPathInsideRoot 兜底）；
 * - root → target 路径上无符号链接组件（assertNoSymlinkOnPath）。
 *
 * 返回 `{ ok: true, absPath, relativePath }`（relativePath 为规范化后的正斜杠相对路径）或
 * `{ ok: false, reason }`。纯函数：不读 DB、不写盘、不依赖时间（realpath 由调用方预先解析）。
 */
export function resolveArtifactTargetPath(
  rootAbs: string,
  relativePath: string,
):
  | { ok: true; absPath: string; relativePath: string }
  | { ok: false; reason: string } {
  const trimmed = (relativePath ?? "").trim();
  if (!trimmed) return { ok: false, reason: "relativePath 不能为空" };
  if (trimmed.includes("\0"))
    return { ok: false, reason: "relativePath 含非法字符" };
  if (trimmed.includes("\\")) {
    return {
      ok: false,
      reason: "relativePath 只允许使用正斜杠 / 分隔，不允许反斜杠",
    };
  }
  if (isAbsolute(trimmed))
    return { ok: false, reason: "relativePath 不能是绝对路径" };
  if (/^[a-zA-Z]:/.test(trimmed))
    return { ok: false, reason: "relativePath 不能是绝对路径" };
  if (trimmed.startsWith("//"))
    return { ok: false, reason: "relativePath 不能是绝对路径" };

  const segments: string[] = [];
  for (const seg of trimmed.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..")
      return { ok: false, reason: "relativePath 不允许 .. 越界" };
    if (seg.includes("\0"))
      return { ok: false, reason: "relativePath 含非法字符" };
    segments.push(seg);
  }
  if (segments.length === 0)
    return { ok: false, reason: "relativePath 不能为空" };

  const absPath = resolve(rootAbs, ...segments);
  if (!isPathInsideRoot(absPath, rootAbs)) {
    return { ok: false, reason: "relativePath 越出工作区根目录" };
  }
  const esc = assertNoSymlinkOnPath(rootAbs, absPath);
  if (esc) return { ok: false, reason: esc };
  return { ok: true, absPath, relativePath: segments.join("/") };
}
