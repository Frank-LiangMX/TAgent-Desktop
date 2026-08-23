import { describe, expect, test } from "vitest"
import type {
  CollaborationMailboxEnvelope,
  CollaborationUserApprovalRequest,
} from "@tagent/shared"
import type {
  FusionRoomAuthoritySnapshot,
  FusionRoomRun,
} from "./fusion-room-authority"
import { listFusionContinuations } from "./fusion-room-continuation"

const ROOM_ID = "room-obs"

function mkSnapshot(overrides: {
  runs?: FusionRoomRun[]
  approvals?: CollaborationUserApprovalRequest[]
  mailbox?: CollaborationMailboxEnvelope[]
}): FusionRoomAuthoritySnapshot {
  return {
    roomId: ROOM_ID,
    ownerUserId: "owner",
    status: "active",
    title: "obs",
    goal: "",
    humanMembers: [{
      id: "hm_owner", roomId: ROOM_ID, userId: "owner", displayName: "房主",
      status: "active", joinedAt: 1, updatedAt: 1,
    }],
    botSeats: [],
    botOwnerConsents: {},
    workspace: {
      id: "rws_obs", roomId: ROOM_ID, kind: "server",
      storageKey: ROOM_ID, status: "active", createdAt: 1, updatedAt: 1,
    },
    messages: [],
    events: [],
    usage: [],
    files: [],
    locks: [],
    runs: overrides.runs ?? [],
    tasks: [],
    artifacts: [],
    approvals: overrides.approvals ?? [],
    mailbox: overrides.mailbox ?? [],
  }
}

function mkRun(overrides: Partial<FusionRoomRun> = {}): FusionRoomRun {
  return {
    id: "run_1", roomId: ROOM_ID, seatId: "seat_a", initiatedByUserId: "owner",
    backend: "pi", fence: 1, status: "running", createdAt: 10, updatedAt: 10,
    ...overrides,
  }
}

function mkApproval(overrides: Partial<CollaborationUserApprovalRequest> = {}): CollaborationUserApprovalRequest {
  return {
    id: "approval_1", roomId: ROOM_ID, memberId: "seat_a", runId: "run_1",
    question: "可以继续吗？", status: "pending", createdAt: 20,
    ...overrides,
  }
}

function mkEnvelope(overrides: Partial<CollaborationMailboxEnvelope> = {}): CollaborationMailboxEnvelope {
  return {
    id: "env_1", roomId: ROOM_ID, fromMemberId: "seat_a", toMemberId: "seat_b",
    type: "question", requestId: "req_1", rootMessageId: "msg_root", causationId: "run_1",
    depth: 1, state: "pending", payload: "请审阅", createdAt: 30,
    ...overrides,
  }
}

describe("listFusionContinuations", () => {
  test("空快照返回空列表", () => {
    expect(listFusionContinuations(mkSnapshot({}))).toEqual([])
  })

  test("blocked run → blocked_run，需要用户确认、副作用未知", () => {
    const items = listFusionContinuations(mkSnapshot({
      runs: [mkRun({ id: "run_blk", status: "blocked", fence: 7, summary: "中断", createdAt: 100 })],
    }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "run_blk", roomId: ROOM_ID, kind: "blocked_run",
      requiresUserConfirm: true, sideEffectRisk: "unknown",
      refs: { runId: "run_blk", seatId: "seat_a" },
    })
    expect(items[0]?.summary).toBe("中断")
    expect(items[0]?.createdAt).toBe(100)
  })

  test("pending approval → pending_approval，需要用户确认", () => {
    const items = listFusionContinuations(mkSnapshot({
      approvals: [mkApproval({ id: "approval_p", status: "pending", question: "是否执行写操作？" })],
    }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "approval_p", kind: "pending_approval",
      requiresUserConfirm: true, sideEffectRisk: "unknown",
      summary: "是否执行写操作？",
      refs: { approvalId: "approval_p", runId: "run_1" },
    })
  })

  test("outbox 信封 → mailbox_outbox，需要用户确认、副作用未知", () => {
    const items = listFusionContinuations(mkSnapshot({
      mailbox: [mkEnvelope({ id: "env_out", delivery: "outbox", payload: "未投递消息" })],
    }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "env_out", kind: "mailbox_outbox",
      requiresUserConfirm: true, sideEffectRisk: "unknown",
      summary: "未投递消息",
      refs: { envelopeId: "env_out" },
    })
  })

  test("awaiting_peer run → awaiting_peer，不需用户确认", () => {
    const items = listFusionContinuations(mkSnapshot({
      runs: [mkRun({ id: "run_wait", status: "awaiting_peer", createdAt: 50 })],
    }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "run_wait", kind: "awaiting_peer",
      requiresUserConfirm: false, sideEffectRisk: "none",
      refs: { runId: "run_wait", seatId: "seat_a" },
    })
  })

  test("completed / failed / cancelled run 不进入列表", () => {
    const items = listFusionContinuations(mkSnapshot({
      runs: [
        mkRun({ id: "run_done", status: "completed" }),
        mkRun({ id: "run_fail", status: "failed" }),
        mkRun({ id: "run_cancel", status: "cancelled" }),
      ],
    }))
    expect(items).toEqual([])
  })

  test("outbox 终态信封（cancelled / expired / 已 dispatched / outcome_unknown）不进入列表", () => {
    const items = listFusionContinuations(mkSnapshot({
      mailbox: [
        mkEnvelope({ id: "env_c", delivery: "outbox", state: "cancelled" }),
        mkEnvelope({ id: "env_e", delivery: "outbox", state: "expired" }),
        mkEnvelope({ id: "env_d", delivery: "dispatched" }),
        mkEnvelope({ id: "env_u", delivery: "outcome_unknown" }),
      ],
    }))
    expect(items.map((item) => item.kind)).not.toContain("mailbox_outbox")
    expect(items).toEqual([])
  })

  test("approved approval 且对应 run 仍等待 → approved_awaiting_resume，不需额外确认", () => {
    const items = listFusionContinuations(mkSnapshot({
      runs: [mkRun({ id: "run_appr", status: "awaiting_user", seatId: "seat_a" })],
      approvals: [mkApproval({
        id: "approval_a", status: "approved", runId: "run_appr",
        resolvedAt: 40, response: "yes",
      })],
    }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "approval_a", kind: "approved_awaiting_resume",
      requiresUserConfirm: false, sideEffectRisk: "unknown",
      refs: { approvalId: "approval_a", runId: "run_appr", seatId: "seat_a" },
    })
    expect(items[0]?.createdAt).toBe(40)
  })

  test("approved approval 但对应 run 已终态 → 不进入列表", () => {
    const items = listFusionContinuations(mkSnapshot({
      runs: [mkRun({ id: "run_done", status: "completed" })],
      approvals: [mkApproval({ id: "approval_a", status: "approved", runId: "run_done" })],
    }))
    expect(items).toEqual([])
  })

  test("可继续一次的 max_depth 停止信封 → depth_stop", () => {
    const items = listFusionContinuations(mkSnapshot({
      mailbox: [mkEnvelope({
        id: "env_stop",
        stopReason: "max_depth",
        continueUsed: false,
        attemptId: "550e8400-e29b-41d4-a716-446655440000",
        depth: 10,
        payload: "深度停止",
      })],
    }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "env_stop", kind: "depth_stop",
      requiresUserConfirm: true, sideEffectRisk: "unknown",
      refs: { envelopeId: "env_stop" },
    })
  })

  test("已 continueUsed 的 max_depth 信封不再可继续 → 不进入列表", () => {
    const items = listFusionContinuations(mkSnapshot({
      mailbox: [mkEnvelope({
        id: "env_used",
        stopReason: "max_depth",
        continueUsed: true,
        attemptId: "550e8400-e29b-41d4-a716-446655440000",
      })],
    }))
    expect(items).toEqual([])
  })

  test("多类 continuation 按 createdAt 升序排列", () => {
    const items = listFusionContinuations(mkSnapshot({
      runs: [
        mkRun({ id: "run_blk", status: "blocked", createdAt: 100 }),
        mkRun({ id: "run_wait", status: "awaiting_peer", createdAt: 10 }),
      ],
      approvals: [mkApproval({ id: "approval_p", status: "pending", createdAt: 50 })],
      mailbox: [mkEnvelope({ id: "env_out", delivery: "outbox", createdAt: 30 })],
    }))
    expect(items.map((item) => item.id)).toEqual([
      "run_wait", "env_out", "approval_p", "run_blk",
    ])
  })
})
