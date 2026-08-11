/**
 * Agent 圆桌 / 班组 设置偏好公共类型契约
 *
 * 落盘：
 * - 圆桌 → ~/.tagent[-dev]/agent-discuss-prefs.json
 * - 班组 → ~/.tagent[-dev]/agent-crew-prefs.json
 *
 * 本期范围：仅落盘 + UI + 校验；部分字段运行时闸尚未接（见各字段注释 +
 * docs/dev/moa-roundtable/IMPLEMENT-AGENT-DISCUSS-CREW-SETTINGS-FINDINGS.md）。
 * 规格：docs/dev/moa-roundtable/IMPLEMENT-AGENT-DISCUSS-CREW-SETTINGS-brief.md
 *
 * 设计原则（对齐 no-progress / cli-workers 契约）：
 * - 本文件只放与 UI 无关的公共契约（类型 + 默认 + 纯校验/归一函数）；
 * - 落盘读写在 apps/electron/src/main/lib/agent/agent-discuss-prefs.ts / agent-crew-prefs.ts；
 * - renderer 只读写整份 prefs，不二次计算合法性（写由主进程校验拒绝）。
 */

// ===== 圆桌（agent-discuss）=====

/**
 * 圆桌讨论默认偏好（全局；会话/班底可覆盖部分项）。
 *
 * 与「会诊」班底的关系：会诊班底的 `roundLimit` 仍可在班底里单独覆盖；
 * 此处 `defaultRoundLimit` 仅作为「未显式指定轮数时」的研讨默认。
 */
export interface AgentDiscussPrefs {
  /**
   * 研讨默认轮数（1–6 整数）。
   * 会诊班底 `roundLimit` 仍可覆盖此值。
   */
  defaultRoundLimit: number
  /**
   * @ 链式深度上限（1–10 整数）。
   * **本期只落盘 + UI**；运行时闸暂为 stub/TODO（见 FINDINGS）。
   */
  maxAgentMentionDepth: number
  /**
   * 讨论进行中主会话输入是否路由到圆桌。
   * 默认 false：讨论进行中主会话输入仍进讨论室（插话），不抢路由到圆桌编排。
   */
  routeComposerWhileDiscussing: boolean
}

/** 圆桌偏好默认值（文件不存在 / 损坏 / 结构非法时的兜底） */
export const AGENT_DISCUSS_PREFS_DEFAULT: AgentDiscussPrefs = {
  defaultRoundLimit: 3,
  maxAgentMentionDepth: 4,
  routeComposerWhileDiscussing: false,
}

export const AGENT_DISCUSS_ROUND_LIMIT_MIN = 1
export const AGENT_DISCUSS_ROUND_LIMIT_MAX = 6
export const AGENT_DISCUSS_MENTION_DEPTH_MIN = 1
export const AGENT_DISCUSS_MENTION_DEPTH_MAX = 10

/**
 * 整单校验圆桌偏好：返回首个错误文案或 null。
 * 纯函数；主进程写盘前调用，非法即拒写（与 cli-workers 同口径）。
 */
export function validateAgentDiscussPrefs(v: unknown): string | null {
  if (!v || typeof v !== 'object') return '圆桌偏好结构不合法：期望对象'
  const p = v as Record<string, unknown>
  const r = p.defaultRoundLimit
  if (
    typeof r !== 'number' ||
    !Number.isInteger(r) ||
    r < AGENT_DISCUSS_ROUND_LIMIT_MIN ||
    r > AGENT_DISCUSS_ROUND_LIMIT_MAX
  ) {
    return `研讨默认轮数须为 ${AGENT_DISCUSS_ROUND_LIMIT_MIN}–${AGENT_DISCUSS_ROUND_LIMIT_MAX} 的整数`
  }
  const d = p.maxAgentMentionDepth
  if (
    typeof d !== 'number' ||
    !Number.isInteger(d) ||
    d < AGENT_DISCUSS_MENTION_DEPTH_MIN ||
    d > AGENT_DISCUSS_MENTION_DEPTH_MAX
  ) {
    return `@ 链式深度上限须为 ${AGENT_DISCUSS_MENTION_DEPTH_MIN}–${AGENT_DISCUSS_MENTION_DEPTH_MAX} 的整数`
  }
  if (typeof p.routeComposerWhileDiscussing !== 'boolean') {
    return '讨论中路由开关须为布尔值'
  }
  return null
}

/** 圆桌偏好合法性断言（read 兜底用） */
export function isValidAgentDiscussPrefs(v: unknown): v is AgentDiscussPrefs {
  return validateAgentDiscussPrefs(v) === null
}

/**
 * 把合法圆桌偏好剥离为已知字段（read 用；丢弃未知字段）。
 * 入参须先经 {@link isValidAgentDiscussPrefs}，否则行为未定义。
 */
export function sanitizeAgentDiscussPrefs(v: AgentDiscussPrefs): AgentDiscussPrefs {
  return {
    defaultRoundLimit: v.defaultRoundLimit,
    maxAgentMentionDepth: v.maxAgentMentionDepth,
    routeComposerWhileDiscussing: v.routeComposerWhileDiscussing,
  }
}

// ===== 班组（agent-crew）=====

/**
 * 班组（长任务派工）偏好。
 * 本期：落盘 + UI；`maxParallelWorkers` 调度未接、`showFlowAsGraph` 为阶段3预留。
 */
export interface AgentCrewPrefs {
  /** Work 派工后自动打开班组面板 */
  autoOpenPanelOnDispatch: boolean
  /**
   * 并行 worker 上限（1–8 整数）。
   * **本期落盘 + UI**；调度器尚未接此上限（见 FINDINGS）。
   */
  maxParallelWorkers: number
  /**
   * 偏好：依赖用图（阶段3）。
   * 本期开关预留，无图时仅文案提示。
   */
  showFlowAsGraph: boolean
}

/** 班组偏好默认值（文件不存在 / 损坏 / 结构非法时的兜底） */
export const AGENT_CREW_PREFS_DEFAULT: AgentCrewPrefs = {
  autoOpenPanelOnDispatch: true,
  maxParallelWorkers: 3,
  showFlowAsGraph: false,
}

export const AGENT_CREW_PARALLEL_MIN = 1
export const AGENT_CREW_PARALLEL_MAX = 8

/** 整单校验班组偏好：返回首个错误文案或 null（与圆桌同口径） */
export function validateAgentCrewPrefs(v: unknown): string | null {
  if (!v || typeof v !== 'object') return '班组偏好结构不合法：期望对象'
  const p = v as Record<string, unknown>
  if (typeof p.autoOpenPanelOnDispatch !== 'boolean') {
    return '派工后自动开面板开关须为布尔值'
  }
  const m = p.maxParallelWorkers
  if (
    typeof m !== 'number' ||
    !Number.isInteger(m) ||
    m < AGENT_CREW_PARALLEL_MIN ||
    m > AGENT_CREW_PARALLEL_MAX
  ) {
    return `并行 worker 上限须为 ${AGENT_CREW_PARALLEL_MIN}–${AGENT_CREW_PARALLEL_MAX} 的整数`
  }
  if (typeof p.showFlowAsGraph !== 'boolean') {
    return '依赖用图开关须为布尔值'
  }
  return null
}

/** 班组偏好合法性断言（read 兜底用） */
export function isValidAgentCrewPrefs(v: unknown): v is AgentCrewPrefs {
  return validateAgentCrewPrefs(v) === null
}

/** 把合法班组偏好剥离为已知字段（read 用；丢弃未知字段） */
export function sanitizeAgentCrewPrefs(v: AgentCrewPrefs): AgentCrewPrefs {
  return {
    autoOpenPanelOnDispatch: v.autoOpenPanelOnDispatch,
    maxParallelWorkers: v.maxParallelWorkers,
    showFlowAsGraph: v.showFlowAsGraph,
  }
}
