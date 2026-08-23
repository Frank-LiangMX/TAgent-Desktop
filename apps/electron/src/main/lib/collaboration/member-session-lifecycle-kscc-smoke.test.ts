/**
 * kscc 生命周期窄冒烟（P1-2b，门控真机测试）。
 *
 * 诚实边界：`kscc bare` **不 resume**（见 packages/pi-core/src/kscc-spawn.ts 顶部注释：
 * 「kscc bare 不 resume、不读 sdk-config JSONL、每次独立」）。本冒烟**不**声称 native
 * resume E2E；只打通 lifecycle `createSession` → `ChannelBackendAdapter.runTurn`（真机 kscc）
 * → `interruptSession` 取消**进行中**的 turn → `heartbeat.alive=false`。
 *
 * 门控：仅当 `TAGENT_KSCC_LIFECYCLE_SMOKE=1` 时运行；否则整 suite skip（不算失败）。
 * 开启后若本机无 `kscc`（resolveKsccPath() === undefined）→ 各 test skip（不算失败）。
 * 失败如实暴露，**禁止为绿而假造**（如 kscc 在 interrupt 前完成全文属竞态，应失败而非假绿）。
 *
 * 与离线单测的区别：**不 mock** `@tagent/pi-core`（用真实 kscc seat runner，spawn 真机 kscc
 * 子进程）与 `../adapters/claude/kscc-path`（用真实 PATH 解析）；仅 mock channel-store（提供
 * kscc-internal 渠道配置，避免 safeStorage）与 cli-workers（kscc 路径不使用，避免重型依赖）。
 *
 * 运行：
 *   # 默认（离线 CI）：整 suite skip
 *   bunx vitest run apps/electron/src/main/lib/collaboration/member-session-lifecycle-kscc-smoke.test.ts
 *   # 真机门控（本机已装 kscc 且有 kscc-internal 渠道）：
 *   $env:TAGENT_KSCC_LIFECYCLE_SMOKE='1'
 *   bunx vitest run apps/electron/src/main/lib/collaboration/member-session-lifecycle-kscc-smoke.test.ts
 */
import { describe, expect, test, vi } from "vitest";
import type { Channel } from "@tagent/shared";

// ===== mock 状态（vi.hoisted 保证 vi.mock 工厂能引用） =====
// 仅提供 kscc-internal 渠道配置（kscc 不需要 apiKey）；不发真实 HTTP、不读真实 safeStorage。
const channelState = vi.hoisted(() => {
  const channel: Channel = {
    id: "kscc-internal",
    provider: "kscc-internal",
    name: "kscc-internal",
    baseUrl: "",
    apiKey: "",
    models: [{ id: "glm-5.2", name: "glm-5.2", enabled: true, contextWindow: 200_000 }],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  } as Channel;
  return { channels: [channel] as Channel[], decrypted: {} as Record<string, string> };
});

vi.mock("../channel/channel-store", () => ({
  listChannels: () => channelState.channels,
  getChannel: (id: string) => channelState.channels.find((c) => c.id === id),
  getDecryptedApiKey: (id: string) => channelState.decrypted[id] ?? "",
}));

// kscc 路径不使用 cli-workers；mock 掉避免加载重型 CLI 依赖。
vi.mock("../agent/cli-workers/resolve-backend", () => ({
  resolveTaskSubagentBackend: () => ({ kind: "unavailable" }),
}));
vi.mock("../agent/cli-workers/run-cli-worker", () => ({
  runCliWorker: async () => ({ ok: true, summary: "", durationMs: 0 }),
}));

// 注意：**不** mock `@tagent/pi-core`（用真实 kscc seat runner）与
// `../adapters/claude/kscc-path`（用真实 PATH 解析），以驱动真机 kscc。

import { resolveKsccPath } from "../adapters/claude/kscc-path";
import { ChannelBackendAdapter } from "./member-backend-adapter";
import { ChannelMemberSessionLifecycleAdapter } from "./member-session-lifecycle";

const SMOKE = process.env.TAGENT_KSCC_LIFECYCLE_SMOKE === "1";
// 仅在开启门控时探测本机 kscc（避免离线运行时 spawn `where kscc`）。
const KSCC_PATH = SMOKE ? resolveKsccPath() : undefined;
const HAS_KSCC = Boolean(KSCC_PATH);

/**
 * 门控整体 skip 说明：未设环境变量时整 suite skip；开启但本机无 kscc 时各 test skip。
 * 二者都不算失败，符合「默认单测必须离线可过、无门控不连真网」的约束。
 */
describe.skipIf(!SMOKE)(
  "kscc lifecycle smoke (TAGENT_KSCC_LIFECYCLE_SMOKE=1)",
  () => {
    test.skipIf(!HAS_KSCC)(
      "create → 极短 runTurn（kscc -p 一句话）→ 非空正文 + heartbeat alive",
      async () => {
        const lifecycle = new ChannelMemberSessionLifecycleAdapter();
        const adapter = new ChannelBackendAdapter(lifecycle);
        const handle = await lifecycle.createSession({
          roomId: "cr_smoke",
          memberId: "cm_smoke",
          logicalSessionId: "ls_smoke_short",
          channelId: "kscc-internal",
        });
        expect(handle.backend).toBe("kscc");
        expect(handle.resumeMode).toBe("none");

        const controller = new AbortController();
        const result = await adapter.runTurn({
          roomId: "cr_smoke",
          memberId: "cm_smoke",
          runId: "run_smoke_short",
          triggerMessageId: "msg_smoke_short",
          logicalSessionId: handle.logicalSessionId,
          channelId: "kscc-internal",
          backend: "pi",
          systemPrompt: "你是助手。",
          prompt: "请只回复「你好」两个字，不要任何其他内容或解释。",
          signal: controller.signal,
        });

        expect(typeof result.text).toBe("string");
        expect(result.text.trim().length).toBeGreaterThan(0);
        const beat = await lifecycle.heartbeat(handle);
        expect(beat.alive).toBe(true);
      },
      30_000,
    );

    test.skipIf(!HAS_KSCC)(
      "create → 长 runTurn + 立即 interrupt → 取消进行中 turn + heartbeat false",
      async () => {
        const lifecycle = new ChannelMemberSessionLifecycleAdapter();
        const adapter = new ChannelBackendAdapter(lifecycle);
        const handle = await lifecycle.createSession({
          roomId: "cr_smoke",
          memberId: "cm_smoke",
          logicalSessionId: "ls_smoke_interrupt",
          channelId: "kscc-internal",
        });

        const controller = new AbortController();
        const turnPromise = adapter.runTurn({
          roomId: "cr_smoke",
          memberId: "cm_smoke",
          runId: "run_smoke_interrupt",
          triggerMessageId: "msg_smoke_interrupt",
          logicalSessionId: handle.logicalSessionId,
          channelId: "kscc-internal",
          backend: "pi",
          systemPrompt: "你是助手。",
          prompt: "请用中文写一篇至少 3000 字的长文章，主题是海洋生态系统。",
          signal: controller.signal,
        });

        // bindTurnAbort 在 runTurn 首个 await 前同步登记；让出一个微任务确保 spawn + signal
        // 监听已就位，再 interrupt。
        await Promise.resolve();
        await lifecycle.interruptSession({ handle, reason: "smoke-interrupt" });

        // 真实 kscc seat runner：abort 后 kill 子进程并 resolve 空正文（见 moa-orchestrator
        // runSeatWithUsage 的 `if (signal.aborted) return { text: "" }`）。故「被取消」表现为
        // reject('aborted') 或 resolve 空正文。若 kscc 在 interrupt 前完成全文（竞态），此处
        // 如实失败——绝不假绿。
        let resolved: { text: string } | undefined;
        let rejected = false;
        try {
          resolved = await turnPromise;
        } catch {
          rejected = true;
        }
        const cancelled = rejected || (resolved ? resolved.text.trim() === "" : false);
        expect(cancelled).toBe(true);

        const beat = await lifecycle.heartbeat(handle);
        expect(beat.alive).toBe(false);
        expect(beat.detail).toBe("interrupted");
      },
      30_000,
    );
  },
);
