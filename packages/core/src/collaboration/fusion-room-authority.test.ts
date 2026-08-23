import { describe, expect, test } from "vitest"
import type { RoomBotSeat, RoomWorkspace } from "@tagent/shared"
import {
  FusionRoomAuthority,
  FusionRoomAuthorityError,
} from "./fusion-room-authority"

const workspace: RoomWorkspace = {
  id: "rws_test",
  roomId: "room_test",
  kind: "server",
  storageKey: "room_test",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
}

const seat = (id: string, ownerUserId: string): RoomBotSeat => ({
  id,
  roomId: "room_test",
  botProfileId: "bot_" + id,
  ownerUserId,
  configRevisionId: "rev_" + id,
  displayNameSnapshot: id,
  roleSnapshot: { displayName: id },
  backend: "pi",
  modelId: "test-model",
  permissionProfile: "workspace-write",
  capabilities: {
    supportsResume: true,
    supportsLiveInput: false,
    supportsToolBridge: true,
    supportsStructuredEvents: true,
  },
  status: "idle",
  logicalSessionId: "session_" + id,
  isCoordinator: false,
  createdAt: 1,
  updatedAt: 1,

})

function authority() {
  return new FusionRoomAuthority({
    roomId: "room_test",
    ownerUserId: "owner",
    workspace,
    now: 1,
  }, () => 100)
}

describe("FusionRoomAuthority", () => {
  test("人类成员邀请、接受、在线状态和 owner 权限", () => {
    const room = authority()
    expect(() => room.inviteHumanMember("user-b", "user-c", "C")).toThrow(/active/)
    const invited = room.inviteHumanMember("owner", "user-b", "B")
    expect(invited.status).toBe("invited")
    expect(() => room.appendUserMessage({
      actorUserId: "user-b",
      content: "未加入",
    })).toThrow(/active/)
    expect(room.acceptInvitation("user-b").status).toBe("active")
    expect(room.setPresence("user-b", "offline").status).toBe("offline")
    expect(room.setPresence("user-b", "active").status).toBe("active")
  })

  test("人类成员可以主动离开，房主可以移除成员且房主不可离开", () => {
    const room = authority()
    room.inviteHumanMember("owner", "user-b", "B")
    room.acceptInvitation("user-b")
    expect(room.leaveHumanMember("user-b").status).toBe("left")
    room.inviteHumanMember("owner", "user-b", "B")
    room.acceptInvitation("user-b")
    expect(room.removeHumanMember("owner", "user-b").status).toBe("removed")
    expect(() => room.leaveHumanMember("owner")).toThrow(/房主/)
    expect(() => room.removeHumanMember("owner", "owner")).toThrow(/房主/)
  })
  test("默认协调者、跨所有者授权、费用归属和消息幂等", () => {
    const room = authority()
    room.inviteHumanMember("owner", "user-b", "User B")
    room.acceptInvitation("user-b")
    const first = room.addBotSeat({ actorUserId: "owner", seat: seat("a", "owner") })
    const second = room.addBotSeat({ actorUserId: "owner", seat: seat("b", "user-b") })
    expect(first.isCoordinator).toBe(true)
    expect(second.isCoordinator).toBe(false)
    const message = room.appendUserMessage({
      actorUserId: "owner",
      content: "交给协调者",
      idempotencyKey: "message-1",
    })
    expect(message.targetMemberIds).toEqual(["a"])
    expect(room.appendUserMessage({
      actorUserId: "owner",
      content: "不同文本",
      idempotencyKey: "message-1",
    }).id).toBe(message.id)
    expect(() => room.recordUsage({
      actorUserId: "owner",
      seatId: second.id,
      inputTokens: 1,
      outputTokens: 2,
      costMicros: 3,
    })).toThrow(FusionRoomAuthorityError)
    room.setBotOwnerConsent("user-b", second.id, true)
    const usage = room.recordUsage({
      actorUserId: "owner",
      seatId: second.id,
      inputTokens: 1,
      outputTokens: 2,
      costMicros: 3,
      providerAccountUserId: "account-b",
      idempotencyKey: "usage-1",
    })
    expect(usage.botOwnerUserId).toBe("user-b")
    expect(usage.providerAccountUserId).toBe("account-b")
    expect(room.recordUsage({
      actorUserId: "owner",
      seatId: second.id,
      inputTokens: 99,
      outputTokens: 99,
      costMicros: 99,
      idempotencyKey: "usage-1",
    }).id).toBe(usage.id)
  })

  test("工作区短锁、SHA 版本和并发冲突 fail-closed", () => {
    const room = authority()
    room.inviteHumanMember("owner", "user-b", "B")
    room.acceptInvitation("user-b")
    const lock = room.acquireWorkspaceLock({
      actorUserId: "owner",
      relativePath: "docs/readme.md",
      idempotencyKey: "lock-1",
    })
    expect(() => room.acquireWorkspaceLock({
      actorUserId: "user-b",
      relativePath: "docs/readme.md",
    })).toThrow(/编辑/)
    const committed = room.commitWorkspaceFile({
      actorUserId: "owner",
      lockId: lock.id,
      relativePath: "docs/readme.md",
      content: "abc",
      idempotencyKey: "commit-1",
    })
    expect(committed.file.version).toBe(1)
    expect(committed.file.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(() => room.acquireWorkspaceLock({
      actorUserId: "user-b",
      relativePath: "../secret.txt",
    })).toThrow(/路径/)
    expect(() => room.acquireWorkspaceLock({
      actorUserId: "user-b",
      relativePath: "docs/readme.md",
      expectedSha256: "bad",
    })).toThrow(/版本/)
    const nextLock = room.acquireWorkspaceLock({
      actorUserId: "user-b",
      relativePath: "docs/readme.md",
      expectedSha256: committed.file.sha256,
    })
    expect(() => room.commitWorkspaceFile({
      actorUserId: "owner",
      lockId: nextLock.id,
      relativePath: "docs/readme.md",
      content: "overwrite",
    })).toThrow(/锁/)
  })

  test("批量工作区提交先全量校验，成功后统一变更并支持幂等重放", () => {
    const room = authority()
    const firstLock = room.acquireWorkspaceLock({ actorUserId: "owner", relativePath: "a.txt" })
    const secondLock = room.acquireWorkspaceLock({ actorUserId: "owner", relativePath: "b.txt" })
    const batch = room.commitWorkspaceFiles({
      actorUserId: "owner",
      idempotencyKey: "batch-1",
      files: [
        { lockId: firstLock.id, relativePath: "a.txt", content: "A" },
        { lockId: secondLock.id, relativePath: "b.txt", content: "B", downloadable: true },
      ],
    })
    expect(batch.files.map((file) => file.relativePath)).toEqual(["a.txt", "b.txt"])
    expect(batch.events).toHaveLength(2)
    expect(room.getSnapshot().locks).toHaveLength(0)
    expect(room.commitWorkspaceFiles({
      actorUserId: "owner",
      idempotencyKey: "batch-1",
      files: [
        { lockId: "stale-a", relativePath: "a.txt", content: "changed" },
        { lockId: "stale-b", relativePath: "b.txt", content: "changed" },
      ],
    })).toEqual(batch)

    const left = room.acquireWorkspaceLock({ actorUserId: "owner", relativePath: "left.txt" })
    const right = room.acquireWorkspaceLock({ actorUserId: "owner", relativePath: "right.txt" })
    const before = room.getSnapshot()
    expect(() => room.commitWorkspaceFiles({
      actorUserId: "owner",
      files: [
        { lockId: left.id, relativePath: "left.txt", content: "left" },
        { lockId: right.id, relativePath: "right.txt", content: "right", expectedSha256: "wrong" },
      ],
    })).toThrow(/冲突|版本/)
    expect(room.getSnapshot().files).toEqual(before.files)
    expect(room.getSnapshot().locks).toEqual(before.locks)
    expect(() => room.commitWorkspaceFiles({
      actorUserId: "owner",
      files: [
        { lockId: left.id, relativePath: "same.txt", content: "1" },
        { lockId: right.id, relativePath: "same.txt", content: "2" },
      ],
    })).toThrow(/重复路径/)
  })
  test("快照恢复保留事件序列和公开消息投影", () => {
    const room = authority()
    room.addBotSeat({ actorUserId: "owner", seat: seat("a", "owner") })
    const message = room.appendUserMessage({
      actorUserId: "owner",
      content: "persist",
    })
    const restored = FusionRoomAuthority.fromSnapshot(room.getSnapshot(), () => 200)
    expect(restored.getSnapshot().messages[0]?.id).toBe(message.id)
    const next = restored.appendUserMessage({
      actorUserId: "owner",
      content: "next",
    })
    const events = restored.getSnapshot().events
    expect(next.id).not.toBe(message.id)
    expect(events.at(-1)?.sequence).toBe(events.length)
    expect(events.some((event) => event.type === "room.created")).toBe(true)
  })

  test("运行 fencing 防止旧 KSCC/Pi 结果回写，撤销授权会取消运行", () => {
    const room = authority()
    const first = room.addBotSeat({ actorUserId: "owner", seat: seat("a", "owner") })
    const running = room.startRun({
      actorUserId: "owner",
      seatId: first.id,
      backend: "pi",
    })
    expect(room.getSnapshot().botSeats[0]?.status).toBe("running")
    expect(() => room.startRun({
      actorUserId: "owner",
      seatId: first.id,
      backend: "kscc",
    })).toThrow(/running/)
    expect(() => room.finishRun({
      actorUserId: "owner",
      runId: running.id,
      fence: running.fence - 1,
      status: "completed",
    })).toThrow(/fencing/)
    const finished = room.finishRun({
      actorUserId: "owner",
      runId: running.id,
      fence: running.fence,
      status: "completed",
      summary: "done",
    })
    expect(finished.status).toBe("completed")
    expect(room.getSnapshot().botSeats[0]?.status).toBe("idle")
    const second = room.startRun({
      actorUserId: "owner",
      seatId: first.id,
      backend: "kscc",
    })
    expect(second.fence).toBeGreaterThan(running.fence)
    const restored = FusionRoomAuthority.fromSnapshot(room.getSnapshot(), () => 200)
    restored.finishRun({
      actorUserId: "owner",
      runId: second.id,
      fence: second.fence,
      status: "completed",
    })
    const third = restored.startRun({
      actorUserId: "owner",
      seatId: first.id,
      backend: "pi",
    })
    expect(third.fence).toBeGreaterThan(second.fence)
    restored.setBotOwnerConsent("owner", first.id, false)
    expect(restored.getSnapshot().runs.find((item) => item.id === third.id)?.status).toBe("cancelled")
  })
  test("受控执行器可以回写成员消息，且保留回复链与幂等", () => {
    const room = authority()
    const bot = room.addBotSeat({ actorUserId: "owner", seat: seat("reply", "owner") })
    room.addBotSeat({ actorUserId: "owner", seat: seat("other", "user-b") })
    const user = room.appendUserMessage({ actorUserId: "owner", content: "请分析" })
    const reply = room.appendMemberMessage({
      actorUserId: "owner", seatId: bot.id, content: "分析结果",
      replyToMessageId: user.id, rootMessageId: user.rootMessageId,
      runId: "run_reply", depth: 0, idempotencyKey: "member-reply-1",
    })
    expect(reply.authorType).toBe("member")
    expect(reply.authorId).toBe(bot.id)
    expect(reply.replyToMessageId).toBe(user.id)
    expect(reply.rootMessageId).toBe(user.rootMessageId)
    expect(room.appendMemberMessage({
      actorUserId: "owner", seatId: bot.id, content: "不同文本", idempotencyKey: "member-reply-1",
    }).id).toBe(reply.id)
    expect(() => room.appendMemberMessage({
      actorUserId: "owner", seatId: "missing", content: "越权",
    })).toThrow(/席位/)
    const other = room.getSnapshot().botSeats.find((item) => item.id.endsWith("other"))
    expect(other).toBeDefined()
    expect(() => room.appendMemberMessage({
      actorUserId: "owner", seatId: other!.id, content: "未授权",
    })).toThrow(/授权/)
  })
  test('房主可代邀请其他用户的 Bot，但不能代签 owner consent', () => {
    const room = authority()
    room.inviteHumanMember('owner', 'bot-owner', 'Bot Owner')
    room.acceptInvitation('bot-owner')
    const foreignSeat = seat('foreign-bot', 'bot-owner')
    expect(() => room.addBotSeat({ actorUserId: 'intruder', seat: foreignSeat })).toThrow(/房主或 Bot 所有人/)
    const added = room.addBotSeat({ actorUserId: 'owner', seat: foreignSeat, ownerConsent: true })
    expect(room.getSnapshot().botOwnerConsents[added.id]).toBe(false)
    expect(() => room.appendMemberMessage({ actorUserId: 'owner', seatId: added.id, content: '未授权' })).toThrow(/授权/)
    room.setBotOwnerConsent('bot-owner', added.id, true)
    expect(room.appendMemberMessage({ actorUserId: 'owner', seatId: added.id, content: '已授权' }).authorType).toBe('member')
  })
  test("task authority supports create, transitions, CAS, idempotency, and legacy restore", () => {
    const room = authority()
    const task = room.createTask({
      actorUserId: "owner",
      roomId: "room_test",
      task: { title: "remote task", description: "projection", status: "todo" },
      idempotencyKey: "task-create-1",
    })
    expect(task.id).toMatch(/^crt_/)
    expect(task.version).toBe(1)
    expect(room.getSnapshot().tasks).toEqual([task])
    const artifactBot = room.addBotSeat({ actorUserId: "owner", seat: seat("artifact", "owner") })
    const artifact = room.publishArtifact({
      actorUserId: "owner", roomId: "room_test", memberId: artifactBot.id,
      relativePath: "dist/out.txt", content: "artifact", taskId: task.id, summary: "release",
      idempotencyKey: "artifact-1",
    })
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(artifact.relativePath).toBe("dist/out.txt")
    expect(room.createTask({
      actorUserId: "owner",
      roomId: "room_test",
      task: { title: "duplicate request", status: "todo" },
      idempotencyKey: "task-create-1",
    }).id).toBe(task.id)

    const running = room.updateTask({
      actorUserId: "owner",
      roomId: "room_test",
      taskId: task.id,
      status: "in_progress",
      expectedVersion: 1,
    })
    expect(running.status).toBe("in_progress")
    expect(running.version).toBe(2)
    expect(() => room.updateTask({
      actorUserId: "owner",
      roomId: "room_test",
      taskId: task.id,
      status: "todo",
      expectedVersion: 2,
    })).toThrow(/transition/)
    expect(() => room.updateTask({
      actorUserId: "owner",
      roomId: "room_test",
      taskId: task.id,
      title: "stale update",
      expectedVersion: 1,
    })).toThrow(/stale/)

    const legacy = authority().getSnapshot()
    delete (legacy as { tasks?: unknown }).tasks
    expect(FusionRoomAuthority.fromSnapshot(legacy).getSnapshot().tasks).toEqual([])
  })
  test("remote approvals and A2A mailbox are authoritative, bounded, and idempotent", () => {
    const room = authority()
    const first = room.addBotSeat({ actorUserId: "owner", seat: seat("approval-bot", "owner") })
    const second = room.addBotSeat({ actorUserId: "owner", seat: seat("peer-bot", "owner") })
    const firstRun = room.startRun({ actorUserId: "owner", seatId: first.id, backend: "pi" })
    const secondRun = room.startRun({ actorUserId: "owner", seatId: second.id, backend: "pi" })
    const root = room.appendUserMessage({ actorUserId: "owner", content: "coordinate" })

    const approval = room.requestUserApproval({
      actorUserId: "owner", roomId: "room_test", memberId: first.id, runId: firstRun.id,
      question: "Publish the result?", options: ["yes", "no"], idempotencyKey: "approval-1",
    })
    expect(approval.status).toBe("pending")
    expect(room.requestUserApproval({
      actorUserId: "owner", roomId: "room_test", memberId: first.id, runId: firstRun.id,
      question: "ignored", idempotencyKey: "approval-1",
    }).id).toBe(approval.id)
    expect(room.resolveUserApproval({
      actorUserId: "owner", roomId: "room_test", requestId: approval.id,
      decision: "approved", response: "go", idempotencyKey: "approval-resolve-1",
    }).status).toBe("approved")

    const question = room.sendMailbox({
      actorUserId: "owner", roomId: "room_test", fromMemberId: first.id,
      toMemberId: second.id, runId: firstRun.id, type: "question",
      payload: "Please review", rootMessageId: root.id, idempotencyKey: "mailbox-1",
    })
    expect(question.type).toBe("question")
    expect(question.depth).toBe(0)
    expect(room.sendMailbox({
      actorUserId: "owner", roomId: "room_test", fromMemberId: first.id,
      toMemberId: second.id, runId: firstRun.id, type: "question",
      payload: "ignored", rootMessageId: root.id, idempotencyKey: "mailbox-1",
    }).id).toBe(question.id)
    const reply = room.replyMailbox({
      actorUserId: "owner", roomId: "room_test", requestId: question.requestId!,
      runId: secondRun.id, answer: "Reviewed", idempotencyKey: "mailbox-reply-1",
    })
    expect(reply.type).toBe("reply")
    expect(room.getSnapshot().mailbox.find((item) => item.id === question.id)?.state).toBe("answered")
    expect(() => room.sendMailbox({
      actorUserId: "owner", roomId: "room_test", fromMemberId: first.id,
      toMemberId: first.id, runId: firstRun.id, type: "message",
      payload: "loop", rootMessageId: root.id,
    })).toThrow(/self-send/)
  })

  test("房间元数据标题和目标支持持久化、更新和幂等", () => {
    const room = authority()
    expect(room.getSnapshot().title).toBe("room_test")
    expect(room.getSnapshot().goal).toBe("")
    room.updateMetadata({
      actorUserId: "owner",
      roomId: "room_test",
      title: "  远程研究室  ",
      goal: "验证融合会话",
      idempotencyKey: "metadata-1",
    })
    const snapshot = room.getSnapshot()
    expect(snapshot.title).toBe("远程研究室")
    expect(snapshot.goal).toBe("验证融合会话")
    room.updateMetadata({
      actorUserId: "owner",
      roomId: "room_test",
      title: "另一个标题",
      idempotencyKey: "metadata-1",
    })
    expect(room.getSnapshot().title).toBe("远程研究室")
    expect(FusionRoomAuthority.fromSnapshot(snapshot).getSnapshot().title).toBe("远程研究室")
    expect(() => room.updateMetadata({
      actorUserId: "not-owner",
      roomId: "room_test",
      title: "越权",
    })).toThrow(FusionRoomAuthorityError)
  })

  test("删除保留 tombstone，移动要求双锁且不覆盖目标", () => {
    const room = authority()
    const firstLock = room.acquireWorkspaceLock({ actorUserId: "owner", relativePath: "src/old.ts" })
    const created = room.commitWorkspaceFile({
      actorUserId: "owner", lockId: firstLock.id, relativePath: "src/old.ts", content: "content",
    })
    const fromLock = room.acquireWorkspaceLock({ actorUserId: "owner", relativePath: "src/old.ts", expectedSha256: created.file.sha256 })
    const toLock = room.acquireWorkspaceLock({ actorUserId: "owner", relativePath: "src/new.ts" })
    const moved = room.moveWorkspaceFile({
      actorUserId: "owner", fromLockId: fromLock.id, toLockId: toLock.id,
      fromPath: "src/old.ts", toPath: "src/new.ts", expectedSha256: created.file.sha256,
      idempotencyKey: "move-1",
    })
    expect(moved.toFile.relativePath).toBe("src/new.ts")
    expect(room.getSnapshot().files.find((file) => file.relativePath === "src/old.ts")?.deleted).toBe(true)
    expect(room.getSnapshot().files.find((file) => file.relativePath === "src/new.ts")?.deleted).toBeUndefined()
    const deleteLock = room.acquireWorkspaceLock({ actorUserId: "owner", relativePath: "src/new.ts", expectedSha256: moved.toFile.sha256 })
    const deleted = room.deleteWorkspaceFile({
      actorUserId: "owner", lockId: deleteLock.id, relativePath: "src/new.ts", expectedSha256: moved.toFile.sha256,
      idempotencyKey: "delete-1",
    })
    expect(deleted.file.deleted).toBe(true)
    expect(room.deleteWorkspaceFile({
      actorUserId: "owner", lockId: "stale", relativePath: "src/new.ts", idempotencyKey: "delete-1",
    })).toEqual(deleted)
  })})
