/**
 * 融合会话 continuation outbox 观察模型（P1-1）。
 *
 * 纯函数：从 `FusionRoomAuthoritySnapshot` 派生「可观察的 continuation」列表，不读 DB、不依赖
 * 时间、不触发副作用。服务离线 / 进程重启后，已批准 approval、已回复 mailbox、仍停在
 * `delivery:'outbox'` 的信封、以及被标成 `blocked`（未知副作用）的 run 都能被列出观察。
 *
 * 设计红线（P1-1 brief / handoff §8 第 4 步）：
 * - 涉及文件 / 命令 / 网络等未知副作用的 continuation 必须进入显式 `resume_confirm`，
 *   **禁止**启动时自动重放；`requiresUserConfirm` 为 true 即「需人类显式确认后才能推进」。
 * - `completed` / `failed` / `cancelled` 等终态不放进入列表。
 * - 这里只负责「观察 + 分类」，是否推进由 Host `confirmResumeContinuation` 在用户确认后决定。
 */
import type { FusionRoomAuthoritySnapshot, FusionRunStatus } from "./fusion-room-authority"
import type {
  CollaborationMailboxDelivery,
  CollaborationRoomEvent,
} from "@tagent/shared"
import { canContinueCollaborationDepthStop } from "@tagent/shared"

/** continuation 分类；决定是否需要人类显式确认以及副作用风险。 */
export type FusionContinuationKind =
  | "blocked_run" // recoverInterruptedRuns 标 blocked，未知副作用
  | "pending_approval" // approvals status=pending
  | "approved_awaiting_resume" // approved 但对应 run 仍在等待 / 未 continuation
  | "mailbox_outbox" // delivery === 'outbox'（尚未 dispatched）
  | "awaiting_peer" // 可观察；通常等 peer reply，不需用户 confirm
  | "depth_stop" // 可选：可 continue 一次的 depth stop 信封

/** continuation 关联的权威实体引用，便于 UI / bridge 精确定位。 */
export interface FusionContinuationRefs {
  runId?: string
  seatId?: string
  envelopeId?: string
  approvalId?: string
}

/** 单条可观察 continuation。 */
export interface FusionContinuationItem {
  /** 稳定 id：runId / approvalId / envelopeId。 */
  id: string
  roomId: string
  kind: FusionContinuationKind
  /** 是否需要人类显式确认后才能推进。 */
  requiresUserConfirm: boolean
  /** 若自动推进是否可能有外部副作用（文件 / 命令 / 网络）。 */
  sideEffectRisk: "none" | "unknown" | "known"
  summary: string
  createdAt?: number
  refs?: FusionContinuationRefs
}

/** Host `confirmResumeContinuation` 入参。 */
export interface ConfirmFusionResumeContinuationInput {
  roomId: string
  /** 房主或具备权限的人类成员（与 active human 守卫对齐）。 */
  actorUserId: string
  /** continuation 稳定 id（runId / envelopeId / approvalId）。 */
  continuationId: string
  /** continuation 分类；决定走 blocked_run 还是 mailbox_outbox 推进路径。 */
  kind: FusionContinuationKind
  idempotencyKey?: string
}

/** confirm-resume 结果状态。 */
export type FusionResumeContinuationStatus = "confirmed" | "already_confirmed"

/** Host `confirmResumeContinuation` 出参：可观察的「已确认」证据。 */
export interface FusionResumeContinuationResult {
  continuationId: string
  roomId: string
  kind: FusionContinuationKind
  status: FusionResumeContinuationStatus
  /** 写入权威事件账本的事件（`run.resume_confirmed` 或 `mailbox.changed`）。 */
  event: CollaborationRoomEvent
  refs: FusionContinuationRefs
  /** blocked_run：旧 run 仍停在原状态（blocked）；confirm 不复活旧 fence。 */
  runStatus?: FusionRunStatus
  /** mailbox_outbox：delivery 推进后的投递进度。 */
  delivery?: CollaborationMailboxDelivery
}

/** `approved_awaiting_resume` 判定：approval 已批准且对应 run 仍处于可恢复的等待态。 */
function runAwaitingResumeAfterApproval(status: FusionRunStatus | undefined): boolean {
  return status === "running" || status === "awaiting_peer" || status === "awaiting_user"
}

/**
 * 从权威快照派生可观察 continuation 列表。
 *
 * 规则（P1-1 brief §1）：
 * - `blocked` run → `blocked_run`，`requiresUserConfirm=true`，`sideEffectRisk='unknown'`；
 * - `pending` approval → `pending_approval`，`requiresUserConfirm=true`；
 * - `approved` approval 且对应 run 仍等待 / 未 continuation → `approved_awaiting_resume`，
 *   `requiresUserConfirm=false`（审批本身就是确认），仍列出供 bridge 观察；
 * - `delivery==='outbox'` 且未终态 → `mailbox_outbox`，`requiresUserConfirm=true`，
 *   `sideEffectRisk='unknown'`（无法证明无副作用）；
 * - `awaiting_peer` run → `awaiting_peer`，`requiresUserConfirm=false`（等 peer）；
 * - 可继续一次的 `max_depth` 停止信封 → `depth_stop`，`requiresUserConfirm=true`；
 * - `completed` / `failed` / `cancelled` 等终态不进入列表。
 */
export function listFusionContinuations(snapshot: FusionRoomAuthoritySnapshot): FusionContinuationItem[] {
  const items: FusionContinuationItem[] = []
  const roomId = snapshot.roomId

  for (const run of snapshot.runs) {
    if (run.status === "blocked") {
      items.push({
        id: run.id,
        roomId,
        kind: "blocked_run",
        requiresUserConfirm: true,
        sideEffectRisk: "unknown",
        summary: run.summary ?? "上一个进程退出时该 run 仍在执行，可能已发生外部副作用；未自动重放。",
        createdAt: run.createdAt,
        refs: { runId: run.id, seatId: run.seatId },
      })
    } else if (run.status === "awaiting_peer") {
      items.push({
        id: run.id,
        roomId,
        kind: "awaiting_peer",
        requiresUserConfirm: false,
        sideEffectRisk: "none",
        summary: run.summary ?? "run 正在等待 peer 回复。",
        createdAt: run.createdAt,
        refs: { runId: run.id, seatId: run.seatId },
      })
    }
  }

  for (const approval of snapshot.approvals) {
    if (approval.status === "pending") {
      items.push({
        id: approval.id,
        roomId,
        kind: "pending_approval",
        requiresUserConfirm: true,
        sideEffectRisk: "unknown",
        summary: approval.question,
        createdAt: approval.createdAt,
        refs: { approvalId: approval.id, runId: approval.runId },
      })
    } else if (approval.status === "approved") {
      const run = snapshot.runs.find((item) => item.id === approval.runId)
      if (runAwaitingResumeAfterApproval(run?.status)) {
        items.push({
          id: approval.id,
          roomId,
          kind: "approved_awaiting_resume",
          requiresUserConfirm: false,
          sideEffectRisk: "unknown",
          summary: "用户已批准，待 execution bridge 以新 turn 继续此前被批准的工作。",
          createdAt: approval.resolvedAt ?? approval.createdAt,
          refs: {
            approvalId: approval.id,
            runId: approval.runId,
            ...(run?.seatId ? { seatId: run.seatId } : {}),
          },
        })
      }
    }
  }

  for (const envelope of snapshot.mailbox) {
    const terminalState = envelope.state === "cancelled" || envelope.state === "expired"
    if (envelope.delivery === "outbox" && !terminalState) {
      items.push({
        id: envelope.id,
        roomId,
        kind: "mailbox_outbox",
        requiresUserConfirm: true,
        sideEffectRisk: "unknown",
        summary: envelope.payload.slice(0, 200) || "未投递的 outbox 信封，等待用户确认后安全重投。",
        createdAt: envelope.createdAt,
        refs: { envelopeId: envelope.id },
      })
    } else if (canContinueCollaborationDepthStop(envelope)) {
      items.push({
        id: envelope.id,
        roomId,
        kind: "depth_stop",
        requiresUserConfirm: true,
        sideEffectRisk: "unknown",
        summary: "A2A 深度停止信封，可由用户继续一次。",
        createdAt: envelope.createdAt,
        refs: { envelopeId: envelope.id },
      })
    }
  }

  // 稳定顺序：createdAt 升序，再按 id；便于 UI 与快照测试断言。
  items.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return items
}
