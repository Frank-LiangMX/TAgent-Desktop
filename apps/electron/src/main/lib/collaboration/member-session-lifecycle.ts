/**
 * Channel 成员会话生命周期薄封装（P1-2a）。
 *
 * 包裹/并列于 ChannelBackendAdapter：runTurn 主路径不动，本类只叠加 create/resume/
 * compact/interrupt/heartbeat 契约（MemberSessionLifecycleAdapter）。诚实 fail-closed：
 *
 * - createSession：解析渠道后端（复用 resolveChannelBackendConfig），返回基于 logicalSessionId
 *   的 handle；backend 按解析结果标 'kscc'（kscc-internal）/ 'channel'（外部）。CHANNEL 当前
 *   supportsResume=false → handle.resumeMode='none'（宿主侧 replay 续跑由 execution bridge 的
 *   continuation 路径承担，不由本方法 resumeSession 完成）。
 * - resumeSession：supportsResume=false → **抛错 fail-closed**，绝不假装原生 resume 成功。
 * - compactSession：未接真实压缩 → 返回 { ok:false, summary:'not implemented' }，不假装已压缩。
 * - interruptSession：登记 sessionId 到内存 Set，并 **abort 该 session 的 inflight turn
 *   controller**（P1-2b 升级：从「只记 Set」到「可取消进行中 turn」）；**未接进程级 kill**，
 *   不杀真实子进程——仅协作 AbortSignal，进程级 kill 由 runner 自身在收到 abort 时处理。
 * - heartbeat：create 后未 interrupt → alive；interrupt 后或未知 session → alive=false。
 *
 * inflight turn 取消契约（P1-2b）：runTurn 调用方经 {@link bindTurnAbort} 把 input.signal 与
 * 本 session 的 interrupt controller 组合成一个 AbortSignal 透传给 runner；interruptSession
 * abort 该 controller 即取消进行中的 turn。controller 复用若已存在（同 session 并发 turn
 * 共享一个 interrupt 控制点），abort 后从登记表移除使下一 turn 拿到全新 controller。
 *
 * 除 createSession 调 resolveChannelBackendConfig（读 channel-store）外无 I/O；不落盘。
 *
 * 不代表本机 kscc/Pi 真机 create→resume E2E 已完成（那是 P1-2b）。
 */
import {
  abortCodexRoomSession,
  MemberBackendResolveError,
  resolveChannelBackendConfig,
} from "./member-backend-adapter";
import type {
  CollaborationMemberCapabilities,
  MemberSessionBackend,
  MemberSessionCompactInput,
  MemberSessionCreateInput,
  MemberSessionHandle,
  MemberSessionHeartbeatResult,
  MemberSessionInterruptInput,
  MemberSessionLifecycleAdapter,
  MemberSessionResumeInput,
} from "@tagent/shared";

/**
 * Channel 后端能力：与 ChannelBackendAdapter.capabilities() 一致，诚实标记
 * 无 resume / 实时输入 / 工具桥 / 结构化事件。
 */
const CHANNEL_LIFECYCLE_CAPABILITIES: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
};

/** 生命周期操作未支持时抛出（fail-closed），禁止假装成功。 */
export class MemberSessionLifecycleError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "MemberSessionLifecycleError";
  }
}

export class ChannelMemberSessionLifecycleAdapter
  implements MemberSessionLifecycleAdapter
{
  /** 已 create 的 sessionId（用于 heartbeat 判定已知 session）。 */
  private readonly sessions = new Set<string>();
  /** 已 interrupt 的 sessionId（heartbeat 据此返回 alive=false）。 */
  private readonly interrupted = new Set<string>();
  /**
   * 每个 session 的 inflight turn AbortController（P1-2b）。
   * bindTurnAbort 登记，interruptSession abort 之即取消进行中的 turn。
   * 复用若已存在（同 session 并发 turn 共享一个 interrupt 控制点）。
   */
  private readonly turnControllers = new Map<string, AbortController>();

  capabilities(): CollaborationMemberCapabilities {
    return CHANNEL_LIFECYCLE_CAPABILITIES;
  }

  async createSession(
    input: MemberSessionCreateInput,
  ): Promise<MemberSessionHandle> {
    if (input.signal?.aborted) {
      throw new MemberSessionLifecycleError(
        "createSession 已在调用前取消",
        "ABORTED",
      );
    }
    if (input.backend === "codex") {
      const sessionId = input.logicalSessionId;
      this.sessions.add(sessionId);
      this.interrupted.delete(sessionId);
      return {
        sessionId,
        logicalSessionId: input.logicalSessionId,
        backend: "codex",
        resumeMode: "native",
        createdAt: Date.now(),
      };
    }
    // 解析渠道后端；失败抛 MemberBackendResolveError（NO_CHANNEL / CHANNEL_DISABLED /
    // NO_API_KEY / NO_KSCC / NO_MODEL / NO_CHANNEL_BACKEND），调用方据此 fail-closed。
    const cfg = resolveChannelBackendConfig({
      channelId: input.channelId,
      modelId: input.modelId,
    });
    const backend: MemberSessionBackend =
      cfg.kind === "kscc" ? "kscc" : "channel";
    // channel 后端无 provider 原生 session id；用稳定逻辑键作 sessionId 占位，便于
    // interrupt/heartbeat 协作（多个成员各自 logicalSessionId 不同，不会碰撞）。
    const sessionId = input.logicalSessionId;
    this.sessions.add(sessionId);
    return {
      sessionId,
      logicalSessionId: input.logicalSessionId,
      backend,
      // CHANNEL 当前 supportsResume=false → resumeMode='none'；宿主侧 replay 续跑由
      // execution bridge 的 continuation 路径承担，不由本方法 resumeSession 完成。
      resumeMode: "none",
      createdAt: Date.now(),
    };
  }

  async resumeSession(
    input: MemberSessionResumeInput,
  ): Promise<MemberSessionHandle> {
    if (
      input.handle.backend === "codex" &&
      input.handle.resumeMode === "native"
    ) {
      if (input.signal?.aborted) {
        throw new MemberSessionLifecycleError(
          "Codex resumeSession 已在调用前取消",
          "ABORTED",
        );
      }
      this.sessions.add(input.handle.sessionId);
      this.interrupted.delete(input.handle.sessionId);
      return {
        ...input.handle,
        // Codex App Server 的 thread ID 由 adapter 按 logicalSessionId 管理；
        // providerSessionId 不改写这里的逻辑寻址键。
        createdAt: Date.now(),
      };
    }
    // 诚实 fail-closed：CHANNEL 不支持原生 resume，禁止假装成功。
    throw new MemberSessionLifecycleError(
      "channel 后端不支持原生 resume（supportsResume=false）；续跑请走 execution bridge 的 continuation 路径",
      "RESUME_NOT_SUPPORTED",
    );
  }

  async compactSession(
    input: MemberSessionCompactInput,
  ): Promise<{ ok: boolean; summary?: string }> {
    // 未接真实压缩；诚实返回 not implemented，不假装已压缩。
    return { ok: false, summary: "not implemented: channel compact not wired" };
  }

  async interruptSession(
    input: MemberSessionInterruptInput,
  ): Promise<void> {
    // 登记 interrupt（heartbeat 据此返回 alive=false）。
    this.interrupted.add(input.handle.sessionId);
    if (input.handle.backend === "codex") {
      abortCodexRoomSession(input.handle.logicalSessionId);
    }
    // P1-2b：abort 该 session 的 inflight turn controller → 组合 signal 随之 abort →
    // 取消进行中的 turn。abort 后从登记表移除，使下一次 bindTurnAbort 拿到全新 controller
    // （避免被中断过的 session 新 turn 一启动即已 abort）。
    // 未接进程级 kill——仅协作 AbortSignal；进程级 kill 由 runner 自身处理。
    const controller = this.turnControllers.get(input.handle.sessionId);
    if (controller) {
      controller.abort();
      this.turnControllers.delete(input.handle.sessionId);
    }
  }

  bindTurnAbort(sessionId: string, callerSignal?: AbortSignal): AbortSignal {
    // turn 开始：复用既有 controller（同 session 并发 turn 共享一个 interrupt 控制点）；
    // 否则新建并登记。
    let controller = this.turnControllers.get(sessionId);
    if (!controller) {
      controller = new AbortController();
      this.turnControllers.set(sessionId, controller);
    }
    // 组合 callerSignal 与 session interrupt controller：任一 abort 即触发。
    const composed = composeAbortSignals([controller.signal, callerSignal]);
    // 结束清理：callerSignal abort 时（bridge dispose / 调用方取消）移除登记项。
    // 正常完成时 controller 留待下一次 bindTurnAbort 覆盖或 interruptSession abort。
    if (callerSignal) {
      if (callerSignal.aborted) {
        this.turnControllers.delete(sessionId);
      } else {
        callerSignal.addEventListener(
          "abort",
          () => this.turnControllers.delete(sessionId),
          { once: true },
        );
      }
    }
    return composed;
  }

  async heartbeat(
    handle: MemberSessionHandle,
  ): Promise<MemberSessionHeartbeatResult> {
    const known = this.sessions.has(handle.sessionId);
    const isInterrupted = this.interrupted.has(handle.sessionId);
    const alive = known && !isInterrupted;
    return {
      alive,
      at: Date.now(),
      detail: alive
        ? undefined
        : isInterrupted
          ? "interrupted"
          : "unknown session",
    };
  }
}

/**
 * 把多个 AbortSignal 组合成一个：任一 abort 即 abort（P1-2b）。
 *
 * - 空数组 → 返回永不 abort 的占位 signal（调用方未传 signal 且 controller 永不 abort 时，
 *   runTurn 不应被此取消）。
 * - 任一已 abort → 直接返回该已 abort 的 signal。
 * - 否则新建 AbortController，监听所有 signal 的 abort；首个 abort 触发后清理全部监听。
 *
 * 不依赖 AbortSignal.any（兼容更广运行时）；纯内存，无 I/O。供 Channel / Fake lifecycle 共用。
 */
export function composeAbortSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => Boolean(s));
  if (filtered.length === 0) return new AbortController().signal;
  const already = filtered.find((s) => s.aborted);
  if (already) return already;
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
    for (const s of filtered) s.removeEventListener("abort", onAbort);
  };
  for (const s of filtered) s.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}
