/**
 * 本地协作室「待确认续跑」纯函数测试（P2-1）。
 *
 * 覆盖 listLocalCollaborationContinuations 的分类规则、requiresUserConfirm 语义、
 * 终态过滤、handoffEnabled/maxA2ADepth 门控、稳定排序与 refs 填充。离线纯函数，不读 DB。
 */
import { describe, expect, test } from "vitest";
import {
  listLocalCollaborationContinuations,
  localCollaborationContinuationKindLabel,
  type LocalCollaborationContinuationItem,
  type LocalCollaborationContinuationKind,
} from "./collaboration-local-continuation";
import type {
  CollaborationMailboxEnvelope,
  CollaborationRun,
  CollaborationRunStatus,
  CollaborationUserApprovalRequest,
} from "./collaboration-room";

const ROOM_ID = "cr_test";

function mkRun(
  overrides: Partial<CollaborationRun> & { id: string } = { id: "run_1" },
): CollaborationRun {
  return {
    roomId: ROOM_ID,
    memberId: "cm_a",
    triggerMessageId: "msg_trigger",
    idempotencyKey: `msg_trigger:cm_a`,
    status: "queued",
    attempt: 0,
    fence: 0,
    createdAt: 100,
    ...overrides,
  };
}

function mkEnvelope(
  overrides: Partial<CollaborationMailboxEnvelope> & { id: string } = {
    id: "env_1",
  },
): CollaborationMailboxEnvelope {
  return {
    roomId: ROOM_ID,
    fromMemberId: "cm_a",
    toMemberId: "cm_b",
    type: "question",
    rootMessageId: "msg_root",
    causationId: "msg_parent",
    depth: 4,
    state: "pending",
    payload: "hello",
    createdAt: 100,
    ...overrides,
  };
}

const VALID_ATTEMPT_ID = "11111111-1111-1111-8111-111111111111";

function mkApproval(
  overrides: Partial<CollaborationUserApprovalRequest> & { id: string } = {
    id: "approval_1",
  },
): CollaborationUserApprovalRequest {
  return {
    roomId: ROOM_ID,
    memberId: "cm_a",
    runId: "run_1",
    question: "是否继续？",
    status: "pending",
    createdAt: 100,
    ...overrides,
  };
}

describe("listLocalCollaborationContinuations", () => {
  test("blocked run → blocked_run，requiresUserConfirm=true，refs 含 runId/memberId", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [mkRun({ id: "run_b", status: "blocked", memberId: "cm_a" })],
      mailbox: [],
      approvals: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "run_b",
      roomId: ROOM_ID,
      kind: "blocked_run",
      requiresUserConfirm: true,
    });
    expect(items[0]!.refs).toEqual({ runId: "run_b", memberId: "cm_a" });
  });

  test("awaiting_peer / awaiting_user → 只读观察（requiresUserConfirm=false）", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [
        mkRun({ id: "run_p", status: "awaiting_peer" }),
        mkRun({ id: "run_u", status: "awaiting_user" }),
      ],
      mailbox: [],
      approvals: [],
    });
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("awaiting_peer");
    expect(kinds).toContain("awaiting_user");
    expect(items.every((i) => i.requiresUserConfirm === false)).toBe(true);
  });

  test("终态 run（queued/running/done/failed/cancelled）不进入列表", () => {
    const terminal: CollaborationRunStatus[] = [
      "queued",
      "running",
      "done",
      "failed",
      "cancelled",
    ];
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: terminal.map((status, i) => mkRun({ id: `run_${i}`, status })),
      mailbox: [],
      approvals: [],
    });
    expect(items).toEqual([]);
  });

  test("pending approval → pending_approval，requiresUserConfirm=true，summary=question", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [],
      mailbox: [],
      approvals: [
        mkApproval({
          id: "ap_1",
          runId: "run_x",
          memberId: "cm_a",
          question: "执行危险命令吗？",
          status: "pending",
        }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "ap_1",
      kind: "pending_approval",
      requiresUserConfirm: true,
      summary: "执行危险命令吗？",
    });
    expect(items[0]!.refs).toEqual({
      approvalId: "ap_1",
      runId: "run_x",
      memberId: "cm_a",
    });
  });

  test("非 pending approval（approved/denied/cancelled）不进入列表", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [],
      mailbox: [],
      approvals: [
        mkApproval({ id: "ap_a", status: "approved" }),
        mkApproval({ id: "ap_d", status: "denied" }),
        mkApproval({ id: "ap_c", status: "cancelled" }),
      ],
    });
    expect(items).toEqual([]);
  });

  test("delivery=outbox 且未终态 → mailbox_outbox，requiresUserConfirm=false（仅观察）", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [],
      mailbox: [
        mkEnvelope({
          id: "env_o",
          delivery: "outbox",
          state: "pending",
          payload: "一条未投递消息",
        }),
      ],
      approvals: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "env_o",
      kind: "mailbox_outbox",
      requiresUserConfirm: false,
    });
    expect(items[0]!.summary).toContain("一条未投递消息");
  });

  test("outbox 终态信封（cancelled/expired）不进入列表", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [],
      mailbox: [
        mkEnvelope({
          id: "env_c",
          delivery: "outbox",
          state: "cancelled",
        }),
        mkEnvelope({
          id: "env_e",
          delivery: "outbox",
          state: "expired",
        }),
      ],
      approvals: [],
    });
    expect(items).toEqual([]);
  });

  test("可继续的 max_depth 停止信封 → depth_stop，requiresUserConfirm=true", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [],
      mailbox: [
        mkEnvelope({
          id: "env_ds",
          delivery: "dispatched",
          state: "delivered",
          stopReason: "max_depth",
          continueUsed: false,
          attemptId: VALID_ATTEMPT_ID,
          depth: 4,
        }),
      ],
      approvals: [],
      maxA2ADepth: 4,
      handoffEnabled: true,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "env_ds",
      kind: "depth_stop",
      requiresUserConfirm: true,
    });
  });

  test("handoffEnabled=false 时不列出 depth_stop", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [],
      mailbox: [
        mkEnvelope({
          id: "env_ds",
          delivery: "dispatched",
          state: "delivered",
          stopReason: "max_depth",
          continueUsed: false,
          attemptId: VALID_ATTEMPT_ID,
          depth: 4,
        }),
      ],
      approvals: [],
      maxA2ADepth: 4,
      handoffEnabled: false,
    });
    expect(items).toEqual([]);
  });

  test("已 continueUsed 的停止信封不再作为 depth_stop 列出", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [],
      mailbox: [
        mkEnvelope({
          id: "env_used",
          delivery: "dispatched",
          state: "delivered",
          stopReason: "max_depth",
          continueUsed: true,
          attemptId: VALID_ATTEMPT_ID,
          depth: 4,
        }),
      ],
      approvals: [],
      maxA2ADepth: 4,
      handoffEnabled: true,
    });
    expect(items).toEqual([]);
  });

  test("outbox 优先于 depth_stop：同一信封只出现一次（mailbox_outbox）", () => {
    // 一个 outbox 且 stopReason=max_depth 的信封：delivery=outbox 命中 mailbox_outbox 分支，
    // 不再走 depth_stop 分支（Fusion 对齐：outbox 优先）。
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [],
      mailbox: [
        mkEnvelope({
          id: "env_both",
          delivery: "outbox",
          state: "pending",
          stopReason: "max_depth",
          continueUsed: false,
          attemptId: VALID_ATTEMPT_ID,
          depth: 4,
        }),
      ],
      approvals: [],
      maxA2ADepth: 4,
      handoffEnabled: true,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("mailbox_outbox");
  });

  test("稳定排序：createdAt 升序，再按 id 升序", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [
        mkRun({ id: "run_z", status: "blocked", createdAt: 300 }),
        mkRun({ id: "run_a", status: "blocked", createdAt: 100 }),
        mkRun({ id: "run_m", status: "blocked", createdAt: 200 }),
      ],
      mailbox: [],
      approvals: [],
    });
    expect(items.map((i) => i.id)).toEqual(["run_a", "run_m", "run_z"]);
  });

  test("createdAt 相同则按 id 升序", () => {
    const items = listLocalCollaborationContinuations({
      roomId: ROOM_ID,
      runs: [
        mkRun({ id: "run_b", status: "blocked", createdAt: 100 }),
        mkRun({ id: "run_a", status: "blocked", createdAt: 100 }),
      ],
      mailbox: [],
      approvals: [],
    });
    expect(items.map((i) => i.id)).toEqual(["run_a", "run_b"]);
  });

  test("空输入返回空列表", () => {
    expect(
      listLocalCollaborationContinuations({
        roomId: ROOM_ID,
        runs: [],
        mailbox: [],
        approvals: [],
      }),
    ).toEqual([]);
  });

  test("label map 覆盖全部 kind", () => {
    const kinds: LocalCollaborationContinuationKind[] = [
      "blocked_run",
      "pending_approval",
      "awaiting_peer",
      "awaiting_user",
      "depth_stop",
      "mailbox_outbox",
    ];
    for (const kind of kinds) {
      expect(localCollaborationContinuationKindLabel[kind]).toBeTruthy();
    }
  });

  test("综合：混合输入按规则分类与排序", () => {
    const items: LocalCollaborationContinuationItem[] =
      listLocalCollaborationContinuations({
        roomId: ROOM_ID,
        runs: [
          mkRun({ id: "run_done", status: "done", createdAt: 50 }), // 终态，跳过
          mkRun({ id: "run_blk", status: "blocked", createdAt: 220 }),
          mkRun({ id: "run_peer", status: "awaiting_peer", createdAt: 210 }),
        ],
        mailbox: [
          mkEnvelope({
            id: "env_out",
            delivery: "outbox",
            state: "pending",
            createdAt: 200,
          }),
          mkEnvelope({
            id: "env_ds",
            delivery: "dispatched",
            state: "delivered",
            stopReason: "max_depth",
            continueUsed: false,
            attemptId: VALID_ATTEMPT_ID,
            depth: 4,
            createdAt: 230,
          }),
        ],
        approvals: [
          mkApproval({ id: "ap_1", status: "pending", createdAt: 205 }),
        ],
        maxA2ADepth: 4,
        handoffEnabled: true,
      });
    expect(items.map((i) => i.kind)).toEqual([
      "mailbox_outbox",
      "pending_approval",
      "awaiting_peer",
      "blocked_run",
      "depth_stop",
    ]);
  });
});
