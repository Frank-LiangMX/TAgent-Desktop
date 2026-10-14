/**
 * Explicit recovery is a fresh, user-initiated turn. These IPC tests keep the boundary in main:
 * renderer input cannot replay a failed prompt or route a recovery into a sidecar/MoA flow.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "tagent-recovery-ipc-"));
process.env.TAGENT_CONFIG_DIR = CONFIG_DIR;
process.env.TAGENT_DEV = "1";

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
  return new Proxy(base, { get: (target, key) => key in target ? target[key as string] : stub() });
});

vi.mock("../workspace/workspace-manager", () => ({
  resolveWorkspaceForSession: () => undefined,
  resolveWorkspaceById: () => undefined,
  listWorkspaces: () => [],
  getDefaultWorkspace: () => undefined,
}));

const { AGENT_IPC_CHANNELS } = await import("@tagent/shared");
const { registerAdapterFactory } = await import("../adapters");
const { createSession, getSessionMeta, readPanelMessages, updateSessionMeta } = await import("../agent/session-store");
const { writeJsonAtomic } = await import("../atomic-json");
const { getChannelsPath } = await import("../config/config-paths");
const { RECOVERY_CONTINUE_PROMPT, SessionService } = await import("./session-service");

const calls: Array<Record<string, unknown>> = [];
const adapter = {
  query: (input: Record<string, unknown>): AsyncIterable<unknown> => {
    calls.push(input);
    return (async function* (): AsyncGenerator<unknown> {
      yield { type: "result", subtype: "success", usage: {} };
    })();
  },
  abort: () => {},
  dispose: () => {},
  setModel: async () => {},
  hasActiveChannel: () => false,
};
registerAdapterFactory("external", () => adapter as never);

const CC_CHANNEL_ID = "cc-recovery";
let service: ReturnType<typeof SessionService.create>;
let sequence = 0;
const sentPayloads: unknown[] = [];

function seedChannels(): void {
  writeJsonAtomic(getChannelsPath(), {
    version: 1,
    channels: [{
      id: CC_CHANNEL_ID,
      name: "Claude Code test",
      provider: "custom",
      apiProtocol: "anthropic-messages",
      baseUrl: "https://example.invalid",
      apiKey: "test-key-not-real",
      enabled: true,
      models: [{ id: "claude-model", name: "Claude", enabled: true }],
      defaultModelId: "claude-model",
      createdAt: 0,
      updatedAt: 0,
    }],
  });
}

function newBoundSession(patch: Record<string, unknown> = {}): string {
  const id = `recovery-${++sequence}`;
  createSession({
    id,
    title: "recovery test",
    channelId: CC_CHANNEL_ID,
    modelId: "claude-model",
    agentRuntime: "pi",
    internalBackend: undefined,
    executionMode: "work",
    ...patch,
  } as never);
  return id;
}

function sendHandler(): (...args: unknown[]) => Promise<unknown> {
  const handler = ipcHandlers.get(AGENT_IPC_CHANNELS.SEND_MESSAGE);
  if (!handler) throw new Error("SEND_MESSAGE handler not registered");
  return handler as (...args: unknown[]) => Promise<unknown>;
}

function injectRuntime(sessionId: string, probes: Partial<{
  isTurnInFlight: () => boolean;
  hasUnsettledStop: () => boolean;
  isInterrupting: () => boolean;
}>): void {
  (service as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId, {
    sessionId,
  isTurnInFlight: () => false,
  hasUnsettledStop: () => false,
  isInterrupting: () => false,
    waitForTurnSettled: async () => true,
    isRunning: () => false,
    destroy: () => {},
    ...probes,
  });
}

beforeEach(() => {
  mkdirSync(join(CONFIG_DIR, "memory"), { recursive: true });
  seedChannels();
  calls.length = 0;
  sentPayloads.length = 0;
  service = SessionService.create(() => ({ webContents: { send: (_channel: string, payload: unknown) => sentPayloads.push(payload) } }) as never, null);
});

afterEach(() => service.disposeAll());
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));

describe("SessionService explicit recovery", () => {
  it("uses the fixed fresh-turn prompt and existing binding, never caller prompt or execution overrides", async () => {
    const sessionId = newBoundSession({ permissionMode: "plan" });
    const result = await sendHandler()({}, {
      sessionId,
      recovery: true,
      prompt: "REPLAY_THE_OLD_TASK",
      channelId: CC_CHANNEL_ID,
      model: "claude-model",
      agentRuntime: "pi",
      executionMode: "chat",
      internalBackend: "codex-app-server",
      attachments: [{
        id: "old-attachment",
        filename: "do-not-replay.txt",
        mediaType: "text/plain",
        localPath: "C:/do-not-replay.txt",
        size: 1,
      }],
      permissionMode: "auto",
    }) as { ok: boolean; error?: string };

    expect(result).toEqual({ ok: true });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(String(calls[0]?.prompt)).toContain(RECOVERY_CONTINUE_PROMPT);
    expect(String(calls[0]?.prompt)).not.toContain("REPLAY_THE_OLD_TASK");
    expect(calls[0]).toMatchObject({ sessionId, model: "claude-model", executionMode: "work" });
    expect(calls[0]?.attachments).toBeUndefined();
    expect(JSON.stringify(readPanelMessages(undefined, sessionId))).toContain(RECOVERY_CONTINUE_PROMPT);
    expect(JSON.stringify(readPanelMessages(undefined, sessionId))).not.toContain("REPLAY_THE_OLD_TASK");
    expect(JSON.stringify(readPanelMessages(undefined, sessionId))).not.toContain("do-not-replay.txt");
    expect(getSessionMeta(sessionId)).toMatchObject({ channelId: CC_CHANNEL_ID, modelId: "claude-model", agentRuntime: "pi", executionMode: "work", permissionMode: "plan" });
  });

  it("treats supplied binding fields as stale-window assertions, not binding overrides", async () => {
    const sessionId = newBoundSession();
    const result = await sendHandler()({}, {
      sessionId,
      recovery: true,
      prompt: "ignored",
      channelId: "other-channel",
      model: "other-model",
      agentRuntime: "codex",
    }) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("其他窗口变更");
    expect(calls).toHaveLength(0);
    expect(getSessionMeta(sessionId)).toMatchObject({ channelId: CC_CHANNEL_ID, modelId: "claude-model", agentRuntime: "pi" });
  });

  it("fails closed while a send, MoA, active turn, unsettled stop, or approval boundary exists", async () => {
    const pending = newBoundSession();
    (service as unknown as { pendingSendBySession: Map<string, number> }).pendingSendBySession.set(pending, 1);
    await expect(sendHandler()({}, { sessionId: pending, recovery: true, prompt: "ignored" })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/发送/) });

    const moa = newBoundSession();
    (service as unknown as { moaInFlight: Set<string> }).moaInFlight.add(moa);
    await expect(sendHandler()({}, { sessionId: moa, recovery: true, prompt: "ignored" })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/MoA/) });

    const running = newBoundSession();
    injectRuntime(running, { isTurnInFlight: () => true });
    await expect(sendHandler()({}, { sessionId: running, recovery: true, prompt: "ignored" })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/仍在执行/) });

    const stopping = newBoundSession();
    injectRuntime(stopping, { hasUnsettledStop: () => true });
    await expect(sendHandler()({}, { sessionId: stopping, recovery: true, prompt: "ignored" })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/停止尚未确认/) });

    const interrupting = newBoundSession();
    injectRuntime(interrupting, { isInterrupting: () => true });
    await expect(sendHandler()({}, { sessionId: interrupting, recovery: true, prompt: "ignored" })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/正在停止/) });

    const switching = newBoundSession();
    (service as unknown as { runtimeSwitchInFlight: Set<string> }).runtimeSwitchInFlight.add(switching);
    await expect(sendHandler()({}, { sessionId: switching, recovery: true, prompt: "ignored" })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/切换运行内核/) });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(sentPayloads)).not.toContain("session_error");
  });

  it.each([
    ["missing", undefined],
    ["archived", { archived: true }],
  ["fusion", { fusionMode: "single-bot", botProfileIds: ["bot-1"] }],
  ["MoA", { modelId: "moa:consult" }],
])("rejects %s sessions before dispatch", async (_name, patch) => {
    const sessionId = patch ? newBoundSession() : "missing-recovery-session";
    // createSession deliberately accepts only creation fields; persist the post-creation state
    // under test through the store, exactly as the normal runtime/fusion flows do.
    if (patch) updateSessionMeta(sessionId, patch as never);
    const result = await sendHandler()({}, { sessionId, recovery: true, prompt: "ignored" }) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(sentPayloads)).not.toContain("session_error");
  });

  it("allows only one same-tick recovery to pass the pending-send gate", async () => {
    const sessionId = newBoundSession();
    const instance = service as unknown as {
      handleSendForRuntime(input: unknown): Promise<void>;
    };
    const original = instance.handleSendForRuntime.bind(instance);
    let entered!: () => void;
    let release!: () => void;
    const enteredFirst = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    instance.handleSendForRuntime = async (input: unknown) => {
      entered();
      await gate;
      await original(input);
    };

    const first = sendHandler()({}, { sessionId, recovery: true, prompt: "ignored" }) as Promise<{ ok: boolean; error?: string }>;
    await enteredFirst;
    const second = await sendHandler()({}, { sessionId, recovery: true, prompt: "ignored" }) as { ok: boolean; error?: string };
    release();
    await expect(first).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/发送/) });
    expect(JSON.stringify(sentPayloads)).not.toContain("session_error");
  });

  it("does not inject an already-ambiguous runtime handoff into recovery", async () => {
    const sessionId = newBoundSession();
    updateSessionMeta(sessionId, {
      runtimeHandoff: {
        from: "codex",
        to: "pi",
        content: "HANDOFF_ALREADY_ATTEMPTED",
        createdAt: 1,
        sourcePanelMessageCount: 0,
        attempts: 1,
        lastOutcome: "ambiguous",
      },
    } as never);

    await expect(sendHandler()({}, { sessionId, recovery: true, prompt: "ignored" })).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(String(calls[0]?.prompt)).toContain(RECOVERY_CONTINUE_PROMPT);
    expect(String(calls[0]?.prompt)).not.toContain("HANDOFF_ALREADY_ATTEMPTED");
    expect(getSessionMeta(sessionId)?.runtimeHandoff).toMatchObject({ attempts: 1, lastOutcome: "ambiguous" });
  });
});
