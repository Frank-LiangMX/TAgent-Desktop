/**
 * Collaboration Room（Agent 协作室）相关类型定义
 *
 * 一个由用户、协调者和多个独立 Agent 组成的持久聊天室。本文件定义领域实体与状态枚举；
 * Stage 1 仅落地 room/member/message 的最小可用模型与 CRUD，run/mailbox/task 为
 * 类型 + 状态枚举占位，运行时（MemberBackendAdapter / A2A mailbox / 调度器）留到 S2+。
 *
 * 设计参考：
 * - docs/plans/agent-collaboration-room/00-MASTER.md
 * - docs/plans/agent-collaboration-room/02-RUNTIME-A2A-SPEC.md §2（实体字段契约）
 * - docs/decisions/ADR-0007-agent-collaboration-room.md
 */

// ===== 房间状态 =====

/**
 * 协作室房间状态机
 * - active：活跃，可发消息、（S2+）可启动 run
 * - paused：暂停，不再启动新 run；已运行 turn 可完成（Stage 1 仅作标记）
 * - archived：归档，停止调度并从活跃列表移除；消息和产物保留
 * - completed：已完成（终态）
 */
export type CollaborationRoomStatus = 'active' | 'paused' | 'archived' | 'completed'

// ===== 成员相关状态 =====

/** 成员后端类型（成员的执行后端，S2+ 由 MemberBackendAdapter 解释） */
export type CollaborationMemberBackend = 'pi' | 'channel' | 'cli'

/** 成员权限档位（room 上限与 member profile 的交集） */
export type CollaborationPermissionProfile = 'read-only' | 'workspace-write'

/**
 * 协作室成员状态机（02-RUNTIME-A2A-SPEC §3）
 *
 * Stage 1 不运行 Agent，成员创建后停留在 'offline'/'idle'；其余状态为 S2+ 占位。
 */
export type CollaborationMemberStatus =
  | 'offline'
  | 'idle'
  | 'queued'
  | 'running'
  | 'awaiting_peer'
  | 'awaiting_user'
  | 'blocked'
  | 'failed'
  | 'paused'
  | 'done'

// ===== 消息相关类型 =====

/** 消息作者类型 */
export type CollaborationMessageAuthorType = 'user' | 'member' | 'system'

/**
 * 消息种类
 * - chat：普通发言（用户或成员）
 * - a2a_request / a2a_reply：A2A 请求/回复（S4+）
 * - task_event：任务事件（S5+）
 * - artifact：产物发布（S5+）
 * - warning：系统警告
 *
 * Stage 1 只产生 'chat'（用户消息）与少量 'system' 消息。
 */
export type CollaborationMessageKind =
  | 'chat'
  | 'a2a_request'
  | 'a2a_reply'
  | 'task_event'
  | 'artifact'
  | 'warning'

/** 消息可见范围 */
export type CollaborationMessageVisibility = 'room' | 'participants' | 'user_only'

// ===== Run / Mailbox / RoomTask 占位状态枚举（S2+ 运行时用） =====

/** Run 状态机（02-RUNTIME-A2A-SPEC §2.4），Stage 2 起产生真实 run */
export type CollaborationRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_peer'
  | 'awaiting_user'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'blocked'

/** 判断是否为合法 run 状态 */
export function isCollaborationRunStatus(value: unknown): value is CollaborationRunStatus {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'awaiting_peer' ||
    value === 'awaiting_user' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'blocked'
  )
}

/** Mailbox 信封状态（02-RUNTIME-A2A-SPEC §2.5），Stage 1 不产生信箱 */
export type CollaborationMailboxState = 'pending' | 'delivered' | 'answered' | 'cancelled' | 'expired'

/** Mailbox 信封类型 */
export type CollaborationMailboxType = 'message' | 'question' | 'reply' | 'handoff'

/** 轻量 room task 状态（无看板时用，S5+） */
export type CollaborationRoomTaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'

// ===== 辅助类型 =====

/**
 * 房间预算（02-RUNTIME-A2A-SPEC §9）
 *
 * 任一上限达到即 fail closed。Stage 1 仅记录，不强制。
 */
export interface CollaborationRoomBudget {
  /** 单根消息最大 Agent turns（可选） */
  maxTurns?: number
  /** 单根消息最大墙钟时长 ms（可选） */
  maxWallTimeMs?: number
  /** 单根消息最大用量 token（可选） */
  maxUsageTokens?: number
}

/**
 * 角色快照（02-RUNTIME-A2A-SPEC §2.2）
 *
 * 必须落快照，避免角色库更新后历史行为被无声改写。
 */
export interface CollaborationRoleSnapshot {
  /** 角色 ID（角色库引用，可选） */
  roleId?: string
  /** 角色显示名（快照） */
  displayName: string
  /** 角色职责描述（快照） */
  description?: string
  /** 角色专属 system prompt 快照（创建成员时从角色库复制，避免库更新改写历史行为） */
  systemPrompt?: string
}

/**
 * 成员能力标识（02-RUNTIME-A2A-SPEC §12，MemberBackendAdapter.capabilities()）
 *
 * Stage 1 仅定义形状，创建静态成员时不要求填充；S2+ 由真实 probe 填充。
 */
export interface CollaborationMemberCapabilities {
  /** 是否支持原生 resume（CLI/SDK 原生 session/thread id） */
  supportsResume: boolean
  /** 是否支持运行中实时输入（长驻双工） */
  supportsLiveInput: boolean
  /** 是否支持工具桥接（MCP/host bridge A2A 工具） */
  supportsToolBridge: boolean
  /** 是否支持结构化事件 */
  supportsStructuredEvents: boolean
}

/** 单次 run 用量记录（最小） */
export interface CollaborationUsageRecord {
  /** 输入 token */
  inputTokens?: number
  /** 输出 token */
  outputTokens?: number
  /** 总 token */
  totalTokens?: number
  /** 墙钟时长 ms */
  wallTimeMs?: number
}

/** 序列化运行错误（最小） */
export interface CollaborationSerializedRunError {
  /** 错误消息 */
  message: string
  /** 错误码（可选） */
  code?: string
  /** 堆栈（可选） */
  stack?: string
}

// ===== 成员后端适配器（02-RUNTIME-A2A-SPEC §12，Stage 2 简化版） =====

/**
 * 一次成员 turn 的输入（宿主组装，不含任何安全字段模型可伪造）。
 *
 * Stage 2 简化：上下文投影为已拼好的 systemPrompt + prompt 两个字符串（近期对话 +
 * 触发消息），不实现完整 §7 投影（角色快照/摘要/信箱投影留 S3+）。
 */
export interface MemberTurnInput {
  /** 房间 ID */
  roomId: string
  /** 成员 ID */
  memberId: string
  /** run ID */
  runId: string
  /** 触发消息 ID */
  triggerMessageId: string
  /** 成员绑定的渠道 ID（缺省时 adapter 取第一个 enabled 外部渠道） */
  channelId?: string
  /** 成员绑定的模型 ID（缺省时 adapter 取渠道默认模型） */
  modelId?: string
  /** 已组装的 system prompt（角色 + 房间目标 + 规则） */
  systemPrompt: string
  /** 已组装的 user prompt（近期对话 + 触发消息） */
  prompt: string
  /** 取消信号；abort 即代表用户取消，runTurn 应回抛错 */
  signal: AbortSignal
  /** 可选流式增量回调（S2 暂不接 renderer，留 S3+） */
  onTextDelta?: (delta: string) => void
}

/** 一次成员 turn 的结果 */
export interface MemberTurnResult {
  /** 成员回复文本 */
  text: string
  /** 用量（可选） */
  usage?: CollaborationUsageRecord
}

/**
 * 成员后端适配器接口（02-RUNTIME-A2A-SPEC §12）。
 *
 * Stage 2 简化：`runTurn` 返回 `Promise<MemberTurnResult>` 而非 `AsyncIterable<MemberEvent>`，
 * 一次 turn 真实调用外部渠道模型并返回正文。S3+ 再按需升级为流式事件枚举。
 * 实现见 apps/electron/src/main/lib/collaboration/member-backend-adapter.ts。
 */
export interface MemberBackendAdapter {
  /** 后端能力（S2 默认全 false：无 resume/工具/实时输入） */
  capabilities(): CollaborationMemberCapabilities
  /** 执行一次 turn；signal abort 抛错代表取消 */
  runTurn(input: MemberTurnInput): Promise<MemberTurnResult>
}

// ===== 实体：Room =====

/**
 * 协作室房间（collaboration_rooms 的一行）
 *
 * Stage 1 持久化为 JSON（config 目录下 collaboration/），重启后恢复。
 */
export interface CollaborationRoom {
  /** 房间 ID，格式 cr_xxxx */
  id: string
  /** 房间名 */
  title: string
  /** 房间目标 */
  goal: string
  /** 绑定工作区 ID（可选，空白团队可留空） */
  workspaceId?: string
  /** 协调者成员 ID（创建静态成员后回填；空白团队为空字符串） */
  coordinatorMemberId: string
  /** 房间状态 */
  status: CollaborationRoomStatus
  /** 房间内总并发 run 上限（默认 3） */
  maxConcurrentRuns: number
  /** A2A 跨成员深度上限（默认 4，硬上限 10） */
  maxA2ADepth: number
  /** 房间预算 */
  budget: CollaborationRoomBudget
  /** 附加看板 ID（可选，S5+） */
  attachedBoardId?: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
  /** 归档时间戳（status === 'archived' 时） */
  archivedAt?: number
}

// ===== 实体：Member =====

/**
 * 协作室成员（collaboration_members 的一行）
 *
 * 逻辑身份持久，物理进程按 turn 短命（S2+）。Stage 1 为静态身份，不执行。
 */
export interface CollaborationMember {
  /** 成员 ID，格式 cm_xxxx */
  id: string
  /** 所属房间 ID */
  roomId: string
  /** 显示名 */
  displayName: string
  /**
   * 历史显示名别名（改名后仍能被 @旧名 命中）。
   * 当前 displayName 始终优先；若房间里另一成员占用了该名，别名不再生效。
   */
  mentionAliases?: string[]
  /** 绑定角色库 ID（可选） */
  roleId?: string
  /** 角色快照（避免角色库更新后历史被改写） */
  roleSnapshot: CollaborationRoleSnapshot
  /** 执行后端 */
  backend: CollaborationMemberBackend
  /** channel 后端渠道 ID（backend === 'channel' 时） */
  channelId?: string
  /** 模型 ID（pi/channel 后端） */
  modelId?: string
  /** CLI worker ID（backend === 'cli' 时） */
  cliWorkerId?: string
  /** 稳定逻辑会话 ID（每成员独立上下文的 key） */
  logicalSessionId: string
  /** 后端原生 resume token（仅保存 CLI/SDK 明确支持的，S2+） */
  backendResumeToken?: string
  /** 权限档位 */
  permissionProfile: CollaborationPermissionProfile
  /** 后端能力（S2+ 由 probe 填充，Stage 1 默认全 false） */
  capabilities: CollaborationMemberCapabilities
  /** 成员状态 */
  status: CollaborationMemberStatus
  /** 成员滚动摘要（S2+） */
  summary?: string
  /** 是否为协调者 */
  isCoordinator: boolean
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

// ===== 实体：Message =====

/**
 * 协作室消息（collaboration_messages 的一行）
 *
 * 02-RUNTIME-A2A-SPEC §2.3 字段契约。Stage 1 只产生用户消息
 * （authorType='user'、kind='chat'）与少量系统消息。
 */
export interface CollaborationMessage {
  /** 消息 ID，格式 msg_xxxx */
  id: string
  /** 所属房间 ID */
  roomId: string
  /** 作者类型 */
  authorType: CollaborationMessageAuthorType
  /** 作者 ID（user 类型为用户标识，member 类型为成员 ID，system 为 'system'） */
  authorId: string
  /** 消息种类 */
  kind: CollaborationMessageKind
  /** 文本内容 */
  content: string
  /** 可见范围 */
  visibility: CollaborationMessageVisibility
  /** 目标成员 ID 列表（@点名；空表示投递协调者/房间公开） */
  targetMemberIds: string[]
  /** 回复的消息 ID（可选） */
  replyToMessageId?: string
  /** 根消息 ID（因果链根，无根时等于自身） */
  rootMessageId: string
  /** 直接父事件 ID（因果链，可选） */
  causationId?: string
  /** 关联 run ID（可选，S2+） */
  runId?: string
  /** 关联 task ID（可选，S5+） */
  taskId?: string
  /** A2A 跨成员深度（默认 0） */
  depth: number
  /** 创建时间戳 */
  createdAt: number
}

// ===== 实体占位：Run / Mailbox / RoomTask（S2+ 运行时，Stage 1 不读写） =====

/**
 * 协作室 run（collaboration_runs 的一行，S2+）
 *
 * 一次成员 turn 的执行记录。Stage 1 不产生；Stage 2 起由 appendUserMessage 触发，
 * 状态机 queued → running → done | failed | cancelled。
 */
export interface CollaborationRun {
  /** run ID，格式 run_xxxx */
  id: string
  /** 所属房间 ID */
  roomId: string
  /** 执行成员 ID */
  memberId: string
  /** 触发消息 ID */
  triggerMessageId: string
  /**
   * 幂等键：`{triggerMessageId}:{memberId}`（见 collaborationRunIdempotencyKey）。
   *
   * 同一触发消息对同一成员只产生一个 run，无论触发多少次（02-RUNTIME-A2A-SPEC §8）。
   * 重启恢复时不据此自动重放（避免重复副作用），仅用于入队去重。
   */
  idempotencyKey: string
  /** 关联 task ID（可选） */
  taskId?: string
  /** run 状态 */
  status: CollaborationRunStatus
  /** 尝试次数 */
  attempt: number
  /** 开始时间戳 */
  startedAt?: number
  /** 完成时间戳 */
  finishedAt?: number
  /** 用量 */
  usage?: CollaborationUsageRecord
  /** 错误（status === 'failed' 时；code='INTERRUPTED' 表示重启时发现的假 running） */
  error?: CollaborationSerializedRunError
}

/** A2A 信箱信封（collaboration_mailbox 的一行，S4+） */
export interface CollaborationMailboxEnvelope {
  /** 信封 ID */
  id: string
  /** 所属房间 ID */
  roomId: string
  /** 发送成员 ID */
  fromMemberId: string
  /** 接收成员 ID */
  toMemberId: string
  /** 信封类型 */
  type: CollaborationMailboxType
  /** 关联 request ID（reply 时引用原 request） */
  requestId?: string
  /** 载荷文本 */
  payload: string
  /** 根消息 ID */
  rootMessageId: string
  /** 直接父事件 ID */
  causationId: string
  /** A2A 深度 */
  depth: number
  /** 信封状态 */
  state: CollaborationMailboxState
  /** 创建时间戳 */
  createdAt: number
  /** 过期时间戳（可选） */
  expiresAt?: number
}

/** 轻量 room task（无看板时用，S5+） */
export interface CollaborationRoomTask {
  /** task ID */
  id: string
  /** 所属房间 ID */
  roomId: string
  /** 任务标题 */
  title: string
  /** 任务描述 */
  body?: string
  /** 负责成员 ID（可选） */
  assigneeMemberId?: string
  /** 状态 */
  status: CollaborationRoomTaskStatus
  /** 依赖任务 ID 列表 */
  dependsOnTaskIds?: string[]
  /** 验收标准 */
  acceptanceCriteria?: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

// ===== 默认值与上限（02-RUNTIME-A2A-SPEC §9） =====

/** 房间默认最大并发 run 数 */
export const COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS = 3

/** A2A 默认深度上限 */
export const COLLABORATION_ROOM_DEFAULT_MAX_A2A_DEPTH = 4

/** A2A 硬深度上限（Agent 不能自行提高） */
export const COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH = 10

/** 房间最大成员数（含协调者，MVP 1–6） */
export const COLLABORATION_ROOM_MAX_MEMBERS = 6

/** 房间 ID 前缀 */
export const COLLABORATION_ROOM_ID_PREFIX = 'cr_'
/** 成员 ID 前缀 */
export const COLLABORATION_MEMBER_ID_PREFIX = 'cm_'
/** 消息 ID 前缀 */
export const COLLABORATION_MESSAGE_ID_PREFIX = 'msg_'
/** 逻辑会话 ID 前缀 */
export const COLLABORATION_LOGICAL_SESSION_ID_PREFIX = 'ls_'
/** run ID 前缀 */
export const COLLABORATION_RUN_ID_PREFIX = 'run_'

/**
 * 计算 run 幂等键：同一触发消息对同一成员只产生一个 run。
 *
 * 用于 appendUserMessage 触发入队时去重，以及重启恢复时识别「同一消息已有 run」。
 * 不含时间戳，纯由 (triggerMessageId, memberId) 决定，保证跨调用稳定。
 */
export function collaborationRunIdempotencyKey(triggerMessageId: string, memberId: string): string {
  return `${triggerMessageId}:${memberId}`
}

/**
 * A2A continuation 幂等键：同一 request 对提问者只唤醒一次新 turn。
 *
 * 02-RUNTIME-A2A-SPEC §6：B 回复后，宿主把 reply 加入 A 的 continuation。
 * 必须含 requestId，避免同一 reply 重复唤醒（S4-3）。
 */
export function collaborationContinuationIdempotencyKey(requestId: string, memberId: string): string {
  return `a2a-continue:${requestId}:${memberId}`
}

// ===== Mention 解析（Stage 3） =====

/** @all 特殊 mention（忽略大小写）：路由到房间全部成员（含协调者） */
export const COLLABORATION_MENTION_ALL = 'all'

/** 匹配 @token（非空白、非 @ 的连续字符）；用 matchAll 逐个扫描 */
const MENTION_REGEX = /@([^\s@]+)/gu
/** @token 末尾常见标点（中英文），匹配成员名前剥掉，避免「@开发。」误判 */
const MENTION_TRAILING_PUNCT = /[.,;:!?，。；！？、）》]+$/u

/**
 * 从用户消息文本解析 @mention，返回命中的成员 ID 列表（按出现顺序去重）。
 *
 * - `@all`（忽略大小写）→ 全部成员（含协调者；即全部 CollaborationMember）
 * - `@displayName` → 精确匹配成员 displayName（忽略大小写）
 * - `@旧名` → 匹配 mentionAliases（当前 displayName 占用同名时，当前名优先）
 * - `@memberId` → 精确匹配成员 id（程序化 / 稳定身份）
 * - 未命中任何 @ → 返回空数组（调用方据此回落协调者）
 *
 * 纯函数，不读 DB、不依赖时间；members 由调用方传入。Stage 3 路由的文本侧入口，
 * service.appendUserMessage 调它把 @displayName 解析为 targetMemberIds 落盘。
 *
 * 设计参考：00-MASTER §5「显式路由」、03-IMPLEMENTATION-PHASES §5「无点名消息路由协调者；多点名并行扇出」。
 */
export function parseCollaborationMentions(
  text: string,
  members: CollaborationMember[],
): string[] {
  if (!text) return []
  const byLowerName = new Map<string, CollaborationMember>()
  const byId = new Map<string, CollaborationMember>()
  // 别名先入；当前 displayName 后写入以覆盖同名冲突
  for (const m of members) {
    byId.set(m.id, m)
    for (const alias of m.mentionAliases ?? []) {
      const key = alias.trim().toLowerCase()
      if (key && !byLowerName.has(key)) byLowerName.set(key, m)
    }
  }
  for (const m of members) {
    byLowerName.set(m.displayName.toLowerCase(), m)
  }

  const matched: string[] = []
  const seen = new Set<string>()
  for (const raw of text.matchAll(MENTION_REGEX)) {
    const name = (raw[1] ?? '').replace(MENTION_TRAILING_PUNCT, '')
    if (!name) continue
    if (name.toLowerCase() === COLLABORATION_MENTION_ALL) {
      for (const m of members) {
        if (!seen.has(m.id)) {
          seen.add(m.id)
          matched.push(m.id)
        }
      }
      continue
    }
    const byName = byLowerName.get(name.toLowerCase())
    const byMemberId = byId.get(name)
    const m = byName ?? byMemberId
    if (m && !seen.has(m.id)) {
      seen.add(m.id)
      matched.push(m.id)
    }
  }
  return matched
}

/**
 * 改名时累积 mention 别名：旧名进别名，新名从别名里摘掉，去重保序。
 */
export function nextCollaborationMentionAliases(
  prev: string[] | undefined,
  oldName: string,
  newName: string,
): string[] {
  const oldN = oldName.trim()
  const newN = newName.trim()
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: string): void => {
    const key = value.trim().toLowerCase()
    if (!key || key === newN.toLowerCase() || seen.has(key)) return
    seen.add(key)
    out.push(value.trim())
  }
  for (const a of prev ?? []) push(a)
  if (oldN) push(oldN)
  return out
}

// ===== 创建/更新输入 =====

/** 创建静态成员的输入（Stage 1：仅身份，不执行） */
export interface CreateCollaborationMemberInput {
  /** 显示名 */
  displayName: string
  /** 绑定角色库 ID（可选） */
  roleId?: string
  /** 角色快照（可选，未提供则用 displayName 兜底） */
  roleSnapshot?: CollaborationRoleSnapshot
  /** 执行后端（默认 'channel'） */
  backend?: CollaborationMemberBackend
  /** channel 后端渠道 ID */
  channelId?: string
  /** 模型 ID */
  modelId?: string
  /** CLI worker ID */
  cliWorkerId?: string
  /** 权限档位（默认 'read-only'，Stage 1 保守） */
  permissionProfile?: CollaborationPermissionProfile
  /** 后端能力（可选，Stage 1 默认全 false） */
  capabilities?: Partial<CollaborationMemberCapabilities>
  /** 是否为协调者（默认 false） */
  isCoordinator?: boolean
}

/** 创建协作室房间的输入 */
export interface CreateCollaborationRoomInput {
  /** 房间名（必填，非空） */
  title: string
  /** 房间目标（可选） */
  goal?: string
  /** 绑定工作区 ID（可选） */
  workspaceId?: string
  /** 初始成员列表（可选，空白团队为空） */
  members?: CreateCollaborationMemberInput[]
  /** 房间内总并发 run 上限（可选，默认 3） */
  maxConcurrentRuns?: number
  /** A2A 跨成员深度上限（可选，默认 4） */
  maxA2ADepth?: number
  /** 房间预算（可选） */
  budget?: CollaborationRoomBudget
  /** 附加看板 ID（可选） */
  attachedBoardId?: string
}

/** 更新协作室成员的输入（改显示名 / 渠道 / 模型） */
export interface UpdateCollaborationMemberInput {
  /** 房间 ID（校验归属） */
  roomId: string
  /** 成员 ID */
  memberId: string
  /** 新显示名 */
  displayName?: string
  /**
   * 新渠道 ID。传空字符串表示解绑。
   * 换渠道且未同时传 modelId 时，service 清空 modelId，由 adapter 回落渠道默认模型。
   */
  channelId?: string
  /** 新模型 ID。传空字符串表示改回渠道默认。 */
  modelId?: string
}

/** 更新协作室房间的输入（rename / archive / pause / complete） */
export interface UpdateCollaborationRoomInput {
  /** 房间 ID */
  roomId: string
  /** 新标题（rename） */
  title?: string
  /** 新状态（archive / pause / complete） */
  status?: CollaborationRoomStatus
  /** 新目标 */
  goal?: string
  /** 新并发上限 */
  maxConcurrentRuns?: number
  /** 新 A2A 深度上限 */
  maxA2ADepth?: number
  /** 新预算 */
  budget?: CollaborationRoomBudget
}

/** 追加用户消息的输入（Stage 1：静态用户消息，不触发 Agent） */
export interface AppendCollaborationUserMessageInput {
  /** 房间 ID */
  roomId: string
  /** 消息文本 */
  content: string
  /** 目标成员 ID 列表（@点名，空表示房间公开/协调者） */
  targetMemberIds?: string[]
  /** 回复的消息 ID（可选） */
  replyToMessageId?: string
}

// ===== 校验与类型守卫 =====

/** 判断是否为合法房间状态 */
export function isCollaborationRoomStatus(value: unknown): value is CollaborationRoomStatus {
  return (
    value === 'active' ||
    value === 'paused' ||
    value === 'archived' ||
    value === 'completed'
  )
}

/** 判断是否为合法成员状态 */
export function isCollaborationMemberStatus(value: unknown): value is CollaborationMemberStatus {
  return (
    value === 'offline' ||
    value === 'idle' ||
    value === 'queued' ||
    value === 'running' ||
    value === 'awaiting_peer' ||
    value === 'awaiting_user' ||
    value === 'blocked' ||
    value === 'failed' ||
    value === 'paused' ||
    value === 'done'
  )
}

/**
 * 校验创建房间输入，返回错误消息列表（空数组表示通过）。
 *
 * Stage 1 service 在 createRoom 前调用；IPC handler 也可复用。
 */
export function validateCreateCollaborationRoomInput(
  input: CreateCollaborationRoomInput,
): string[] {
  const errors: string[] = []
  const title = input.title?.trim()
  if (!title) {
    errors.push('title 不能为空')
  } else if (title.length > 200) {
    errors.push('title 长度不能超过 200')
  }
  if (input.members) {
    if (input.members.length > COLLABORATION_ROOM_MAX_MEMBERS) {
      errors.push(`members 数量不能超过 ${COLLABORATION_ROOM_MAX_MEMBERS}`)
    }
    for (let i = 0; i < input.members.length; i++) {
      const m = input.members[i]
      if (!m || !m.displayName || m.displayName.trim() === '') {
        errors.push(`members[${i}].displayName 不能为空`)
      }
    }
  }
  if (
    input.maxConcurrentRuns !== undefined &&
    (input.maxConcurrentRuns < 1 || input.maxConcurrentRuns > 16)
  ) {
    errors.push('maxConcurrentRuns 须在 1–16')
  }
  if (
    input.maxA2ADepth !== undefined &&
    (input.maxA2ADepth < 1 || input.maxA2ADepth > COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH)
  ) {
    errors.push(`maxA2ADepth 须在 1–${COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH}`)
  }
  return errors
}
