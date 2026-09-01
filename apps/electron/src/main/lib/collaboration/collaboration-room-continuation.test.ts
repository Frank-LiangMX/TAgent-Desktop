/**
 * 协作室「待确认续跑」service 行为测试（P2-1）。
 *
 * 覆盖 CollaborationRoomService.listContinuations（纯函数派生 + 房间字段透传）与
 * confirmResumeBlockedRun（新 turn 续跑、不复活旧 fence、幂等键不冲突、幂等返回同一
 * newRunId、各类失败守卫）。通过 TAGENT_CONFIG_DIR 指向临时目录 + 注入 mock adapter，
 * 直接 upsert blocked run 模拟 recoverInterruptedRuns 标记的中断态。
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MemberBackendAdapter,
  MemberTurnInput,
  MemberTurnResult,
  CollaborationMemberCapabilities,
} from "@tagent/shared";
import { CollaborationRoomService } from "./collaboration-room-service";
import { upsertMember, upsertRun } from "./collaboration-room-repository";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `tagent-collab-continuation-test-`));
  process.env.TAGENT_CONFIG_DIR = tmpDir;
});

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

const MOCK_CAPS: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
};

function createMockAdapter(text = "mock reply"): MemberBackendAdapter {
  const calls: MemberTurnInput[] = [];
  const adapter: MemberBackendAdapter = {
    capabilities: () => MOCK_CAPS,
    runTurn: async (input: MemberTurnInput): Promise<MemberTurnResult> => {
      calls.push(input);
      if (input.onTextDelta) input.onTextDelta(text);
      return { text };
    },
  };
  return adapter;
}

function createService(
  adapter: MemberBackendAdapter = createMockAdapter(),
): CollaborationRoomService {
  return CollaborationRoomService.create({ adapter });
}

function createRoomWithCoordinator(svc: CollaborationRoomService): {
  roomId: string;
  coordinatorId: string;
} {
  const room = svc.createRoom({
    title: "续跑测试",
    members: [{ displayName: "协调者", isCoordinator: true }],
  });
  const coord = svc.listMembers(room.id)[0]!;
  return { roomId: room.id, coordinatorId: coord.id };
}

/** 在 active 房间里落盘一条真实用户触发消息（暂停时追加只落盘不触发 run）。 */
function appendTriggerMessage(
  svc: CollaborationRoomService,
  roomId: string,
  content: string,
): string {
  svc.updateRoom({ roomId, status: "paused" });
  const msg = svc.appendUserMessage({ roomId, content });
  svc.updateRoom({ roomId, status: "active" });
  return msg.id;
}

/** 直接落盘一个 blocked run（模拟 recoverInterruptedRuns 标记的中断态）。 */
function seedBlockedRun(opts: {
  roomId: string;
  memberId: string;
  triggerMessageId: string;
  runId?: string;
  fence?: number;
  idempotencyKey?: string;
}): void {
  upsertRun({
    id: opts.runId ?? "run_blk",
    roomId: opts.roomId,
    memberId: opts.memberId,
    triggerMessageId: opts.triggerMessageId,
    idempotencyKey: opts.idempotencyKey ?? `${opts.triggerMessageId}:${opts.memberId}`,
    status: "blocked",
    attempt: 0,
    fence: opts.fence ?? 0,
  });
}

/** 直接落盘一个 failed run（模拟成员后端失败后的历史记录）。 */
function seedFailedRun(opts: {
  roomId: string;
  memberId: string;
  triggerMessageId: string;
  runId?: string;
  fence?: number;
}): void {
  upsertRun({
    id: opts.runId ?? "run_failed",
    roomId: opts.roomId,
    memberId: opts.memberId,
    triggerMessageId: opts.triggerMessageId,
    idempotencyKey: `${opts.triggerMessageId}:${opts.memberId}`,
    status: "failed",
    attempt: 1,
    fence: opts.fence ?? 3,
    error: { code: "UPSTREAM_FAILED", message: "上游不可用" },
  });
}

describe("CollaborationRoomService.listContinuations（P2-1）", () => {
  test("blocked run → listContinuations 出现 blocked_run 项", () => {
    const svc = createService();
    const { roomId, coordinatorId } = createRoomWithCoordinator(svc);
    const triggerId = appendTriggerMessage(svc, roomId, "你好");
    seedBlockedRun({ roomId, memberId: coordinatorId, triggerMessageId: triggerId });

    const items = svc.listContinuations(roomId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "blocked_run",
      requiresUserConfirm: true,
      roomId,
    });
    expect(items[0]!.refs?.runId).toBe("run_blk");
  });

  test("未知房间 → 返回空列表（不抛错）", () => {
    const svc = createService();
    expect(svc.listContinuations("cr_nonexistent")).toEqual([]);
  });

  test("正常 done run 不进入续跑列表", async () => {
    const svc = createService();
    const { roomId } = createRoomWithCoordinator(svc);
    svc.appendUserMessage({ roomId, content: "跑完" });
    await svc.awaitAllRuns();
    expect(svc.listRuns(roomId)[0]!.status).toBe("done");
    expect(svc.listContinuations(roomId)).toEqual([]);
  });
});

describe("CollaborationRoomService.confirmResumeBlockedRun（P2-1）", () => {
  test("确认继续：新建 queued run（新 id/fence），旧 run 保持 blocked，幂等键不冲突", async () => {
    const svc = createService();
    const { roomId, coordinatorId } = createRoomWithCoordinator(svc);
    const triggerId = appendTriggerMessage(svc, roomId, "继续我");
    // 旧 blocked run：fence=5，幂等键 trigger:member
    seedBlockedRun({
      roomId,
      memberId: coordinatorId,
      triggerMessageId: triggerId,
      runId: "run_blk",
      fence: 5,
    });

    const result = svc.confirmResumeBlockedRun({
      roomId,
      runId: "run_blk",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const newRunId = result.newRunId;
    expect(newRunId).not.toBe("run_blk");

    // 旧 run 仍 blocked，fence 不变（不复活旧 fence）
    const oldRun = svc.getRunById("run_blk")!;
    expect(oldRun.status).toBe("blocked");
    expect(oldRun.fence).toBe(5);

    // 新 run：新对象（新 id）、非 blocked、同一 memberId + triggerMessageId，幂等键不与旧键冲突
    // （新 fence 0 起步，调度器启动后可能已递增到 1，但绝不沿用旧 run 的 fence 5）。
    const newRun = svc.getRunById(newRunId)!;
    expect(newRun.status).not.toBe("blocked");
    expect(newRun.fence).not.toBe(oldRun.fence);
    expect(newRun.memberId).toBe(coordinatorId);
    expect(newRun.triggerMessageId).toBe(triggerId);
    expect(newRun.idempotencyKey).not.toBe(oldRun.idempotencyKey);
    expect(newRun.idempotencyKey.startsWith("resume-of:run_blk:")).toBe(true);

    // 新 run 经调度器跑完（mock adapter）
    await svc.awaitAllRuns();
    expect(svc.getRunById(newRunId)!.status).toBe("done");
    // 旧 run 仍 blocked，fence 仍为 5（未复活旧 fence）
    expect(svc.getRunById("run_blk")!.status).toBe("blocked");
    expect(svc.getRunById("run_blk")!.fence).toBe(5);
  });

  test("幂等：同 idempotencyKey 重复调用返回同一 newRunId，不二次新建", () => {
    const svc = createService();
    const { roomId, coordinatorId } = createRoomWithCoordinator(svc);
    const triggerId = appendTriggerMessage(svc, roomId, "幂等续跑");
    seedBlockedRun({
      roomId,
      memberId: coordinatorId,
      triggerMessageId: triggerId,
      runId: "run_blk2",
    });

    const key = "resume-blocked:run_blk2";
    const r1 = svc.confirmResumeBlockedRun({
      roomId,
      runId: "run_blk2",
      idempotencyKey: key,
    });
    const r2 = svc.confirmResumeBlockedRun({
      roomId,
      runId: "run_blk2",
      idempotencyKey: key,
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.newRunId).toBe(r2.newRunId);
    // 新 run 的幂等键即调用方键，且不等于旧 blocked run 键
    const newRun = svc.getRunById(r1.newRunId)!;
    expect(newRun.idempotencyKey).toBe(key);
    expect(newRun.idempotencyKey).not.toBe(
      svc.getRunById("run_blk2")!.idempotencyKey,
    );
  });

  test("房间未激活 → 失败", () => {
    const svc = createService();
    const { roomId, coordinatorId } = createRoomWithCoordinator(svc);
    const triggerId = appendTriggerMessage(svc, roomId, "暂停态");
    seedBlockedRun({
      roomId,
      memberId: coordinatorId,
      triggerMessageId: triggerId,
      runId: "run_blk3",
    });
    svc.updateRoom({ roomId, status: "paused" });
    const result = svc.confirmResumeBlockedRun({
      roomId,
      runId: "run_blk3",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("未激活");
  });

  test("run 不存在或跨房间 → 失败", () => {
    const svc = createService();
    const { roomId } = createRoomWithCoordinator(svc);
    const result = svc.confirmResumeBlockedRun({
      roomId,
      runId: "run_missing",
    });
    expect(result.ok).toBe(false);
  });

  test("run 非 blocked 状态 → 失败", async () => {
    const svc = createService();
    const { roomId } = createRoomWithCoordinator(svc);
    svc.appendUserMessage({ roomId, content: "跑完" });
    await svc.awaitAllRuns();
    const doneRun = svc.listRuns(roomId)[0]!;
    const result = svc.confirmResumeBlockedRun({
      roomId,
      runId: doneRun.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("blocked");
  });

  test("成员已移除 → 失败", () => {
    const svc = createService();
    const { roomId, coordinatorId } = createRoomWithCoordinator(svc);
    const triggerId = appendTriggerMessage(svc, roomId, "成员没了");
    seedBlockedRun({
      roomId,
      memberId: coordinatorId,
      triggerMessageId: triggerId,
      runId: "run_blk4",
    });
    const coord = svc.listMembers(roomId)[0]!;
    upsertMember({ ...coord, status: "removed" });
    const result = svc.confirmResumeBlockedRun({
      roomId,
      runId: "run_blk4",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("成员");
  });

  test("触发消息已删除（triggerMessageId 找不到）→ 失败", () => {
    const svc = createService();
    const { roomId, coordinatorId } = createRoomWithCoordinator(svc);
    seedBlockedRun({
      roomId,
      memberId: coordinatorId,
      triggerMessageId: "msg_nonexistent",
      runId: "run_blk5",
    });
    const result = svc.confirmResumeBlockedRun({
      roomId,
      runId: "run_blk5",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("触发消息");
  });
});

describe("CollaborationRoomService.retryRun（P1 恢复动作）", () => {
  test("failed run 重试：旧 run 保持 failed，新 run 完成", async () => {
    const svc = createService();
    const { roomId, coordinatorId } = createRoomWithCoordinator(svc);
    const triggerId = appendTriggerMessage(svc, roomId, "请重试");
    seedFailedRun({
      roomId,
      memberId: coordinatorId,
      triggerMessageId: triggerId,
      runId: "run_failed",
      fence: 7,
    });

    const result = svc.retryRun({
      roomId,
      runId: "run_failed",
      idempotencyKey: "retry-run:run_failed:same",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const oldRun = svc.getRunById("run_failed")!;
    const newRun = svc.getRunById(result.newRunId)!;
    expect(oldRun.status).toBe("failed");
    expect(oldRun.fence).toBe(7);
    expect(newRun.id).not.toBe(oldRun.id);
    expect(newRun.fence).not.toBe(oldRun.fence);
    expect(newRun.memberId).toBe(coordinatorId);
    expect(newRun.triggerMessageId).toBe(triggerId);

    await svc.awaitAllRuns();
    expect(svc.getRunById(result.newRunId)!.status).toBe("done");
    expect(svc.getRunById("run_failed")!.status).toBe("failed");
  });

  test("换成员重试：新 run 使用选择的成员；重复调用幂等", async () => {
    const svc = createService();
    const room = svc.createRoom({
      title: "换成员重试",
      members: [
        { displayName: "协调者", isCoordinator: true },
        { displayName: "审阅者" },
      ],
    });
    const members = svc.listMembers(room.id);
    const coordinator = members.find((member) => member.isCoordinator)!;
    const reviewer = members.find((member) => !member.isCoordinator)!;
    const triggerId = appendTriggerMessage(svc, room.id, "换人再试");
    seedFailedRun({
      roomId: room.id,
      memberId: coordinator.id,
      triggerMessageId: triggerId,
      runId: "run_switch",
    });

    const key = "retry-run:run_switch:reviewer";
    const first = svc.retryRun({
      roomId: room.id,
      runId: "run_switch",
      memberId: reviewer.id,
      idempotencyKey: key,
    });
    const second = svc.retryRun({
      roomId: room.id,
      runId: "run_switch",
      memberId: reviewer.id,
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.newRunId).toBe(first.newRunId);
    expect(svc.getRunById(first.newRunId)!.memberId).toBe(reviewer.id);
    expect(svc.listRuns(room.id)).toHaveLength(2);

    await svc.awaitAllRuns();
    expect(svc.getRunById(first.newRunId)!.status).toBe("done");
  });

  test("blocked/done run 不允许走普通重试入口", async () => {
    const svc = createService();
    const { roomId, coordinatorId } = createRoomWithCoordinator(svc);
    const triggerId = appendTriggerMessage(svc, roomId, "状态守卫");
    seedBlockedRun({
      roomId,
      memberId: coordinatorId,
      triggerMessageId: triggerId,
      runId: "run_blocked_no_retry",
    });
    const blocked = svc.retryRun({
      roomId,
      runId: "run_blocked_no_retry",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("blocked");

    svc.appendUserMessage({ roomId, content: "完成后再试" });
    await svc.awaitAllRuns();
    const doneRun = svc.listRuns(roomId).find((run) => run.status === "done")!;
    const done = svc.retryRun({ roomId, runId: doneRun.id });
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.reason).toContain("failed");
  });
});
