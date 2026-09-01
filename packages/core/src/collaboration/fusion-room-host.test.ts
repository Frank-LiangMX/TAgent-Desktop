import { describe, expect, test } from "vitest"
import type { CollaborationMailboxEnvelope, RoomBotSeat, RoomWorkspace } from "@tagent/shared"
import { FusionRoomHost } from "./fusion-room-host"
import { FusionRoomAuthorityError } from "./fusion-room-authority"

const workspace: RoomWorkspace = {
  id: "rws_host",
  roomId: "host-room",
  kind: "server",
  storageKey: "host-room",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
}

function mkSeat(id: string, roomId: string, botProfileId: string): RoomBotSeat {
  return {
    id, roomId, botProfileId, ownerUserId: "owner",
    configRevisionId: "rev_" + botProfileId,
    displayNameSnapshot: botProfileId, roleSnapshot: { displayName: botProfileId },
    backend: "pi", modelId: "test-model", permissionProfile: "read-only",
    capabilities: { supportsResume: false, supportsLiveInput: false, supportsToolBridge: false, supportsStructuredEvents: false },
    status: "idle", logicalSessionId: "session_" + botProfileId, isCoordinator: false, createdAt: 1, updatedAt: 1,
  }
}

describe("FusionRoomHost", () => {
  test("按房间隔离分发并广播权威事件", () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: "host-room", ownerUserId: "owner", workspace, now: 1 })
    const notifications: string[] = []
    const stop = host.subscribe("host-room", (notification) => {
      notifications.push(...notification.events.map((event) => event.type))
    })
    host.dispatch("host-room", {
      type: "invite-human",
      actorUserId: "owner",
      userId: "user-b",
      displayName: "B",
    })
    host.dispatch("host-room", { type: "accept-invitation", userId: "user-b" })
    const message = host.dispatch("host-room", {
      type: "message",
      input: { actorUserId: "user-b", content: "hello" },
    })
    expect(message && "content" in message ? message.content : "").toBe("hello")
    expect(notifications).toEqual([
      "human-member.changed",
      "human-member.changed",
      "message.appended",
    ])
    stop()
    host.dispatch("host-room", {
      type: "status",
      actorUserId: "owner",
      status: "paused",
    })
    expect(notifications).toHaveLength(3)
    expect(host.listRoomIds()).toEqual(["host-room"])
  })

  test("快照存储自动保存，新的 Host 按 roomId 惰性恢复并继续分发", () => {
    const persisted = new Map<string, any>()
    const store = {
      load: (roomId: string) => persisted.get(roomId),
      save: (snapshot: any) => persisted.set(snapshot.roomId, snapshot),
      listRoomIds: () => [...persisted.keys()],
    }
    const host = new FusionRoomHost({ snapshotStore: store })
    host.createRoom({
      roomId: "persisted-room",
      ownerUserId: "owner",
      workspace: { ...workspace, id: "rws_persisted", roomId: "persisted-room", storageKey: "persisted-room" },
    })
    host.dispatch("persisted-room", {
      type: "message",
      input: { actorUserId: "owner", content: "before restart", idempotencyKey: "m1" },
    })
    const resumed = new FusionRoomHost({ snapshotStore: store })
    expect(resumed.listRoomIds()).toEqual(["persisted-room"])
    expect(resumed.getSnapshot("persisted-room").messages[0]?.content).toBe("before restart")
    resumed.dispatch("persisted-room", {
      type: "message",
      input: { actorUserId: "owner", content: "after restart", idempotencyKey: "m2" },
    })
    const events = resumed.getSnapshot("persisted-room").events
    expect(events.at(-1)?.sequence).toBe(events.length)
    expect(resumed.getSnapshot("persisted-room").messages.at(-1)?.content).toBe("after restart")
  })
  test("错误动作不广播，快照可以恢复到新的 Host", () => {
    const host = new FusionRoomHost()
    const snapshot = host.createRoom({
      roomId: "restore-room",
      ownerUserId: "owner",
      workspace: { ...workspace, id: "rws_restore", roomId: "restore-room", storageKey: "restore-room" },
    })
    expect(() => host.dispatch("restore-room", {
      type: "message",
      input: { actorUserId: "unknown", content: "no" },
    })).toThrow(FusionRoomAuthorityError)
    const restored = new FusionRoomHost()
    restored.restoreRoom(snapshot)
    expect(restored.getSnapshot("restore-room").events[0]?.type).toBe("room.created")
    expect(() => restored.getSnapshot("missing")).toThrow(/不存在/)
  })

  test("工作区物理提交失败时回滚权威快照和文件事务", () => {
    const transactions: Array<{ committed: boolean; rolledBack: boolean }> = []
    const store = {
      prepareCommit: () => {
        const state = { committed: false, rolledBack: false }
        transactions.push(state)
        return {
          commit: () => {
            state.committed = true
            throw new Error("disk failure")
          },
          rollback: () => {
            state.rolledBack = true
          },
        }
      },
    }
    const host = new FusionRoomHost({ workspaceStore: store })
    host.createRoom({
      roomId: "workspace-room",
      ownerUserId: "owner",
      workspace: { ...workspace, id: "rws_workspace", roomId: "workspace-room", storageKey: "workspace-room" },
    })
    host.dispatch("workspace-room", {
      type: "lock",
      input: { actorUserId: "owner", relativePath: "notes.md" },
    })
    const before = host.getSnapshot("workspace-room")
    expect(() => host.dispatch("workspace-room", {
      type: "commit-file",
      input: {
        actorUserId: "owner",
        lockId: before.locks[0]!.id,
        relativePath: "notes.md",
        content: "should rollback",
      },
    })).toThrow("disk failure")
    const after = host.getSnapshot("workspace-room")
    expect(after.files).toEqual(before.files)
    expect(after.locks).toEqual(before.locks)
    expect(transactions).toEqual([{ committed: true, rolledBack: true }])
  })

  test("多文件物理提交任一文件失败时全部事务逆序回滚", () => {
    const transactions: Array<{ path?: string; committed: boolean; rolledBack: boolean }> = []
    const store = {
      prepareCommit: (input: { relativePath: string }) => {
        const state = { path: input.relativePath, committed: false, rolledBack: false }
        transactions.push(state)
        return {
          commit: () => {
            state.committed = true
            if (state.path === "b.txt") throw new Error("second disk failure")
          },
          rollback: () => { state.rolledBack = true },
        }
      },
    }
    const host = new FusionRoomHost({ workspaceStore: store })
    host.createRoom({
      roomId: "batch-workspace-room",
      ownerUserId: "owner",
      workspace: { ...workspace, id: "rws_batch_workspace", roomId: "batch-workspace-room", storageKey: "batch-workspace-room" },
    })
    host.dispatch("batch-workspace-room", { type: "lock", input: { actorUserId: "owner", relativePath: "a.txt" } })
    host.dispatch("batch-workspace-room", { type: "lock", input: { actorUserId: "owner", relativePath: "b.txt" } })
    const before = host.getSnapshot("batch-workspace-room")
    expect(() => host.dispatch("batch-workspace-room", {
      type: "commit-files",
      input: {
        actorUserId: "owner",
        files: [
          { lockId: before.locks[0]!.id, relativePath: "a.txt", content: "A" },
          { lockId: before.locks[1]!.id, relativePath: "b.txt", content: "B" },
        ],
      },
    })).toThrow("second disk failure")
    expect(host.getSnapshot("batch-workspace-room").files).toEqual(before.files)
    expect(host.getSnapshot("batch-workspace-room").locks).toEqual(before.locks)
    expect(transactions).toEqual([
      { path: "a.txt", committed: true, rolledBack: true },
      { path: "b.txt", committed: true, rolledBack: true },
    ])
  })
  test("Host 通过统一动作账本广播成员输出", () => {
    const host = new FusionRoomHost()
    host.createRoom({ roomId: "member-output-room", ownerUserId: "owner", workspace: { ...workspace, id: "rws_member_output", roomId: "member-output-room", storageKey: "member-output-room" }, now: 1 })
    const seat: RoomBotSeat = {
      id: "seat-host", roomId: "member-output-room", botProfileId: "bot-host", ownerUserId: "owner",
      configRevisionId: "rev-host", displayNameSnapshot: "开发者", roleSnapshot: { displayName: "开发者" },
      backend: "pi", modelId: "test-model", permissionProfile: "read-only",
      capabilities: { supportsResume: false, supportsLiveInput: false, supportsToolBridge: false, supportsStructuredEvents: false },
      status: "idle", logicalSessionId: "session-host", isCoordinator: false, createdAt: 1, updatedAt: 1,
    }
    host.dispatch("member-output-room", { type: "add-bot", input: { actorUserId: "owner", seat } })
    const result = host.dispatch("member-output-room", {
      type: "member-message",
      input: { actorUserId: "owner", seatId: "seat-host", content: "已完成分析", idempotencyKey: "member-output-1" },
    })
    expect(result && "authorType" in result ? result.authorType : "").toBe("member")
    expect(host.getSnapshot("member-output-room").events.at(-1)?.type).toBe("message.appended")
  })
  test("重启恢复不会重放未知副作用的运行", () => {
    const host = new FusionRoomHost()
    const roomId = "recovery-room"
    host.createRoom({
      roomId,
      ownerUserId: "owner",
      workspace: { ...workspace, id: "rws_recovery", roomId, storageKey: roomId },
      now: 1,
    })
    const seat: RoomBotSeat = {
      id: "seat-recovery", roomId, botProfileId: "bot-recovery", ownerUserId: "owner",
      configRevisionId: "rev-recovery", displayNameSnapshot: "恢复测试 Bot", roleSnapshot: { displayName: "恢复测试 Bot" },
      backend: "pi", modelId: "test-model", permissionProfile: "read-only",
      capabilities: { supportsResume: false, supportsLiveInput: false, supportsToolBridge: false, supportsStructuredEvents: false },
      status: "idle", logicalSessionId: "session-recovery", isCoordinator: false, createdAt: 1, updatedAt: 1,
    }
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat } })
    const started = host.dispatch(roomId, {
      type: "start-run",
      input: { actorUserId: "owner", seatId: seat.id, backend: "pi", idempotencyKey: "recovery-start" },
    })
    expect(started && "status" in started ? started.status : "").toBe("running")

    const recovered = host.recoverInterruptedRuns()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.status).toBe("blocked")
    expect(recovered[0]?.summary).toContain("未自动重放")
    expect(host.getSnapshot(roomId).runs[0]?.status).toBe("blocked")
  })

  test("重启恢复后可列出 blocked continuation 且需用户确认", () => {
    const host = new FusionRoomHost()
    const roomId = "list-recovery-room"
    host.createRoom({ roomId, ownerUserId: "owner", workspace: { ...workspace, id: "rws_list", roomId, storageKey: roomId }, now: 1 })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat-list", roomId, "bot-list") } })
    host.dispatch(roomId, {
      type: "start-run",
      input: { actorUserId: "owner", seatId: "seat-list", backend: "pi", idempotencyKey: "list-start" },
    })
    host.recoverInterruptedRuns()
    const items = host.listContinuations(roomId)
    const blocked = items.find((item) => item.kind === "blocked_run")
    expect(blocked).toBeTruthy()
    expect(blocked?.requiresUserConfirm).toBe(true)
    expect(blocked?.sideEffectRisk).toBe("unknown")
    expect(blocked?.id).toBe(host.getSnapshot(roomId).runs[0]?.id)
  })

  test("confirmResumeContinuation 对 blocked run 幂等且写 run.resume_confirmed，旧 run 不复活", () => {
    const host = new FusionRoomHost()
    const roomId = "confirm-blocked-room"
    host.createRoom({ roomId, ownerUserId: "owner", workspace: { ...workspace, id: "rws_cb", roomId, storageKey: roomId }, now: 1 })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat-cb", roomId, "bot-cb") } })
    host.dispatch(roomId, {
      type: "start-run",
      input: { actorUserId: "owner", seatId: "seat-cb", backend: "pi", idempotencyKey: "cb-start" },
    })
    host.recoverInterruptedRuns()
    const run = host.getSnapshot(roomId).runs[0]!
    expect(run.status).toBe("blocked")
    const fenceBefore = run.fence
    const eventsBefore = host.getSnapshot(roomId).events.length

    const result = host.confirmResumeContinuation({
      roomId, actorUserId: "owner", continuationId: run.id, kind: "blocked_run", idempotencyKey: "cb-confirm-1",
    })
    expect(result.status).toBe("confirmed")
    expect(result.kind).toBe("blocked_run")
    expect(result.event.type).toBe("run.resume_confirmed")
    expect(result.runStatus).toBe("blocked")
    // 旧 run 不得悄悄变回 running 并用同一 fence 继续
    const runAfter = host.getSnapshot(roomId).runs[0]!
    expect(runAfter.status).toBe("blocked")
    expect(runAfter.fence).toBe(fenceBefore)
    expect(host.getSnapshot(roomId).events.length).toBe(eventsBefore + 1)

    // 幂等：同 idempotencyKey 重复确认返回 already_confirmed，不新增事件
    const again = host.confirmResumeContinuation({
      roomId, actorUserId: "owner", continuationId: run.id, kind: "blocked_run", idempotencyKey: "cb-confirm-1",
    })
    expect(again.status).toBe("already_confirmed")
    expect(again.event.id).toBe(result.event.id)
    expect(host.getSnapshot(roomId).events.length).toBe(eventsBefore + 1)
    expect(host.getSnapshot(roomId).runs[0]?.status).toBe("blocked")
  })

  test("retry-run 为 failed run 创建新 fence，支持换成员且幂等", () => {
    const host = new FusionRoomHost()
    const roomId = "retry-run-room"
    host.createRoom({ roomId, ownerUserId: "owner", workspace: { ...workspace, id: "rws_retry", roomId, storageKey: roomId }, now: 1 })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat-a", roomId, "bot-a") } })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat-b", roomId, "bot-b") } })
    const message = host.dispatch(roomId, {
      type: "message",
      input: { actorUserId: "owner", content: "请执行并在失败后重试" },
    })
    const messageId = message && "id" in message ? message.id : ""
    const started = host.dispatch(roomId, {
      type: "start-run",
      input: { actorUserId: "owner", seatId: "seat-a", backend: "pi", triggerMessageId: messageId, idempotencyKey: "retry-start" },
    })
    const oldRun = started && "fence" in started ? started : undefined
    expect(oldRun).toBeTruthy()
    const failed = host.dispatch(roomId, {
      type: "finish-run",
      input: {
        actorUserId: "owner",
        runId: oldRun!.id,
        fence: oldRun!.fence,
        status: "failed",
        summary: "上游不可用",
      },
    })
    expect(failed && "status" in failed ? failed.status : "").toBe("failed")

    const retried = host.dispatch(roomId, {
      type: "retry-run",
      input: {
        actorUserId: "owner",
        runId: oldRun!.id,
        seatId: "seat-b",
        idempotencyKey: "retry-once",
      },
    })
    expect(retried && "status" in retried ? retried.status : "").toBe("running")
    expect(retried && "seatId" in retried ? retried.seatId : "").toBe("seat-b")
    expect(retried && "fence" in retried ? retried.fence : 0).toBe(1)
    expect(host.getSnapshot(roomId).runs.find((run) => run.id === oldRun!.id)?.status).toBe("failed")

    const again = host.dispatch(roomId, {
      type: "retry-run",
      input: {
        actorUserId: "owner",
        runId: oldRun!.id,
        seatId: "seat-b",
        idempotencyKey: "retry-once",
      },
    })
    expect(again && "id" in again ? again.id : "").toBe(retried && "id" in retried ? retried.id : "")
    expect(host.getSnapshot(roomId).runs).toHaveLength(2)
  })

  test("continue-depth-stop 保留旧停止证据并创建新信封/新 run，且幂等", () => {
    const host = new FusionRoomHost()
    const roomId = "depth-continue-room"
    host.createRoom({ roomId, ownerUserId: "owner", workspace: { ...workspace, id: "rws_depth", roomId, storageKey: roomId }, now: 1 })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat-a", roomId, "bot-a") } })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat-b", roomId, "bot-b") } })
    const message = host.dispatch(roomId, {
      type: "message",
      input: { actorUserId: "owner", content: "深度停止源消息" },
    })
    const messageId = message && "id" in message ? message.id : ""
    const stopped: CollaborationMailboxEnvelope = {
      id: "env-stop",
      roomId,
      fromMemberId: "seat-a",
      toMemberId: "seat-b",
      type: "question",
      payload: "请继续审阅",
      rootMessageId: messageId,
      causationId: "run-old",
      depth: 4,
      state: "cancelled",
      attemptId: "550e8400-e29b-41d4-a716-446655440000",
      delivery: "failed",
      stopReason: "max_depth",
      continueUsed: false,
      sourceMessageId: messageId,
      createdAt: 2,
    }
    const resumedHost = new FusionRoomHost()
    resumedHost.restoreRoom({ ...host.getSnapshot(roomId), mailbox: [stopped] })

    const result = resumedHost.dispatch(roomId, {
      type: "continue-depth-stop",
      input: {
        roomId,
        actorUserId: "owner",
        envelopeId: stopped.id,
        idempotencyKey: "depth-continue-once",
      },
    })
    expect(result && "status" in result ? result.status : "").toBe("continued")
    expect(result && "newEnvelopeId" in result ? result.newEnvelopeId : "").not.toBe(stopped.id)
    expect(result && "runId" in result ? result.runId : "").toBeTruthy()

    const snapshot = resumedHost.getSnapshot(roomId)
    expect(snapshot.mailbox.find((item) => item.id === stopped.id)?.continueUsed).toBe(true)
    const nextEnvelope = snapshot.mailbox.find((item) => item.id !== stopped.id)!
    expect(nextEnvelope.depth).toBe(stopped.depth + 1)
    expect(nextEnvelope.delivery).toBe("dispatched")
    expect(nextEnvelope.deliveryRunId).toBe(result && "runId" in result ? result.runId : "")
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.runs[0]?.seatId).toBe("seat-b")
    expect(snapshot.runs[0]?.status).toBe("running")

    const again = resumedHost.dispatch(roomId, {
      type: "continue-depth-stop",
      input: {
        roomId,
        actorUserId: "owner",
        envelopeId: stopped.id,
        idempotencyKey: "depth-continue-once",
      },
    })
    expect(again && "newEnvelopeId" in again ? again.newEnvelopeId : "").toBe(nextEnvelope.id)
    expect(resumedHost.getSnapshot(roomId).mailbox).toHaveLength(2)
    expect(resumedHost.getSnapshot(roomId).runs).toHaveLength(1)
  })

  test("confirmResumeContinuation 对 outbox 信封 delivery 合法前进到 dispatched，幂等", () => {
    const host = new FusionRoomHost()
    const roomId = "confirm-outbox-room"
    host.createRoom({ roomId, ownerUserId: "owner", workspace: { ...workspace, id: "rws_co", roomId, storageKey: roomId }, now: 1 })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat_a", roomId, "bot-a") } })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat_b", roomId, "bot-b") } })
    const message = host.dispatch(roomId, { type: "message", input: { actorUserId: "owner", content: "root" } })
    const rootId = message && "id" in message ? message.id : ""
    const run = host.dispatch(roomId, {
      type: "start-run",
      input: { actorUserId: "owner", seatId: "seat_a", backend: "pi", idempotencyKey: "co-start" },
    })
    const runId = run && "id" in run ? run.id : ""
    const envelope = host.dispatch(roomId, {
      type: "send-mailbox",
      input: {
        actorUserId: "owner", roomId, fromMemberId: "seat_a", toMemberId: "seat_b",
        runId, type: "question", payload: "请审阅", rootMessageId: rootId, idempotencyKey: "co-send",
      },
    })
    const envelopeId = envelope && "id" in envelope ? envelope.id : ""
    expect(host.getSnapshot(roomId).mailbox[0]?.delivery).toBe("outbox")

    const items = host.listContinuations(roomId)
    const outbox = items.find((item) => item.kind === "mailbox_outbox")
    expect(outbox?.id).toBe(envelopeId)
    expect(outbox?.requiresUserConfirm).toBe(true)

    const result = host.confirmResumeContinuation({
      roomId, actorUserId: "owner", continuationId: envelopeId, kind: "mailbox_outbox", idempotencyKey: "co-confirm-1",
    })
    expect(result.status).toBe("confirmed")
    expect(result.delivery).toBe("dispatched")
    expect(result.event.type).toBe("mailbox.changed")
    expect(result.event.payload.mailboxAction).toBe("resume_dispatched")
    expect(host.getSnapshot(roomId).mailbox[0]?.delivery).toBe("dispatched")

    // 幂等：同 idempotencyKey 重复确认返回 already_confirmed
    const again = host.confirmResumeContinuation({
      roomId, actorUserId: "owner", continuationId: envelopeId, kind: "mailbox_outbox", idempotencyKey: "co-confirm-1",
    })
    expect(again.status).toBe("already_confirmed")
    expect(again.event.id).toBe(result.event.id)
  })

  test("outbox confirm 拒绝非法迁移：已 dispatched 信封不得再 confirm", () => {
    const host = new FusionRoomHost()
    const roomId = "confirm-illegal-room"
    host.createRoom({ roomId, ownerUserId: "owner", workspace: { ...workspace, id: "rws_ci", roomId, storageKey: roomId }, now: 1 })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat_a", roomId, "bot-a") } })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat_b", roomId, "bot-b") } })
    const message = host.dispatch(roomId, { type: "message", input: { actorUserId: "owner", content: "root" } })
    const rootId = message && "id" in message ? message.id : ""
    const run = host.dispatch(roomId, { type: "start-run", input: { actorUserId: "owner", seatId: "seat_a", backend: "pi", idempotencyKey: "ci-start" } })
    const runId = run && "id" in run ? run.id : ""
    const envelope = host.dispatch(roomId, {
      type: "send-mailbox",
      input: { actorUserId: "owner", roomId, fromMemberId: "seat_a", toMemberId: "seat_b", runId, type: "question", payload: "请审阅", rootMessageId: rootId, idempotencyKey: "ci-send" },
    })
    const envelopeId = envelope && "id" in envelope ? envelope.id : ""
    // 先合法推进到 dispatched
    host.confirmResumeContinuation({ roomId, actorUserId: "owner", continuationId: envelopeId, kind: "mailbox_outbox", idempotencyKey: "ci-confirm-1" })
    expect(host.getSnapshot(roomId).mailbox[0]?.delivery).toBe("dispatched")

    // 已 dispatched 再用新 idempotencyKey confirm → 非法迁移拒绝
    let caught: unknown
    try {
      host.confirmResumeContinuation({
        roomId, actorUserId: "owner", continuationId: envelopeId, kind: "mailbox_outbox", idempotencyKey: "ci-confirm-2",
      })
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(FusionRoomAuthorityError)
    expect((caught as FusionRoomAuthorityError).code).toBe("INVALID_STATE")

    // 同幂等键仍返回 already_confirmed，不视作非法
    const again = host.confirmResumeContinuation({
      roomId, actorUserId: "owner", continuationId: envelopeId, kind: "mailbox_outbox", idempotencyKey: "ci-confirm-1",
    })
    expect(again.status).toBe("already_confirmed")
  })

  test("confirmResumeContinuation 非成员 FORBIDDEN / 错误 continuationId NOT_FOUND / 不支持 kind INVALID_STATE", () => {
    const host = new FusionRoomHost()
    const roomId = "confirm-auth-room"
    host.createRoom({ roomId, ownerUserId: "owner", workspace: { ...workspace, id: "rws_ca", roomId, storageKey: roomId }, now: 1 })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat_a", roomId, "bot-a") } })
    host.dispatch(roomId, { type: "start-run", input: { actorUserId: "owner", seatId: "seat_a", backend: "pi", idempotencyKey: "ca-start" } })
    host.recoverInterruptedRuns()
    const runId = host.getSnapshot(roomId).runs[0]!.id

    // 非成员（陌生人不在房间）→ FORBIDDEN
    let caught: unknown
    try {
      host.confirmResumeContinuation({ roomId, actorUserId: "stranger", continuationId: runId, kind: "blocked_run" })
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(FusionRoomAuthorityError)
    expect((caught as FusionRoomAuthorityError).code).toBe("FORBIDDEN")

    // 错误 continuationId → NOT_FOUND
    caught = undefined
    try {
      host.confirmResumeContinuation({ roomId, actorUserId: "owner", continuationId: "run_missing", kind: "blocked_run" })
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(FusionRoomAuthorityError)
    expect((caught as FusionRoomAuthorityError).code).toBe("NOT_FOUND")

    // 不支持的 kind（pending_approval 应走 resolve-approval）→ INVALID_STATE
    caught = undefined
    try {
      host.confirmResumeContinuation({ roomId, actorUserId: "owner", continuationId: runId, kind: "pending_approval" })
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(FusionRoomAuthorityError)
    expect((caught as FusionRoomAuthorityError).code).toBe("INVALID_STATE")
  })

  test("重启后新 Host 仍能列出 blocked run 与 outbox 信封", () => {
    const persisted = new Map<string, any>()
    const store = {
      load: (id: string) => persisted.get(id),
      save: (snapshot: any) => persisted.set(snapshot.roomId, snapshot),
      listRoomIds: () => [...persisted.keys()],
    }
    const host = new FusionRoomHost({ snapshotStore: store })
    const roomId = "restart-observe-room"
    host.createRoom({ roomId, ownerUserId: "owner", workspace: { ...workspace, id: "rws_ro", roomId, storageKey: roomId }, now: 1 })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat_a", roomId, "bot-a") } })
    host.dispatch(roomId, { type: "add-bot", input: { actorUserId: "owner", seat: mkSeat("seat_b", roomId, "bot-b") } })
    const message = host.dispatch(roomId, { type: "message", input: { actorUserId: "owner", content: "root" } })
    const rootId = message && "id" in message ? message.id : ""
    // 一条 running run（重启后会被 recover 标 blocked）+ 一条 outbox 信封
    const run = host.dispatch(roomId, { type: "start-run", input: { actorUserId: "owner", seatId: "seat_a", backend: "pi", idempotencyKey: "ro-start" } })
    const runId = run && "id" in run ? run.id : ""
    host.dispatch(roomId, {
      type: "send-mailbox",
      input: { actorUserId: "owner", roomId, fromMemberId: "seat_a", toMemberId: "seat_b", runId, type: "question", payload: "未投递", rootMessageId: rootId, idempotencyKey: "ro-send" },
    })

    // 模拟进程退出 + 重启：新 Host 从同一快照存储恢复
    const restarted = new FusionRoomHost({ snapshotStore: store })
    expect(restarted.listRoomIds()).toContain(roomId)
    restarted.recoverInterruptedRuns()
    const items = restarted.listContinuations(roomId)
    expect(items.map((item) => item.kind)).toEqual(expect.arrayContaining(["blocked_run", "mailbox_outbox"]))
    const blocked = items.find((item) => item.kind === "blocked_run")
    const outbox = items.find((item) => item.kind === "mailbox_outbox")
    expect(blocked?.requiresUserConfirm).toBe(true)
    expect(outbox?.requiresUserConfirm).toBe(true)
  })
})
