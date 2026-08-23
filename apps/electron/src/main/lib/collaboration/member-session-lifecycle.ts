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
 * - interruptSession：仅登记 sessionId 到内存 Set，供后续 turn 的 AbortSignal 协作；
 *   **未接进程级 kill**，不杀真实子进程。
 * - heartbeat：create 后未 interrupt → alive；interrupt 后或未知 session → alive=false。
 *
 * 除 createSession 调 resolveChannelBackendConfig（读 channel-store）外无 I/O；不落盘。
 *
 * 不代表本机 kscc/Pi 真机 create→resume E2E 已完成（那是 P1-2b）。
 */
import {
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
    // 仅登记 sessionId，供后续 turn 的 AbortSignal 协作；未接进程级 kill，不杀真实子进程。
    this.interrupted.add(input.handle.sessionId);
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
