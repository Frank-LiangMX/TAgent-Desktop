import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bridgeBotSidecarRequest,
  clearBotSidecars,
  closeBotSidecar,
  minimizeBotSidecar,
  openBotSidecar,
} from "./bot-sidecar-service";
import { createSession, getSessionMeta } from "../agent/session-store";
import { createBotProfile } from "./bot-profile-service";
import type { BotConfigRevision, BotProfile } from "@tagent/shared";

let configDir = "";

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "tagent-sidecar-"));
  process.env.TAGENT_CONFIG_DIR = configDir;
  const now = Date.now();
  const profile: BotProfile = {
    id: "sidecar-test-bot",
    ownerUserId: "user-a",
    displayName: "旁路测试 Bot",
    status: "active",
    currentConfigRevisionId: "sidecar-test-bot-r1",
    memoryNamespace: "sidecar-test-bot",
    createdAt: now,
    updatedAt: now,
  };
  const revision: BotConfigRevision = {
    id: "sidecar-test-bot-r1",
    botProfileId: profile.id,
    version: 1,
    backend: "channel",
    channelId: "channel-sidecar-test",
    modelId: "model-sidecar-test",
    roleSnapshot: {
      roleId: "role-sidecar-test",
      displayName: profile.displayName,
      description: "旁路测试",
      systemPrompt: "你是旁路测试 Bot",
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
  createSession({
    id: "parent-session",
    title: "主会话",
    workspaceId: "workspace-a",
  });
});

afterAll(() => {
  clearBotSidecars();
  delete process.env.TAGENT_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearBotSidecars();
});

describe("bot-sidecar-service", () => {
  test("同一会话同一 Bot 重开复用 sidecar 身份，且建立隐藏专属 session", () => {
    const first = openBotSidecar({
      sessionId: "parent-session",
      botProfileId: "sidecar-test-bot",
    });
    const minimized = minimizeBotSidecar(first.sidecarId);
    expect(minimized?.lifecycle).toBe("minimized");
    const reopened = openBotSidecar({
      sessionId: "parent-session",
      botProfileId: "sidecar-test-bot",
    });
    expect(reopened.sidecarId).toBe(first.sidecarId);
    expect(reopened.lifecycle).toBe("open");
    expect(reopened.agentSessionId).toBe(
      "bot_sidecar_parent-session_sidecar-test-bot",
    );
    expect(getSessionMeta(reopened.agentSessionId)?.hidden).toBe(true);
    expect(getSessionMeta(reopened.agentSessionId)?.botProfileIds).toEqual([
      "sidecar-test-bot",
    ]);
    expect(getSessionMeta(reopened.agentSessionId)?.workspaceId).toBe(
      "workspace-a",
    );
  });

  test("桥接必须校验 sidecar 与会话/Bot 归属，关闭后拒绝", () => {
    const state = openBotSidecar({
      sessionId: "parent-session",
      botProfileId: "sidecar-test-bot",
    });
    expect(
      bridgeBotSidecarRequest({
        sidecarId: state.sidecarId,
        sessionId: "session-other",
        botProfileId: "sidecar-test-bot",
        content: "建议",
      }).accepted,
    ).toBe(false);
    expect(
      bridgeBotSidecarRequest({
        sidecarId: state.sidecarId,
        sessionId: "parent-session",
        botProfileId: "sidecar-test-bot",
        content: "建议",
      }).accepted,
    ).toBe(true);
    closeBotSidecar({ sidecarId: state.sidecarId });
    expect(
      bridgeBotSidecarRequest({
        sidecarId: state.sidecarId,
        sessionId: "parent-session",
        botProfileId: "sidecar-test-bot",
        content: "建议",
      }).accepted,
    ).toBe(false);
  });
});
