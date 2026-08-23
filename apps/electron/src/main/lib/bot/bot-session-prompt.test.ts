import { describe, expect, test, vi } from "vitest";
import type { BotMemoryRecord, BotProfileRecord } from "@tagent/shared";

const mocks = {
  getBotProfileRecord: vi.fn(),
  getActiveBotMemories: vi.fn(),
};

vi.mock("./bot-profile-service", () => ({
  getBotProfileRecord: mocks.getBotProfileRecord,
}));
vi.mock("./bot-memory-service", () => ({
  getActiveBotMemories: mocks.getActiveBotMemories,
}));

const { buildBotSessionPromptAppend } = await import("./bot-session-prompt");

const record = (id: string, name: string): BotProfileRecord => ({
  profile: {
    id,
    ownerUserId: "user-a",
    displayName: name,
    description: `${name} description`,
    status: "active",
    currentConfigRevisionId: `${id}-r1`,
    memoryNamespace: id,
    createdAt: 1,
    updatedAt: 1,
  },
  revisions: [
    {
      id: `${id}-r1`,
      botProfileId: id,
      version: 1,
      backend: "pi",
      roleSnapshot: {
        displayName: name,
        description: `${name} role`,
        systemPrompt: `You are ${name}.`,
      },
      permissionProfile: "read-only",
      capabilities: {
        supportsResume: true,
        supportsLiveInput: true,
        supportsToolBridge: true,
        supportsStructuredEvents: true,
      },
      createdAt: 1,
    },
  ],
});

const memory: BotMemoryRecord = {
  id: "memory-1",
  botProfileId: "bot-a",
  ownerUserId: "user-a",
  text: "先给结论，再给证据。",
  state: "active",
  confidence: 0.9,
  sourceSurface: "bot-chat",
  createdAt: 1,
  updatedAt: 2,
  activatedAt: 2,
  revision: 2,
};

describe("bot-session-prompt", () => {
  test("普通会话不注入 Bot 内容", () => {
    expect(buildBotSessionPromptAppend()).toBe("");
  });

  test("单 Bot 注入当前角色和已确认记忆", () => {
    mocks.getBotProfileRecord.mockReturnValue(record("bot-a", "研究员"));
    mocks.getActiveBotMemories.mockReturnValue([memory]);
    const prompt = buildBotSessionPromptAppend(["bot-a"]);
    expect(prompt).toContain("Bot「研究员」");
    expect(prompt).toContain("You are 研究员.");
    expect(prompt).toContain("先给结论，再给证据。");
  });

  test("多 Bot 不伪装成已经存在的协调者", () => {
    mocks.getBotProfileRecord.mockImplementation((id: string) =>
      record(id, id === "bot-a" ? "研究员" : "审校员"),
    );
    const prompt = buildBotSessionPromptAppend(["bot-a", "bot-b"]);
    expect(prompt).toContain("默认协调者「研究员」承接");
    expect(prompt).toContain("不要伪造其他 Bot 已经发言、调用工具或完成工作");
  });

  test("显式 @ Bot 会改变本轮承接目标", () => {
    mocks.getBotProfileRecord.mockImplementation((id: string) =>
      record(id, id === "bot-a" ? "研究员" : "审校员"),
    );
    mocks.getActiveBotMemories.mockReturnValue([]);
    const prompt = buildBotSessionPromptAppend(
      ["bot-a", "bot-b"],
      "请 @审校员 重点检查风险",
    );
    expect(prompt).toContain("用户 @ 指定的 Bot「审校员」优先承接");
  });
});
