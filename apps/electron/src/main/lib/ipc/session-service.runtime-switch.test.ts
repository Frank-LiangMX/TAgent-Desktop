/**
 * ADR-0011 §5 运行内核切换 —— **orchestration 测试**（真实 SessionService + IPC handler + 会话存储）。
 *
 * 与 `runtime-switch.test.ts`（纯函数单测）互补：本文件走真实 session-service 的
 * IPC handler / 事务 / 落盘路径，只把「适配器」与「electron 宿主」替换为可控替身：
 * - electron：ipcMain 记录 handler（测试直接调用捕获的 handler，等价于 renderer invoke）
 * - 适配器：`registerAdapterFactory` 注入假适配器（不 spawn 真进程）
 * - 配置目录：TAGENT_CONFIG_DIR 指向临时目录，绝不读写用户真实 ~/.tagent[-dev]
 *
 * 覆盖：切换事务校验与落盘、busy/停止未确认/审批在途 fail-closed、串行化、
 * 旧内核停止失败不吞、UPDATE_SESSION_META 跨内核旁路拦截、发送期交接投递与终态消费。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@tagent/shared";

// 必须在任何主进程模块读取配置路径之前固定临时目录
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "tagent-switch-orch-"));
process.env.TAGENT_CONFIG_DIR = CONFIG_DIR;
process.env.TAGENT_DEV = "1";

/** 捕获 ipcMain.handle 注册的 handler（测试直接调用 = 模拟 renderer invoke）。 */
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => {
  const stub = (): Record<string, unknown> => ({});
  const ipcMain = {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    },
    on: () => {},
    once: () => {},
    removeHandler: () => {},
    removeAllListeners: () => {},
  };
  const app = {
    isPackaged: false,
    getPath: () => CONFIG_DIR,
    getAppPath: () => CONFIG_DIR,
    on: () => {},
    whenReady: async () => {},
  };
  const safeStorage = {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  const base: Record<string, unknown> = { ipcMain, app, safeStorage, BrowserWindow: class {} };
  return new Proxy(base, {
    get: (target, key) =>
      key in target ? target[key as string] : stub(),
  });
});

const {
  AGENT_IPC_CHANNELS,
} = await import("@tagent/shared");
const { registerAdapterFactory } = await import("../adapters");
const {
  appendPanelMessages,
  createSession,
  getSessionMeta,
  updateSessionMeta,
} = await import("../agent/session-store");
const { SessionService, createRuntimeConnectionFingerprint } = await import("./session-service");
const { writeJsonAtomic } = await import("../atomic-json");
const { getChannelsPath, getAgentSessionPanelMessagesPath } = await import("../config/config-paths");
const { getChannel, getDecryptedApiKey, updateChannel } = await import("../channel/channel-store");

// 假的 Codex Runtime 探测（避免真实 spawn 探测进程）
vi.mock("../adapters/codex/codex-runtime-resolver", () => ({
  probeCodexRuntime: () => ({ ok: true, version: "test" }),
  resolveCodexRuntime: () => ({ available: true, source: "system", version: "test", diagnostics: [] }),
  resolveCodexRuntimeAsync: async () => ({
    available: true,
    source: "system",
    version: "test",
    diagnostics: [],
  }),
  clearCodexRuntimeAsyncCache: () => {},
}));

// workspace-manager 内部用 CJS require 延迟导入 session-store，在 vitest ESM 下不可用；
// 本测试不关心工作区解析（切换只把它当路径提示），直接替身。
vi.mock("../workspace/workspace-manager", () => ({
  resolveWorkspaceForSession: () => undefined,
  resolveWorkspaceById: () => undefined,
  listWorkspaces: () => [],
  getDefaultWorkspace: () => undefined,
}));

/** 假适配器：query 由测试注入的行为驱动，其余方法为静默替身。 */
interface FakeAdapterHandle {
  adapter: unknown;
  /** 已收到的 query 调用（prompt 等） */
  calls: Array<Record<string, unknown>>;
  interruptCalls: () => number;
  abortCalls: () => number;
}

type FakeRun = (input: Record<string, unknown>) => AsyncGenerator<unknown>;

function makeFakeAdapter(): FakeAdapterHandle & { setRun: (run?: FakeRun) => void } {
  const calls: Array<Record<string, unknown>> = [];
  let interrupts = 0;
  let aborts = 0;
  let behaviorRun: FakeRun | undefined;

  const adapter = {
    query: (input: Record<string, unknown>): AsyncIterable<unknown> => {
      calls.push(input);
      const run = behaviorRun;
      return (async function* (): AsyncGenerator<unknown> {
        if (run) {
          yield* run(input);
          return;
        }
        yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] }, parent_tool_use_id: null };
        yield { type: "result", subtype: "success", usage: { input_tokens: 0, output_tokens: 0 } };
      })();
    },
    abort: () => {
      aborts += 1;
    },
    hasActiveChannel: () => true,
    interruptQuery: async () => {
      interrupts += 1;
    },
    sendQueuedMessage: async () => {},
    dispose: () => {},
    setModel: async () => {},
  };
  return {
    adapter,
    calls,
    interruptCalls: () => interrupts,
    abortCalls: () => aborts,
    setRun: (run) => {
      behaviorRun = run;
    },
  };
}

/**
 * 适配器工厂全局只注册一次：`registerAdapterFactory` 在已有实例后不可替换。
 * 需要改变行为时改 fake handle 的 run 行为，而不是重注册。
 */
const codexAdapter = makeFakeAdapter();
const claudeCodeAdapter = makeFakeAdapter();
const externalAdapter = makeFakeAdapter();
registerAdapterFactory("codex", () => codexAdapter.adapter as never);
registerAdapterFactory("claude-code", () => claudeCodeAdapter.adapter as never);
registerAdapterFactory("external", () => externalAdapter.adapter as never);

/** 记录主进程推给渲染层的事件（校验 UI 终态行为未被本切片改变）。 */
const sentPayloads: Array<{ channel: string; payload: unknown }> = [];
const fakeWindow = {
  webContents: {
    send: (channel: string, payload: unknown) => {
      sentPayloads.push({ channel, payload });
    },
  },
};

function eventsOfType(type: string): unknown[] {
  return sentPayloads
    .map((item) => item.payload as { payload?: { event?: { type?: string } } })
    .filter((p) => p?.payload?.event?.type === type);
}

const KSCC_CHANNEL_ID = "kscc-1";
const CODEX_CHANNEL_ID = "codex-1";
const API_CHANNEL_ID = "api-1";
const API_CHANNEL_ID_2 = "api-2";
const RESPONSES_CHANNEL_ID = "responses-api";
const MESSAGES_CHANNEL_ID = "messages-api";

function seedChannels(opts: { includeExternal?: boolean } = {}): void {
  const includeExternal = opts.includeExternal !== false;
  writeJsonAtomic(getChannelsPath(), {
    version: 1,
    channels: [
      {
        id: KSCC_CHANNEL_ID,
        name: "KSCC 内网",
        provider: "kscc-internal",
        baseUrl: "",
        apiKey: "",
        enabled: true,
        models: [{ id: "kscc-default", name: "KSCC", enabled: true }],
        defaultModelId: "kscc-default",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: CODEX_CHANNEL_ID,
        name: "Codex",
        provider: "codex-internal",
        baseUrl: "",
        apiKey: "",
        enabled: true,
        models: [
          { id: "gpt-5", name: "GPT-5", enabled: true },
          { id: "gpt-off", name: "GPT-off", enabled: false },
        ],
        defaultModelId: "gpt-5",
        createdAt: 0,
        updatedAt: 0,
      },
      ...(includeExternal
        ? [
            {
              id: API_CHANNEL_ID,
              name: "外部 API",
              provider: "custom",
              baseUrl: "https://example.invalid",
              apiKey: "test-key-not-real",
              enabled: true,
              models: [{ id: "grok-4", name: "Grok", enabled: true }],
              defaultModelId: "grok-4",
              createdAt: 0,
              updatedAt: 0,
            },
            {
              id: API_CHANNEL_ID_2,
              name: "外部 API 2",
              provider: "custom",
              baseUrl: "https://example2.invalid",
              apiKey: "test-key-not-real",
              enabled: true,
              models: [{ id: "grok-5", name: "Grok 5", enabled: true }],
              defaultModelId: "grok-5",
              createdAt: 0,
              updatedAt: 0,
            },
            {
              id: RESPONSES_CHANNEL_ID,
              name: "Responses API",
              provider: "custom",
              apiProtocol: "openai-responses",
              baseUrl: "https://responses.example.invalid/v1",
              apiKey: "responses-key-not-real",
              enabled: true,
              models: [{ id: "gpt-api", name: "GPT API", enabled: true, contextWindow: 128_000 }],
              defaultModelId: "gpt-api",
              createdAt: 0,
              updatedAt: 0,
            },
            {
              id: MESSAGES_CHANNEL_ID,
              name: "Messages API",
              provider: "custom",
              apiProtocol: "anthropic-messages",
              baseUrl: "https://messages.example.invalid",
              apiKey: "messages-key-not-real",
              enabled: true,
              models: [{ id: "claude-api", name: "Claude API", enabled: true, contextWindow: 200_000 }],
              defaultModelId: "claude-api",
              createdAt: 0,
              updatedAt: 0,
            },
          ]
        : []),
    ],
  });
}

let svc: ReturnType<typeof SessionService.create>;
let seq = 0;

function newSession(patch: Record<string, unknown> = {}): string {
  seq += 1;
  const id = `sess-${seq}`;
  createSession({
    id,
    title: `会话 ${seq}`,
    channelId: MESSAGES_CHANNEL_ID,
    modelId: "claude-api",
    agentRuntime: "claude-code",
    internalBackend: "claude-code",
    workspaceId: undefined,
    executionMode: "work",
    ...patch,
  } as never);
  return id;
}

function switchHandler(): (...args: unknown[]) => Promise<unknown> {
  const handler = ipcHandlers.get(AGENT_IPC_CHANNELS.SWITCH_SESSION_RUNTIME);
  if (!handler) throw new Error("SWITCH_SESSION_RUNTIME handler 未注册");
  return handler as (...args: unknown[]) => Promise<unknown>;
}

function metaHandler(): (...args: unknown[]) => Promise<unknown> {
  const handler = ipcHandlers.get(AGENT_IPC_CHANNELS.UPDATE_SESSION_META);
  if (!handler) throw new Error("UPDATE_SESSION_META handler 未注册");
  return handler as (...args: unknown[]) => Promise<unknown>;
}

function sendHandler(): (...args: unknown[]) => Promise<unknown> {
  const handler = ipcHandlers.get(AGENT_IPC_CHANNELS.SEND_MESSAGE);
  if (!handler) throw new Error("SEND_MESSAGE handler 未注册");
  return handler as (...args: unknown[]) => Promise<unknown>;
}

/** 注入一个假的 SessionRuntime 替身（只实现切换事务用到的探针）。 */
function injectRuntime(
  sessionId: string,
  probes: Partial<{
    isTurnInFlight: () => boolean;
    isInterrupting: () => boolean;
    hasUnsettledStop: () => boolean;
    waitForTurnSettled: (ms?: number) => Promise<boolean>;
    destroy: () => void;
    isRunning: () => boolean;
  }> = {},
): void {
  const fake = {
    sessionId,
    isTurnInFlight: () => false,
    isInterrupting: () => false,
    hasUnsettledStop: () => false,
    waitForTurnSettled: async () => true,
    destroy: () => {},
    isRunning: () => false,
    ...probes,
  };
  (svc as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId, fake);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mkdirSync(join(CONFIG_DIR, 'memory'), { recursive: true });
  seedChannels();
  codexAdapter.calls.length = 0;
  codexAdapter.setRun(undefined);
  claudeCodeAdapter.calls.length = 0;
  claudeCodeAdapter.setRun(undefined);
  externalAdapter.calls.length = 0;
  externalAdapter.setRun(undefined);
  sentPayloads.length = 0;
  svc = SessionService.create(() => fakeWindow as never, null);
});

afterAll(() => {
  try {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
});

describe('orchestration：配置重建必须等待旧 loop 退出', () => {
  it.each(['configuration', 'sidecar'] as const)('%s 不得通过 isFirst 重建绕过旧 runtime 的停止闩锁', async kind => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    claudeCodeAdapter.setRun(async function* () {
      yield { type: 'result', subtype: 'success', usage: {} };
      await gate;
    });
    const sessionId = newSession({ agentRuntime: 'claude-code', internalBackend: 'claude-code', channelId: MESSAGES_CHANNEL_ID, modelId: 'claude-api' });
    const input = { sessionId, channelId: MESSAGES_CHANNEL_ID, model: 'claude-api', agentRuntime: 'claude-code', prompt: 'first' };
    expect(await sendHandler()({}, input)).toMatchObject({ ok: true });
    const runtimes = (svc as unknown as { runtimes: Map<string, { dropLiveProcessForConfigChange(reason: string): void; hasUnsettledStop(): boolean; isTurnInFlight(): boolean }> }).runtimes;
    const previous = runtimes.get(sessionId)!;
    await vi.waitFor(() => expect(previous.isTurnInFlight()).toBe(false));
    if (kind === 'configuration') previous.dropLiveProcessForConfigChange('test-config');
    const pending = sendHandler()({}, { ...input, prompt: 'second', ...(kind === 'sidecar' ? { contextPrompt: 'new advisor context' } : {}) });
    try {
      await vi.waitFor(() => expect(previous.hasUnsettledStop()).toBe(true));
      expect(claudeCodeAdapter.calls).toHaveLength(1);
      expect(runtimes.get(sessionId)).toBe(previous);
      release();
      expect(await pending).toMatchObject({ ok: true });
      expect(claudeCodeAdapter.calls).toHaveLength(2);
    } finally {
      release();
      await pending;
    }
  });

  it('配置重建超时不替换 runtime、不派发第二条消息', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    claudeCodeAdapter.setRun(async function* () { yield { type: 'result', subtype: 'success', usage: {} }; await gate; });
    const sessionId = newSession({ agentRuntime: 'claude-code', internalBackend: 'claude-code', channelId: MESSAGES_CHANNEL_ID, modelId: 'claude-api' });
    const input = { sessionId, channelId: MESSAGES_CHANNEL_ID, model: 'claude-api', agentRuntime: 'claude-code', prompt: 'first' };
    expect(await sendHandler()({}, input)).toMatchObject({ ok: true });
    const runtimes = (svc as unknown as { runtimes: Map<string, { dropLiveProcessForConfigChange(reason: string): void; waitForTurnSettled(ms: number): Promise<boolean> }> }).runtimes;
    const previous = runtimes.get(sessionId)!;
    previous.dropLiveProcessForConfigChange('test-config');
    const spy = vi.spyOn(previous, 'waitForTurnSettled').mockResolvedValue(false);
    try {
      const result = await sendHandler()({}, { ...input, prompt: 'second' }) as { ok: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(result.error).toContain('尚未确认停稳');
      expect(claudeCodeAdapter.calls).toHaveLength(1);
      expect(runtimes.get(sessionId)).toBe(previous);
    } finally { spy.mockRestore(); release(); await flush(); }
  });
});

describe('orchestration：切换事务（真实 IPC handler）', () => {
  it('成功切换：落盘新绑定 + 归档旧原生 id + 生成待投递交接资料', async () => {
    const sessionId = newSession();
    updateSessionMeta(sessionId, { sdkSessionId: "sdk-native-old" });
    appendPanelMessages(undefined, sessionId, [
      { type: "user", uuid: "u1", createdAt: 1, message: { role: "user", content: [{ type: "text", text: "把脚本改成增量跑" }] } },
      { type: "assistant", uuid: "a1", createdAt: 2, message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
    ] as never);

    // 切换前快照：权限 / 执行形态 / 工作区必须原样保留
    const before = getSessionMeta(sessionId)!;

    const updated = (await switchHandler()({}, {
      sessionId,
      channelId: CODEX_CHANNEL_ID,
      modelId: "gpt-5",
      runtime: "codex",
    })) as Record<string, unknown>;

    expect(updated.channelId).toBe(CODEX_CHANNEL_ID);
    expect(updated.modelId).toBe("gpt-5");
    expect(updated.internalBackend).toBe("codex-app-server");
    expect(updated.sdkSessionId).toBeUndefined();
    expect(updated.runtimeSwitchRevision).toBe(1);
    expect((updated.runtimeBindings as never as Record<string, Record<string, unknown>>)['claude-code']?.nativeSessionId).toBe("sdk-native-old");
    const handoff = updated.runtimeHandoff as Record<string, unknown>;
    expect(handoff.from).toBe("claude-code");
    expect(handoff.to).toBe("codex");
    expect(String(handoff.content)).toContain("把脚本改成增量跑");
    expect(String(handoff.content)).toContain("不等同于完整上下文迁移");
    // 权限 / 执行形态 / 工作区未被改动（切换不静默改权限、不扩权）
    expect(updated.executionMode).toBe(before.executionMode);
    expect(updated.permissionMode).toBe(before.permissionMode);
    expect(updated.workspaceId).toBe(before.workspaceId);
    expect(updated.workspaceId).toBeUndefined();

    // 重开（重新读盘）后绑定与 pending 一致
    const reloaded = getSessionMeta(sessionId)!;
    expect(reloaded.channelId).toBe(CODEX_CHANNEL_ID);
    expect(reloaded.runtimeHandoff?.content ?? "").toContain("把脚本改成增量跑");
  });

  it('busy：回合在跑 → 拒绝且绑定一字未改', async () => {
    const sessionId = newSession();
    injectRuntime(sessionId, { isTurnInFlight: () => true });
    await expect(
      switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "codex" }),
    ).rejects.toThrow(/仍在执行/);
    expect(getSessionMeta(sessionId)?.channelId).toBe(MESSAGES_CHANNEL_ID);
    expect(getSessionMeta(sessionId)?.runtimeHandoff).toBeUndefined();
  });

  it('停止未确认静默：先等待终态；超时 → fail-closed 拒绝', async () => {
    const sessionId = newSession();
    let unsettled = true;
    injectRuntime(sessionId, {
      hasUnsettledStop: () => unsettled,
      waitForTurnSettled: async () => false, // 超时未观察到原生终态
    });
    await expect(
      switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "codex" }),
    ).rejects.toThrow(/尚未确认本轮停稳/);
    expect(getSessionMeta(sessionId)?.channelId).toBe(MESSAGES_CHANNEL_ID);
    expect(unsettled).toBe(true);
  });

  it('停止后在超时内观察到原生终态 → 等待成功并完成切换', async () => {
    const sessionId = newSession();
    let unsettled = true;
    injectRuntime(sessionId, {
      hasUnsettledStop: () => unsettled,
      waitForTurnSettled: async () => {
        await flush();
        unsettled = false;
        return true;
      },
    });
    const updated = (await switchHandler()({}, {
      sessionId,
      channelId: CODEX_CHANNEL_ID,
      modelId: "gpt-5",
      runtime: "codex",
    })) as Record<string, unknown>;
    expect(updated.channelId).toBe(CODEX_CHANNEL_ID);
    expect(unsettled).toBe(false);
  });

  it('长驻但空闲的内核（长驻 loop 仍在跑、无在途回合）→ 允许切换', async () => {
    const sessionId = newSession();
    // isRunning()=true（长驻进程活着），但本轮未运行、无未确认停止 → 静默允许
    injectRuntime(sessionId, {
      isRunning: () => true,
      isTurnInFlight: () => false,
      hasUnsettledStop: () => false,
    });
    const updated = (await switchHandler()({}, {
      sessionId,
      channelId: CODEX_CHANNEL_ID,
      modelId: "gpt-5",
      runtime: "codex",
    })) as Record<string, unknown>;
    expect(updated.channelId).toBe(CODEX_CHANNEL_ID);
  });

  it('审批在途 → 拒绝（fail-closed）', async () => {
    const sessionId = newSession();
    const { askUserService } = await import("../agent/agent-ask-user-service");
    const spy = vi
      .spyOn(askUserService, "getPendingRequests")
      .mockReturnValue([{ requestId: "r1", sessionId, questions: [] } as never]);
    await expect(
      switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "codex" }),
    ).rejects.toThrow(/审批/);
    spy.mockRestore();
    expect(getSessionMeta(sessionId)?.channelId).toBe(MESSAGES_CHANNEL_ID);
  });

  it('旧内核停止失败（abort 抛错）→ 切换失败且不吞异常', async () => {
    const sessionId = newSession();
    injectRuntime(sessionId, {
      destroy: () => {
        throw new Error("abort failed (simulated)");
      },
    });
    await expect(
      switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "codex" }),
    ).rejects.toThrow(/abort failed/);
    // 未落盘新绑定：renderer 看到失败后保持原选择
    expect(getSessionMeta(sessionId)?.channelId).toBe(MESSAGES_CHANNEL_ID);
    expect(getSessionMeta(sessionId)?.internalBackend).toBe("claude-code");
  });

  it('校验失败（停用模型 / 内核不匹配）→ 不写绑定、不生成交接', async () => {
    const sessionId = newSession();
    await expect(
      switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-off", runtime: "codex" }),
    ).rejects.toThrow(/已停用/);
    await expect(
      switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "pi" }),
    ).rejects.toThrow(/不适用于/);
    expect(getSessionMeta(sessionId)?.channelId).toBe(MESSAGES_CHANNEL_ID);
  });

  it('源历史读失败 → 切换失败（不假装交接完成、不丢绑定）', async () => {
    const sessionId = newSession();
    // 用目录占住面板 JSONL 路径 → readPanelMessages 抛错（源历史不可读）
    const panelPath = getAgentSessionPanelMessagesPath(sessionId);
    mkdirSync(panelPath, { recursive: true });
    try {
      await expect(
        switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "codex" }),
      ).rejects.toThrow();
      expect(getSessionMeta(sessionId)?.channelId).toBe(MESSAGES_CHANNEL_ID);
      expect(getSessionMeta(sessionId)?.runtimeHandoff).toBeUndefined();
    } finally {
      rmSync(panelPath, { recursive: true, force: true });
    }
  });

  it('草稿（未持久化）会话拒绝切换', async () => {
    await expect(
      switchHandler()({}, { sessionId: "never-created", channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "codex" }),
    ).rejects.toThrow(/尚未持久化/);
  });

  it('并发两次切换被串行化：后到者按最新 meta 重新校验，最终绑定一致', async () => {
    const sessionId = newSession();
    const [a, b] = await Promise.all([
      switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "codex" }),
      switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "codex" }),
    ]);
    expect((a as Record<string, unknown>).channelId).toBe(CODEX_CHANNEL_ID);
    expect((b as Record<string, unknown>).channelId).toBe(CODEX_CHANNEL_ID);
    expect(getSessionMeta(sessionId)?.internalBackend).toBe("codex-app-server");
    expect(getSessionMeta(sessionId)?.runtimeSwitchRevision).toBe(2);
  });
});

describe('orchestration：UPDATE_SESSION_META 不得绕过切换约束', () => {
  it('已持久化会话跨内核改 agentRuntime → 拒绝并提示走 switchSessionRuntime', async () => {
    const sessionId = newSession(); // claude-code 绑定
    await expect(
      metaHandler()({}, { id: sessionId, patch: { agentRuntime: "codex" } }),
    ).rejects.toThrow(/switchSessionRuntime/);
    expect(getSessionMeta(sessionId)?.agentRuntime).toBe("claude-code");
    expect(getSessionMeta(sessionId)?.internalBackend).toBe("claude-code");
  });

  it('同值写入 / 同内核字段更新放行（不误伤内部路径）', async () => {
    const sessionId = newSession();
    await expect(
      metaHandler()({}, { id: sessionId, patch: { internalBackend: "claude-code" } }),
    ).resolves.toBeTruthy();
    await expect(
      metaHandler()({}, { id: sessionId, patch: { modelId: "claude-api" } }),
    ).resolves.toBeTruthy();
    expect(getSessionMeta(sessionId)?.internalBackend).toBe("claude-code");
  });

  it('历史 kscc 渠道的会话改 internalBackend=codex-app-server 也被拦（不产生渠道/内核错配）', async () => {
    // 直接写盘模拟历史会话：渠道 kscc-internal（已停用）但 internalBackend 缺省 → 内核未知
    const sessionId = newSession({ channelId: KSCC_CHANNEL_ID, agentRuntime: undefined, internalBackend: undefined });
    await expect(
      metaHandler()({}, { id: sessionId, patch: { internalBackend: "codex-app-server" } }),
    ).rejects.toThrow(/switchSessionRuntime/);
  });
});

describe('orchestration：发送期交接投递与终态消费', () => {
  it('投递后目标内核产出原生终态 → 消费交接（清除 pending）', async () => {
    const sessionId = newSession({ sdkSessionId: "sdk-old" });
    appendPanelMessages(undefined, sessionId, [
      { type: "user", uuid: "u1", createdAt: 1, message: { role: "user", content: [{ type: "text", text: "原始目标" }] } },
    ] as never);
    await switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "codex" });
    expect(getSessionMeta(sessionId)?.runtimeHandoff?.attempts).toBeUndefined();

    const result = (await sendHandler()({}, { sessionId, prompt: "继续", channelId: CODEX_CHANNEL_ID, model: "gpt-5" })) as { ok: boolean; error?: string };
    // 本用例要求走「spawn 成功 → 原生终态」路径：失败即测试失败（不静默降级）
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // 真实跑到终态：交接被消费，且目标内核确实收到了交接正文
    await flush();
    await flush();
    const prompt = String(codexAdapter.calls.at(-1)?.prompt ?? "");
    expect(prompt).toContain("跨内核交接");
    expect(prompt).toContain("原始目标");
    expect(prompt).toContain("继续"); // 用户本轮消息仍在
    // 交接资料已含近期可见历史 → 本回合不再叠加 composeMoaPrompt 的整段历史块（避免重复注入）
    expect(prompt).not.toContain("[本轮议题]");
    expect(prompt.match(/\[会话上下文\]/g)?.length ?? 0).toBe(1);
    expect(getSessionMeta(sessionId)?.runtimeHandoff).toBeUndefined();
  });

  it('目标内核启动即抛错 → 交接保留且归零 attempts（下次发送可重投，不自动重发）', async () => {
    const sessionId = newSession({ sdkChannel: undefined } as never);
    appendPanelMessages(undefined, sessionId, [
      { type: "user", uuid: "u1", createdAt: 1, message: { role: "user", content: [{ type: "text", text: "原始目标" }] } },
    ] as never);
    await switchHandler()({}, { sessionId, channelId: CODEX_CHANNEL_ID, modelId: "gpt-5", runtime: "codex" });

    // 目标适配器 query 立即抛错（模拟 spawn/协议失败）
    codexAdapter.setRun(async function* (): AsyncGenerator<unknown> {
      throw new Error("codex spawn failed (simulated)");
    });

    const result = (await sendHandler()({}, { sessionId, prompt: "继续", channelId: CODEX_CHANNEL_ID, model: "gpt-5" })) as { ok: boolean; error?: string };
    await flush();
    const meta = getSessionMeta(sessionId)!;
    expect(meta.runtimeHandoff?.content).toBeTruthy();
    if (result.ok) {
      // 异步启动失败：sendMessage 已返回 ok，但适配器随后抛错 → 必须保留 pending
      expect(meta.runtimeHandoff?.attempts).toBe(0);
      expect(meta.runtimeHandoff?.lastOutcome).toBe("retryable");
    } else {
      expect(meta.runtimeHandoff?.attempts).toBe(0);
    }
  });
});

describe('orchestration：终态性质（onTurnEnd 非成功专属）', () => {
  /** 切到 codex 并让目标内核产出指定终态。 */
  async function switchAndSendWithResult(
    result: Record<string, unknown>,
  ): Promise<{ sessionId: string; ok: boolean; error?: string }> {
    const sessionId = newSession();
    updateSessionMeta(sessionId, { sdkSessionId: "sdk-old" });
    appendPanelMessages(undefined, sessionId, [
      { type: "user", uuid: "u1", createdAt: 1, message: { role: "user", content: [{ type: "text", text: "原始目标" }] } },
    ] as never);
    await switchHandler()({}, {
      sessionId,
      channelId: CODEX_CHANNEL_ID,
      modelId: "gpt-5",
      runtime: "codex",
    });
    codexAdapter.setRun(async function* (): AsyncGenerator<unknown> {
      yield { type: "assistant", message: { content: [{ type: "text", text: "半途" }] }, parent_tool_use_id: null };
      yield result;
    });
    const r = (await sendHandler()({}, {
      sessionId,
      prompt: "继续",
      channelId: CODEX_CHANNEL_ID,
      model: "gpt-5",
    })) as { ok: boolean; error?: string };
    await flush();
    await flush();
    return { sessionId, ...r };
  }

  it('error_max_turns 终态：不消费交接（标记 ambiguous 保留），UI 终态事件照常推送', async () => {
    const { sessionId, ok } = await switchAndSendWithResult({
      type: "result",
      subtype: "error_max_turns",
      errors: ["已达最大工具循环轮次"],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(ok).toBe(true);
    // 目标内核确实收到了交接资料（投递发生过）
    expect(String(codexAdapter.calls.at(-1)?.prompt ?? "")).toContain("跨内核交接");
    // 但终态不是成功 → 不得消费
    const meta = getSessionMeta(sessionId)!;
    expect(meta.runtimeHandoff?.content).toBeTruthy();
    expect(meta.runtimeHandoff?.lastOutcome).toBe("ambiguous");
    expect(meta.runtimeHandoff?.attempts).toBe(1);
    // 既有 UI 终态行为未被本切片改变：turn_end 照常推
    expect(eventsOfType("turn_end").length).toBeGreaterThan(0);
  });

  it('error_during_execution（is_error）终态：同样不消费', async () => {
    const { sessionId } = await switchAndSendWithResult({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["stream error"],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const meta = getSessionMeta(sessionId)!;
    expect(meta.runtimeHandoff?.content).toBeTruthy();
    expect(meta.runtimeHandoff?.lastOutcome).toBe("ambiguous");
  });

  it('paused_no_progress 终态：同样不消费（暂停不是成功）', async () => {
    const { sessionId } = await switchAndSendWithResult({
      type: "result",
      subtype: "paused_no_progress",
      errors: ["已暂停：连续多次操作未获得新进展。"],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const meta = getSessionMeta(sessionId)!;
    expect(meta.runtimeHandoff?.lastOutcome).toBe("ambiguous");
  });

  it('成功终态仍照常消费（对照组）', async () => {
    const { sessionId } = await switchAndSendWithResult({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(getSessionMeta(sessionId)?.runtimeHandoff).toBeUndefined();
  });

  it('Codex completed 终态：成功消费交接', async () => {
    const { sessionId } = await switchAndSendWithResult({
      kind: "result",
      subtype: "completed",
    });
    expect(getSessionMeta(sessionId)?.runtimeHandoff).toBeUndefined();
  });

  it('Codex completed 带 is_error：不消费交接', async () => {
    const { sessionId } = await switchAndSendWithResult({
      kind: "result",
      subtype: "completed",
      is_error: true,
      errors: ["Codex result failed"],
    });
    const meta = getSessionMeta(sessionId)!;
    expect(meta.runtimeHandoff?.content).toBeTruthy();
    expect(meta.runtimeHandoff?.lastOutcome).toBe("ambiguous");
  });
});

describe('orchestration：UPDATE_SESSION_META 组合级拦截（含未类型化 channelId）', () => {
  it('仅原生线程 ID 识别的旧 Codex 会话仍可重命名', async () => {
    const sessionId = newSession({ internalBackend: undefined });
    updateSessionMeta(sessionId, { codexThreadId: "legacy-thread" });
    await expect(
      metaHandler()({}, { id: sessionId, patch: { title: "新标题" } }),
    ).resolves.toBeTruthy();
    expect(getSessionMeta(sessionId)?.title).toBe("新标题");
    expect(getSessionMeta(sessionId)?.codexThreadId).toBe("legacy-thread");
  });

  it('不能通过显式清空 channelId 绕过绑定校验', async () => {
    const sessionId = newSession({ channelId: API_CHANNEL_ID, agentRuntime: undefined, internalBackend: undefined });
    await expect(
      metaHandler()({}, { id: sessionId, patch: { channelId: undefined } }),
    ).rejects.toThrow(/渠道不存在/);
    expect(getSessionMeta(sessionId)?.channelId).toBe(API_CHANNEL_ID);
  });

  it('跨内核改 channelId（不带 internalBackend）也被拦', async () => {
    const sessionId = newSession({ agentRuntime: undefined, internalBackend: undefined, channelId: MESSAGES_CHANNEL_ID, modelId: "claude-api" }); // 外部渠道 → pi
    await expect(
      metaHandler()({}, { id: sessionId, patch: { channelId: CODEX_CHANNEL_ID } }),
    ).rejects.toThrow(/switchSessionRuntime/);
    expect(getSessionMeta(sessionId)?.channelId).toBe(MESSAGES_CHANNEL_ID);
  });

  it('channelId + internalBackend 一起改也不放行（组合校验）', async () => {
    const sessionId = newSession();
    await expect(
      metaHandler()({}, {
        id: sessionId,
        patch: { channelId: CODEX_CHANNEL_ID, internalBackend: "codex-app-server" },
      }),
    ).rejects.toThrow(/switchSessionRuntime/);
    expect(getSessionMeta(sessionId)?.channelId).toBe(MESSAGES_CHANNEL_ID);
  });

  it('同内核换渠道（Pi → Pi）放行', async () => {
    const sessionId = newSession({ agentRuntime: undefined, channelId: API_CHANNEL_ID, internalBackend: undefined, modelId: "grok-4" });
    await expect(
      metaHandler()({}, { id: sessionId, patch: { channelId: API_CHANNEL_ID_2 } }),
    ).resolves.toBeTruthy();
    expect(getSessionMeta(sessionId)?.channelId).toBe(API_CHANNEL_ID_2);
  });

  it('换成不存在的渠道 → 拒绝（不用「查不到」绕过内核比对）', async () => {
    const sessionId = newSession({ agentRuntime: undefined, internalBackend: undefined });
    await expect(
      metaHandler()({}, { id: sessionId, patch: { channelId: "ghost" } }),
    ).rejects.toThrow(/渠道不存在/);
    expect(getSessionMeta(sessionId)?.channelId).toBe(MESSAGES_CHANNEL_ID);
  });
});

describe('orchestration：发送渠道解析（会话绑定优先于默认内核）', () => {
  it('同 channelId 的 endpoint/key/protocol/model/capacity 变化产生新连接指纹，不泄露凭据', () => {
    const channel = {
      id: API_CHANNEL_ID,
      name: '外部 API',
      provider: 'custom',
      apiProtocol: 'openai-responses',
      baseUrl: 'https://one.example/v1',
      apiKey: '',
      enabled: true,
      models: [{ id: 'gpt-5', name: 'GPT-5', enabled: true, contextWindow: 128_000 }],
      createdAt: 0,
      updatedAt: 0,
    } as Channel;
    const baseline = createRuntimeConnectionFingerprint('codex', channel, 'gpt-5', 'key-one');
    expect(createRuntimeConnectionFingerprint('codex', { ...channel, baseUrl: 'https://two.example/v1' }, 'gpt-5', 'key-one')).not.toBe(baseline);
    expect(createRuntimeConnectionFingerprint('codex', channel, 'gpt-5', 'key-two')).not.toBe(baseline);
    expect(createRuntimeConnectionFingerprint('codex', { ...channel, apiProtocol: 'openai-chat' }, 'gpt-5', 'key-one')).not.toBe(baseline);
    expect(createRuntimeConnectionFingerprint('codex', { ...channel, models: [{ ...channel.models[0]!, contextWindow: 256_000 }] }, 'gpt-5', 'key-one')).not.toBe(baseline);
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['endpoint', { baseUrl: 'https://rotated.example/v1' }],
    ['credential', { apiKey: 'rotated-key-not-real' }],
  ])('same-id %s change disposes the old live runtime before a new send', async (_label, patch) => {
    const sessionId = newSession({ channelId: API_CHANNEL_ID, modelId: 'grok-4', internalBackend: undefined });
    updateSessionMeta(sessionId, { agentRuntime: 'pi' });
    const before = getChannel(API_CHANNEL_ID)!;
    (svc as unknown as { runtimeBindingBySession: Map<string, string> }).runtimeBindingBySession.set(
      sessionId,
      createRuntimeConnectionFingerprint('pi', before, 'grok-4', getDecryptedApiKey(API_CHANNEL_ID)),
    );
    let destroyed = 0;
    (svc as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId, {
      hasLiveProcess: () => true,
      isTurnInFlight: () => false,
      hasUnsettledStop: () => false,
      isInterrupting: () => false,
      destroy: () => { destroyed += 1 },
    });
    updateChannel(API_CHANNEL_ID, patch);

    const result = (await sendHandler()({}, { sessionId, prompt: 'continue', channelId: API_CHANNEL_ID, model: 'grok-4' })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(destroyed).toBe(1);
    expect(externalAdapter.calls.at(-1)?.channelConfig).toEqual(expect.objectContaining({
      baseUrl: getChannel(API_CHANNEL_ID)?.baseUrl,
    }));
  });

  it('Responses API + codex 首发把 apiConnection 交给 Codex，并持久化显式运行内核', async () => {
    const sessionId = 'draft-official-codex';
    const result = (await sendHandler()({}, {
      sessionId,
      prompt: 'hello responses',
      agentRuntime: 'codex',
      channelId: RESPONSES_CHANNEL_ID,
      model: 'gpt-api',
    })) as { ok: boolean; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(codexAdapter.calls).toHaveLength(1);
    expect(codexAdapter.calls[0]).toMatchObject({
      model: 'gpt-api',
      apiConnection: {
        channelId: RESPONSES_CHANNEL_ID,
        baseUrl: 'https://responses.example.invalid/v1',
        apiKey: 'responses-key-not-real',
        contextWindow: 128_000,
      },
    });
    expect(getSessionMeta(sessionId)).toMatchObject({
      agentRuntime: 'codex',
      channelId: RESPONSES_CHANNEL_ID,
      modelId: 'gpt-api',
      internalBackend: 'codex-app-server',
    });
  });

  it('Messages API + claude-code 首发且重读后保持显式绑定', async () => {
    const sessionId = 'draft-official-claude';
    const result = (await sendHandler()({}, {
      sessionId,
      prompt: 'hello messages',
      agentRuntime: 'claude-code',
      channelId: MESSAGES_CHANNEL_ID,
      model: 'claude-api',
    })) as { ok: boolean; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(claudeCodeAdapter.calls).toHaveLength(1);
    expect(claudeCodeAdapter.calls[0]).toMatchObject({
      model: 'claude-api',
      apiConnection: {
        channelId: MESSAGES_CHANNEL_ID,
        baseUrl: 'https://messages.example.invalid',
        apiKey: 'messages-key-not-real',
        contextWindow: 200_000,
      },
    });
    // getSessionMeta reads the persisted index rather than a SessionService cache.
    expect(getSessionMeta(sessionId)).toMatchObject({
      agentRuntime: 'claude-code',
      channelId: MESSAGES_CHANNEL_ID,
      modelId: 'claude-api',
      internalBackend: 'claude-code',
    });
  });

  it('已绑定会话拒绝发送输入中冲突的 agentRuntime', async () => {
    const sessionId = newSession();
    updateSessionMeta(sessionId, { agentRuntime: 'claude-code' });
    const r = (await sendHandler()({}, {
      sessionId,
      prompt: 'hi',
      agentRuntime: 'codex',
      channelId: MESSAGES_CHANNEL_ID,
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('已显式绑定');
  });

  it('已持久化 claude-code 会话未传 channelId → 用 meta 绑定渠道，不报「已锁定…跨内核」', async () => {
    const sessionId = newSession(); // messages 渠道 + internalBackend=claude-code
    const r = (await sendHandler()({}, { sessionId, prompt: "hi" })) as { ok: boolean; error?: string };
    expect(String(r.error ?? "")).not.toContain("已锁定");
    expect(String(r.error ?? "")).not.toContain("跨运行内核");
    if (r.ok) {
      // 确实用了 Claude Code 内核（而不是默认外部渠道）
      expect(claudeCodeAdapter.calls.length).toBe(1);
      expect(externalAdapter.calls.length).toBe(0);
    }
  });

  it('显式选择的旧会话保持：codex 绑定 + 显式 channelId 正常发送', async () => {
    const sessionId = newSession({ channelId: CODEX_CHANNEL_ID, agentRuntime: "codex", internalBackend: "codex-app-server", modelId: "gpt-5" });
    const r = (await sendHandler()({}, {
      sessionId,
      prompt: "hi",
      channelId: CODEX_CHANNEL_ID,
      model: "gpt-5",
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(true);
    expect(codexAdapter.calls.length).toBe(1);
  });

  it('新会话无显式选择且无可用 Pi 渠道 → 明确拒绝，不静默回落内置内核', async () => {
    seedChannels({ includeExternal: false });
    const r = (await sendHandler()({}, { sessionId: "draft-no-channel", prompt: "hi" })) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("Pi 渠道");
    expect(claudeCodeAdapter.calls.length).toBe(0);
    expect(codexAdapter.calls.length).toBe(0);
  });

  it('新会话有 Pi 渠道时默认走 Pi（外部渠）', async () => {
    const r = (await sendHandler()({}, { sessionId: "draft-pi-default", prompt: "hi" })) as {
      ok: boolean;
      error?: string;
    };
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(externalAdapter.calls.length).toBe(1);
    expect(claudeCodeAdapter.calls.length).toBe(0);
    expect(codexAdapter.calls.length).toBe(0);
    expect(getSessionMeta("draft-pi-default")?.channelId).toBe(API_CHANNEL_ID);
  });
});
