/**
 * 本地协作室「待确认续跑」观察模型（P2-1）。
 *
 * 纯函数：从已落盘的 runs / mailbox / approvals 派生「可观察的 continuation」列表，不读 DB、
 * 不依赖时间、不触发副作用。与远程 Fusion 页的 `listFusionContinuations`（core 包）语义对齐，
 * 但服务于本地 `CollaborationRoomService` 路径：
 * - `blocked` run（recoverInterruptedRuns 标记的未知副作用 run）→ `blocked_run`，需用户显式确认
 *   后以**新** turn 续跑（新 runId / 新 fence），**不复活旧 fence**；
 * - `pending` approval → `pending_approval`，确认走既有 resolve-user-approval IPC（审批卡片在时间线）；
 * - `awaiting_peer` / `awaiting_user` run → 只读观察（后者指向时间线审批卡片）；
 * - 可继续一次的 `max_depth` 停止信封 → `depth_stop`，确认走既有 continue-depth-stop（卡片在时间线）；
 * - `delivery==='outbox'` 且未终态 → `mailbox_outbox`，仅观察（legacy recover 已可能自动重投，
 *   本切片不新开 outbox confirm）。
 *
 * 设计红线（P2-1 brief / 02-RUNTIME-A2A-SPEC §14）：
 * - 涉及未知副作用的 continuation 必须显式 `requiresUserConfirm`，**禁止**自动重放；
 * - `completed` / `failed` / `cancelled` 等终态不进入列表；
 * - 这里只负责「观察 + 分类」，是否推进由 `CollaborationRoomService.confirmResumeBlockedRun`
 *   在用户确认后决定（blocked_run），或由既有审批 / 深度停止入口决定。
 */
import type {
  CollaborationMailboxEnvelope,
  CollaborationRun,
  CollaborationUserApprovalRequest,
} from "./collaboration-room";
import { canContinueCollaborationDepthStop } from "./collaboration-a2a";

/** 本地 continuation 分类；决定是否需要人类显式确认以及 UI 呈现。 */
export type LocalCollaborationContinuationKind =
  | "blocked_run" // recoverInterruptedRuns 标 blocked，未知副作用；需确认后新 turn 续跑
  | "pending_approval" // approvals status=pending；确认走既有 resolve-user-approval
  | "awaiting_peer" // 可观察；等 peer reply，不需用户 confirm
  | "awaiting_user" // 可观察；等用户审批，指向时间线审批卡片
  | "depth_stop" // 可继续一次的 max_depth 停止信封；确认走既有 continue-depth-stop
  | "mailbox_outbox"; // delivery === 'outbox' 且未终态；仅观察（legacy recover 已可能重投）

/** continuation 关联的本地实体引用，便于 UI / 定位精确指向。 */
export interface LocalCollaborationContinuationRefs {
  runId?: string;
  memberId?: string;
  envelopeId?: string;
  approvalId?: string;
}

/** 单条可观察 continuation。 */
export interface LocalCollaborationContinuationItem {
  /** 稳定 id：runId / approvalId / envelopeId。 */
  id: string;
  roomId: string;
  kind: LocalCollaborationContinuationKind;
  /** 是否需要人类显式确认后才能推进（blocked_run / pending_approval / depth_stop 为 true）。 */
  requiresUserConfirm: boolean;
  summary: string;
  createdAt?: number;
  refs?: LocalCollaborationContinuationRefs;
}

/**
 * continuation 分类 → 中文标签（与远程 Fusion 页共用同一份措辞基线，避免复制粘贴失控）。
 * 远程 `FusionContinuationKind` 与本地集合略有差异（远程含 `approved_awaiting_resume`，
 * 本地含 `awaiting_user`），故各自维护一份 label map，但措辞对齐。
 */
export const localCollaborationContinuationKindLabel: Record<
  LocalCollaborationContinuationKind,
  string
> = {
  blocked_run: "中断的运行",
  pending_approval: "待审批",
  awaiting_peer: "等待成员回复",
  awaiting_user: "等待用户审批",
  depth_stop: "深度停止",
  mailbox_outbox: "未投递消息",
};

/** 终态信封状态：不再进入可观察列表。 */
function isMailboxTerminalState(
  envelope: CollaborationMailboxEnvelope,
): boolean {
  return envelope.state === "cancelled" || envelope.state === "expired";
}

/**
 * 从已落盘的 runs / mailbox / approvals 派生可观察 continuation 列表。
 *
 * 规则（P2-1 brief §1，对齐 Fusion / legacy）：
 * - `blocked` run → `blocked_run`，`requiresUserConfirm=true`；
 * - `pending` approval → `pending_approval`，`requiresUserConfirm=true`；
 * - `awaiting_peer` run → `awaiting_peer`，`requiresUserConfirm=false`；
 * - `awaiting_user` run → `awaiting_user`，`requiresUserConfirm=false`（指向时间线审批卡片）；
 * - `delivery==='outbox'` 且未终态 → `mailbox_outbox`，`requiresUserConfirm=false`（仅观察）；
 * - 可继续一次的 `max_depth` 停止信封 → `depth_stop`，`requiresUserConfirm=true`；
 *   `handoffEnabled === false` 时不列出（A2A 交接关闭则无深度停止续跑）；
 * - `completed` / `failed` / `cancelled` 等终态不进入列表。
 *
 * 稳定顺序：createdAt 升序，再按 id 升序，便于 UI 与快照测试断言。
 */
export function listLocalCollaborationContinuations(input: {
  roomId: string;
  runs: CollaborationRun[];
  mailbox: CollaborationMailboxEnvelope[];
  approvals: CollaborationUserApprovalRequest[];
  /** 房间 A2A 深度上限；缺省时仅以信封 stopReason==='max_depth' 为准。 */
  maxA2ADepth?: number;
  /** 是否启用 A2A 交接；显式 false 时不列出 depth_stop。 */
  handoffEnabled?: boolean;
}): LocalCollaborationContinuationItem[] {
  const { roomId, runs, mailbox, approvals, maxA2ADepth, handoffEnabled } =
    input;
  const items: LocalCollaborationContinuationItem[] = [];

  for (const run of runs) {
    if (run.status === "blocked") {
      items.push({
        id: run.id,
        roomId,
        kind: "blocked_run",
        requiresUserConfirm: true,
        summary:
          "上一个进程退出时该 run 仍在执行，可能已发生外部副作用；确认后以新 turn 续跑，不复活旧 fence。",
        createdAt: run.createdAt,
        refs: { runId: run.id, memberId: run.memberId },
      });
    } else if (run.status === "awaiting_peer") {
      items.push({
        id: run.id,
        roomId,
        kind: "awaiting_peer",
        requiresUserConfirm: false,
        summary: "run 正在等待成员回复。",
        createdAt: run.createdAt,
        refs: { runId: run.id, memberId: run.memberId },
      });
    } else if (run.status === "awaiting_user") {
      items.push({
        id: run.id,
        roomId,
        kind: "awaiting_user",
        requiresUserConfirm: false,
        summary: "run 正在等待用户审批，请使用下方审批卡片处理。",
        createdAt: run.createdAt,
        refs: { runId: run.id, memberId: run.memberId },
      });
    }
  }

  for (const approval of approvals) {
    if (approval.status === "pending") {
      items.push({
        id: approval.id,
        roomId,
        kind: "pending_approval",
        requiresUserConfirm: true,
        summary: approval.question,
        createdAt: approval.createdAt,
        refs: {
          approvalId: approval.id,
          runId: approval.runId,
          memberId: approval.memberId,
        },
      });
    }
  }

  for (const envelope of mailbox) {
    if (envelope.delivery === "outbox" && !isMailboxTerminalState(envelope)) {
      items.push({
        id: envelope.id,
        roomId,
        kind: "mailbox_outbox",
        requiresUserConfirm: false,
        summary:
          envelope.payload.slice(0, 200) ||
          "未投递的 outbox 信封，重启恢复时已尝试安全重投；此处仅观察。",
        createdAt: envelope.createdAt,
        refs: { envelopeId: envelope.id },
      });
    } else if (
      canContinueCollaborationDepthStop(envelope) &&
      handoffEnabled !== false &&
      (maxA2ADepth === undefined || envelope.depth >= maxA2ADepth)
    ) {
      items.push({
        id: envelope.id,
        roomId,
        kind: "depth_stop",
        requiresUserConfirm: true,
        summary: "A2A 深度停止信封，可由用户继续一次；请使用下方深度停止卡片。",
        createdAt: envelope.createdAt,
        refs: { envelopeId: envelope.id },
      });
    }
  }

  items.sort(
    (a, b) =>
      (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return items;
}
