import type {
  CollaborationHumanMemberStatus,
  CollaborationMessage,
  CollaborationRoomTask,
  CollaborationArtifact,
  CollaborationRoomEvent,
  FusionHumanMember,
  RoomBotSeat,
} from "@tagent/shared"
import {
  FusionRoomAuthority,
  FusionRoomAuthorityError,
} from "./fusion-room-authority"
import type {
  AddFusionBotSeatInput,
  AppendFusionMemberMessageInput,
  AcquireFusionWorkspaceLockInput,
  AppendFusionMessageInput,
  DeleteFusionWorkspaceFileInput, MoveFusionWorkspaceFileInput,

  CommitFusionWorkspaceFileInput,
  CommitFusionWorkspaceFilesInput,
  CreateFusionRoomAuthorityInput,
  CreateFusionRoomTaskInput, UpdateFusionRoomTaskInput, PublishFusionArtifactInput,
  RequestFusionUserApprovalInput, ResolveFusionUserApprovalInput, SendFusionMailboxInput, ReplyFusionMailboxInput,
  FusionAuthorityRoomStatus,
  FusionRoomAuthoritySnapshot,
  FusionUsageLedgerEntry,
  FusionWorkspaceCommitResult,
  FusionWorkspaceBatchCommitResult,
  FusionWorkspaceDeleteResult, FusionWorkspaceMoveResult,

  FusionWorkspaceLock,
  RecordFusionUsageInput,
  StartFusionRunInput, RetryFusionRunInput, FinishFusionRunInput, AwaitFusionRunInput, UpdateFusionRoomMetadataInput, FusionRoomRun,
} from "./fusion-room-authority"
import type {
  ConfirmFusionResumeContinuationInput,
  FusionContinuationItem,
  FusionResumeContinuationResult,
  ContinueFusionDepthStopInput,
  ContinueFusionDepthStopResult,
} from "./fusion-room-continuation"
import { listFusionContinuations } from "./fusion-room-continuation"

export type FusionRoomAction =
  | { type: "invite-human"; actorUserId: string; userId: string; displayName: string }
  | { type: "accept-invitation"; userId: string }
  | { type: "leave-human"; actorUserId: string }
  | { type: "remove-human"; actorUserId: string; userId: string }
  | { type: "presence"; actorUserId: string; status: Extract<CollaborationHumanMemberStatus, "active" | "offline"> }
  | { type: "add-bot"; input: AddFusionBotSeatInput }
  | { type: "bot-consent"; actorUserId: string; seatId: string; consent: boolean }
  | { type: "remove-bot"; actorUserId: string; seatId: string }
  | { type: "message"; input: AppendFusionMessageInput }
  | { type: "member-message"; input: AppendFusionMemberMessageInput }
  | { type: "lock"; input: AcquireFusionWorkspaceLockInput }
  | { type: "commit-file"; input: CommitFusionWorkspaceFileInput }
  | { type: "commit-files"; input: CommitFusionWorkspaceFilesInput }
  | { type: "delete-file"; input: DeleteFusionWorkspaceFileInput }
  | { type: "move-file"; input: MoveFusionWorkspaceFileInput }
  | { type: "usage"; input: RecordFusionUsageInput }
  | { type: "start-run"; input: StartFusionRunInput }
  | { type: "retry-run"; input: RetryFusionRunInput }
  | { type: "continue-depth-stop"; input: ContinueFusionDepthStopInput }
  | { type: "finish-run"; input: FinishFusionRunInput }
  | { type: "await-run"; input: AwaitFusionRunInput }
  | { type: "update-metadata"; input: UpdateFusionRoomMetadataInput }
  | { type: "status"; actorUserId: string; status: FusionAuthorityRoomStatus }
  | { type: "create-task"; input: CreateFusionRoomTaskInput }
  | { type: "update-task"; input: UpdateFusionRoomTaskInput }
  | { type: "publish-artifact"; input: PublishFusionArtifactInput }
  | { type: "request-approval"; input: RequestFusionUserApprovalInput }
  | { type: "resolve-approval"; input: ResolveFusionUserApprovalInput }
  | { type: "send-mailbox"; input: SendFusionMailboxInput }
  | { type: "reply-mailbox"; input: ReplyFusionMailboxInput }
  | { type: "confirm-resume-continuation"; input: ConfirmFusionResumeContinuationInput }

export type FusionRoomActionResult =
  | FusionHumanMember
  | RoomBotSeat
  | CollaborationMessage
  | CollaborationRoomTask
  | CollaborationArtifact
  | import("@tagent/shared").CollaborationUserApprovalRequest
  | import("@tagent/shared").CollaborationMailboxEnvelope
  | FusionWorkspaceLock
  | FusionWorkspaceCommitResult
  | FusionWorkspaceBatchCommitResult
  | FusionWorkspaceDeleteResult
  | FusionWorkspaceMoveResult
  | FusionWorkspaceDeleteResult
  | FusionUsageLedgerEntry
  | FusionRoomRun
  | FusionResumeContinuationResult
  | ContinueFusionDepthStopResult
  | void

export interface FusionRoomEventNotification {
  roomId: string
  events: CollaborationRoomEvent[]
  snapshot: FusionRoomAuthoritySnapshot
}

export type FusionRoomEventListener = (notification: FusionRoomEventNotification) => void

export interface FusionRoomSnapshotStore {
  load(roomId: string): FusionRoomAuthoritySnapshot | undefined
  /**
   * Persist a snapshot. When expectedEventCount is supplied, the adapter must
   * compare it with the latest persisted event count atomically and reject a
   * stale writer instead of overwriting another Host's update.
   */
  save(snapshot: FusionRoomAuthoritySnapshot, options?: { expectedEventCount?: number }): void
  listRoomIds?(): string[]
}

export class FusionRoomSnapshotConflictError extends FusionRoomAuthorityError {
  constructor(message = "RoomSession 快照已被其他 Host 更新，请重新加载后重试") {
    super("CONFLICT", message)
    this.name = "FusionRoomSnapshotConflictError"
  }
}

export interface FusionRoomWorkspaceCommitTransaction {
  commit(): void
  rollback(): void
}

export interface FusionRoomWorkspaceStore {
  prepareCommit(input: {
    roomId: string
    relativePath: string
    content: string
  }): FusionRoomWorkspaceCommitTransaction
  prepareDelete?(input: { roomId: string; relativePath: string }): FusionRoomWorkspaceCommitTransaction
  prepareMove?(input: { roomId: string; fromPath: string; toPath: string }): FusionRoomWorkspaceCommitTransaction
  readFile?(roomId: string, relativePath: string): string | undefined
  searchFiles?(roomId: string, relativePath: string, pattern?: string, maxResults?: number): { paths: string[]; truncated: boolean }
  runCommand?(input: { roomId: string; command: string; args?: string; cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{ ok: true; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean } | { ok: false; reason: string }>
}

export interface FusionRoomHostOptions {
  snapshotStore?: FusionRoomSnapshotStore
  workspaceStore?: FusionRoomWorkspaceStore
}


/**
 * Multi-room host boundary for a server transport.
 *
 * It deliberately has no HTTP/WebSocket dependency. A transport authenticates a request,
 * calls dispatch(), and forwards the emitted events to subscribed clients. A storage
 * adapter can persist snapshots after each successful dispatch.
 */
export class FusionRoomHost {
  private readonly rooms = new Map<string, FusionRoomAuthority>()
  private readonly listeners = new Map<string, Set<FusionRoomEventListener>>()
  private readonly snapshotStore?: FusionRoomSnapshotStore
  private readonly workspaceStore?: FusionRoomWorkspaceStore

  constructor(options: FusionRoomHostOptions = {}) {
    this.snapshotStore = options.snapshotStore
    this.workspaceStore = options.workspaceStore
  }

  createRoom(input: CreateFusionRoomAuthorityInput): FusionRoomAuthoritySnapshot {
    if (this.rooms.has(input.roomId) || this.snapshotStore?.load(input.roomId)) {
      throw new FusionRoomAuthorityError("CONFLICT", "RoomSession 已存在")
    }
    const room = new FusionRoomAuthority(input)
    this.rooms.set(input.roomId, room)
    const snapshot = room.getSnapshot()
    this.snapshotStore?.save(snapshot)
    return snapshot
  }

  restoreRoom(snapshot: FusionRoomAuthoritySnapshot): void {
    if (this.rooms.has(snapshot.roomId)) {
      throw new FusionRoomAuthorityError("CONFLICT", "RoomSession 已存在")
    }
    this.rooms.set(snapshot.roomId, FusionRoomAuthority.fromSnapshot(snapshot))
    this.snapshotStore?.save(snapshot)
  }

  /**
   * Safely closes runs left in running state by a previous process. We do not
   * replay them because the provider may already have performed an external
   * side effect; awaiting peer/user runs remain recoverable through their
   * durable mailbox/approval state.
   */
  recoverInterruptedRuns(): FusionRoomRun[] {
    const recovered: FusionRoomRun[] = []
    for (const roomId of this.listRoomIds()) {
      let snapshot: FusionRoomAuthoritySnapshot
      try { snapshot = this.getSnapshot(roomId) } catch { continue }
      for (const run of snapshot.runs.filter((item) => item.status === "running")) {
        try {
          const next = this.dispatch(roomId, {
            type: "finish-run",
            input: {
              actorUserId: snapshot.ownerUserId,
              runId: run.id,
              fence: run.fence,
              status: "blocked",
              summary: "上一个 RoomSession 进程退出时该 run 仍在执行，存在未知副作用；未自动重放。",
              idempotencyKey: "fusion-recover-blocked:" + run.id + ":" + run.fence,
            },
          })
          if (next && typeof next === "object" && "status" in next) recovered.push(next as FusionRoomRun)
        } catch {
          // A stale/fenced run or a room removed during recovery is left for
          // the authoritative persistence layer to reconcile.
        }
      }
    }
    return recovered
  }

  /**
   * 列出某房间可观察的 continuation（blocked run / pending approval / outbox 信封等），
   * 供重启后的 UI / IPC 观察。纯函数派生，不触发副作用、不自动推进。
   */
  listContinuations(roomId: string): FusionContinuationItem[] {
    return listFusionContinuations(this.getSnapshot(roomId))
  }

  /**
   * 用户（房主或 active 人类成员）显式确认恢复一条 continuation（P1-1）。
   *
   * 仅写可观察「已确认」证据，**不**复活旧 fence 的 blocked run；`mailbox_outbox` 仅当
   * delivery 可合法前进为 dispatched 时推进。幂等：同 idempotencyKey 重复确认返回同一结果。
   */
  confirmResumeContinuation(input: ConfirmFusionResumeContinuationInput): FusionResumeContinuationResult {
    const result = this.dispatch(input.roomId, { type: "confirm-resume-continuation", input })
    if (!result || typeof result !== "object" || !("continuationId" in result)) {
      throw new FusionRoomAuthorityError("INVALID_STATE", "confirm-resume-continuation 未返回预期结果")
    }
    return result as FusionResumeContinuationResult
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId)
  }

  getSnapshot(roomId: string): FusionRoomAuthoritySnapshot {
    return this.room(roomId).getSnapshot()
  }

  listRoomIds(): string[] {
    const persisted = this.snapshotStore?.listRoomIds?.() ?? []
    return [...new Set([...this.rooms.keys(), ...persisted])].sort()
  }

  subscribe(roomId: string, listener: FusionRoomEventListener): () => void {
    this.room(roomId)
    const listeners = this.listeners.get(roomId) ?? new Set<FusionRoomEventListener>()
    listeners.add(listener)
    this.listeners.set(roomId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(roomId)
    }
  }

  dispatch(roomId: string, action: FusionRoomAction): FusionRoomActionResult {
    const room = this.room(roomId)
    const beforeSnapshot = room.getSnapshot()
    const before = beforeSnapshot.events.length
    const workspaceTransactions: FusionRoomWorkspaceCommitTransaction[] = []
    try {
      if (action.type === "commit-file" || action.type === "publish-artifact") {
        const transaction = this.workspaceStore?.prepareCommit({
          roomId,
          relativePath: action.input.relativePath,
          content: action.input.content,
        })
        if (transaction) workspaceTransactions.push(transaction)
      } else if (action.type === "delete-file") {
        const transaction = this.workspaceStore?.prepareDelete?.({ roomId, relativePath: action.input.relativePath })
        if (transaction) workspaceTransactions.push(transaction)
      } else if (action.type === "move-file") {
        const transaction = this.workspaceStore?.prepareMove?.({ roomId, fromPath: action.input.fromPath, toPath: action.input.toPath })
        if (transaction) workspaceTransactions.push(transaction)
      } else if (action.type === "commit-files") {
        for (const file of action.input.files) {
          const transaction = this.workspaceStore?.prepareCommit({
            roomId,
            relativePath: file.relativePath,
            content: file.content,
          })
          if (transaction) workspaceTransactions.push(transaction)
        }
      }
    } catch (error) {
      for (const transaction of workspaceTransactions) transaction.rollback()
      throw error
    }
    let result: FusionRoomActionResult
    try {
      switch (action.type) {
      case "invite-human":
        result = room.inviteHumanMember(action.actorUserId, action.userId, action.displayName)
        break
      case "accept-invitation":
        result = room.acceptInvitation(action.userId)
        break
      case "leave-human":
        result = room.leaveHumanMember(action.actorUserId)
        break
      case "remove-human":
        result = room.removeHumanMember(action.actorUserId, action.userId)
        break
      case "presence":
        result = room.setPresence(action.actorUserId, action.status)
        break
      case "add-bot":
        result = room.addBotSeat(action.input)
        break
      case "bot-consent":
        result = room.setBotOwnerConsent(action.actorUserId, action.seatId, action.consent)
        break
      case "remove-bot":
        result = room.removeBotSeat(action.actorUserId, action.seatId)
        break
      case "message":
        result = room.appendUserMessage(action.input)
        break
      case "member-message":
        result = room.appendMemberMessage(action.input)
        break
      case "create-task":
        result = room.createTask(action.input)
        break
      case "update-task":
        result = room.updateTask(action.input)
        break
      case "publish-artifact":
        result = room.publishArtifact(action.input)
        break
      case "request-approval":
        result = room.requestUserApproval(action.input)
        break
      case "resolve-approval":
        result = room.resolveUserApproval(action.input)
        break
      case "send-mailbox":
        result = room.sendMailbox(action.input)
        break
      case "reply-mailbox":
        result = room.replyMailbox(action.input)
        break
      case "confirm-resume-continuation":
        result = room.confirmResumeContinuation(action.input)
        break
      case "lock":
        result = room.acquireWorkspaceLock(action.input)
        break
      case "commit-file":
        result = room.commitWorkspaceFile(action.input)
        break
      case "commit-files":
        result = room.commitWorkspaceFiles(action.input)
        break
      case "delete-file":
        result = room.deleteWorkspaceFile(action.input)
        break
      case "move-file":
        result = room.moveWorkspaceFile(action.input)
        break
      case "usage":
        result = room.recordUsage(action.input)
        break
      case "start-run":
        result = room.startRun(action.input)
        break
      case "retry-run":
        result = room.retryRun(action.input)
        break
      case "continue-depth-stop":
        result = room.continueDepthStop(action.input)
        break
      case "finish-run":
        result = room.finishRun(action.input)
        break
      case "await-run":
        result = room.awaitRun(action.input)
        break
      case "update-metadata":
        room.updateMetadata(action.input)
        result = undefined
        break
      case "status":
        result = room.setStatus(action.actorUserId, action.status)
        break
        default:
          throw new FusionRoomAuthorityError("INVALID_STATE", "未知 RoomSession 动作")
      }
      for (const transaction of workspaceTransactions) transaction.commit()
      this.snapshotStore?.save(room.getSnapshot(), {
        expectedEventCount: beforeSnapshot.events.length,
      })
    } catch (error) {
      for (const transaction of [...workspaceTransactions].reverse()) {
        try { transaction.rollback() } catch { /* 保留原始动作错误 */ }
      }
      this.rooms.set(roomId, FusionRoomAuthority.fromSnapshot(beforeSnapshot))
      // 原子快照写入失败时，持久化层仍保留动作前版本；不要用本地旧快照
      // 反向覆盖其他 Host 可能已经提交的新版本。
      throw error
    }
    this.notify(roomId, before)
    return result
  }

  private room(roomId: string): FusionRoomAuthority {
    const existing = this.rooms.get(roomId)
    if (existing) return existing
    const persisted = this.snapshotStore?.load(roomId)
    if (persisted) {
      const restored = FusionRoomAuthority.fromSnapshot(persisted)
      this.rooms.set(roomId, restored)
      return restored
    }
    throw new FusionRoomAuthorityError("NOT_FOUND", "RoomSession 不存在")
  }

  private notify(roomId: string, beforeEventCount: number): void {
    const room = this.room(roomId)
    const snapshot = room.getSnapshot()
    const events = snapshot.events.slice(beforeEventCount)
    if (events.length === 0) return
    const listeners = this.listeners.get(roomId)
    if (!listeners || listeners.size === 0) return
    const notification = { roomId, events, snapshot }
    for (const listener of [...listeners]) listener(notification)
  }
}
