/**
 * Collaboration Room 协作室 IPC 通道常量与请求/响应类型
 *
 * 渲染进程通过 window.electronAPI.collaborationRoom.* 调用，主进程在
 * main/lib/collaboration/collaboration-ipc.ts 注册处理器。
 * 通道命名与 kanban/automation 一致：动词:名词 形式，CHANGED 为 main→renderer 广播。
 *
 * Stage 2：在 Stage 1 的 7 个通道基础上新增 LIST_RUNS / CANCEL_RUN，并启用 CHANGED
 * 广播（run/member/message 变更时主进程主动推送，渲染层据此重新拉取）。
 * Stage 3：新增 ADD_MEMBER（向已有房间追加成员，「添加成员」按钮用）。
 * Stage 4.5：新增 CONTINUE_DEPTH_STOP（继续一次已达 A2A 深度上限的交接）。
 * S5 面板：新增 LIST_ROOM_TASKS / CREATE_ROOM_TASK / UPDATE_ROOM_TASK / LIST_ARTIFACTS /
 * READ_ARTIFACT，供右侧室级任务/产物面板读写已落盘的 room task / artifact 真值。
 *   - 任务 create/update 复用 service 既有守卫（挂板 fail-closed、负责人归属、严格状态机、CAS）；
 *   - READ_ARTIFACT 由宿主按 artifactId 反查记录后经 resolveArtifactTargetPath 复用同一条安全
 *     路径解析再读盘，渲染层只传 artifactId、永不传路径，不越权扩大文件访问面。
 */

import type {
  CollaborationArtifact,
  CollaborationRoom,
  CollaborationMember,
  CollaborationMemberPreset,
  CollaborationMessage,
  CollaborationRoomTask,
  CollaborationRun,
  CollaborationUserApprovalRequest,
  CreateCollaborationRoomInput,
  CreateCollaborationMemberInput,
  RemoveCollaborationMemberInput,
  SaveCollaborationMemberPresetInput,
  CreateCollaborationRoomTaskInput,
  UpdateCollaborationRoomInput,
  UpdateCollaborationMemberInput,
  UpdateCollaborationRoomTaskInput,
  InviteCollaborationHumanMemberInput,
  JoinCollaborationHumanMemberInput,
  LeaveCollaborationHumanMemberInput,
  RemoveCollaborationHumanMemberInput,
  SetCollaborationBotOwnerConsentInput,
  AppendCollaborationUserMessageInput,
  ListBoardProjectedTasksInput,
  GetBoardProjectedSummaryInput,
  BoardProjectedTask,
  BoardProjectedSummary,
} from "./collaboration-room";
import type {
  SessionToRoomBrief,
  RoomToSessionHandoff,
  SourceSessionExcerptRequest,
  SourceSessionExcerptResult,
} from "./session-collab-bridge";
import type { LocalCollaborationContinuationItem } from "./collaboration-local-continuation";

export type { CollaborationMemberPreset, SaveCollaborationMemberPresetInput };

export const COLLABORATION_ROOM_IPC_CHANNELS = {
  /** 列出全部协作室房间（默认不含 archived） */
  LIST: "collaboration-room:list",
  /** 创建协作室房间（含可选静态成员） */
  CREATE: "collaboration-room:create",
  /** 将统一会话派生为协作室；原会话保留，房间成为新的协作真值源 */
  UPGRADE_FROM_SESSION: "collaboration-room:upgrade-from-session",
  /** 获取单个房间（不存在返回 null） */
  GET: "collaboration-room:get",
  /** 更新房间（rename / pause / archive / complete） */
  UPDATE: "collaboration-room:update",
  /** 列出某房间全部消息（按 createdAt 升序） */
  LIST_MESSAGES: "collaboration-room:list-messages",
  /** 追加用户消息（Stage 2：落盘后异步触发成员 run） */
  APPEND_USER_MESSAGE: "collaboration-room:append-user-message",
  /** 列出某房间全部成员（静态身份 + 运行状态） */
  LIST_MEMBERS: "collaboration-room:list-members",
  /** 列出房间内真实用户成员 */
  LIST_HUMAN_MEMBERS: "collaboration-room:list-human-members",
  /** 邀请/加入/离开/移除用户成员 */
  INVITE_HUMAN_MEMBER: "collaboration-room:invite-human-member",
  JOIN_HUMAN_MEMBER: "collaboration-room:join-human-member",
  LEAVE_HUMAN_MEMBER: "collaboration-room:leave-human-member",
  REMOVE_HUMAN_MEMBER: "collaboration-room:remove-human-member",
  /** Bot 所有人授权/撤回 */
  SET_BOT_OWNER_CONSENT: "collaboration-room:set-bot-owner-consent",
  /** 向已有房间追加一个成员（Stage 3：「添加成员」按钮；displayName + 自动绑默认渠道） */
  ADD_MEMBER: "collaboration-room:add-member",
  /** 更新已有成员（改显示名 / 渠道 / 模型） */
  UPDATE_MEMBER: "collaboration-room:update-member",
  /** 软删除成员（保留历史与加入时快照，不再参与新路由） */
  REMOVE_MEMBER: "collaboration-room:remove-member",
  /** 列出用户保存的成员配置模板 */
  LIST_MEMBER_PRESETS: "collaboration-room:list-member-presets",
  /** 保存/更新成员配置模板 */
  SAVE_MEMBER_PRESET: "collaboration-room:save-member-preset",
  /** 删除成员配置模板 */
  DELETE_MEMBER_PRESET: "collaboration-room:delete-member-preset",
  /** 列出某房间全部 run（按 createdAt 升序，Stage 2） */
  LIST_RUNS: "collaboration-room:list-runs",
  /** 取消某 run（abort 后端调用 + 置 cancelled，Stage 2） */
  CANCEL_RUN: "collaboration-room:cancel-run",
  /** 列出某房间全部 A2A 信箱信封（S4 审计视图） */
  LIST_MAILBOX: "collaboration-room:list-mailbox",
  /** 继续一次已达 A2A 深度上限的交接（S4.5：仅 max_depth 停止且未继续过可继续一次） */
  CONTINUE_DEPTH_STOP: "collaboration-room:continue-depth-stop",
  /** 列出某房间全部轻量 room task（S5 面板：右侧任务/产物面板读取任务真值） */
  LIST_ROOM_TASKS: "collaboration-room:list-room-tasks",
  /** 创建轻量 room task（S5 面板：复用 service 守卫，挂板时 fail-closed） */
  CREATE_ROOM_TASK: "collaboration-room:create-room-task",
  /** 更新轻量 room task（S5 面板：改派 / 状态 / 标题等；复用 service 守卫 + 严格状态机 + CAS） */
  UPDATE_ROOM_TASK: "collaboration-room:update-room-task",
  /** 列出某房间全部产物（S5 面板：读取 artifact 审计真值） */
  LIST_ARTIFACTS: "collaboration-room:list-artifacts",
  /** 预览产物文本（S5 面板：宿主按 artifactId 反查 + 复用安全路径解析后读盘，渲染层不传路径） */
  READ_ARTIFACT: "collaboration-room:read-artifact",
  /** 将产物安全复制到用户选择的本地路径 */
  DOWNLOAD_ARTIFACT: "collaboration-room:download-artifact",
  /** 从用户选择的个人目录显式导入到房间服务工作区 */
  IMPORT_WORKSPACE: "collaboration-room:import-workspace",
  /** 列出房间挂载看板的投影任务（S5 看板桥：从 kanban-store 读取后投影为只读形状） */
  LIST_BOARD_TASKS: "collaboration-room:list-board-tasks",
  /** 获取房间挂载看板的投影统计摘要（S5 看板桥） */
  GET_BOARD_SUMMARY: "collaboration-room:get-board-summary",
  /** 列出房间内成员发起的用户审批请求 */
  LIST_USER_APPROVALS: "collaboration-room:list-user-approvals",
  /** 解决一个用户审批请求 */
  RESOLVE_USER_APPROVAL: "collaboration-room:resolve-user-approval",
  /** 列出某房间的可观察「待确认续跑」项（P2-1：blocked run / 待审批 / 深度停止 / outbox 等） */
  LIST_CONTINUATIONS: "collaboration-room:list-continuations",
  /** 确认继续一个 blocked run：新建 turn（新 runId/fence），不复活旧 fence（P2-1） */
  CONFIRM_RESUME_BLOCKED: "collaboration-room:confirm-resume-blocked",
  /**
   * P2-UX 桥接：明示进房（userConfirmed 闸）——精炼单会话前情提要写入房间背景。
   * 旧 UPGRADE_FROM_SESSION 仍保留（UI 未改前旧路径可用，但旧路径无精炼桥）。
   */
  ENTER_WITH_BRIDGE: "collaboration-room:enter-with-bridge",
  /** P2-UX 桥接：明示退出（userConfirmed 闸）——精炼协作结论写回原 session，房间转 paused。 */
  EXIT_WITH_BRIDGE: "collaboration-room:exit-with-bridge",
  /** P2-UX 桥接：协调者按需读原 session 摘录（预算校验 + 读 panel + clamp，本切片不接 host 工具表）。 */
  READ_SOURCE_EXCERPT: "collaboration-room:read-source-excerpt",
  /** 房间数据变更事件（main → renderer，Stage 2 起广播） */
  CHANGED: "collaboration-room:changed",
  /** 成员 turn 流式正文增量（独立通道，避免走 CHANGED 全量刷新） */
  TEXT_DELTA: "collaboration-room:text-delta",
} as const;

/** 成员 turn 流式正文增量（累积文本，非单 token） */
export interface CollaborationTextDeltaPayload {
  roomId: string;
  runId: string;
  memberId: string;
  /** 截至当前的累积正文 */
  text: string;
  at: number;
}

/** 列出全部房间输入 */
export interface ListCollaborationRoomsInput {
  /** 是否包含已归档房间（默认 false，只看 active/paused/completed） */
  includeArchived?: boolean;
}

/** 将已有统一会话派生为协作室输入 */
export interface UpgradeFusionSessionInput {
  sessionId: string;
  title?: string;
  goal?: string;
}
export interface GetCollaborationRoomInput {
  /** 房间 ID */
  roomId: string;
}

/** 列出某房间消息输入 */
export interface ListCollaborationMessagesInput {
  /** 房间 ID */
  roomId: string;
}

/** 列出某房间成员输入 */
export interface ListCollaborationMembersInput {
  /** 房间 ID */
  roomId: string;
}

/** 追加成员输入（Stage 3）；复用 CreateCollaborationMemberInput 字段，加 roomId */
export type AddCollaborationMemberInput = {
  /** 房间 ID */
  roomId: string;
} & CreateCollaborationMemberInput;

/** 软删除成员输入 */
export type RemoveCollaborationMemberChannelInput =
  RemoveCollaborationMemberInput;

/** 列出某房间 run 输入（Stage 2） */
export interface ListCollaborationRunsInput {
  /** 房间 ID */
  roomId: string;
}

/** 取消某 run 输入（Stage 2） */
export interface CancelCollaborationRunInput {
  /** 房间 ID */
  roomId: string;
  /** run ID */
  runId: string;
}

/** 列出某房间全部 A2A 信箱信封输入（S4） */
export interface ListCollaborationMailboxInput {
  /** 房间 ID */
  roomId: string;
}

/** 继续一次 A2A 深度停止输入（S4.5） */
export interface ContinueCollaborationDepthStopInput {
  /** 房间 ID（校验信封归属，防跨房间继续） */
  roomId: string;
  /** 已达深度上限的停止信封 ID */
  envelopeId: string;
}

/** 继续一次 A2A 深度停止结果（与 CollaborationRoomService.continueDepthStop 一致） */
export type ContinueCollaborationDepthStopResult =
  { ok: true; envelopeId: string } | { ok: false; reason: string };

/** 列出某房间全部轻量 room task 输入（S5 面板） */
export interface ListCollaborationRoomTasksInput {
  /** 房间 ID */
  roomId: string;
}

/** 列出某房间全部产物输入（S5 面板） */
export interface ListCollaborationArtifactsInput {
  /** 房间 ID */
  roomId: string;
}

/** 预览产物文本输入（S5 面板）：渲染层只传 artifactId，路径由宿主反查记录后安全解析 */
export interface ReadCollaborationArtifactInput {
  /** 房间 ID（校验产物归属，防跨房间预览） */
  roomId: string;
  /** 产物 ID */
  artifactId: string;
}

/** 下载某房间产物输入；绝对目标路径只在主进程保存对话框内产生。 */
export interface DownloadCollaborationArtifactInput {
  roomId: string;
  artifactId: string;
  actorUserId?: string;
}

/** 下载结果；取消保存对话框不是错误。 */
export type DownloadCollaborationArtifactResult =
  | { ok: true; path: string; relativePath: string }
  | { ok: true; canceled: true; relativePath: string }
  | { ok: false; reason: string };
/** 显式导入个人工作区输入；绝对源路径只在主进程目录选择器内产生。 */
export interface ImportCollaborationWorkspaceResult {
  ok: true;
  files: number;
  skipped: number;
  bytes: number;
}
/** 导入失败结果。 */
export interface ImportCollaborationWorkspaceFailure {
  ok: false;
  reason: string;
}
export type ImportCollaborationWorkspaceResponse =
  | ImportCollaborationWorkspaceResult
  | ImportCollaborationWorkspaceFailure;
/** 列出某房间的用户审批请求。 */
export interface ListCollaborationUserApprovalsInput {
  roomId: string;
}

/** 解决某房间的用户审批请求。 */
export interface ResolveCollaborationUserApprovalInput {
  roomId: string;
  requestId: string;
  decision: "approved" | "denied";
  response?: string;
}

export type ResolveCollaborationUserApprovalResult =
  | { ok: true; request: CollaborationUserApprovalRequest; runId?: string }
  | { ok: false; reason: string };

/** 列出某房间的可观察「待确认续跑」项输入（P2-1）。 */
export interface ListCollaborationContinuationsInput {
  /** 房间 ID */
  roomId: string;
}

/** 列出某房间的可观察「待确认续跑」项结果（P2-1，纯函数派生）。 */
export type ListCollaborationContinuationsResult =
  LocalCollaborationContinuationItem[];

/** 确认继续一个 blocked run 输入（P2-1）。 */
export interface ConfirmResumeBlockedRunInput {
  /** 房间 ID（校验 run 归属，防跨房间续跑） */
  roomId: string;
  /** 仍处于 blocked 状态的 run ID */
  runId: string;
  /** 调用方幂等键；同键重复调用返回同一 newRunId */
  idempotencyKey?: string;
}

/**
 * 确认继续一个 blocked run 结果（与 CollaborationRoomService.confirmResumeBlockedRun 一致）。
 *
 * 成功返回新 run 的 id（新 turn、新 fence；旧 run 仍保持 blocked，不复活旧 fence）；
 * 失败（房间未激活 / run 不存在或非 blocked / 成员已移除 / 触发消息已删 / 幂等冲突）返回
 * `{ ok: false, reason }`，不抛错。
 */
export type ConfirmResumeBlockedRunResult =
  | { ok: true; newRunId: string }
  | { ok: false; reason: string };

// ===== P2-UX 桥接：明示进房 / 明示退出 / 按需读原史（14-SESSION-COLLAB-BRIDGE-SPEC） =====
// userConfirmed 必须由 renderer 传入、主进程再校验；AbortSignal 不可跨 IPC 序列化，
// 故 IPC 输入不含 signal（服务层自行接 AbortController／IPC 层不传）。

/** 明示进房 IPC 输入（14 §1：禁止静默自动升，须用户确认）。 */
export interface EnterCollaborationWithBridgeInput {
  /** 来源单会话 ID（升级后房间 sourceSessionId = 该值） */
  sessionId: string;
  /** 必须为 true；否则主进程抛 USER_CONFIRM_REQUIRED */
  userConfirmed: true;
  /** 可选房间标题；缺省走 upgradeFusionSession 既定派生 */
  title?: string;
  /** 用户/UI 可选短目标，优先进 brief.goal */
  goalHint?: string;
}

/** 明示进房结果。brief 已写入房间 goal + 系统消息（前情提要）。 */
export interface EnterCollaborationWithBridgeResult {
  /** 协作室房间 ID */
  roomId: string;
  /** 来源单会话 ID */
  sourceSessionId: string;
  /** 精炼后的进房前情提要（已过预算裁剪） */
  brief: SessionToRoomBrief;
  /** brief 来源：'llm' 调用成功 / 'heuristic' fail-closed 兜底（含幂等复用） */
  briefSource: "llm" | "heuristic";
  /** true 表示命中幂等复用（已有 fusionRoomId 且房间存在），未重新精炼 */
  reusedExistingRoom: boolean;
}

/** 明示退出 IPC 输入（14 §1：退出须用户确认，勿静默）。 */
export interface ExitCollaborationWithBridgeInput {
  /** 来源单会话 ID */
  sessionId: string;
  /** 必须为 true；否则主进程抛 USER_CONFIRM_REQUIRED */
  userConfirmed: true;
}

/** 明示退出结果。handoff 已写回原 session 面板；房间转 paused、fusionRoomId 清空。 */
export interface ExitCollaborationWithBridgeResult {
  /** 协作室房间 ID（已 paused，保留历史） */
  roomId: string;
  /** 来源单会话 ID */
  sourceSessionId: string;
  /** 精炼后的回写摘要（已过预算裁剪） */
  handoff: RoomToSessionHandoff;
  /** handoff 来源：'llm' / 'heuristic' */
  handoffSource: "llm" | "heuristic";
}

/**
 * 按需读原 session 摘录 IPC 输入。复用契约层 {@link SourceSessionExcerptRequest} 形状，
 * 追加 `alreadyUsedThisTurnTokens`（单轮累计预算，IPC 层透传给服务层预算校验）。
 */
export interface ReadSourceSessionExcerptInput extends SourceSessionExcerptRequest {
  /** 本轮已用 token 预算（缺省 0）；服务层据此校验单轮累计硬顶 */
  alreadyUsedThisTurnTokens?: number;
}

/** 按需读原史 IPC 结果 = 契约层 {@link SourceSessionExcerptResult}（预算耗尽时主进程抛稳定错误）。 */
export type ReadSourceSessionExcerptResult = SourceSessionExcerptResult;


/**
 * 预览产物文本结果（与 CollaborationRoomService.readArtifact 一致）。
 *
 * 成功返回当前盘上文件经 UTF-8 解码的文本（按 COLLABORATION_ARTIFACT_MAX_CONTENT_BYTES
 * 上限截断并置 truncated）、产物记录里的 relativePath / sha256，以及盘上文件的实际字节数。
 * sha256 取自产物审计记录（发布时按实际写入字节求得），仅作展示与比对，不据其阻断预览。
 */
export type ReadCollaborationArtifactResult =
  | {
      ok: true;
      artifactId: string;
      relativePath: string;
      content: string;
      /** 盘上文件实际字节数（可能大于返回 content 的字节数，当 truncated=true） */
      byteSize: number;
      /** 产物审计记录里的 sha256（hex），供面板展示短码 */
      sha256: string;
      /** 盘上文件超过预览上限时被截断 */
      truncated: boolean;
    }
  | { ok: false; reason: string };

/**
 * 房间数据变更事件 payload（main → renderer，Stage 2 起广播）
 *
 * 渲染层收到后重新 LIST/GET/LIST_MESSAGES/LIST_MEMBERS/LIST_RUNS 该房间即可，
 * 不依赖 kind 做增量更新（payload 仅用于日志/过滤）。
 */
export interface CollaborationRoomChangedPayload {
  /** 发生变更的房间 ID */
  roomId: string;
  /** 变更类型 */
  kind:
    | "created"
    | "updated"
    | "archived"
    | "message-appended"
    | "member-message-appended"
    | "run-started"
    | "run-finished"
    | "run-cancelled"
    | "run-awaiting-peer"
    | "run-awaiting-user"
    | "mailbox-updated"
    | "run-continued";
  /** 发生时间戳 */
  at: number;
}

// ===== 复用领域输入类型作为 IPC payload =====
// 创建/更新/追加消息的 IPC 输入与领域输入完全一致，直接复用，避免重复定义。
// 见 ./collaboration-room.ts 中的：
//   - CreateCollaborationRoomInput   → CREATE
//   - UpdateCollaborationRoomInput    → UPDATE
//   - AppendCollaborationUserMessageInput → APPEND_USER_MESSAGE
//
// 返回类型：
//   - LIST              → CollaborationRoom[]
//   - CREATE            → CollaborationRoom
//   - GET               → CollaborationRoom | null
//   - UPDATE            → CollaborationRoom
//   - LIST_MESSAGES     → CollaborationMessage[]
//   - APPEND_USER_MESSAGE → CollaborationMessage
//   - LIST_MEMBERS      → CollaborationMember[]
//   - ADD_MEMBER        → CollaborationMember
//   - LIST_RUNS         → CollaborationRun[]
//   - CANCEL_RUN        → CollaborationRun | null
//   - LIST_MAILBOX      → CollaborationMailboxEnvelope[]
//   - CONTINUE_DEPTH_STOP → ContinueCollaborationDepthStopResult
//   - LIST_ROOM_TASKS    → CollaborationRoomTask[]
//   - CREATE_ROOM_TASK   → CollaborationRoomTask
//   - UPDATE_ROOM_TASK   → CollaborationRoomTask
//   - LIST_ARTIFACTS     → CollaborationArtifact[]
//   - LIST_USER_APPROVALS → CollaborationUserApprovalRequest[]
//   - RESOLVE_USER_APPROVAL → ResolveCollaborationUserApprovalResult
//   - LIST_CONTINUATIONS  → ListCollaborationContinuationsResult (P2-1)
//   - CONFIRM_RESUME_BLOCKED → ConfirmResumeBlockedRunResult (P2-1)
//   - READ_ARTIFACT      → ReadCollaborationArtifactResult
//   - ENTER_WITH_BRIDGE  → EnterCollaborationWithBridgeResult (P2-UX 桥接)
//   - EXIT_WITH_BRIDGE   → ExitCollaborationWithBridgeResult (P2-UX 桥接)
//   - READ_SOURCE_EXCERPT → ReadSourceSessionExcerptResult (P2-UX 桥接；预算耗尽抛稳定错误)

/** 重新导出领域输入类型，便于 handler / preload / 渲染层统一引用 */
export type {
  CreateCollaborationRoomInput,
  UpdateCollaborationRoomInput,
  UpdateCollaborationMemberInput,
  RemoveCollaborationMemberInput,
  AppendCollaborationUserMessageInput,
  CreateCollaborationRoomTaskInput,
  UpdateCollaborationRoomTaskInput,
  InviteCollaborationHumanMemberInput,
  JoinCollaborationHumanMemberInput,
  LeaveCollaborationHumanMemberInput,
  RemoveCollaborationHumanMemberInput,
  SetCollaborationBotOwnerConsentInput,
  CollaborationRoom,
  CollaborationMember,
  CollaborationMessage,
  CollaborationRun,
  CollaborationRoomTask,
  CollaborationArtifact,
  CollaborationUserApprovalRequest,
  BoardProjectedTask,
  BoardProjectedSummary,
};
