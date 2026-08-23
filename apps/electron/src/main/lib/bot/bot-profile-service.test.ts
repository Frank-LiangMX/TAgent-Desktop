import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BotConfigRevision, BotProfile } from "@tagent/shared";

let botsPath = "";

vi.mock("../config/config-paths", () => ({
  getBotProfilesPath: () => botsPath,
  getBotMemoriesPath: () => botsPath,
}));

const {
  archiveBotProfile,
  createBotProfile,
  getBotProfileRecord,
  loadBotProfiles,
  publishBotConfigRevision,
  saveBotProfileRecord,
  validateBotProfileRecord,
} = await import("./bot-profile-service");

describe("bot-profile-service", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tagent-bot-profile-test-"));
    botsPath = join(tempDir, "bots.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const makeProfile = (): BotProfile => ({
    id: "bot-researcher",
    ownerUserId: "user-a",
    displayName: "研究助手",
    description: "整理资料并给出可验证结论",
    status: "active",
    currentConfigRevisionId: "bot-researcher-r1",
    memoryNamespace: "bot:user-a:bot-researcher",
    createdAt: 100,
    updatedAt: 100,
  });

  const makeRevision = (
    version = 1,
    id = `bot-researcher-r${version}`,
  ): BotConfigRevision => ({
    id,
    botProfileId: "bot-researcher",
    version,
    backend: "channel",
    channelId: "kscc",
    modelId: "glm-5.2",
    roleSnapshot: {
      roleId: "analyst",
      displayName: "软件架构师",
      description: "分析与研究",
      systemPrompt: "你负责研究和验证。",
    },
    permissionProfile: "read-only",
    capabilities: {
      supportsResume: true,
      supportsLiveInput: false,
      supportsToolBridge: true,
      supportsStructuredEvents: true,
    },
    createdAt: version * 100,
    publishedAt: version * 100,
  });

  test("首次创建必须同时保存 profile 和首个 revision", () => {
    const record = createBotProfile(makeProfile(), makeRevision());
    expect(record.profile.id).toBe("bot-researcher");
    expect(loadBotProfiles()).toHaveLength(1);
    expect(getBotProfileRecord("bot-researcher")?.revisions).toHaveLength(1);
  });

  test("没有 revision 或 current revision 不存在时拒绝", () => {
    const profile = makeProfile();
    expect(validateBotProfileRecord({ profile, revisions: [] })).toContain(
      "profile 至少需要一个 config revision",
    );
    expect(() => saveBotProfileRecord({ profile, revisions: [] })).toThrow(
      "至少需要一个",
    );
  });

  test("revision 只能追加下一个版本", () => {
    createBotProfile(makeProfile(), makeRevision());
    const next = publishBotConfigRevision("bot-researcher", makeRevision(2));
    expect(next.profile.currentConfigRevisionId).toBe("bot-researcher-r2");
    expect(next.revisions.map((revision) => revision.version)).toEqual([1, 2]);
    expect(() =>
      publishBotConfigRevision("bot-researcher", makeRevision(4)),
    ).toThrow("必须为 3");
  });

  test("已存在的 revision 不允许被原地修改", () => {
    const record = createBotProfile(makeProfile(), makeRevision());
    const changed = {
      ...record,
      revisions: [{ ...record.revisions[0]!, modelId: "deepseek-v4-flash" }],
    };
    expect(() => saveBotProfileRecord(changed)).toThrow("不可修改");
  });

  test("revision 必须属于当前 Bot，不能跨 Bot 绑定", () => {
    expect(() =>
      createBotProfile(makeProfile(), {
        ...makeRevision(),
        botProfileId: "another-bot",
      }),
    ).toThrow("必须匹配");
  });

  test("归档 Bot 保留配置历史", () => {
    createBotProfile(makeProfile(), makeRevision());
    const archived = archiveBotProfile("bot-researcher", 999);
    expect(archived.profile.status).toBe("archived");
    expect(archived.profile.archivedAt).toBe(999);
    expect(archived.revisions).toHaveLength(1);
  });

  test("损坏或不完整记录不会进入加载结果", () => {
    writeFileSync(
      botsPath,
      JSON.stringify({
        version: 1,
        records: [{ profile: { id: "broken" }, revisions: [] }],
      }),
      "utf8",
    );
    expect(loadBotProfiles()).toEqual([]);
  });

  test("重复 Bot ID 不会被静默覆盖", () => {
    createBotProfile(makeProfile(), makeRevision());
    expect(() => createBotProfile(makeProfile(), makeRevision())).toThrow(
      "已存在",
    );
  });
});
