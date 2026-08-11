/**
 * 主会话无进展防循环（No-Progress Guard）公共类型契约
 *
 * 规格真源：docs/dev/core-loop/NO-PROGRESS-GUARD-SPEC.md §20。
 *
 * 设计原则（§19.2 纯判定、薄适配）：
 * - 本文件只放与内核无关的公共契约（mode / reason code / 观察输入 / 判定输出 / IPC 事件）；
 * - 守卫纯逻辑（签名归一化、状态机、阈值）在 apps/electron/src/main/lib/agent/no-progress-guard.ts，
 *   KSCC / Pi 适配层只负责把各自 SDK 事件翻译成 {@link ToolBatchObservation} 再喂守卫。
 * - renderer 只展示，不二次计算是否无进展（§20.4）。
 */

/**
 * 运行模式（§20.1）。
 *
 * - `off`：完全不计算，紧急回滚使用；
 * - `shadow`：计算、记录、发送诊断事件，但不改变模型行为；
 * - `enforce`：启用提醒、强制复盘和安全暂停（产品默认，避免空转撞 maxTurns）。
 * 可用 `TAGENT_NO_PROGRESS_GUARD_MODE=shadow|off` 临时回退。
 */
export type NoProgressGuardMode = 'off' | 'shadow' | 'enforce'

/**
 * 默认运行模式：`enforce`（产品要真正防死循环）。
 * 紧急回退：环境变量 `TAGENT_NO_PROGRESS_GUARD_MODE=shadow|off`。
 */
export const NO_PROGRESS_GUARD_DEFAULT_MODE: NoProgressGuardMode = 'enforce'

/** 守卫运行模式的合法白名单（非法环境变量值回落默认值，§23.1） */
export const NO_PROGRESS_GUARD_MODES: readonly NoProgressGuardMode[] = ['off', 'shadow', 'enforce']

/** 覆盖守卫模式的环境变量名（§23.1；不得写入会话 meta） */
export const TAGENT_NO_PROGRESS_GUARD_MODE_ENV = 'TAGENT_NO_PROGRESS_GUARD_MODE'

/**
 * 规范化运行模式。
 *
 * 优先级：`env` 显式值 > 落盘偏好（stored）> {@link NO_PROGRESS_GUARD_DEFAULT_MODE}。
 * 纯函数、不依赖 Node 全局：主进程传入 `process.env`，单测传 plain Record。
 */
export function resolveNoProgressGuardMode(
  env?: Record<string, string | undefined> | null,
  stored?: NoProgressGuardMode | null,
): NoProgressGuardMode {
  const raw = env?.[TAGENT_NO_PROGRESS_GUARD_MODE_ENV]
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw
  if (stored === 'off' || stored === 'shadow' || stored === 'enforce') return stored
  return NO_PROGRESS_GUARD_DEFAULT_MODE
}

/**
 * 稳定的触发原因枚举（§20.3）。新增条目只能追加，不得改语义。
 */
export type NoProgressReasonCode =
  /** 同一动作签名得到相同失败结果签名（§7.1.1） */
  | 'same_failure_repeated'
  /** 同一文件累计编辑而验证结果未变（§7.1.2） */
  | 'same_target_edited_without_verification_change'
  /** 连续工具批次无有效进展（§7.1.3 / §7.3.2） */
  | 'no_new_evidence'
  /** 同一命令重复空输出超时（§7.1.4 / §7.3.3） */
  | 'empty_timeout_repeated'
  /** 工具持续成功但任务级验证连续失败（§7.1.5） */
  | 'action_success_goal_unchanged'
  /** 强制复盘后仍尝试重复工具调用（§7.3.1） */
  | 'reflection_ignored'
  /** 无进展状态持续超时（§7.3.4） */
  | 'time_without_progress'

/**
 * 守卫阶段（§8 状态机）。
 *
 * - `observing`：正常观察；
 * - `reflection_required`：一级软提醒（§7.1）；
 * - `final_response_only`：二级强制复盘（§7.2）；
 * - `paused`：三级安全暂停（§7.3）。
 */
export type NoProgressPhase = 'observing' | 'reflection_required' | 'final_response_only' | 'paused'

/** 判定类型（§20.3） */
export type NoProgressDecisionKind = 'continue' | 'warn' | 'require_reflection' | 'pause'

/** IPC 事件阶段（§20.4） */
export type NoProgressEventPhase = 'warning' | 'reflection' | 'paused' | 'cleared'

/**
 * 统一观察输入（§20.2）。
 *
 * 守卫不直接接收 SDK 或 Pi 私有事件，防止核心逻辑与某个内核绑定。
 * 适配层把一批工具调用结果翻译成此结构再喂守卫。
 */
export interface ToolBatchObservation {
  sessionId: string
  turnId: string
  provider: 'kscc' | 'pi'
  /** 本批次观测时间（epoch ms）；守卫的时间判定（§7.3.4）以此为准，便于回放测试注入 */
  observedAt: number
  calls: Array<{
    toolUseId: string
    toolName: string
    input: unknown
    /** 工具结果（成功 / 结构化输出）；失败时可能为 undefined */
    output?: unknown
    /** 失败文案（Bash 退出码 / 工具抛错） */
    error?: string
    /** 工具执行耗时（ms），仅诊断用，不参与签名 */
    durationMs?: number
  }>
}

/**
 * 判定输出（§20.3）。
 *
 * `kind` 是本批次的状态机推进结果；`emitPhase` 是建议下发的 IPC 事件阶段（可为 null）。
 */
export interface NoProgressDecision {
  kind: NoProgressDecisionKind
  reasonCodes: NoProgressReasonCode[]
  phase: NoProgressPhase
  batchCount: number
  noProgressBatchCount: number
  repeatedFailureCount: number
  emptyTimeoutCount: number
  /** 适配层用于注入模型的复盘 / 收束上下文（enforce 下 warn / require_reflection 才用） */
  modelContext?: string
  /** UI 可见的简短摘要（enforce 下 paused 才用；不传完整命令 / 文件正文 / 工具输出） */
  userMessage?: string
  /** 建议下发的 IPC 事件阶段；null 表示本批次无需下发事件 */
  emitPhase?: NoProgressEventPhase | null
}

/**
 * PreToolUse / beforeToolCall 的拦截建议（适配层在 final_response_only 阶段调用守卫得到）。
 */
export interface ToolAttemptAdvice {
  /** 是否允许该工具调用 */
  allow: boolean
  /** 拒绝时回灌给模型的原因（即复盘 / 收束要求） */
  blockReason?: string
  /** 命中三级暂停：适配层应停止当前 turn 并归一化为 paused_no_progress 终态 */
  pause?: boolean
  /** 对应的判定（用于结构化日志 / IPC 事件） */
  decision?: NoProgressDecision
}

/**
 * IPC 事件（§20.4）：在 {@link TAgentEvent} 中新增统一事件，而非三个独立临时事件。
 *
 * 约束：
 * - 不传完整命令、文件正文或工具输出；
 * - renderer 只展示，不再次计算；
 * - `paused` 与终态 result 配对，但不得额外产生 `session_error`；
 * - `cleared` 用于收到有效进展或新用户回合后清除过程提示；
 * - `shadow=true` 表示仅诊断、未改变模型行为，UI 应忽略（不展示、不清 running）。
 */
export interface NoProgressEvent {
  type: 'no_progress'
  phase: NoProgressEventPhase
  reasonCodes: NoProgressReasonCode[]
  batchCount: number
  noProgressBatchCount: number
  /** 一句阶段摘要（§11.1 / §11.2），不含敏感细节 */
  summary?: string
  /** shadow 模式诊断事件：UI 应忽略 */
  shadow?: boolean
}
