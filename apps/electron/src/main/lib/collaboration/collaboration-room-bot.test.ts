import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotConfigRevision, BotProfile } from "@tagent/shared";
import { createBotProfile } from "../bot/bot-profile-service";
import { CollaborationRoomService } from "./collaboration-room-service";

let configDir = "";

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "tagent-collab-bot-"));
  process.env.TAGENT_CONFIG_DIR = configDir;
});

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

function seedBot(id: string, name: string, version = 1, ownerUserId = "user-a"): void {
  const now = Date.now();
  const profile: BotProfile = {
    id,
    ownerUserId,
    displayName: name,
    status: "active",
    currentConfigRevisionId: `${id}-r${version}`,
    memoryNamespace: id,
    createdAt: now,
    updatedAt: now,
  };
  const revision: BotConfigRevision = {
    id: `${id}-r${version}`,
    botProfileId: id,
    version,
    backend: "channel",
    channelId: `channel-${id}`,
    modelId: `model-${id}`,
    roleSnapshot: {
      roleId: `role-${id}`,
      displayName: name,
      description: `${name} 角色`,
      systemPrompt: `你是 ${name}`,
    },
    permissionProfile: "read-only",
    capabilities: {
      supportsResume: true,
      supportsLiveInput: true,
      supportsToolBridge: false,
      supportsStructuredEvents: true,
    },
    createdAt: now,
    publishedAt: now,
  };
  createBotProfile(profile, revision);
}

describe("协作室 Bot 快照桥接", () => {
  test("房间保留来源统一会话，便于升级后恢复同一协作室", () => {
    seedBot("bot-room-source", "来源 Bot");
    const service = CollaborationRoomService.create();
    const room = service.createRoom({
      title: "来源会话房间",
      sourceSessionId: "session-source-1",
      members: [{ botProfileId: "bot-room-source", displayName: "来源 Bot" }],
    });
    expect(service.getRoomById(room.id)?.sourceSessionId).toBe(
      "session-source-1",
    );
  });

  test("创建房间时把 Bot 当前 revision 复制到成员，首个 Bot 为协调者", () => {
    seedBot("bot-room-a", "研究 Bot");
    const service = CollaborationRoomService.create();
    const room = service.createRoom({
      title: "Bot 房间",
      members: [{ botProfileId: "bot-room-a", displayName: "临时名称" }],
    });
    const member = service.listMembers(room.id)[0]!;
    expect(member.botProfileId).toBe("bot-room-a");
    expect(member.configRevisionId).toBe("bot-room-a-r1");
    expect(member.displayName).toBe("研究 Bot");
    expect(member.roleSnapshot.systemPrompt).toBe("你是 研究 Bot");
    expect(member.channelId).toBe("channel-bot-room-a");
    expect(member.modelId).toBe("model-bot-room-a");
    expect(member.isCoordinator).toBe(true);
    expect(room.coordinatorMemberId).toBe(member.id);
  });

  test("空房间追加首个 Bot 时也设置协调者，第二个 Bot 不抢协调者", () => {
    seedBot("bot-room-b", "第一 Bot");
    seedBot("bot-room-c", "第二 Bot");
    const service = CollaborationRoomService.create();
    const room = service.createRoom({ title: "追加 Bot" });
    const first = service.addMember(room.id, {
      botProfileId: "bot-room-b",
      displayName: "x",
    });
    const second = service.addMember(room.id, {
      botProfileId: "bot-room-c",
      displayName: "y",
    });
    expect(first.isCoordinator).toBe(true);
    expect(second.isCoordinator).toBe(false);
    expect(service.getRoomById(room.id)?.coordinatorMemberId).toBe(first.id);
    expect(
      service.listMembers(room.id).map((member) => member.botProfileId),
    ).toEqual(["bot-room-b", "bot-room-c"]);
  });

  test("移除 Bot 保留快照，协调者由替换 Bot 接任", () => {
    seedBot("bot-room-d", "旧 Bot");
    seedBot("bot-room-e", "新 Bot");
    const service = CollaborationRoomService.create();
    const room = service.createRoom({
      title: "替换 Bot",
      members: [{ botProfileId: "bot-room-d", displayName: "旧 Bot" }],
    });
    const oldMember = service.listMembers(room.id)[0]!;
    const removed = service.removeMember({
      roomId: room.id,
      memberId: oldMember.id,
    });
    expect(removed.status).toBe("removed");
    expect(removed.botProfileId).toBe("bot-room-d");
    expect(removed.configRevisionId).toBe("bot-room-d-r1");
    expect(removed.removedAt).toBeTypeOf("number");
    expect(removed.handoffSummary).toBe("");
    expect(service.listMessages(room.id).at(-1)?.content).toContain("没有可接任的协调者");
    expect(service.getRoomById(room.id)?.coordinatorMemberId).toBe("");

    const replacement = service.addMember(room.id, {
      botProfileId: "bot-room-e",
      displayName: "新 Bot",
    });
    expect(replacement.id).not.toBe(oldMember.id);
    expect(replacement.botProfileId).toBe("bot-room-e");
    expect(replacement.configRevisionId).toBe("bot-room-e-r1");
    expect(replacement.isCoordinator).toBe(true);
    expect(service.getRoomById(room.id)?.coordinatorMemberId).toBe(
      replacement.id,
    );
    expect(service.listMembers(room.id)).toHaveLength(2);
  });

  test("HumanMember 状态机控制房间消息发送", () => {
    const service = CollaborationRoomService.create();
    const room = service.createRoom({ title: "多人房间" });

    const invited = service.inviteHumanMember({
      roomId: room.id,
      userId: "user-b",
      displayName: "协作者",
    });
    expect(invited.status).toBe("invited");
    expect(() =>
      service.appendUserMessage({
        roomId: room.id,
        actorUserId: "user-b",
        content: "未接受邀请不能发言",
      }),
    ).toThrow(/活跃成员/);

    const joined = service.joinHumanMember({
      roomId: room.id,
      userId: "user-b",
      actorUserId: "user-b",
    });
    expect(joined.status).toBe("active");
    const message = service.appendUserMessage({
      roomId: room.id,
      actorUserId: "user-b",
      content: "现在可以发言",
    });
    expect(message.authorId).toBe("user-b");

    const left = service.leaveHumanMember({
      roomId: room.id,
      userId: "user-b",
      actorUserId: "user-b",
    });
    expect(left.status).toBe("left");
    expect(() =>
      service.appendUserMessage({
        roomId: room.id,
        actorUserId: "user-b",
        content: "离开后不能发言",
      }),
    ).toThrow(/活跃成员/);
  });

  test("跨用户 Bot 只能由 Bot 所有人授权", () => {
    seedBot("bot-owner-consent", "跨用户 Bot");
    const service = CollaborationRoomService.create();
    const room = service.createRoom({
      title: "授权房间",
      ownerUserId: "local-user",
      members: [{ botProfileId: "bot-owner-consent", displayName: "跨用户 Bot" }],
    });
    const member = service.listMembers(room.id)[0]!;
    expect(member.ownerConsent).toBe(false);
    expect(() =>
      service.setBotOwnerConsent({
        roomId: room.id,
        memberId: member.id,
        consent: true,
        actorUserId: "local-user",
      }),
    ).toThrow(/所有人/);

    const granted = service.setBotOwnerConsent({
      roomId: room.id,
      memberId: member.id,
      consent: true,
      actorUserId: "user-a",
    });
    expect(granted.ownerConsent).toBe(true);

    const revoked = service.setBotOwnerConsent({
      roomId: room.id,
      memberId: member.id,
      consent: false,
      actorUserId: "user-a",
    });
    expect(revoked.ownerConsent).toBe(false);
  });
  test("打包本地模式拒绝远程用户和他人 Bot，但允许本机 Bot", () => {
    seedBot("bot-local-only", "本机 Bot", 1, "local-user");
    seedBot("bot-remote-only", "远程 Bot", 1, "user-a");
    const service = CollaborationRoomService.create({ localOnly: true });
    const room = service.createRoom({
      title: "本地融合房间",
      members: [{ botProfileId: "bot-local-only", displayName: "本机 Bot" }],
    });

    expect(() =>
      service.inviteHumanMember({
        roomId: room.id,
        userId: "user-b",
        displayName: "远程用户",
      }),
    ).toThrow(/本地融合模式/);
    expect(() =>
      service.addMember(room.id, {
        botProfileId: "bot-remote-only",
        displayName: "远程 Bot",
      }),
    ).toThrow(/其他用户所有的 Bot/);
    expect(() =>
      service.createRoom({
        title: "远程房主房间",
        ownerUserId: "user-b",
      }),
    ).toThrow(/本机用户/);
    expect(service.listMembers(room.id)[0]?.botOwnerUserId).toBe("local-user");
  });
});
