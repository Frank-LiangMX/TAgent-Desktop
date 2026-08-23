/**
 * MemberBackend 生命周期契约（P1-2a）
 *
 * 在现有 MemberBackendAdapter.runTurn 之外，补一层与 provider 无关的统一生命周期契约：
 * create / resume / compact / interrupt / heartbeat，以及 turn usage 的规范化回写形状。
 *
 * 设计目标：
 * - 旧代码只依赖 runTurn 的继续工作；新 Host/bridge 可按需依赖 lifecycle。
 * - 诚实能力：capabilities() 必须如实反映 provider 能力；未支持的操作（如 supportsResume=false
 *   时的 resumeSession）必须 fail-closed（抛错或返回未实现），绝不假装原生 resume 成功。
 *
 * 本切片只交付契约 + Fake + Channel 薄封装 + normalize 纯函数 + 单测；
 * **不代表**本机 kscc/Pi 真机 create→resume E2E 已完成（那是后续 P1-2b）。
 *
 * 类型优先放在 shared，供 core / electron / renderer 共享；运行时实现（Channel / Fake）
 * 见 apps/electron/src/main/lib/collaboration/。
 *
 * 参考：
 * - docs/plans/agent-collaboration-room/P1-2a-PROVIDER-LIFECYCLE-CONTRACT-brief.md
 * - packages/shared/src/types/collaboration-room.ts（MemberTurnInput / MemberTurnResult /
 *   MemberBackendAdapter / CollaborationMemberCapabilities / CollaborationUsageRecord）
 */
import type {
  CollaborationMemberCapabilities,
  CollaborationUsageRecord,
  MemberBackendAdapter,
  MemberTurnInput,
} from "./collaboration-room";

/**
 * 生命周期会话的后端标识。
 *
 * 比 {@link CollaborationMemberBackend} 更细：把 channel 后端再拆成 `kscc`（kscc-internal
 * 本机子进程）与 `channel`（外部 HTTP 渠道），供 handle 精确记录 createSession 的解析结果。
 * `pi` / `cli` 与 {@link CollaborationMemberBackend} 同义。
 */
export type MemberSessionBackend = "pi" | "kscc" | "cli" | "channel";

/**
 * resume 模式：
 * - `native`：provider 原生 session/thread id，resumeSession 可凭 providerSessionId 恢复。
 * - `replay`：由宿主重放上下文，不要求 provider 原生 id；resumeSession 一般 fail-closed，
 *   续跑走 execution bridge 的 continuation 路径。
 * - `none`：不支持 resume；resumeSession 必须 fail-closed。
 */
export type MemberSessionResumeMode = "native" | "replay" | "none";

/**
 * 一次成员会话的句柄；createSession 返回，后续 resume/compact/interrupt/heartbeat 凭此寻址。
 */
export interface MemberSessionHandle {
  /** 物理会话 ID（provider 原生或宿主派生）；resumeMode='replay'/'none' 时可能仅为稳定占位。 */
  sessionId: string;
  /** 逻辑席位/成员会话键；与 RoomBotSeat.logicalSessionId 对齐用途。 */
  logicalSessionId: string;
  backend: MemberSessionBackend;
  resumeMode: MemberSessionResumeMode;
  createdAt: number;
}

/** createSession 输入。backend 沿用 MemberTurnInput.backend 的粗粒度类型，adapter 解析后再细化。 */
export interface MemberSessionCreateInput {
  roomId: string;
  memberId: string;
  logicalSessionId: string;
  /** 成员执行后端（粗粒度）；adapter 解析后写入 handle.backend 的细粒度标识。 */
  backend?: MemberTurnInput["backend"];
  channelId?: string;
  modelId?: string;
  workspaceId?: string;
  signal?: AbortSignal;
}

export interface MemberSessionResumeInput {
  handle: MemberSessionHandle;
  /** 仅 native 有意义；replay 由宿主重放上下文，不要求 provider 原生 id。 */
  providerSessionId?: string;
  signal?: AbortSignal;
}

export interface MemberSessionCompactInput {
  handle: MemberSessionHandle;
  reason?: string;
  signal?: AbortSignal;
}

export interface MemberSessionInterruptInput {
  handle: MemberSessionHandle;
  reason?: string;
}

export interface MemberSessionHeartbeatResult {
  alive: boolean;
  at: number;
  detail?: string;
}

/**
 * 规范化后的用量，供 Host recordUsage / bridge 回写。
 *
 * 字段集合与 {@link CollaborationUsageRecord} 对齐；单独定义以承载「只保留有定义字段」的
 * 规范化语义，并预留后续裁剪/扩展空间。
 */
export interface NormalizedMemberUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  wallTimeMs?: number;
  toolCalls?: number;
  costUsd?: number;
}

/**
 * 把一次 turn 的用量规范化为 {@link NormalizedMemberUsage}。
 *
 * 规则：
 * - 只保留有定义且为有限数的字段（undefined / NaN / ±Infinity 一律省略），避免把脏数据
 *   或「未度量」混入权威用量账本。
 * - provider 自报字段（input/output/total/costUsd）作为基线。
 * - extras（宿主测量的 wallTimeMs / 计数的 toolCalls）**覆盖** usage 同名字段：宿主侧度量
 *   比 provider 自报更可信，且 provider 一般不回 wallTimeMs/toolCalls。
 *
 * 纯函数，不读 DB、不依赖时间。
 *
 * @param usage 一次 turn 的原始用量（MemberTurnResult.usage），可为 undefined。
 * @param extras 宿主侧补充度量；当前只定义 wallTimeMs / toolCalls。
 */
export function normalizeMemberTurnUsage(
  usage: CollaborationUsageRecord | undefined,
  extras?: { wallTimeMs?: number; toolCalls?: number },
): NormalizedMemberUsage {
  const pick = (value: number | undefined): number | undefined =>
    value === undefined || !Number.isFinite(value) ? undefined : value;
  const result: NormalizedMemberUsage = {};
  const set = (key: keyof NormalizedMemberUsage, value: number | undefined): void => {
    const cleaned = pick(value);
    if (cleaned !== undefined) result[key] = cleaned;
  };
  // provider 自报字段优先作为基线
  set("inputTokens", usage?.inputTokens);
  set("outputTokens", usage?.outputTokens);
  set("totalTokens", usage?.totalTokens);
  set("costUsd", usage?.costUsd);
  // wallTimeMs / toolCalls：extras 覆盖 usage（宿主度量更可信）
  set("wallTimeMs", extras?.wallTimeMs ?? usage?.wallTimeMs);
  set("toolCalls", extras?.toolCalls ?? usage?.toolCalls);
  return result;
}

/**
 * 生命周期扩展契约。可与现有 {@link MemberBackendAdapter} 组合：
 * - 旧代码只依赖 runTurn 继续工作；
 * - 新 Host/bridge 可依赖 lifecycle。
 *
 * 诚实性约束：capabilities() 必须如实反映 provider 能力；未支持的操作（如 supportsResume=false
 * 时的 resumeSession）必须 fail-closed（抛错），禁止假装成功。
 *
 * inflight turn 取消：{@link bindTurnAbort} 把调用方 signal 与该 session 的 interrupt
 * controller 组合成一个 AbortSignal，供 runTurn 透传；{@link interruptSession} abort 该
 * controller 即取消进行中的 turn。**不杀真实子进程**——仅协作 AbortSignal；进程级 kill 由
 * runner 自身在收到 abort 时处理（如 kscc seat runner 的 proc.kill）。
 *
 * 实现见 apps/electron/src/main/lib/collaboration/（Channel / Fake）。
 */
export interface MemberSessionLifecycleAdapter {
  capabilities(): CollaborationMemberCapabilities;
  createSession(input: MemberSessionCreateInput): Promise<MemberSessionHandle>;
  resumeSession(input: MemberSessionResumeInput): Promise<MemberSessionHandle>;
  compactSession(
    input: MemberSessionCompactInput,
  ): Promise<{ ok: boolean; summary?: string }>;
  interruptSession(input: MemberSessionInterruptInput): Promise<void>;
  heartbeat(handle: MemberSessionHandle): Promise<MemberSessionHeartbeatResult>;
  /**
   * 把调用方 signal 与该 session 的 interrupt controller 组合成一个 AbortSignal，
   * 供 {@link MemberBackendAdapter.runTurn} 透传给底层 runner。
   *
   * 语义：
   * - **turn 开始**：为 sessionId 登记 AbortController（复用若已存在——同 session 并发
   *   turn 共享一个 interrupt 控制点；否则新建），返回 callerSignal 与该 controller 的
   *   组合 signal（任一 abort 即 abort）。
   * - **interruptSession**：abort 该 session 的 controller → 组合 signal 随之 abort →
   *   取消进行中的 turn；abort 后从登记表移除，使下一次 bindTurnAbort 拿到全新 controller
   *   （避免被中断过的 session 新 turn 一启动即已 abort）。
   * - **结束清理**：callerSignal abort 时（bridge dispose / 调用方取消）自动移除登记项；
   *   正常完成时 controller 留待下一次 bindTurnAbort 覆盖或 interruptSession abort。
   *
   * 不杀真实子进程；仅协作 AbortSignal。callerSignal 可缺（仅靠 interrupt 取消）。
   * sessionId 一般取 {@link MemberSessionHandle.sessionId}（Channel 实现中与 logicalSessionId 同值）。
   */
  bindTurnAbort(sessionId: string, callerSignal?: AbortSignal): AbortSignal;
}

/**
 * 组合类型别名：同时具备单 turn 执行与生命周期管理的适配器。
 *
 * capabilities() 在两个接口中签名一致，交集合法。runTurn 来自 MemberBackendAdapter；
 * create/resume/compact/interrupt/heartbeat 来自 MemberSessionLifecycleAdapter。
 */
export type MemberBackendWithLifecycleAdapter = MemberBackendAdapter &
  MemberSessionLifecycleAdapter;
