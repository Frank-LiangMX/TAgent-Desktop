/**
 * 成员会话生命周期适配器单测（P1-2a）。
 *
 * 覆盖：
 * - Fake：create → heartbeat alive → interrupt → heartbeat dead
 * - Fake：supportsResume=false 时 resume 抛错
 * - Fake：supportsResume=true 时 resume 返回同 logicalSessionId / 复用或新 sessionId（文档化）
 * - Fake：compact 可配置成功/失败
 * - Channel lifecycle：create 成功（backend 按 kscc/channel 解析）、resume fail-closed、
 *   compact 未实现、interrupt 后 heartbeat false、未 interrupt heartbeat true
 *
 * Channel 分支 mock 与 member-backend-adapter.test.ts 同款（channel-store / kscc-path /
 * pi-core / cli-workers），不 发真实 HTTP、不读真实 safeStorage。
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Channel, ChannelModel } from "@tagent/shared";

// ===== mock 状态（vi.hoisted 保证 vi.mock 工厂能引用） =====
const channelState = vi.hoisted(() => ({
  channels: [] as Channel[],
  decrypted: {} as Record<string, string>,
}));
const ksccState = vi.hoisted(() => ({ path: "/fake/kscc" as string | undefined }));

vi.mock("../channel/channel-store", () => ({
  listChannels: () => channelState.channels,
  getChannel: (id: string) =>
    channelState.channels.find((c) => c.id === id),
  getDecryptedApiKey: (id: string) => channelState.decrypted[id] ?? "",
}));

vi.mock("../adapters/claude/kscc-path", () => ({
  resolveKsccPath: () => ksccState.path,
}));

vi.mock("../agent/cli-workers/resolve-backend", () => ({
  resolveTaskSubagentBackend: () => ({ kind: "unavailable" }),
}));

vi.mock("../agent/cli-workers/run-cli-worker", () => ({
  runCliWorker: async () => ({ ok: true, summary: "", durationMs: 0 }),
}));

vi.mock("@tagent/pi-core", () => ({
  createPiHttpSeatRunner: () => ({ runSeat: async () => "" }),
  createKsccSeatRunner: () => ({ runSeat: async () => "" }),
  createKsccBareStreamFn: () => () => ({}),
  createHttpDirectStreamFn: () => () => ({}),
}));

import {
  ChannelMemberSessionLifecycleAdapter,
  MemberSessionLifecycleError,
} from "./member-session-lifecycle";
import {
  FakeMemberSessionLifecycleAdapter,
} from "./member-session-lifecycle-fake";

function fakeModel(id: string, enabled = true): ChannelModel {
  return { id, name: id, enabled, contextWindow: 200_000 };
}

function fakeChannel(
  over: Partial<Channel> & Pick<Channel, "id" | "provider">,
): Channel {
  return {
    name: over.provider,
    baseUrl: "",
    apiKey: "",
    models: [fakeModel("default-model")],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Channel;
}

beforeEach(() => {
  channelState.channels = [];
  channelState.decrypted = {};
  ksccState.path = "/fake/kscc";
});

describe("FakeMemberSessionLifecycleAdapter", () => {
  test("create → heartbeat alive → interrupt → heartbeat dead", async () => {
    const fake = new FakeMemberSessionLifecycleAdapter();
    const handle = await fake.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_1",
    });

    const alive = await fake.heartbeat(handle);
    expect(alive.alive).toBe(true);

    await fake.interruptSession({ handle, reason: "user-cancel" });
    expect(fake.interruptCalls).toHaveLength(1);
    expect(fake.interruptCalls[0]?.reason).toBe("user-cancel");

    const dead = await fake.heartbeat(handle);
    expect(dead.alive).toBe(false);
    expect(dead.detail).toBe("interrupted");
  });

  test("supportsResume=false 时 resume 抛错（fail-closed）", async () => {
    const fake = new FakeMemberSessionLifecycleAdapter({
      supportsResume: false,
      resumeMode: "none",
    });
    expect(fake.capabilities().supportsResume).toBe(false);
    const handle = await fake.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_1",
    });

    await expect(
      fake.resumeSession({ handle }),
    ).rejects.toMatchObject({ code: "RESUME_NOT_SUPPORTED" });
    expect(fake.resumeCalls).toHaveLength(1);
  });

  test("supportsResume=true 且 resumeMode=non-native 时 resume 抛错（仅 native）", async () => {
    const fake = new FakeMemberSessionLifecycleAdapter({
      supportsResume: true,
      resumeMode: "replay",
    });
    const handle = await fake.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_1",
    });

    await expect(
      fake.resumeSession({ handle }),
    ).rejects.toMatchObject({ code: "RESUME_MODE_NOT_NATIVE" });
  });

  test("supportsResume=true 且 native：resume 返回同 logicalSessionId，默认复用原 sessionId", async () => {
    const fake = new FakeMemberSessionLifecycleAdapter();
    const handle = await fake.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_1",
    });
    const originalSessionId = handle.sessionId;

    const resumed = await fake.resumeSession({ handle });
    // 文档化行为：logicalSessionId 不变；sessionId 默认复用原 id
    expect(resumed.logicalSessionId).toBe("ls_1");
    expect(resumed.sessionId).toBe(originalSessionId);
    expect(resumed.resumeMode).toBe("native");
    expect(fake.resumeCalls).toHaveLength(1);

    // resumed handle 仍是已知 session，heartbeat alive
    const alive = await fake.heartbeat(resumed);
    expect(alive.alive).toBe(true);
  });

  test("resume 传入 providerSessionId 时使用新 sessionId（仍同 logicalSessionId）", async () => {
    const fake = new FakeMemberSessionLifecycleAdapter();
    const handle = await fake.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_1",
    });

    const resumed = await fake.resumeSession({
      handle,
      providerSessionId: "provider-native-xyz",
    });
    expect(resumed.sessionId).toBe("provider-native-xyz");
    expect(resumed.logicalSessionId).toBe("ls_1");
    // 新 sessionId 已登记，heartbeat alive
    expect((await fake.heartbeat(resumed)).alive).toBe(true);
  });

  test("compact 可配置成功/失败，并记录调用", async () => {
    const okFake = new FakeMemberSessionLifecycleAdapter();
    const handle = await okFake.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_1",
    });
    const okResult = await okFake.compactSession({ handle, reason: "long" });
    expect(okResult).toEqual({ ok: true, summary: "compacted" });
    expect(okFake.compactCalls).toHaveLength(1);
    expect(okFake.compactCalls[0]?.reason).toBe("long");

    const failFake = new FakeMemberSessionLifecycleAdapter({
      compactFails: true,
      compactSummary: "boom",
    });
    const handle2 = await failFake.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_2",
    });
    const failResult = await failFake.compactSession({ handle: handle2 });
    expect(failResult).toEqual({ ok: false, summary: "boom" });
  });

  test("未知 session 的 heartbeat 返回 alive=false 且 detail='unknown session'", async () => {
    const fake = new FakeMemberSessionLifecycleAdapter();
    const unknown: Awaited<ReturnType<typeof fake.createSession>> = {
      sessionId: "fake-999",
      logicalSessionId: "ls_x",
      backend: "pi",
      resumeMode: "native",
      createdAt: 0,
    };
    const beat = await fake.heartbeat(unknown);
    expect(beat.alive).toBe(false);
    expect(beat.detail).toBe("unknown session");
  });

  test("create 前已 abort → 抛 ABORTED", async () => {
    const fake = new FakeMemberSessionLifecycleAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fake.createSession({
        roomId: "cr_1",
        memberId: "cm_1",
        logicalSessionId: "ls_1",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("ChannelMemberSessionLifecycleAdapter", () => {
  test("capabilities 诚实全 false（与 ChannelBackendAdapter 一致）", () => {
    const adapter = new ChannelMemberSessionLifecycleAdapter();
    expect(adapter.capabilities()).toEqual({
      supportsResume: false,
      supportsLiveInput: false,
      supportsToolBridge: false,
      supportsStructuredEvents: false,
    });
  });

  test("createSession：kscc-internal 渠道 → backend='kscc'，resumeMode='none'", async () => {
    channelState.channels = [
      fakeChannel({
        id: "kscc-internal",
        provider: "kscc-internal",
        models: [fakeModel("glm-5.2")],
      }),
    ];
    ksccState.path = "/fake/kscc";
    const adapter = new ChannelMemberSessionLifecycleAdapter();

    const handle = await adapter.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_1",
      channelId: "kscc-internal",
    });
    expect(handle.backend).toBe("kscc");
    expect(handle.resumeMode).toBe("none");
    expect(handle.logicalSessionId).toBe("ls_1");
    expect(handle.sessionId).toBe("ls_1");
  });

  test("createSession：外部渠道 → backend='channel'", async () => {
    channelState.channels = [
      fakeChannel({
        id: "ext",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        models: [fakeModel("claude-x")],
      }),
    ];
    channelState.decrypted = { ext: "sk-1" };
    const adapter = new ChannelMemberSessionLifecycleAdapter();

    const handle = await adapter.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_ext",
      channelId: "ext",
    });
    expect(handle.backend).toBe("channel");
    expect(handle.resumeMode).toBe("none");
  });

  test("createSession：渠道解析失败 → 透传 MemberBackendResolveError（fail-closed）", async () => {
    // 无任何渠道 + 未绑定 channelId → NO_CHANNEL_BACKEND。
    // 注：resolveChannelBackendConfig 把短码放 Error.message、人类可读说明放 .code
    //（既有约定，本切片不改），故此处断言 message。
    const adapter = new ChannelMemberSessionLifecycleAdapter();
    await expect(
      adapter.createSession({
        roomId: "cr_1",
        memberId: "cm_1",
        logicalSessionId: "ls_1",
      }),
    ).rejects.toMatchObject({ message: "NO_CHANNEL_BACKEND" });
  });

  test("resumeSession：supportsResume=false → fail-closed 抛 RESUME_NOT_SUPPORTED", async () => {
    channelState.channels = [
      fakeChannel({
        id: "kscc-internal",
        provider: "kscc-internal",
        models: [fakeModel("glm-5.2")],
      }),
    ];
    const adapter = new ChannelMemberSessionLifecycleAdapter();
    const handle = await adapter.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_1",
      channelId: "kscc-internal",
    });

    await expect(
      adapter.resumeSession({ handle, providerSessionId: "native-1" }),
    ).rejects.toMatchObject({ code: "RESUME_NOT_SUPPORTED" });
  });

  test("compactSession：未接真实压缩 → { ok:false, summary:'not implemented' }", async () => {
    const adapter = new ChannelMemberSessionLifecycleAdapter();
    const result = await adapter.compactSession({
      handle: {
        sessionId: "ls_1",
        logicalSessionId: "ls_1",
        backend: "channel",
        resumeMode: "none",
        createdAt: 0,
      },
      reason: "long",
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not implemented");
  });

  test("interrupt 后 heartbeat false；未 interrupt heartbeat true", async () => {
    channelState.channels = [
      fakeChannel({
        id: "kscc-internal",
        provider: "kscc-internal",
        models: [fakeModel("glm-5.2")],
      }),
    ];
    const adapter = new ChannelMemberSessionLifecycleAdapter();
    const handle = await adapter.createSession({
      roomId: "cr_1",
      memberId: "cm_1",
      logicalSessionId: "ls_1",
      channelId: "kscc-internal",
    });

    const alive = await adapter.heartbeat(handle);
    expect(alive.alive).toBe(true);

    await adapter.interruptSession({ handle, reason: "user-cancel" });

    const dead = await adapter.heartbeat(handle);
    expect(dead.alive).toBe(false);
    expect(dead.detail).toBe("interrupted");
  });

  test("未知 session heartbeat false；MemberSessionLifecycleError 是 Error 子类", () => {
    const adapter = new ChannelMemberSessionLifecycleAdapter();
    const err = new MemberSessionLifecycleError("x", "CODE");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("CODE");

    const unknown = {
      sessionId: "never-created",
      logicalSessionId: "ls_x",
      backend: "channel" as const,
      resumeMode: "none" as const,
      createdAt: 0,
    };
    return adapter.heartbeat(unknown).then((beat) => {
      expect(beat.alive).toBe(false);
      expect(beat.detail).toBe("unknown session");
    });
  });
});
