/**
 * 单会话 ↔ 协作室桥接服务层测试（P2-UX-BRIDGE-SERVICE-brief）
 *
 * 通过 TAGENT_CONFIG_DIR 指向临时目录，注入假 modelCaller，覆盖 brief 测试清单 1–6：
 * 1. enter 缺 userConfirmed → 抛
 * 2. enter + 假 LLM JSON → room.goal 更新 + 系统消息含「前情提要」+ briefSource='llm'
 * 3. enter + 假 LLM 抛错 → heuristic 仍成功建房/写 brief
 * 4. enter 已有 fusionRoomId → reusedExistingRoom（不调模型）
 * 5. exit 缺确认 → 抛；exit 成功 → panel 有回写 system 消息 + meta.fusionRoomId 清空 + room paused
 * 6. excerpt 超单轮预算 → 拒绝；正常 → truncated/tokenEstimate 合理
 * + bonus: exit + LLM 抛错 → heuristic handoff 仍成功（fail-closed）
 *
 * 不打真网：modelCaller 注入假实现；CollaborationRoomService.create() 用默认栈但不触发任何
 * 成员 turn（enter/exit 不调 appendUserMessage，不进调度器）。
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotConfigRevision, BotProfile } from "@tagent/shared";
import {
  SOURCE_EXCERPT_PER_TURN_HARD_MAX_TOKENS,
  type EnterCollaborationWithBridgeInput,
  type ExitCollaborationWithBridgeInput,
} from "@tagent/shared";
import { createBotProfile } from "../bot/bot-profile-service";
import {
  appendPanelMessages,
  createSession,
  getSessionMeta,
  readPanelMessages,
  updateSessionMeta,
} from "../agent/session-store";
import { CollaborationRoomService } from "./collaboration-room-service";
import {
  reconcileLinkedSourceSessions,
  syncSourceSessionAfterRoomMemberChange,
} from "./collaboration-ipc";
import { appendMessage } from "./collaboration-room-repository";
import {
  BridgeConfirmRequiredError,
  BridgeExcerptBudgetError,
  SessionCollabBridgeService,
} from "./session-collab-bridge-service";

let configDir = "";
const WORKSPACE_ID = "ws-bridge-test";
const BOT_A = "bot-bridge-a";
const BOT_B = "bot-bridge-b";

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "tagent-bridge-svc-"));
  process.env.TAGENT_CONFIG_DIR = configDir;
  seedBot(BOT_A, "桥接 Bot A");
  seedBot(BOT_B, "桥接 Bot B");
});

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

/** 单 service 实例供全部测试复用（enter/exit 不触发成员 turn，不进调度器）。 */
const service = CollaborationRoomService.create();

function seedBot(id: string, name: string): void {
  const now = Date.now();
  const profile: BotProfile = {
    id,
    ownerUserId: "user-a",
    displayName: name,
    status: "active",
    currentConfigRevisionId: `${id}-r1`,
    memoryNamespace: id,
    createdAt: now,
    updatedAt: now,
  };
  const revision: BotConfigRevision = {
    id: `${id}-r1`,
    botProfileId: id,
    version: 1,
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
      supportsResume: false,
      supportsLiveInput: false,
      supportsToolBridge: false,
      supportsStructuredEvents: false,
    },
    createdAt: now,
    publishedAt: now,
  };
  createBotProfile(profile, revision);
}

/** 建一个带 2 Bot 的多 Bot 会话（upgradeFusionSession 要求 ≥2 Bot）。 */
function mkSession(): string {
  const id = `sess-${randomUUID()}`;
  createSession({ id, title: "桥接测试会话", workspaceId: WORKSPACE_ID });
  updateSessionMeta(id, {
    botProfileIds: [BOT_A, BOT_B],
    fusionMode: "multi-bot",
  });
  return id;
}

test("历史 room 不会反向把已退出的普通多 Bot 会话重新绑定", () => {
  const sessionId = mkSession();
  const room = service.createRoom({
    title: "历史房间不重绑",
    sourceSessionId: sessionId,
    members: [
      { displayName: "桥接 Bot A", botProfileId: BOT_A, isCoordinator: true },
      { displayName: "桥接 Bot B", botProfileId: BOT_B },
    ],
  });

  // 模拟用户已退出协作室：保留普通多 Bot 参与者，但清掉当前 room 链接。
  updateSessionMeta(sessionId, { fusionRoomId: undefined });
  syncSourceSessionAfterRoomMemberChange(service, room.id);
  reconcileLinkedSourceSessions(service);

  expect(getSessionMeta(sessionId)?.fusionRoomId).toBeUndefined();
  expect(getSessionMeta(sessionId)?.fusionMode).toBe("multi-bot");
});

test("来源会话投影按真实成员数保留手动 Codex/CLI 成员", () => {
  const sessionId = mkSession();
  const room = service.createRoom({
    title: "混合成员投影",
    sourceSessionId: sessionId,
    members: [
      { displayName: "桥接 Bot A", botProfileId: BOT_A, isCoordinator: true },
      { displayName: "手动 Codex", backend: "codex", modelId: "gpt-5.6-sol" },
    ],
  });
  updateSessionMeta(sessionId, { fusionRoomId: room.id });

  syncSourceSessionAfterRoomMemberChange(service, room.id);

  expect(getSessionMeta(sessionId)?.fusionRoomId).toBe(room.id);
  expect(getSessionMeta(sessionId)?.fusionMode).toBe("multi-bot");
  expect(getSessionMeta(sessionId)?.botProfileIds).toEqual([BOT_A]);
});

function userMsg(text: string): unknown {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}
function assistantMsg(text: string): unknown {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function seedPanel(
  sessionId: string,
  turns: Array<{ role: "user" | "assistant"; text: string }>,
): void {
  const msgs = turns.map((t) =>
    t.role === "user" ? userMsg(t.text) : assistantMsg(t.text),
  );
  appendPanelMessages(WORKSPACE_ID, sessionId, msgs);
}

describe("SessionCollabBridgeService（P2-UX 桥接服务层）", () => {
  test("1. enter 缺 userConfirmed → 抛 BridgeConfirmRequiredError", async () => {
    const bridge = new SessionCollabBridgeService({
      roomService: service,
      modelCaller: async () => "",
    });
    await expect(
      bridge.enterCollaborationWithBridge({
        sessionId: "sess-no-confirm",
        userConfirmed: false,
      } as unknown as EnterCollaborationWithBridgeInput),
    ).rejects.toThrow(BridgeConfirmRequiredError);
  });

  test("2. enter + 假 LLM JSON → room.goal 更新 + 系统消息含「前情提要」+ briefSource='llm'", async () => {
    const sessionId = mkSession();
    seedPanel(sessionId, [
      { role: "user", text: "帮我设计一个登录模块" },
      { role: "assistant", text: "好的，我先了解一下需求" },
      { role: "user", text: "要支持 OAuth 和邮箱注册" },
    ]);
    const calls: string[] = [];
    const metaChanges: string[] = [];
    const bridge = new SessionCollabBridgeService({
      roomService: service,
      notifySessionMetaChanged: (changedSessionId) =>
        metaChanges.push(changedSessionId),
      modelCaller: async (input) => {
        calls.push(input.systemPrompt);
        return JSON.stringify({
          goal: "设计登录模块",
          decisions: ["采用 OAuth"],
          openQuestions: [],
          todos: ["写注册接口"],
          artifacts: ["src/auth"],
        });
      },
    });
    const result = await bridge.enterCollaborationWithBridge({
      sessionId,
      userConfirmed: true,
    });
    expect(result.briefSource).toBe("llm");
    expect(result.reusedExistingRoom).toBe(false);
    expect(result.sourceSessionId).toBe(sessionId);
    // room.goal 被更新为 brief.goal
    const room = service.getRoomById(result.roomId)!;
    expect(room.goal).toBe("设计登录模块");
    expect(room.sourceSessionId).toBe(sessionId);
    // 系统消息含「前情提要」
    const msgs = service.listMessages(result.roomId);
    expect(msgs.at(-1)?.authorType).toBe("system");
    expect(msgs.at(-1)?.content).toContain("前情提要");
    // 调了一次模型
    expect(calls).toHaveLength(1);
    // meta 已绑定房间
    expect(getSessionMeta(sessionId)?.fusionRoomId).toBe(result.roomId);
    expect(metaChanges).toEqual([sessionId]);
  });

  test("3. enter + 假 LLM 抛错 → heuristic 仍成功建房/写 brief", async () => {
    const sessionId = mkSession();
    seedPanel(sessionId, [
      { role: "user", text: "帮我重构数据库层" },
      { role: "assistant", text: "好的" },
    ]);
    const bridge = new SessionCollabBridgeService({
      roomService: service,
      modelCaller: async () => {
        throw new Error("network down");
      },
    });
    const result = await bridge.enterCollaborationWithBridge({
      sessionId,
      userConfirmed: true,
    });
    expect(result.briefSource).toBe("heuristic");
    expect(result.reusedExistingRoom).toBe(false);
    expect(service.getRoomById(result.roomId)).toBeDefined();
    // 启发式 goal = 最近 user 文本
    expect(result.brief.goal).toContain("重构数据库层");
    // 系统消息仍写入
    const msgs = service.listMessages(result.roomId);
    expect(msgs.at(-1)?.content).toContain("前情提要");
  });

  test("4. enter 已有 fusionRoomId → reusedExistingRoom=true（不重复 summarize）", async () => {
    const sessionId = mkSession();
    seedPanel(sessionId, [{ role: "user", text: "初始目标" }]);
    let calls = 0;
    const bridge = new SessionCollabBridgeService({
      roomService: service,
      modelCaller: async () => {
        calls += 1;
        return JSON.stringify({
          goal: "首次目标",
          decisions: [],
          openQuestions: [],
          todos: [],
          artifacts: [],
        });
      },
    });
    const first = await bridge.enterCollaborationWithBridge({
      sessionId,
      userConfirmed: true,
    });
    expect(first.reusedExistingRoom).toBe(false);
    const second = await bridge.enterCollaborationWithBridge({
      sessionId,
      userConfirmed: true,
    });
    expect(second.reusedExistingRoom).toBe(true);
    expect(second.roomId).toBe(first.roomId);
    // 复用不重复调模型
    expect(calls).toBe(1);
  });

  test("4b. 进房摘要 abort → 清理 fusionRoomId 并暂停半成品房间", async () => {
    const sessionId = mkSession();
    seedPanel(sessionId, [{ role: "user", text: "可取消的协作目标" }]);
    const controller = new AbortController();
    const bridge = new SessionCollabBridgeService({
      roomService: service,
      modelCaller: async () => {
        controller.abort();
        throw new Error("aborted");
      },
    });

    await expect(
      bridge.enterCollaborationWithBridge({
        sessionId,
        userConfirmed: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");

    expect(getSessionMeta(sessionId)?.fusionRoomId).toBeUndefined();
    const room = service
      .listRooms(true)
      .filter((item) => item.sourceSessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    expect(room).toBeDefined();
    expect(room?.status).toBe("paused");
  });

  test("5a. exit 缺确认 → 抛 BridgeConfirmRequiredError", async () => {
    const bridge = new SessionCollabBridgeService({
      roomService: service,
      modelCaller: async () => "",
    });
    await expect(
      bridge.exitCollaborationWithBridge({
        sessionId: "sess-no-exit-confirm",
        userConfirmed: false,
      } as unknown as ExitCollaborationWithBridgeInput),
    ).rejects.toThrow(BridgeConfirmRequiredError);
  });

  test("5b. exit 成功 → panel 有回写 system 消息 + meta.fusionRoomId 清空 + room paused", async () => {
    const sessionId = mkSession();
    seedPanel(sessionId, [{ role: "user", text: "协作目标" }]);
    // 先进房（用 LLM 进房 caller）
    const enterBridge = new SessionCollabBridgeService({
      roomService: service,
      modelCaller: async () =>
        JSON.stringify({
          goal: "协作目标",
          decisions: [],
          openQuestions: [],
          todos: [],
          artifacts: [],
        }),
    });
    const entered = await enterBridge.enterCollaborationWithBridge({
      sessionId,
      userConfirmed: true,
    });
    // 退出（用 LLM 回写 caller）
    const metaChanges: string[] = [];
    const exitBridge = new SessionCollabBridgeService({
      roomService: service,
      notifySessionMetaChanged: (changedSessionId) =>
        metaChanges.push(changedSessionId),
      modelCaller: async () =>
        JSON.stringify({
          outcomes: ["已实现登录接口"],
          changes: ["新增 src/auth/login.ts"],
          risks: ["未写测试"],
        }),
    });
    const exited = await exitBridge.exitCollaborationWithBridge({
      sessionId,
      userConfirmed: true,
    });
    expect(exited.handoffSource).toBe("llm");
    expect(exited.roomId).toBe(entered.roomId);
    expect(exited.sourceSessionId).toBe(sessionId);
    // panel 有回写 system 消息（assistant + modelId '协作室回写'）
    const panel = readPanelMessages(WORKSPACE_ID, sessionId);
    const last = panel.at(-1) as
      | { modelId?: string; content?: Array<{ type?: string; text?: string }> }
      | undefined;
    expect(last).toBeDefined();
    expect(last?.modelId).toBe("协作室回写");
    expect(last?.content?.[0]?.text).toContain("协作室回写");
    // meta.fusionRoomId 清空
    expect(getSessionMeta(sessionId)?.fusionRoomId).toBeUndefined();
    // 房间转 paused（历史保留）
    const room = service.getRoomById(entered.roomId)!;
    expect(room.status).toBe("paused");
    expect(service.listMessages(entered.roomId).length).toBeGreaterThan(0);
    expect(metaChanges).toEqual([sessionId]);
  });

  test("6. excerpt 超单轮预算 → 拒绝；正常 → truncated/tokenEstimate 合理；query 过滤", () => {
    const sessionId = mkSession();
    seedPanel(
      sessionId,
      Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `第${i}条内容，包含关键词 secret-${i}。`,
      })),
    );
    const room = service.createRoom({
      title: "来源摘录绑定校验",
      sourceSessionId: sessionId,
      members: [
        { displayName: "桥接 Bot A", botProfileId: BOT_A, isCoordinator: true },
        { displayName: "桥接 Bot B", botProfileId: BOT_B },
      ],
    });
    const bridge = new SessionCollabBridgeService({
      roomService: service,
      modelCaller: async () => "",
    });
    const req = { sourceSessionId: sessionId, roomId: room.id };
    const otherSessionId = mkSession();
    const otherRoom = service.createRoom({
      title: "其他来源房间",
      sourceSessionId: otherSessionId,
      members: [
        { displayName: "桥接 Bot A", botProfileId: BOT_A, isCoordinator: true },
        { displayName: "桥接 Bot B", botProfileId: BOT_B },
      ],
    });
    expect(() =>
      bridge.readSourceSessionExcerpt(
        { ...req, roomId: otherRoom.id },
        0,
      ),
    ).toThrow("来源会话与协作室不匹配");
    // 超单轮预算 → 抛 BridgeExcerptBudgetError
    expect(() =>
      bridge.readSourceSessionExcerpt(req, SOURCE_EXCERPT_PER_TURN_HARD_MAX_TOKENS),
    ).toThrow(BridgeExcerptBudgetError);
    // 正常 → 截断到 maxTokens 预算
    const result = bridge.readSourceSessionExcerpt(
      { ...req, maxTokens: 200 },
      0,
    );
    expect(result.sourceSessionId).toBe(sessionId);
    expect(result.excerpt.length).toBeGreaterThan(0);
    expect(result.tokenEstimate).toBeGreaterThan(0);
    expect(result.charCount).toBe(result.excerpt.length);
    // 200 token → 240 字符硬顶
    expect(result.excerpt.length).toBeLessThanOrEqual(240);
    // query 过滤：只含匹配条目
    const filtered = bridge.readSourceSessionExcerpt(
      { ...req, query: "secret-5" },
      0,
    );
    expect(filtered.excerpt).toContain("secret-5");
    expect(filtered.excerpt).not.toContain("secret-6");
  });

  test("7. exit + LLM 抛错 → heuristic handoff 仍成功（fail-closed）", async () => {
    const sessionId = mkSession();
    seedPanel(sessionId, [{ role: "user", text: "另一个协作目标" }]);
    const enterBridge = new SessionCollabBridgeService({
      roomService: service,
      modelCaller: async () =>
        JSON.stringify({
          goal: "另一个协作目标",
          decisions: [],
          openQuestions: [],
          todos: [],
          artifacts: [],
        }),
    });
    const entered = await enterBridge.enterCollaborationWithBridge({
      sessionId,
      userConfirmed: true,
    });
    // 给房间加一条用户消息（直接落盘，不触发 run），供启发式 narrative 取材
    appendMessage({
      id: `msg-${randomUUID()}`,
      roomId: entered.roomId,
      authorType: "user",
      authorId: "user",
      kind: "chat",
      content: "请实现登录接口",
      visibility: "room",
      targetMemberIds: [],
      rootMessageId: `root-${randomUUID()}`,
      depth: 0,
      createdAt: Date.now(),
    });
    const exitBridge = new SessionCollabBridgeService({
      roomService: service,
      modelCaller: async () => {
        throw new Error("handoff model unavailable");
      },
    });
    const exited = await exitBridge.exitCollaborationWithBridge({
      sessionId,
      userConfirmed: true,
    });
    expect(exited.handoffSource).toBe("heuristic");
    // 启发式 outcomes 兜底
    expect(exited.handoff.outcomes.length).toBeGreaterThan(0);
    expect(exited.handoff.outcomes[0]).toContain("协作已结束");
    // meta 已清、房间 paused
    expect(getSessionMeta(sessionId)?.fusionRoomId).toBeUndefined();
    expect(service.getRoomById(entered.roomId)?.status).toBe("paused");
  });
});
