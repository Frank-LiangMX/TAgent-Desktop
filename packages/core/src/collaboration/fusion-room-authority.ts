
import type {
  CollaborationHumanMemberStatus, CollaborationMessage, CollaborationMessageKind,
  CollaborationRoomEvent, CollaborationRoomEventType, CollaborationMemberBackend,
  CollaborationRoomTask, CollaborationRoomTaskStatus, CollaborationArtifact,
  CollaborationUserApprovalRequest, CollaborationUserApprovalStatus, CollaborationMailboxEnvelope,
  FusionHumanMember, RoomBotSeat, RoomWorkspace,
} from "@tagent/shared"
import { validateRoomWorkspace, transitionCollaborationRoomTaskStatus } from "@tagent/shared"

export type FusionAuthorityRoomStatus = "active" | "paused" | "archived"
export type FusionAuthorityErrorCode =
  | "NOT_FOUND" | "FORBIDDEN" | "INVALID_STATE" | "CONFLICT"
  | "LOCKED" | "CONSENT_REQUIRED"

export class FusionRoomAuthorityError extends Error {
  readonly code: FusionAuthorityErrorCode
  constructor(code: FusionAuthorityErrorCode, message: string) {
    super(message); this.name = "FusionRoomAuthorityError"; this.code = code
  }
}

export interface FusionUsageLedgerEntry {
  id: string; roomId: string; seatId: string; botOwnerUserId: string
  initiatedByUserId: string; providerAccountUserId?: string; modelId?: string
  inputTokens: number; outputTokens: number; costMicros: number; createdAt: number
}
export interface FusionWorkspaceFileVersion {
  relativePath: string; sha256: string; byteSize: number; version: number
  updatedByUserId: string; updatedAt: number
  /** 只有显式发布的版本才允许通过远程下载接口导出。 */
  downloadable?: boolean
  /** 删除保留 tombstone 以继续提供版本冲突保护；不代表物理文件存在。 */
  deleted?: boolean
}
export interface FusionWorkspaceLock {
  id: string; roomId: string; relativePath: string; ownerUserId: string
  baseSha256?: string; acquiredAt: number; expiresAt: number
}
export interface FusionRoomAuthoritySnapshot {
  roomId: string; ownerUserId: string; status: FusionAuthorityRoomStatus
  /** 房间元数据；旧快照缺失时由 authority 用 roomId/空字符串兼容恢复。 */
  title?: string; goal?: string
  humanMembers: FusionHumanMember[]; botSeats: RoomBotSeat[]
  botOwnerConsents: Record<string, boolean>; coordinatorSeatId?: string
  workspace: RoomWorkspace; messages: CollaborationMessage[]
  events: CollaborationRoomEvent[]; usage: FusionUsageLedgerEntry[]
  files: FusionWorkspaceFileVersion[]; locks: FusionWorkspaceLock[]; runs: FusionRoomRun[]
  tasks: import("@tagent/shared").CollaborationRoomTask[]
  artifacts: CollaborationArtifact[]
  approvals: CollaborationUserApprovalRequest[]
  mailbox: CollaborationMailboxEnvelope[]
}
export interface CreateFusionRoomAuthorityInput {
  roomId: string; ownerUserId: string; workspace: RoomWorkspace; title?: string; goal?: string; now?: number
}
export interface UpdateFusionRoomMetadataInput {
  actorUserId: string; roomId: string; title?: string; goal?: string; idempotencyKey?: string
}
export interface CreateFusionRoomTaskInput {
  actorUserId: string
  roomId: string
  task: Omit<CollaborationRoomTask, "id" | "roomId" | "version" | "createdAt" | "updatedAt" | "status"> & { status?: CollaborationRoomTaskStatus }
  idempotencyKey?: string
}
export interface UpdateFusionRoomTaskInput {
  actorUserId: string
  roomId: string
  taskId: string
  status?: CollaborationRoomTaskStatus
  title?: string
  description?: string
  assigneeMemberId?: string
  acceptanceCriteria?: string
  /** 仅作为任务更新审计说明，不改写任务字段。 */
  summary?: string
  runId?: string
  expectedVersion?: number
  idempotencyKey?: string
}
export interface PublishFusionArtifactInput {
  actorUserId: string
  roomId: string
  memberId: string
  relativePath: string
  content: string
  runId?: string
  taskId?: string
  summary?: string
  idempotencyKey?: string
}
export interface RequestFusionUserApprovalInput {
  actorUserId: string
  roomId: string
  memberId: string
  runId: string
  question: string
  reason?: string
  options?: string[]
  idempotencyKey?: string
}
export interface ResolveFusionUserApprovalInput {
  actorUserId: string
  roomId: string
  requestId: string
  decision: Exclude<CollaborationUserApprovalStatus, "pending">
  response?: string
  idempotencyKey?: string
}
export interface SendFusionMailboxInput {
  actorUserId: string
  roomId: string
  fromMemberId: string
  toMemberId: string
  runId: string
  type: "message" | "question" | "handoff"
  payload: string
  rootMessageId: string
  idempotencyKey?: string
}
export interface ReplyFusionMailboxInput {
  actorUserId: string
  roomId: string
  requestId: string
  runId: string
  answer: string
  idempotencyKey?: string
}
export interface SendFusionMailboxInput {
  actorUserId: string
  roomId: string
  fromMemberId: string
  toMemberId: string
  runId: string
  type: "message" | "question" | "handoff"
  payload: string
  rootMessageId: string
  idempotencyKey?: string
}
export interface ReplyFusionMailboxInput {
  actorUserId: string
  roomId: string
  requestId: string
  runId: string
  answer: string
  idempotencyKey?: string
}
export interface AppendFusionMessageInput {
  actorUserId: string; content: string; targetSeatIds?: string[]
  replyToMessageId?: string; idempotencyKey?: string
}
export interface AppendFusionMemberMessageInput {
  actorUserId: string; seatId: string; content: string
  kind?: CollaborationMessageKind; visibility?: "room" | "participants" | "user_only"
  targetSeatIds?: string[]; replyToMessageId?: string; rootMessageId?: string
  causationId?: string; runId?: string; depth?: number; idempotencyKey?: string
}
export interface AddFusionBotSeatInput {
  actorUserId: string; seat: RoomBotSeat; ownerConsent?: boolean
  idempotencyKey?: string
}
export interface AcquireFusionWorkspaceLockInput {
  actorUserId: string; relativePath: string; leaseMs?: number
  expectedSha256?: string; idempotencyKey?: string
}
export interface CommitFusionWorkspaceFileInput {
  actorUserId: string; lockId: string; relativePath: string; content: string
  expectedSha256?: string; summary?: string; idempotencyKey?: string
  /** 明确发布为可下载产物；默认 false，防止普通工作文件外泄。 */
  downloadable?: boolean
  /** 删除保留 tombstone 以继续提供版本冲突保护；不代表物理文件存在。 */
  deleted?: boolean
}
export interface DeleteFusionWorkspaceFileInput {
  actorUserId: string; lockId: string; relativePath: string
  expectedSha256?: string; idempotencyKey?: string
}
export interface MoveFusionWorkspaceFileInput {
  actorUserId: string; fromLockId: string; toLockId: string
  fromPath: string; toPath: string; expectedSha256?: string; idempotencyKey?: string
}export interface CommitFusionWorkspaceFilesInput {
  actorUserId: string
  files: Array<Omit<CommitFusionWorkspaceFileInput, "actorUserId" | "idempotencyKey">>
  idempotencyKey?: string
}
export interface RecordFusionUsageInput {
  actorUserId: string; seatId: string; inputTokens: number
  outputTokens: number; costMicros: number; providerAccountUserId?: string
  modelId?: string; idempotencyKey?: string
}
export interface FusionWorkspaceCommitResult {
  file: FusionWorkspaceFileVersion; event: CollaborationRoomEvent
}
export interface FusionWorkspaceDeleteResult {
  file: FusionWorkspaceFileVersion; event: CollaborationRoomEvent
}
export interface FusionWorkspaceMoveResult {
  fromFile: FusionWorkspaceFileVersion; toFile: FusionWorkspaceFileVersion; event: CollaborationRoomEvent
}export interface FusionWorkspaceBatchCommitResult {
  files: FusionWorkspaceFileVersion[]
  events: CollaborationRoomEvent[]
}
export type FusionRunBackend = CollaborationMemberBackend | "kscc"
export type FusionRunStatus = "running" | "awaiting_peer" | "awaiting_user" | "completed" | "failed" | "cancelled" | "blocked"
export interface FusionRoomRun {
  id: string; roomId: string; seatId: string; initiatedByUserId: string
  /** 触发本次 turn 的房间消息；continuation 会复用它建立上下文。 */
  triggerMessageId?: string
  backend: FusionRunBackend; fence: number; status: FusionRunStatus
  createdAt: number; updatedAt: number; finishedAt?: number; summary?: string
}
export interface StartFusionRunInput {
  actorUserId: string; seatId: string; backend: FusionRunBackend; triggerMessageId?: string
  idempotencyKey?: string
}
export interface AwaitFusionRunInput {
  actorUserId: string; runId: string; fence: number
  status: "awaiting_peer" | "awaiting_user"; summary?: string; idempotencyKey?: string
}
export interface FinishFusionRunInput {
  actorUserId: string; runId: string; fence: number
  status: Exclude<FusionRunStatus, "running" | "awaiting_peer" | "awaiting_user">; summary?: string
  idempotencyKey?: string
}

let authorityIdCounter = 0
const uniqueId = (): string => Date.now().toString(36) + "_" + (authorityIdCounter++).toString(36) + "_" + Math.random().toString(36).slice(2, 10)

const DEFAULT_LEASE_MS = 30_000
const MAX_LEASE_MS = 15 * 60 * 1000
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const MAX_FUSION_MESSAGE_BYTES = 256 * 1024
const assertFusionMessageSize = (content: string): void => {
  if (new TextEncoder().encode(content).byteLength > MAX_FUSION_MESSAGE_BYTES) {
    throw new FusionRoomAuthorityError("INVALID_STATE", "消息内容超过 256 KiB 限制")
  }
}
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
  0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
  0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
  0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const

function hashText(value: string): string {
  const bytes = Array.from(new TextEncoder().encode(value))
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while ((bytes.length + 8) % 64 !== 0) bytes.push(0)
  for (let shift = 56; shift >= 0; shift -= 8) {
    bytes.push(Math.floor(bitLength / 2 ** shift) & 0xff)
  }
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  const rightRotate = (value: number, amount: number): number =>
    (value >>> amount) | (value << (32 - amount))
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64).fill(0)
    for (let i = 0; i < 16; i++) {
      const base = offset + i * 4
      words[i] =
        (bytes[base]! << 24) |
        (bytes[base + 1]! << 16) |
        (bytes[base + 2]! << 8) |
        bytes[base + 3]!
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        rightRotate(words[i - 15]!, 7) ^
        rightRotate(words[i - 15]!, 18) ^
        (words[i - 15]! >>> 3)
      const s1 =
        rightRotate(words[i - 2]!, 17) ^
        rightRotate(words[i - 2]!, 19) ^
        (words[i - 2]! >>> 10)
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) | 0
    }
    let a = h[0]!; let b = h[1]!; let c = h[2]!; let d = h[3]!; let e = h[4]!; let f = h[5]!; let g = h[6]!; let hh = h[7]!
    for (let i = 0; i < 64; i++) {
      const sum1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (hh + sum1 + choose + SHA256_K[i]! + words[i]!) | 0
      const sum0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) | 0
      hh = g; g = f; f = e; e = (d + temp1) | 0
      d = c; c = b; b = a; a = (temp1 + temp2) | 0
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0
    h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0
    h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0
  }
  return h.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("")
}
const nowOf = (clock: () => number): number => {
  const value = clock(); return Number.isFinite(value) ? value : Date.now()
}
const activeHuman = (members: FusionHumanMember[], userId: string) =>
  members.find((item) => item.userId === userId && item.status === "active")
const normalizeRoomTitle = (value: string | undefined, fallback: string): string => {
  const title = value?.trim() || fallback.trim()
  if (!title) throw new FusionRoomAuthorityError("INVALID_STATE", "房间标题不能为空")
  if (title.length > 200) throw new FusionRoomAuthorityError("INVALID_STATE", "房间标题过长")
  return title
}
const normalizeRoomGoal = (value: string | undefined): string => {
  const goal = value?.trim() ?? ""
  if (goal.length > 4000) throw new FusionRoomAuthorityError("INVALID_STATE", "房间目标过长")
  return goal
}
const safePath = (value: string): string => {
  const raw = value.trim()
  if (!raw || raw.includes("\0") || raw.includes("\\") ||
      raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:/.test(raw)) {
    throw new FusionRoomAuthorityError("FORBIDDEN", "工作区路径必须是安全的相对路径")
  }
  const parts = raw.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new FusionRoomAuthorityError("FORBIDDEN", "工作区路径不能包含 .、.. 或空路径段")
  }
  return parts.join("/")
}
const assertCount = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new FusionRoomAuthorityError("INVALID_STATE", name + " 必须是非负整数")
  }
}

/**
 * Host-agnostic authoritative RoomSession core. A transport/database adapter
 * can persist getSnapshot() and broadcast the events returned by each action.
 */
export class FusionRoomAuthority {
  private state: FusionRoomAuthoritySnapshot
  constructor(
    input: CreateFusionRoomAuthorityInput | FusionRoomAuthoritySnapshot,
    private readonly clock: () => number = Date.now,
  ) {
    if ("events" in input && "messages" in input) {
      const restored = copy(input) as FusionRoomAuthoritySnapshot & { runs?: FusionRoomRun[] }
      this.state = { ...restored, title: restored.title?.trim() || restored.roomId, goal: restored.goal?.trim() ?? "", runs: restored.runs ?? [], tasks: restored.tasks ?? [], artifacts: restored.artifacts ?? [], approvals: restored.approvals ?? [], mailbox: restored.mailbox ?? [] }
      this.validateSnapshot(); return
    }
    const errors = validateRoomWorkspace(input.workspace)
    if (errors.length) throw new FusionRoomAuthorityError("INVALID_STATE", errors.join(";"))
    const now = input.now ?? nowOf(clock)
    const owner: FusionHumanMember = {
      id: "hm_" + uniqueId(), roomId: input.roomId, userId: input.ownerUserId,
      displayName: "房主", status: "active", joinedAt: now, updatedAt: now,
    }
    this.state = {
      roomId: input.roomId, ownerUserId: input.ownerUserId, status: "active",
      title: normalizeRoomTitle(input.title, input.roomId), goal: normalizeRoomGoal(input.goal),
      humanMembers: [owner], botSeats: [], botOwnerConsents: {},
      workspace: copy(input.workspace), messages: [], events: [], usage: [],
      files: [], locks: [], runs: [], tasks: [], artifacts: [], approvals: [], mailbox: [],
    }
    this.event("room.created", input.ownerUserId, input.roomId, {
      roomId: input.roomId, ownerUserId: input.ownerUserId,
      workspaceId: input.workspace.id, title: this.state.title, goal: this.state.goal,
    })
  }
  static fromSnapshot(snapshot: FusionRoomAuthoritySnapshot, clock = Date.now) {
    return new FusionRoomAuthority(snapshot, clock)
  }
  getSnapshot(): FusionRoomAuthoritySnapshot { return copy(this.state) }

  private validateSnapshot(): void {
    if (!this.state.roomId.trim() || !this.state.ownerUserId.trim()) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "RoomSession 身份字段不能为空")
    }
    const errors = validateRoomWorkspace(this.state.workspace)
    if (errors.length) throw new FusionRoomAuthorityError("INVALID_STATE", errors.join(";"))
    if (!activeHuman(this.state.humanMembers, this.state.ownerUserId)) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "房主必须是 active 成员")
    }
  }
  private member(userId: string): FusionHumanMember {
    const member = this.state.humanMembers.find((item) => item.userId === userId)
    if (!member) throw new FusionRoomAuthorityError("NOT_FOUND", "用户不是房间成员")
    return member
  }
  private active(userId: string): FusionHumanMember {
    const member = activeHuman(this.state.humanMembers, userId)
    if (!member) throw new FusionRoomAuthorityError("FORBIDDEN", "用户不是房间 active 成员")
    return member
  }
  private owner(userId: string): void {
    this.active(userId)
    if (userId !== this.state.ownerUserId) {
      throw new FusionRoomAuthorityError("FORBIDDEN", "只有房主可以执行该操作")
    }
  }
  private activeRoom(): void {
    if (this.state.status !== "active") {
      throw new FusionRoomAuthorityError("INVALID_STATE", "房间当前不接受新动作")
    }
  }
  private event(
    type: CollaborationRoomEventType, actorUserId: string, entityId: string,
    payload: Record<string, unknown>, idempotencyKey?: string,
  ): CollaborationRoomEvent {
    if (idempotencyKey) {
      const old = this.state.events.find((item) =>
        item.roomId === this.state.roomId && item.idempotencyKey === idempotencyKey)
      if (old) return copy(old)
    }
    const sequence = this.state.events.reduce((max, item) =>
      Math.max(max, item.sequence), 0) + 1
    const event: CollaborationRoomEvent = {
      id: "cre_" + uniqueId(), roomId: this.state.roomId, sequence,
      type, actorUserId, entityId, ...(idempotencyKey ? { idempotencyKey } : {}),
      payload: copy(payload), createdAt: nowOf(this.clock),
    }
    this.state.events.push(event); return copy(event)
  }
  private seat(seatId: string): RoomBotSeat {
    const seat = this.state.botSeats.find((item) =>
      item.id === seatId && item.status !== "removed")
    if (!seat) throw new FusionRoomAuthorityError("NOT_FOUND", "Bot 席位不存在或已移除")
    return seat
  }
  private canRun(seat: RoomBotSeat): void {
    if (seat.ownerUserId !== this.state.ownerUserId &&
        this.state.botOwnerConsents[seat.id] !== true) {
      throw new FusionRoomAuthorityError("CONSENT_REQUIRED", "Bot 所有人尚未授权该房间使用此 Bot")
    }
  }
  private purgeLocks(now: number): void {
    this.state.locks = this.state.locks.filter((item) => item.expiresAt > now)
  }
  private run(runId: string): FusionRoomRun {
    const run = this.state.runs.find((item) => item.id === runId)
    if (!run) throw new FusionRoomAuthorityError("NOT_FOUND", "Run does not exist")
    return run
  }
  private finishRunInternal(run: FusionRoomRun, status: Exclude<FusionRunStatus, "running">, actorUserId: string, summary?: string, idempotencyKey?: string): FusionRoomRun {
    if (run.status !== "running") return copy(run)
    const next = { ...run, status, updatedAt: nowOf(this.clock), finishedAt: nowOf(this.clock), ...(summary ? { summary } : {}) }
    this.state.runs = this.state.runs.map((item) => item.id === run.id ? next : item)
    const seat = this.state.botSeats.find((item) => item.id === run.seatId)
    if (seat?.status === "running") {
      this.state.botSeats = this.state.botSeats.map((item) =>
        item.id === seat.id ? { ...item, status: "idle" as const, updatedAt: nowOf(this.clock) } : item)
    }
    this.event("run.changed", actorUserId, run.id, {
      runId: run.id, seatId: run.seatId, status, fence: run.fence, backend: run.backend, summary,
    }, idempotencyKey)
    return copy(next)
  }
  private cancelRunsForSeat(seatId: string, actorUserId: string, reason: string): void {
    for (const run of this.state.runs.filter((item) => item.seatId === seatId && item.status === "running")) {
      this.finishRunInternal(run, "cancelled", actorUserId, reason)
    }
  }

  inviteHumanMember(actorUserId: string, userId: string, displayName: string): FusionHumanMember {
    this.activeRoom(); this.owner(actorUserId)
    const uid = userId.trim(), name = displayName.trim()
    if (!uid || !name) throw new FusionRoomAuthorityError("INVALID_STATE", "用户 ID 和显示名不能为空")
    const old = this.state.humanMembers.find((item) => item.userId === uid)
    if (old?.status === "active") throw new FusionRoomAuthorityError("CONFLICT", "用户已经在房间内")
    const now = nowOf(this.clock)
    const next: FusionHumanMember = old
      ? { ...old, displayName: name, status: "invited", updatedAt: now, leftAt: undefined }
      : { id: "hm_" + uniqueId(), roomId: this.state.roomId, userId: uid,
          displayName: name, status: "invited", joinedAt: now, updatedAt: now }
    this.state.humanMembers = this.state.humanMembers.filter((item) => item.userId !== uid).concat(next)
    this.event("human-member.changed", actorUserId, next.id, { userId: uid, displayName: name, status: "invited" })
    return copy(next)
  }

  acceptInvitation(userId: string): FusionHumanMember {
    this.activeRoom()
    const old = this.member(userId)
    if (old.status !== "invited") throw new FusionRoomAuthorityError("CONFLICT", "当前用户没有待接受邀请")
    const next = { ...old, status: "active" as const, updatedAt: nowOf(this.clock), leftAt: undefined }
    this.state.humanMembers = this.state.humanMembers.map((item) => item.id === old.id ? next : item)
    this.event("human-member.changed", userId, old.id, { userId, status: "active" })
    return copy(next)
  }

  leaveHumanMember(actorUserId: string): FusionHumanMember {
    this.activeRoom()
    const old = this.member(actorUserId)
    if (old.userId === this.state.ownerUserId) {
      throw new FusionRoomAuthorityError("FORBIDDEN", "房主必须先转移房间所有权")
    }
    if (old.status === "left" || old.status === "removed") {
      throw new FusionRoomAuthorityError("CONFLICT", "当前用户已经离开房间")
    }
    const next = {
      ...old,
      status: "left" as const,
      leftAt: nowOf(this.clock),
      updatedAt: nowOf(this.clock),
    }
    this.state.humanMembers = this.state.humanMembers.map((item) => item.id === old.id ? next : item)
    this.event("human-member.changed", actorUserId, old.id, {
      userId: actorUserId,
      status: "left",
    })
    return copy(next)
  }

  removeHumanMember(actorUserId: string, userId: string): FusionHumanMember {
    this.activeRoom()
    this.owner(actorUserId)
    const old = this.member(userId)
    if (old.userId === this.state.ownerUserId) {
      throw new FusionRoomAuthorityError("FORBIDDEN", "不能移除房主")
    }
    if (old.status === "removed") {
      throw new FusionRoomAuthorityError("CONFLICT", "用户已经被移除")
    }
    const next = {
      ...old,
      status: "removed" as const,
      leftAt: nowOf(this.clock),
      updatedAt: nowOf(this.clock),
    }
    this.state.humanMembers = this.state.humanMembers.map((item) => item.id === old.id ? next : item)
    this.event("human-member.changed", actorUserId, old.id, {
      userId,
      status: "removed",
    })
    return copy(next)
  }
  setPresence(actorUserId: string, status: Extract<CollaborationHumanMemberStatus, "active" | "offline">): FusionHumanMember {
    const old = this.member(actorUserId)
    if (old.status !== "active" && old.status !== "offline") {
      throw new FusionRoomAuthorityError("FORBIDDEN", "当前用户不能更新在线状态")
    }
    const next = { ...old, status, updatedAt: nowOf(this.clock) }
    this.state.humanMembers = this.state.humanMembers.map((item) => item.id === old.id ? next : item)
    this.event("human-member.changed", actorUserId, old.id, { userId: actorUserId, status })
    return copy(next)
  }

  addBotSeat(input: AddFusionBotSeatInput): RoomBotSeat {
    this.activeRoom()
    const seat = copy(input.seat)
    if (input.actorUserId !== this.state.ownerUserId && input.actorUserId !== seat.ownerUserId) {
      throw new FusionRoomAuthorityError("FORBIDDEN", "只有房主或 Bot 所有人可以加入 Bot")
    }
    this.active(input.actorUserId)
    if (seat.roomId !== this.state.roomId) throw new FusionRoomAuthorityError("FORBIDDEN", "Bot 席位不属于当前房间")
    if (this.state.botSeats.some((item) => item.botProfileId === seat.botProfileId && item.status !== "removed")) {
      throw new FusionRoomAuthorityError("CONFLICT", "同一 Bot 不能重复加入房间")
    }
    const coordinator = !this.state.botSeats.some((item) => item.status !== "removed" && item.isCoordinator)
    seat.isCoordinator = coordinator; seat.status = "idle"; seat.updatedAt = nowOf(this.clock)
    this.state.botSeats.push(seat)
    if (coordinator) this.state.coordinatorSeatId = seat.id
    this.state.botOwnerConsents[seat.id] =
      seat.ownerUserId === input.actorUserId && input.ownerConsent !== false
    this.event("bot-member.changed", input.actorUserId, seat.id, {
      botProfileId: seat.botProfileId, ownerUserId: seat.ownerUserId,
      status: seat.status, isCoordinator: seat.isCoordinator,
      ownerConsent: this.state.botOwnerConsents[seat.id],
    }, input.idempotencyKey)
    return copy(seat)
  }

  setBotOwnerConsent(actorUserId: string, seatId: string, consent: boolean): void {
    this.active(actorUserId)
    const seat = this.seat(seatId)
    if (seat.ownerUserId !== actorUserId) throw new FusionRoomAuthorityError("FORBIDDEN", "只有 Bot 所有人可以授权或撤回")
    this.state.botOwnerConsents[seatId] = consent
    if (!consent) this.cancelRunsForSeat(seatId, actorUserId, "Bot owner consent revoked")
    this.event("bot-member.changed", actorUserId, seatId, { ownerConsent: consent })
  }

  removeBotSeat(actorUserId: string, seatId: string): void {
    this.owner(actorUserId)
    const seat = this.seat(seatId), now = nowOf(this.clock)
    this.cancelRunsForSeat(seatId, actorUserId, "Bot seat removed")
    const removed = { ...seat, status: "removed" as const, removedAt: now, updatedAt: now, isCoordinator: false }
    this.state.botSeats = this.state.botSeats.map((item) => item.id === seat.id ? removed : item)
    if (seat.isCoordinator || this.state.coordinatorSeatId === seat.id) {
      const successor = this.state.botSeats.find((item) => item.status !== "removed")
      this.state.coordinatorSeatId = successor?.id
      this.state.botSeats = this.state.botSeats.map((item) =>
        item.status === "removed" ? { ...item, isCoordinator: false } :
        { ...item, isCoordinator: item.id === successor?.id })
    }
    this.event("bot-member.changed", actorUserId, seat.id, {
      status: "removed", successorSeatId: this.state.coordinatorSeatId,
    })
  }

  requestUserApproval(input: RequestFusionUserApprovalInput): CollaborationUserApprovalRequest {
    this.activeRoom()
    this.active(input.actorUserId)
    if (input.roomId !== this.state.roomId) throw new FusionRoomAuthorityError("FORBIDDEN", "RoomSession mismatch")
    const member = this.seat(input.memberId)
    this.canRun(member)
    const run = this.run(input.runId)
    if (run.seatId !== member.id || run.status !== "running") {
      throw new FusionRoomAuthorityError("CONFLICT", "Approval must reference a running Bot")
    }
    const question = input.question.trim()
    if (!question) throw new FusionRoomAuthorityError("INVALID_STATE", "Approval question is empty")
    if (new TextEncoder().encode(question).byteLength > 16 * 1024) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "Approval question exceeds 16 KiB")
    }
    const reason = input.reason?.trim()
    if (reason && new TextEncoder().encode(reason).byteLength > 4 * 1024) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "Approval reason exceeds 4 KiB")
    }
    const options = input.options?.map((item) => item.trim()).filter(Boolean)
    if (options && (options.length > 8 || options.some((item) => item.length > 200))) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "Approval options exceed limits")
    }
    if (input.idempotencyKey) {
      const old = this.state.events.find((event) =>
        event.idempotencyKey === input.idempotencyKey &&
        event.payload.approvalAction === "requested")
      const existing = old && this.state.approvals.find((item) => item.id === old.entityId)
      if (existing) return copy(existing)
    }
    const request: CollaborationUserApprovalRequest = {
      id: "approval_" + uniqueId(), roomId: this.state.roomId, memberId: member.id,
      runId: run.id, question, ...(reason ? { reason } : {}),
      ...(options && options.length ? { options } : {}),
      status: "pending", createdAt: nowOf(this.clock),
    }
    this.state.approvals.push(request)
    this.event("room.updated", input.actorUserId, request.id, {
      approvalAction: "requested", approval: copy(request),
    }, input.idempotencyKey)
    return copy(request)
  }

  resolveUserApproval(input: ResolveFusionUserApprovalInput): CollaborationUserApprovalRequest {
    this.activeRoom()
    this.active(input.actorUserId)
    if (input.roomId !== this.state.roomId) throw new FusionRoomAuthorityError("FORBIDDEN", "RoomSession mismatch")
    const old = this.state.approvals.find((item) => item.id === input.requestId)
    if (!old) throw new FusionRoomAuthorityError("NOT_FOUND", "Approval request does not exist")
    if (old.status !== "pending") return copy(old)
    const response = input.response?.trim()
    if (response && new TextEncoder().encode(response).byteLength > 4 * 1024) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "Approval response exceeds 4 KiB")
    }
    if (input.idempotencyKey) {
      const oldEvent = this.state.events.find((event) =>
        event.idempotencyKey === input.idempotencyKey &&
        event.payload.approvalAction === "resolved")
      const existing = oldEvent && this.state.approvals.find((item) => item.id === oldEvent.entityId)
      if (existing) return copy(existing)
    }
    const next: CollaborationUserApprovalRequest = {
      ...old, status: input.decision, ...(response ? { response } : {}),
      resolvedAt: nowOf(this.clock),
    }
    this.state.approvals = this.state.approvals.map((item) => item.id === old.id ? next : item)
    this.event("room.updated", input.actorUserId, next.id, {
      approvalAction: "resolved", approval: copy(next),
    }, input.idempotencyKey)
    return copy(next)
  }

  sendMailbox(input: SendFusionMailboxInput): CollaborationMailboxEnvelope {
    this.activeRoom()
    this.active(input.actorUserId)
    if (input.roomId !== this.state.roomId) throw new FusionRoomAuthorityError("FORBIDDEN", "RoomSession mismatch")
    const from = this.seat(input.fromMemberId)
    const to = this.seat(input.toMemberId)
    this.canRun(from)
    this.canRun(to)
    if (from.id === to.id) throw new FusionRoomAuthorityError("INVALID_STATE", "A2A self-send is not allowed")
    const run = this.run(input.runId)
    if (run.seatId !== from.id || run.status !== "running") {
      throw new FusionRoomAuthorityError("CONFLICT", "A2A envelope must reference a running sender")
    }
    const payload = input.payload.trim()
    if (!payload) throw new FusionRoomAuthorityError("INVALID_STATE", "A2A payload is empty")
    if (new TextEncoder().encode(payload).byteLength > 32 * 1024) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "A2A payload exceeds 32 KiB")
    }
    const source = this.state.messages.find((item) => item.id === input.rootMessageId)
    if (!source) throw new FusionRoomAuthorityError("NOT_FOUND", "A2A rootMessageId does not exist")
    if (input.idempotencyKey) {
      const old = this.state.events.find((event) =>
        event.idempotencyKey === input.idempotencyKey &&
        event.type === "mailbox.changed")
      const existing = old && this.state.mailbox.find((item) => item.id === old.entityId)
      if (existing) return copy(existing)
    }
    const rootMessageId = source.rootMessageId
    const depth = this.state.mailbox
      .filter((item) => item.rootMessageId === rootMessageId)
      .reduce((max, item) => Math.max(max, item.depth), -1) + 1
    if (depth > 10) throw new FusionRoomAuthorityError("INVALID_STATE", "A2A hard depth limit reached")
    const envelope: CollaborationMailboxEnvelope = {
      id: "env_" + uniqueId(), roomId: this.state.roomId,
      fromMemberId: from.id, toMemberId: to.id, type: input.type,
      ...(input.type === "question" ? { requestId: "req_" + uniqueId() } : {}),
      payload, rootMessageId, causationId: run.id, depth, state: "pending",
      attemptId: "attempt_" + uniqueId(), delivery: "outbox",
      sourceMessageId: source.id, createdAt: nowOf(this.clock),
    }
    this.state.mailbox.push(envelope)
    this.event("mailbox.changed", input.actorUserId, envelope.id, {
      mailboxAction: "sent", envelope: copy(envelope),
    }, input.idempotencyKey)
    return copy(envelope)
  }

  replyMailbox(input: ReplyFusionMailboxInput): CollaborationMailboxEnvelope {
    this.activeRoom()
    this.active(input.actorUserId)
    if (input.roomId !== this.state.roomId) throw new FusionRoomAuthorityError("FORBIDDEN", "RoomSession mismatch")
    const question = this.state.mailbox.find((item) =>
      item.type === "question" && item.requestId === input.requestId)
    if (!question) throw new FusionRoomAuthorityError("NOT_FOUND", "A2A question does not exist")
    if (question.state !== "pending" && question.state !== "delivered") {
      throw new FusionRoomAuthorityError("CONFLICT", "A2A question is already closed")
    }
    const from = this.seat(question.toMemberId)
    const to = this.seat(question.fromMemberId)
    this.canRun(from)
    this.canRun(to)
    const run = this.run(input.runId)
    if (run.seatId !== from.id || run.status !== "running") {
      throw new FusionRoomAuthorityError("CONFLICT", "A2A reply must reference a running receiver")
    }
    const answer = input.answer.trim()
    if (!answer) throw new FusionRoomAuthorityError("INVALID_STATE", "A2A answer is empty")
    if (new TextEncoder().encode(answer).byteLength > 32 * 1024) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "A2A answer exceeds 32 KiB")
    }
    if (input.idempotencyKey) {
      const old = this.state.events.find((event) =>
        event.idempotencyKey === input.idempotencyKey &&
        event.type === "mailbox.changed")
      const existing = old && this.state.mailbox.find((item) => item.id === old.entityId)
      if (existing) return copy(existing)
    }
    const reply: CollaborationMailboxEnvelope = {
      id: "env_" + uniqueId(), roomId: this.state.roomId,
      fromMemberId: from.id, toMemberId: to.id, type: "reply",
      requestId: question.requestId, payload: answer,
      rootMessageId: question.rootMessageId, causationId: run.id,
      depth: question.depth, state: "answered", createdAt: nowOf(this.clock),
    }
    this.state.mailbox = this.state.mailbox
      .map((item) => item.id === question.id ? { ...item, state: "answered" as const } : item)
      .concat(reply)
    this.event("mailbox.changed", input.actorUserId, reply.id, {
      mailboxAction: "replied", envelope: copy(reply), questionId: question.id,
    }, input.idempotencyKey)
    return copy(reply)
  }

  appendUserMessage(input: AppendFusionMessageInput): CollaborationMessage {
    this.activeRoom(); this.active(input.actorUserId)
    if (input.idempotencyKey) {
      const old = this.state.events.find((item) =>
        item.idempotencyKey === input.idempotencyKey && item.type === "message.appended")
      const messageId = typeof old?.payload.messageId === "string" ? old.payload.messageId : undefined
      const existing = this.state.messages.find((item) => item.id === messageId)
      if (existing) return copy(existing)
    }
    const content = input.content.trim()
    if (!content) throw new FusionRoomAuthorityError("INVALID_STATE", "消息内容不能为空")
    assertFusionMessageSize(content)
    const activeSeats = this.state.botSeats.filter((item) => item.status !== "removed")
    const requested = input.targetSeatIds ?? []
    const targets = requested.length ? requested :
      this.state.coordinatorSeatId ? [this.state.coordinatorSeatId] :
      activeSeats.slice(0, 1).map((item) => item.id)
    for (const seatId of targets) this.seat(seatId)
    const id = "msg_" + uniqueId()
    const message: CollaborationMessage = {
      id, roomId: this.state.roomId, authorType: "user", authorId: input.actorUserId,
      kind: "chat", content, visibility: "room", targetMemberIds: targets,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      rootMessageId: id, depth: 0, createdAt: nowOf(this.clock),
    }
    this.state.messages.push(message)
    this.event("message.appended", input.actorUserId, id, {
      messageId: id, content, targetSeatIds: targets, authorUserId: input.actorUserId,
    }, input.idempotencyKey)
    return copy(message)
  }

  appendMemberMessage(input: AppendFusionMemberMessageInput): CollaborationMessage {
    this.activeRoom()
    this.active(input.actorUserId)
    const seat = this.seat(input.seatId)
    this.canRun(seat)
    const content = input.content.trim()
    if (!content) throw new FusionRoomAuthorityError("INVALID_STATE", "成员消息内容不能为空")
    assertFusionMessageSize(content)
    if (input.depth !== undefined && (!Number.isSafeInteger(input.depth) || input.depth < 0)) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "成员消息 depth 非法")
    }
    if (input.idempotencyKey) {
      const old = this.state.events.find((item) =>
        item.idempotencyKey === input.idempotencyKey && item.type === "message.appended")
      const messageId = typeof old?.payload.messageId === "string" ? old.payload.messageId : undefined
      const existing = this.state.messages.find((item) => item.id === messageId)
      if (existing) return copy(existing)
    }
    const parent = input.replyToMessageId
      ? this.state.messages.find((item) => item.id === input.replyToMessageId)
      : undefined
    if (input.replyToMessageId && !parent) {
      throw new FusionRoomAuthorityError("NOT_FOUND", "回复目标消息不存在")
    }
    const id = "msg_" + uniqueId()
    const message: CollaborationMessage = {
      id, roomId: this.state.roomId, authorType: "member", authorId: seat.id,
      kind: input.kind ?? "chat", content, visibility: input.visibility ?? "room",
      targetMemberIds: input.targetSeatIds ?? [],
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      rootMessageId: input.rootMessageId ?? parent?.rootMessageId ?? id,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      depth: input.depth ?? 0, createdAt: nowOf(this.clock),
    }
    this.state.messages.push(message)
    this.event("message.appended", input.actorUserId, id, {
      messageId: id, authorMemberId: seat.id, kind: message.kind,
      rootMessageId: message.rootMessageId, runId: input.runId,
    }, input.idempotencyKey)
    return copy(message)
  }
  createTask(input: CreateFusionRoomTaskInput): CollaborationRoomTask {
    this.activeRoom()
    this.active(input.actorUserId)
    if (input.roomId !== this.state.roomId) {
      throw new FusionRoomAuthorityError("FORBIDDEN", "Task does not belong to this room")
    }
    const title = input.task.title.trim()
    if (!title) throw new FusionRoomAuthorityError("INVALID_STATE", "Task title cannot be empty")
    const status = input.task.status ?? "todo"
    if (status !== "todo") {
      throw new FusionRoomAuthorityError("INVALID_STATE", "New task must start in todo")
    }
    const assignee = input.task.assigneeMemberId
    if (assignee && !this.state.humanMembers.some((item) =>
      (item.id === assignee || item.userId === assignee) &&
      (item.status === "active" || item.status === "offline")) &&
      !this.state.botSeats.some((item) => item.id === assignee && item.status !== "removed")) {
      throw new FusionRoomAuthorityError("NOT_FOUND", "Task assignee is not a room member")
    }
    if (input.idempotencyKey) {
      const oldEvent = this.state.events.find((item) =>
        item.type === "room.updated" && item.idempotencyKey === input.idempotencyKey)
      const existing = oldEvent && this.state.tasks.find((item) => item.id === oldEvent.entityId)
      if (existing) return copy(existing)
    }
    const now = nowOf(this.clock)
    const task: CollaborationRoomTask = {
      ...copy(input.task),
      id: "crt_" + uniqueId(),
      roomId: this.state.roomId,
      title,
      status,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    this.state.tasks.push(task)
    this.event("room.updated", input.actorUserId, task.id, {
      taskAction: "created", taskId: task.id, task: copy(task),
    }, input.idempotencyKey)
    return copy(task)
  }

  updateTask(input: UpdateFusionRoomTaskInput): CollaborationRoomTask {
    this.activeRoom()
    this.active(input.actorUserId)
    if (input.roomId !== this.state.roomId) {
      throw new FusionRoomAuthorityError("FORBIDDEN", "Task does not belong to this room")
    }
    const old = this.state.tasks.find((item) => item.id === input.taskId)
    if (!old) throw new FusionRoomAuthorityError("NOT_FOUND", "Task does not exist")
    if (input.expectedVersion !== undefined && input.expectedVersion !== old.version) {
      throw new FusionRoomAuthorityError("CONFLICT", "Task version is stale")
    }
    if (input.assigneeMemberId && !this.state.humanMembers.some((item) =>
      (item.id === input.assigneeMemberId || item.userId === input.assigneeMemberId) &&
      (item.status === "active" || item.status === "offline")) &&
      !this.state.botSeats.some((item) => item.id === input.assigneeMemberId && item.status !== "removed")) {
      throw new FusionRoomAuthorityError("NOT_FOUND", "Task assignee is not a room member")
    }
    if (input.status !== undefined && input.status !== old.status &&
        !transitionCollaborationRoomTaskStatus(old.status, input.status).ok) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "Illegal task status transition")
    }
    if (input.title !== undefined && !input.title.trim()) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "Task title cannot be empty")
    }
    if (input.idempotencyKey) {
      const oldEvent = this.state.events.find((item) =>
        item.type === "room.updated" && item.idempotencyKey === input.idempotencyKey)
      const existing = oldEvent && this.state.tasks.find((item) => item.id === oldEvent.entityId)
      if (existing) return copy(existing)
    }
    const next: CollaborationRoomTask = {
      ...old,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      version: old.version + 1,
      updatedAt: nowOf(this.clock),
    }
    if (input.description !== undefined) {
      if (input.description) next.description = input.description
      else delete next.description
    }
    if (input.assigneeMemberId !== undefined) {
      if (input.assigneeMemberId) next.assigneeMemberId = input.assigneeMemberId
      else delete next.assigneeMemberId
    }
    if (input.acceptanceCriteria !== undefined) {
      if (input.acceptanceCriteria) next.acceptanceCriteria = input.acceptanceCriteria
      else delete next.acceptanceCriteria
    }
    if (input.runId !== undefined) {
      if (input.runId) next.runId = input.runId
      else delete next.runId
    }


    this.state.tasks = this.state.tasks.map((item) => item.id === old.id ? next : item)
    this.event("room.updated", input.actorUserId, next.id, {
      taskAction: "updated", taskId: next.id, task: copy(next), summary: input.summary,
    }, input.idempotencyKey)
    return copy(next)
  }

  publishArtifact(input: PublishFusionArtifactInput): CollaborationArtifact {
    this.activeRoom()
    this.active(input.actorUserId)
    if (input.roomId !== this.state.roomId) {
      throw new FusionRoomAuthorityError("FORBIDDEN", "Artifact does not belong to this room")
    }
    const seat = this.seat(input.memberId)
    this.canRun(seat)
    const path = safePath(input.relativePath)
    const byteSize = new TextEncoder().encode(input.content).byteLength
    if (byteSize > 1024 * 1024) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "Artifact content exceeds 1 MiB")
    }
    if (input.summary && input.summary.length > 2000) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "Artifact summary is too long")
    }
    if (input.taskId && !this.state.tasks.some((task) => task.id === input.taskId)) {
      throw new FusionRoomAuthorityError("NOT_FOUND", "Artifact task does not exist")
    }
    if (input.idempotencyKey) {
      const oldEvent = this.state.events.find((item) =>
        item.type === "artifact.published" && item.idempotencyKey === input.idempotencyKey)
      const existing = oldEvent && this.state.artifacts.find((item) => item.id === oldEvent.entityId)
      if (existing) return copy(existing)
    }
    const artifact: CollaborationArtifact = {
      id: "cart_" + uniqueId(),
      roomId: this.state.roomId,
      memberId: seat.id,
      relativePath: path,
      sha256: hashText(input.content),
      byteSize,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      createdAt: nowOf(this.clock),
    }
    this.state.artifacts.push(artifact)
    this.event("artifact.published", input.actorUserId, artifact.id, {
      artifactId: artifact.id,
      memberId: artifact.memberId,
      relativePath: artifact.relativePath,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
      taskId: artifact.taskId,
      runId: artifact.runId,
      summary: artifact.summary,
    }, input.idempotencyKey)
    return copy(artifact)
  }

  acquireWorkspaceLock(input: AcquireFusionWorkspaceLockInput): FusionWorkspaceLock {
    this.activeRoom(); this.active(input.actorUserId)
    const path = safePath(input.relativePath), now = nowOf(this.clock)
    this.purgeLocks(now)
    const current = this.state.files.find((item) => item.relativePath === path)
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== current?.sha256) {
      throw new FusionRoomAuthorityError("CONFLICT", "文件版本已经变化")
    }
    if (this.state.locks.some((item) => item.relativePath === path && item.expiresAt > now)) {
      throw new FusionRoomAuthorityError("LOCKED", "文件正被其他用户编辑")
    }
    const leaseMs = Math.min(Math.max(input.leaseMs ?? DEFAULT_LEASE_MS, 1000), MAX_LEASE_MS)
    const lock: FusionWorkspaceLock = {
      id: "lock_" + uniqueId(), roomId: this.state.roomId, relativePath: path,
      ownerUserId: input.actorUserId, ...(current?.sha256 ? { baseSha256: current.sha256 } : {}),
      acquiredAt: now, expiresAt: now + leaseMs,
    }
    this.state.locks.push(lock)
    this.event("room.updated", input.actorUserId, lock.id, {
      workspaceAction: "lock-acquired", relativePath: path, expiresAt: lock.expiresAt,
    }, input.idempotencyKey)
    return copy(lock)
  }

  commitWorkspaceFile(input: CommitFusionWorkspaceFileInput): FusionWorkspaceCommitResult {
    this.activeRoom(); this.active(input.actorUserId)
    const path = safePath(input.relativePath), now = nowOf(this.clock)
    this.purgeLocks(now)
    const lock = this.state.locks.find((item) => item.id === input.lockId &&
      item.relativePath === path && item.ownerUserId === input.actorUserId && item.expiresAt > now)
    if (!lock) throw new FusionRoomAuthorityError("LOCKED", "没有有效的当前用户工作区锁")
    const current = this.state.files.find((item) => item.relativePath === path)
    const expected = input.expectedSha256 ?? lock.baseSha256
    if (expected !== current?.sha256) throw new FusionRoomAuthorityError("CONFLICT", "文件版本冲突，不能覆盖他人的新产出")
    const file: FusionWorkspaceFileVersion = {
      relativePath: path, sha256: hashText(input.content),
      byteSize: new TextEncoder().encode(input.content).length, version: (current?.version ?? 0) + 1,
      updatedByUserId: input.actorUserId,
      updatedAt: now,
      ...(input.downloadable === true ? { downloadable: true } : {}),
    }
    this.state.files = this.state.files.filter((item) => item.relativePath !== path).concat(file)
    this.state.locks = this.state.locks.filter((item) => item.id !== lock.id)
    const event = this.event("artifact.published", input.actorUserId, path, {
      relativePath: path, sha256: file.sha256, byteSize: file.byteSize,
      version: file.version, summary: input.summary,
    }, input.idempotencyKey)
    return { file: copy(file), event }
  }

  deleteWorkspaceFile(input: DeleteFusionWorkspaceFileInput): FusionWorkspaceDeleteResult {
    this.activeRoom(); this.active(input.actorUserId)
    const path = safePath(input.relativePath)
    if (input.idempotencyKey) {
      const oldEvent = this.state.events.find((event) =>
        event.idempotencyKey === input.idempotencyKey && event.payload.workspaceAction === "deleted")
      const existing = oldEvent && this.state.files.find((item) => item.relativePath === path && item.deleted)
      if (existing) return { file: copy(existing), event: copy(oldEvent!) }
    }
    const now = nowOf(this.clock)
    this.purgeLocks(now)
    const lock = this.state.locks.find((item) => item.id === input.lockId &&
      item.relativePath === path && item.ownerUserId === input.actorUserId && item.expiresAt > now)
    if (!lock) throw new FusionRoomAuthorityError("LOCKED", "没有有效的当前用户工作区锁")
    const current = this.state.files.find((item) => item.relativePath === path)
    if (!current || current.deleted) throw new FusionRoomAuthorityError("NOT_FOUND", "文件不存在")
    const expected = input.expectedSha256 ?? lock.baseSha256
    if (expected !== current.sha256) throw new FusionRoomAuthorityError("CONFLICT", "文件版本冲突，不能删除他人的新产出")

    const file: FusionWorkspaceFileVersion = {
      relativePath: path, sha256: current.sha256, byteSize: current.byteSize,
      version: current.version + 1, updatedByUserId: input.actorUserId, updatedAt: now, deleted: true,
    }
    this.state.files = this.state.files.filter((item) => item.relativePath !== path).concat(file)
    this.state.locks = this.state.locks.filter((item) => item.id !== lock.id)
    const event = this.event("room.updated", input.actorUserId, path, {
      workspaceAction: "deleted", relativePath: path, version: file.version, sha256: file.sha256,
    }, input.idempotencyKey)
    return { file: copy(file), event }
  }

  moveWorkspaceFile(input: MoveFusionWorkspaceFileInput): FusionWorkspaceMoveResult {
    this.activeRoom(); this.active(input.actorUserId)
    const fromPath = safePath(input.fromPath), toPath = safePath(input.toPath)
    if (fromPath === toPath) throw new FusionRoomAuthorityError("CONFLICT", "移动源路径和目标路径不能相同")
    const now = nowOf(this.clock)
    this.purgeLocks(now)
    const fromLock = this.state.locks.find((item) => item.id === input.fromLockId &&
      item.relativePath === fromPath && item.ownerUserId === input.actorUserId && item.expiresAt > now)
    const toLock = this.state.locks.find((item) => item.id === input.toLockId &&
      item.relativePath === toPath && item.ownerUserId === input.actorUserId && item.expiresAt > now)
    if (!fromLock || !toLock) throw new FusionRoomAuthorityError("LOCKED", "移动需要源路径和目标路径的有效工作区锁")
    const source = this.state.files.find((item) => item.relativePath === fromPath)
    const target = this.state.files.find((item) => item.relativePath === toPath)
    if (!source || source.deleted) throw new FusionRoomAuthorityError("NOT_FOUND", "源文件不存在")
    if (target && !target.deleted) throw new FusionRoomAuthorityError("CONFLICT", "目标路径已存在，拒绝覆盖")
    const expected = input.expectedSha256 ?? fromLock.baseSha256
    if (expected !== source.sha256) throw new FusionRoomAuthorityError("CONFLICT", "文件版本冲突，不能移动他人的新产出")
    if (input.idempotencyKey) {
      const oldEvent = this.state.events.find((event) =>
        event.idempotencyKey === input.idempotencyKey && event.payload.workspaceAction === "moved")
      if (oldEvent) {
        const oldFrom = this.state.files.find((item) => item.relativePath === fromPath && item.deleted)
        const oldTo = this.state.files.find((item) => item.relativePath === toPath && !item.deleted)
        if (oldFrom && oldTo) return { fromFile: copy(oldFrom), toFile: copy(oldTo), event: copy(oldEvent) }
      }
    }
    const fromFile: FusionWorkspaceFileVersion = {
      relativePath: fromPath, sha256: source.sha256, byteSize: source.byteSize,
      version: source.version + 1, updatedByUserId: input.actorUserId, updatedAt: now, deleted: true,
    }
    const toFile: FusionWorkspaceFileVersion = {
      ...source, relativePath: toPath, version: (target?.version ?? 0) + 1,
      updatedByUserId: input.actorUserId, updatedAt: now,
    }
    this.state.files = this.state.files
      .filter((item) => item.relativePath !== fromPath && item.relativePath !== toPath)
      .concat(fromFile, toFile)
    this.state.locks = this.state.locks.filter((item) => item.id !== fromLock.id && item.id !== toLock.id)
    const event = this.event("room.updated", input.actorUserId, fromPath, {
      workspaceAction: "moved", fromPath, toPath, fromVersion: fromFile.version, toVersion: toFile.version,
      sha256: toFile.sha256,
    }, input.idempotencyKey)
    return { fromFile: copy(fromFile), toFile: copy(toFile), event }
  }
  commitWorkspaceFiles(input: CommitFusionWorkspaceFilesInput): FusionWorkspaceBatchCommitResult {
    this.activeRoom(); this.active(input.actorUserId)
    if (input.files.length === 0) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "批量工作区提交不能为空")
    }
    const normalizedPaths = input.files.map((item) => safePath(item.relativePath))
    if (new Set(normalizedPaths).size !== normalizedPaths.length) {
      throw new FusionRoomAuthorityError("CONFLICT", "批量工作区提交不能包含重复路径")
    }

    const batchKeys = input.idempotencyKey
      ? input.files.map((_, index) => input.idempotencyKey + ":batch:" + index)
      : []
    if (batchKeys.length > 0) {
      const existingEvents = batchKeys.map((key) => this.state.events.find((event) =>
        event.type === "artifact.published" && event.idempotencyKey === key))
      if (existingEvents.some(Boolean) && !existingEvents.every(Boolean)) {
        throw new FusionRoomAuthorityError("CONFLICT", "批量提交幂等记录不完整，拒绝部分重放")
      }
      if (existingEvents.every((event): event is CollaborationRoomEvent => Boolean(event))) {
        const files = existingEvents.map((event) => {
          const path = String(event.payload.relativePath ?? "")
          const file = this.state.files.find((item) => item.relativePath === path)
          if (!file) throw new FusionRoomAuthorityError("INVALID_STATE", "批量提交事件缺少文件版本")
          return copy(file)
        })
        return { files, events: existingEvents.map(copy) }
      }
    }

    // 先在副本上验证并生成完整事件集；只有全部文件成功，才替换权威状态。
    const staged = FusionRoomAuthority.fromSnapshot(this.state, this.clock)
    const results = input.files.map((item, index) => staged.commitWorkspaceFile({
      ...item,
      actorUserId: input.actorUserId,
      ...(batchKeys[index] ? { idempotencyKey: batchKeys[index] } : {}),
    }))
    this.state = staged.getSnapshot()
    return {
      files: results.map((result) => copy(result.file)),
      events: results.map((result) => copy(result.event)),
    }
  }
  recordUsage(input: RecordFusionUsageInput): FusionUsageLedgerEntry {
    this.activeRoom(); this.active(input.actorUserId)
    assertCount(input.inputTokens, "inputTokens"); assertCount(input.outputTokens, "outputTokens")
    assertCount(input.costMicros, "costMicros")
    const seat = this.seat(input.seatId); this.canRun(seat)
    if (input.idempotencyKey) {
      const old = this.state.events.find((item) =>
        item.idempotencyKey === input.idempotencyKey && item.type === "usage.recorded")
      const existing = old && this.state.usage.find((item) => item.id === old.entityId)
      if (existing) return copy(existing)
    }
    const entry: FusionUsageLedgerEntry = {
      id: "usage_" + uniqueId(), roomId: this.state.roomId, seatId: seat.id,
      botOwnerUserId: seat.ownerUserId, initiatedByUserId: input.actorUserId,
      ...(input.providerAccountUserId ? { providerAccountUserId: input.providerAccountUserId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      inputTokens: input.inputTokens, outputTokens: input.outputTokens,
      costMicros: input.costMicros, createdAt: nowOf(this.clock),
    }
    this.state.usage.push(entry)
    this.event("usage.recorded", input.actorUserId, entry.id, {
      seatId: seat.id, botOwnerUserId: seat.ownerUserId,
      providerAccountUserId: entry.providerAccountUserId, modelId: entry.modelId,
      inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, costMicros: entry.costMicros,
    }, input.idempotencyKey)
    return copy(entry)
  }

  startRun(input: StartFusionRunInput): FusionRoomRun {
    this.activeRoom(); this.active(input.actorUserId)
    const seat = this.seat(input.seatId); this.canRun(seat)
    if (seat.status === "running") throw new FusionRoomAuthorityError("CONFLICT", "Bot already has a running task")
    if (input.idempotencyKey) {
      const old = this.state.events.find((item) => item.idempotencyKey === input.idempotencyKey && item.type === "run.changed")
      const existing = old && this.state.runs.find((item) => item.id === old.entityId)
      if (existing) return copy(existing)
    }
    const fence = Math.max(0, ...this.state.runs.filter((item) => item.seatId === seat.id).map((item) => item.fence)) + 1
    const now = nowOf(this.clock)
    const run: FusionRoomRun = {
      id: "run_" + uniqueId(), roomId: this.state.roomId, seatId: seat.id,
      initiatedByUserId: input.actorUserId, backend: input.backend, fence,
      ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
      status: "running", createdAt: now, updatedAt: now,
    }
    this.state.runs.push(run)
    this.state.botSeats = this.state.botSeats.map((item) =>
      item.id === seat.id ? { ...item, status: "running" as const, updatedAt: now } : item)
    this.event("run.changed", input.actorUserId, run.id, {
      runId: run.id, seatId: run.seatId, status: run.status, fence, backend: run.backend,
    }, input.idempotencyKey)
    return copy(run)
  }

  awaitRun(input: AwaitFusionRunInput): FusionRoomRun {
    this.activeRoom()
    const run = this.run(input.runId)
    if (run.fence !== input.fence) throw new FusionRoomAuthorityError("CONFLICT", "Run fencing token is stale")
    this.active(input.actorUserId)
    if (run.status === input.status) return copy(run)
    if (run.status !== "running") {
      throw new FusionRoomAuthorityError("CONFLICT", "Only a running run can enter a waiting state")
    }
    const next: FusionRoomRun = {
      ...run, status: input.status, updatedAt: nowOf(this.clock),
      ...(input.summary ? { summary: input.summary } : {}),
    }
    this.state.runs = this.state.runs.map((item) => item.id === run.id ? next : item)
    const seat = this.state.botSeats.find((item) => item.id === run.seatId)
    if (seat?.status === "running") {
      this.state.botSeats = this.state.botSeats.map((item) =>
        item.id === seat.id ? { ...item, status: "idle" as const, updatedAt: nowOf(this.clock) } : item)
    }
    this.event("run.changed", input.actorUserId, run.id, {
      runId: run.id, seatId: run.seatId, status: input.status, fence: run.fence,
      backend: run.backend, summary: input.summary,
    }, input.idempotencyKey)
    return copy(next)
  }

  finishRun(input: FinishFusionRunInput): FusionRoomRun {
    const run = this.run(input.runId)
    if (run.fence !== input.fence) throw new FusionRoomAuthorityError("CONFLICT", "Run fencing token is stale")
    const actor = this.member(input.actorUserId)
    if (actor.status === "removed" || actor.status === "left") {
      throw new FusionRoomAuthorityError("FORBIDDEN", "Current user cannot finish this run")
    }
    return this.finishRunInternal(run, input.status, input.actorUserId, input.summary, input.idempotencyKey)
  }

  updateMetadata(input: UpdateFusionRoomMetadataInput): void {
    this.activeRoom()
    this.owner(input.actorUserId)
    if (input.roomId !== this.state.roomId) {
      throw new FusionRoomAuthorityError("FORBIDDEN", "RoomSession mismatch")
    }
    if (input.idempotencyKey && this.state.events.some((event) =>
      event.idempotencyKey === input.idempotencyKey &&
      event.payload.roomMetadataAction === "updated")) {
      return
    }
    const nextTitle = input.title === undefined
      ? this.state.title ?? this.state.roomId
      : normalizeRoomTitle(input.title, this.state.roomId)
    const nextGoal = input.goal === undefined
      ? this.state.goal ?? ""
      : normalizeRoomGoal(input.goal)
    this.state.title = nextTitle
    this.state.goal = nextGoal
    this.event("room.updated", input.actorUserId, this.state.roomId, {
      roomMetadataAction: "updated",
      title: nextTitle,
      goal: nextGoal,
    }, input.idempotencyKey)
  }
  setStatus(actorUserId: string, status: FusionAuthorityRoomStatus): void {
    this.owner(actorUserId)
    if (status === this.state.status) return
    this.state.status = status
    if (status !== "active") this.state.locks = []
    this.event("room.updated", actorUserId, this.state.roomId, { status })
  }
}
