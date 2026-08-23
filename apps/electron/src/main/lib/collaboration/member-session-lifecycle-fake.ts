/**
 * Fake 成员会话生命周期适配器（P1-2a 单测主力）。
 *
 * 全程无 I/O；可配置 resumeMode（默认 native）与 capabilities.supportsResume（默认 true），
 * 用于在不含真实 provider 的单测里钉死 MemberSessionLifecycleAdapter 契约行为。
 *
 * 行为契约：
 * - createSession → 新 handle；resumeMode 取自 options（默认 'native'），sessionId 为
 *   `fake-<n>`（每次 create 自增，保证唯一）。
 * - resumeSession：仅当 capabilities.supportsResume **且** handle.resumeMode==='native' 才成功；
 *   否则抛 MemberSessionLifecycleError（RESUME_NOT_SUPPORTED / RESUME_MODE_NOT_NATIVE）。
 *   成功时返回 handle：logicalSessionId 不变；sessionId = providerSessionId ?? 原 sessionId
 *   （即默认复用原 sessionId，调用方也可通过 providerSessionId 指定新 id）。
 * - compactSession：记录调用；options.compactFails=true 时返回 { ok:false }，否则 { ok:true }。
 * - interruptSession：标记 sessionId 已中断；之后 heartbeat.alive=false；并 **abort 该
 *   session 的 inflight turn controller**（P1-2b：取消进行中的 turn）。
 * - heartbeat：已知 session 且未 interrupt → alive；interrupt 或未知 → alive=false。
 *
 * inflight turn 取消（P1-2b）：bindTurnAbort 把调用方 signal 与本 session 的 interrupt
 * controller 组合成 AbortSignal 透传给 runTurn；interruptSession abort 之即取消。本 Fake
 * 只实现生命周期契约，不实现 runTurn（单测不需要 provider 执行）；如需可取消的并发 turn，
 * 可另注入 MemberBackendAdapter，其 runTurn 监听 bindTurnAbort 返回的组合 signal。
 */
import {
  composeAbortSignals,
  MemberSessionLifecycleError,
} from "./member-session-lifecycle";
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
  MemberSessionResumeMode,
} from "@tagent/shared";

/** Fake 配置项。 */
export interface FakeMemberSessionLifecycleOptions {
  /** createSession 返回 handle 的 resumeMode；默认 'native'。 */
  resumeMode?: MemberSessionResumeMode;
  /** capabilities.supportsResume；默认 true（与 resumeMode='native' 配对）。 */
  supportsResume?: boolean;
  /** capabilities.supportsLiveInput；默认 false。 */
  supportsLiveInput?: boolean;
  /** capabilities.supportsToolBridge；默认 false。 */
  supportsToolBridge?: boolean;
  /** capabilities.supportsStructuredEvents；默认 false。 */
  supportsStructuredEvents?: boolean;
  /** handle.backend；默认 'pi'（Fake 与 provider 无关，仅作占位标识）。 */
  backend?: MemberSessionBackend;
  /** compactSession 是否失败；默认 false（成功）。 */
  compactFails?: boolean;
  /** compactSession 成功时返回的 summary；默认 'compacted'。 */
  compactSummary?: string;
}

interface ResolvedFakeOptions {
  resumeMode: MemberSessionResumeMode;
  supportsResume: boolean;
  supportsLiveInput: boolean;
  supportsToolBridge: boolean;
  supportsStructuredEvents: boolean;
  backend: MemberSessionBackend;
  compactFails: boolean;
  compactSummary: string;
}

function resolveOptions(
  opts: FakeMemberSessionLifecycleOptions | undefined,
): ResolvedFakeOptions {
  return {
    resumeMode: opts?.resumeMode ?? "native",
    supportsResume: opts?.supportsResume ?? true,
    supportsLiveInput: opts?.supportsLiveInput ?? false,
    supportsToolBridge: opts?.supportsToolBridge ?? false,
    supportsStructuredEvents: opts?.supportsStructuredEvents ?? false,
    backend: opts?.backend ?? "pi",
    compactFails: opts?.compactFails ?? false,
    compactSummary: opts?.compactSummary ?? "compacted",
  };
}

export class FakeMemberSessionLifecycleAdapter
  implements MemberSessionLifecycleAdapter
{
  readonly options: ResolvedFakeOptions;
  /** createSession 调用记录（可断言入参）。 */
  readonly createCalls: MemberSessionCreateInput[] = [];
  /** resumeSession 调用记录。 */
  readonly resumeCalls: MemberSessionResumeInput[] = [];
  /** compactSession 调用记录。 */
  readonly compactCalls: Array<{
    handle: MemberSessionHandle;
    reason?: string;
  }> = [];
  /** interruptSession 调用记录。 */
  readonly interruptCalls: Array<{
    handle: MemberSessionHandle;
    reason?: string;
  }> = [];
  /** 已 create 的 sessionId（heartbeat 据此判定已知 session）。 */
  private readonly sessions = new Set<string>();
  /** 已 interrupt 的 sessionId（heartbeat 据此返回 alive=false）。 */
  private readonly interrupted = new Set<string>();
  /** 每个 session 的 inflight turn AbortController（P1-2b）；interruptSession abort 之。 */
  private readonly turnControllers = new Map<string, AbortController>();
  private sessionCounter = 0;

  constructor(opts?: FakeMemberSessionLifecycleOptions) {
    this.options = resolveOptions(opts);
  }

  capabilities(): CollaborationMemberCapabilities {
    return {
      supportsResume: this.options.supportsResume,
      supportsLiveInput: this.options.supportsLiveInput,
      supportsToolBridge: this.options.supportsToolBridge,
      supportsStructuredEvents: this.options.supportsStructuredEvents,
    };
  }

  async createSession(
    input: MemberSessionCreateInput,
  ): Promise<MemberSessionHandle> {
    this.createCalls.push(input);
    if (input.signal?.aborted) {
      throw new MemberSessionLifecycleError(
        "createSession 已在调用前取消",
        "ABORTED",
      );
    }
    this.sessionCounter += 1;
    const sessionId = `fake-${this.sessionCounter}`;
    this.sessions.add(sessionId);
    return {
      sessionId,
      logicalSessionId: input.logicalSessionId,
      backend: this.options.backend,
      resumeMode: this.options.resumeMode,
      createdAt: Date.now(),
    };
  }

  async resumeSession(
    input: MemberSessionResumeInput,
  ): Promise<MemberSessionHandle> {
    this.resumeCalls.push(input);
    if (input.signal?.aborted) {
      throw new MemberSessionLifecycleError(
        "resumeSession 已在调用前取消",
        "ABORTED",
      );
    }
    if (!this.options.supportsResume) {
      throw new MemberSessionLifecycleError(
        "fake 后端声明 supportsResume=false，不支持 resume",
        "RESUME_NOT_SUPPORTED",
      );
    }
    if (input.handle.resumeMode !== "native") {
      throw new MemberSessionLifecycleError(
        `fake 后端仅支持 native resume，handle.resumeMode='${input.handle.resumeMode}'`,
        "RESUME_MODE_NOT_NATIVE",
      );
    }
    // 文档化：logicalSessionId 不变；sessionId = providerSessionId ?? 原 sessionId。
    const sessionId = input.providerSessionId ?? input.handle.sessionId;
    this.sessions.add(sessionId);
    return {
      sessionId,
      logicalSessionId: input.handle.logicalSessionId,
      backend: input.handle.backend,
      resumeMode: input.handle.resumeMode,
      createdAt: input.handle.createdAt,
    };
  }

  async compactSession(
    input: MemberSessionCompactInput,
  ): Promise<{ ok: boolean; summary?: string }> {
    this.compactCalls.push({ handle: input.handle, reason: input.reason });
    if (this.options.compactFails) {
      return { ok: false, summary: this.options.compactSummary };
    }
    return { ok: true, summary: this.options.compactSummary };
  }

  async interruptSession(
    input: MemberSessionInterruptInput,
  ): Promise<void> {
    this.interruptCalls.push({ handle: input.handle, reason: input.reason });
    this.interrupted.add(input.handle.sessionId);
    // P1-2b：abort 该 session 的 inflight turn controller → 组合 signal 随之 abort →
    // 取消进行中的 turn；abort 后移除登记，使下一 bindTurnAbort 拿到全新 controller。
    const controller = this.turnControllers.get(input.handle.sessionId);
    if (controller) {
      controller.abort();
      this.turnControllers.delete(input.handle.sessionId);
    }
  }

  bindTurnAbort(sessionId: string, callerSignal?: AbortSignal): AbortSignal {
    let controller = this.turnControllers.get(sessionId);
    if (!controller) {
      controller = new AbortController();
      this.turnControllers.set(sessionId, controller);
    }
    const composed = composeAbortSignals([controller.signal, callerSignal]);
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
