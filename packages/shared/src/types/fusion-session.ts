/**
 * 多用户融合会话第一切片的领域契约。
 *
 * 本文件只定义可序列化的身份/席位/工作区边界和 fail-closed 纯函数；
 * 不直接启动 Agent，不改变旧 CollaborationRoom 的运行时。
 */
import type {
  CollaborationMemberBackend,
  CollaborationMemberCapabilities,
  CollaborationPermissionProfile,
  CollaborationRoleSnapshot,
} from "./collaboration-room";

export type FusionConversationMode =
  "ordinary" | "single-bot" | "multi-bot" | "multi-user";

export type FusionHumanMemberStatus =
  "invited" | "active" | "offline" | "left" | "removed";

export interface FusionHumanMember {
  id: string;
  roomId: string;
  userId: string;
  displayName: string;
  status: FusionHumanMemberStatus;
  joinedAt: number;
  updatedAt: number;
  leftAt?: number;
}

export type BotProfileStatus = "draft" | "active" | "paused" | "archived";

export interface BotConfigRevision {
  id: string;
  botProfileId: string;
  version: number;
  backend: CollaborationMemberBackend;
  channelId?: string;
  modelId?: string;
  roleSnapshot: CollaborationRoleSnapshot;
  permissionProfile: CollaborationPermissionProfile;
  capabilities: CollaborationMemberCapabilities;
  createdAt: number;
  publishedAt?: number;
}

export interface BotProfile {
  id: string;
  ownerUserId: string;
  displayName: string;
  description?: string;
  status: BotProfileStatus;
  currentConfigRevisionId: string;
  memoryNamespace: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

/**
 * Bot 库的本地持久化记录。
 *
 * revision 与 profile 一起读取，但 revision 发布后不可原地修改；
 * 房间加入时仍需从这里复制出 RoomBotSeat 快照。
 */
export interface BotProfileRecord {
  profile: BotProfile;
  revisions: BotConfigRevision[];
}

export type BotMemoryState = "candidate" | "active" | "rejected" | "archived";

export type BotMemorySourceSurface =
  "bot-chat" | "ordinary-session" | "fusion-session" | "sidecar" | "user-note";

/** Bot 的小而精长期记忆；candidate 永远不能直接进入 prompt。 */
export interface BotMemoryRecord {
  id: string;
  botProfileId: string;
  ownerUserId: string;
  text: string;
  state: BotMemoryState;
  confidence: number;
  sourceSurface: BotMemorySourceSurface;
  sourceReferenceId?: string;
  createdAt: number;
  updatedAt: number;
  activatedAt?: number;
  archivedAt?: number;
  revision: number;
}

export type RoomBotSeatStatus =
  | "invited"
  | "accepted"
  | "idle"
  | "running"
  | "awaiting_user"
  | "blocked"
  | "paused"
  | "removed";

/** BotProfile 在一个 RoomSession 内的配置快照，不是 BotProfile 本体。 */
export interface RoomBotSeat {
  id: string;
  roomId: string;
  botProfileId: string;
  ownerUserId: string;
  configRevisionId: string;
  displayNameSnapshot: string;
  roleSnapshot: CollaborationRoleSnapshot;
  backend: CollaborationMemberBackend;
  channelId?: string;
  modelId?: string;
  permissionProfile: CollaborationPermissionProfile;
  capabilities: CollaborationMemberCapabilities;
  status: RoomBotSeatStatus;
  logicalSessionId: string;
  isCoordinator: boolean;
  createdAt: number;
  updatedAt: number;
  removedAt?: number;
  handoffSummary?: string;
}

export type RoomAgentSessionStatus =
  "idle" | "running" | "paused" | "ended" | "failed";

export interface CreateRoomBotSeatInput {
  id: string;
  roomId: string;
  logicalSessionId: string;
  createdAt: number;
  /** 首个 Bot 默认成为协调者；后续替换时由 RoomSession 显式传入。 */
  isCoordinator?: boolean;
}

/**
 * 将 Bot 库记录复制成房间席位快照。
 *
 * 这个函数刻意不返回 BotProfile 引用：Bot 库后续发布新 revision、归档或删除，
 * 都不能无声改写已经加入房间的身份、模型、工具权限和角色指令。
 */
export function createRoomBotSeatFromProfile(
  record: BotProfileRecord,
  input: CreateRoomBotSeatInput,
): RoomBotSeat {
  const revision = record.revisions.find(
    (item) => item.id === record.profile.currentConfigRevisionId,
  );
  if (!revision) throw new Error("Bot 当前 revision 不存在，不能加入房间");
  if (record.profile.status === "archived")
    throw new Error("已归档 Bot 不能加入新房间");
  if (
    !input.id.trim() ||
    !input.roomId.trim() ||
    !input.logicalSessionId.trim()
  ) {
    throw new Error("RoomBotSeat 的 id、roomId、logicalSessionId 必填");
  }
  if (!Number.isFinite(input.createdAt))
    throw new Error("RoomBotSeat.createdAt 非法");

  const roleSnapshot = JSON.parse(
    JSON.stringify(revision.roleSnapshot),
  ) as CollaborationRoleSnapshot;
  const capabilities = JSON.parse(
    JSON.stringify(revision.capabilities),
  ) as CollaborationMemberCapabilities;
  return {
    id: input.id,
    roomId: input.roomId,
    botProfileId: record.profile.id,
    ownerUserId: record.profile.ownerUserId,
    configRevisionId: revision.id,
    displayNameSnapshot: record.profile.displayName,
    roleSnapshot,
    backend: revision.backend,
    channelId: revision.channelId,
    modelId: revision.modelId,
    permissionProfile: revision.permissionProfile,
    capabilities,
    status: "idle",
    logicalSessionId: input.logicalSessionId,
    isCoordinator: input.isCoordinator === true,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}
export interface RoomAgentSession {
  id: string;
  roomId: string;
  seatId: string;
  configRevisionId: string;
  status: RoomAgentSessionStatus;
  summary?: string;
  backendResumeToken?: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

export type RoomWorkspaceKind = "server" | "local-host" | "cloud-volume";
export type RoomWorkspaceStatus = "active" | "archived" | "deleted";

export interface RoomWorkspace {
  id: string;
  roomId: string;
  kind: RoomWorkspaceKind;
  /** 服务端内部根路径；客户端不得把它当作可读写任意路径。 */
  rootPath?: string;
  storageKey?: string;
  status: RoomWorkspaceStatus;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

/** 0/1/2+ Bot 的路由模式，人数不改变单 Bot 的稳定路径。 */
export function getFusionConversationMode(
  humanCount: number,
  botCount: number,
): FusionConversationMode {
  if (!Number.isInteger(humanCount) || humanCount < 1) return "ordinary";
  if (humanCount > 1) return "multi-user";
  if (botCount <= 0) return "ordinary";
  if (botCount === 1) return "single-bot";
  return "multi-bot";
}

/** 权限解析 fail-closed：旧数据缺省或非法值不得意外升权。 */
export function normalizeFusionPermissionProfile(
  value: unknown,
): CollaborationPermissionProfile {
  return value === "workspace-write" ? "workspace-write" : "read-only";
}

/** 旧 CollaborationMember 没有 seatId 时稳定派生；不使用随机数或时间戳。 */
export function deriveLegacyRoomBotSeatId(
  roomId: string,
  memberId: string,
): string {
  const safeRoomId = roomId.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeMemberId = memberId.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return `rbs_legacy_${safeRoomId}_${safeMemberId}`;
}

export function validateRoomWorkspace(value: RoomWorkspace): string[] {
  const errors: string[] = [];
  if (!value.id.trim()) errors.push("workspace.id 必填");
  if (!value.roomId.trim()) errors.push("workspace.roomId 必填");
  if (!["server", "local-host", "cloud-volume"].includes(value.kind)) {
    errors.push("workspace.kind 非法");
  }
  if (
    value.status === "active" &&
    !value.rootPath?.trim() &&
    !value.storageKey?.trim()
  ) {
    errors.push("active workspace 必须有 rootPath 或 storageKey");
  }
  return errors;
}

export type CollaborationRoomEventType =
  | "room.created"
  | "room.updated"
  | "human-member.changed"
  | "bot-member.changed"
  | "message.appended"
  | "run.changed"
  | "run.resume_confirmed"
  | "mailbox.changed"
  | "task.changed"
  | "artifact.published"
  | "session.projected"
  | "projection.failed"
  | "usage.recorded"

export interface CollaborationRoomEvent {
  id: string
  roomId: string
  sequence: number
  type: CollaborationRoomEventType
  actorUserId: string
  entityId?: string
  causationId?: string
  idempotencyKey?: string
  payload: Record<string, unknown>
  createdAt: number
}

export interface AppendCollaborationRoomEventInput {
  roomId: string
  type: CollaborationRoomEventType
  actorUserId: string
  entityId?: string
  causationId?: string
  idempotencyKey?: string
  payload?: Record<string, unknown>
  expectedSequence?: number
}

export type BotSidecarLifecycle = "open" | "minimized" | "closed";

export interface OpenBotSidecarInput {
  sessionId: string;
  botProfileId: string;
}

export interface EnsureBotSidecarSessionInput {
  sessionId: string;
  botProfileId: string;
}

export interface BotSidecarState {
  sidecarId: string;
  sessionId: string;
  botProfileId: string;
  /** 当前主会话与 Bot 的隐藏专属 session；关闭窗口不销毁上下文，切换主会话不串上下文。 */
  agentSessionId: string;
  lifecycle: BotSidecarLifecycle;
  openedAt: number;
  updatedAt: number;
}

export interface CloseBotSidecarInput {
  sidecarId: string;
}

export interface BotSidecarBridgeRequest {
  sidecarId: string;
  sessionId: string;
  botProfileId: string;
  /** 由旁路 Bot 提炼后的建议；不会绕过主会话 Agent 直接写入时间线。 */
  content: string;
}

export interface BotSidecarBridgeResult {
  ok: boolean;
  accepted: boolean;
  error?: string;
}
/** 将一段用户明确提交的笔记/证据交给 AI 整理；输出永远先落 candidate。 */
export interface ConsolidateBotMemoryInput {
  botProfileId: string;
  ownerUserId: string;
  sourceSurface: BotMemorySourceSurface;
  sourceReferenceId?: string;
  evidence: string;
  /**
   * 只有用户明确选择“让 AI 整理”时才允许把这段素材发送给配置的模型渠道。
   * 未设置或为 false 时保持本地整理，不向外部服务发送原文。
   */
  allowModelProcessing?: boolean;
}

/** AI 整理结果；created 中的记录仍必须由用户逐条确认后才进入 prompt。 */
export interface BotMemoryConsolidationResult {
  created: BotMemoryRecord[];
  skipped: string[];
  /** 实际使用的整理路径；local 表示模型不可用时的安全 fallback。 */
  method?: "ai" | "local";
  warning?: string;
}
export const BOT_IPC_CHANNELS = {
  LIST: "bot:list",
  GET: "bot:get",
  SAVE: "bot:save",
  CREATE: "bot:create",
  ARCHIVE: "bot:archive",
  PUBLISH_REVISION: "bot:publish-revision",
  MEMORY_LIST: "bot:memory-list",
  MEMORY_SAVE_CANDIDATE: "bot:memory-save-candidate",
  MEMORY_ACTIVATE: "bot:memory-activate",
  MEMORY_REJECT: "bot:memory-reject",
  MEMORY_ARCHIVE: "bot:memory-archive",
  MEMORY_CONSOLIDATE: "bot:memory-consolidate",
  SIDECAR_OPEN: "bot:sidecar-open",
  SIDECAR_CLOSE: "bot:sidecar-close",
  SIDECAR_MINIMIZE: "bot:sidecar-minimize",
  SIDECAR_BRIDGE_REQUEST: "bot:sidecar-bridge-request",
  SIDECAR_SESSION_ENSURE: "bot:sidecar-session-ensure",
} as const;

export interface SaveBotProfileInput {
  record: BotProfileRecord;
}

export interface CreateBotProfileInput {
  record: BotProfileRecord;
}

export interface PublishBotConfigRevisionInput {
  profileId: string;
  revision: BotConfigRevision;
}

export interface SaveBotMemoryCandidateInput {
  memory: BotMemoryRecord;
}
