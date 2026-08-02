/**
 * 会话协作/执行形态（executionMode）
 *
 * 与 permissionMode（Plan/自动/完全自动）分层：
 * - chat：只读讨论，禁止改本地与看板派工
 * - work：真干活，写操作受 permissionMode 约束
 *
 * @see docs/plans/multi-runtime/02-chat-work-and-permissions.md
 * @see docs/decisions/ADR-0003-execution-mode-chat-work.md
 * @see docs/decisions/ADR-0005-user-owned-mode-switch.md
 */

/** 协作大模式 */
export type ExecutionMode = 'chat' | 'work'

export const EXECUTION_MODES = ['chat', 'work'] as const

/** 新建会话默认：Chat（安全优先） */
export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'chat'

/**
 * 旧会话 meta 无字段时的回退：work
 * 避免 2.0 升级后既有会话突然变只读。
 */
export const LEGACY_EXECUTION_MODE: ExecutionMode = 'work'

export function isExecutionMode(value: string | undefined | null): value is ExecutionMode {
  return value === 'chat' || value === 'work'
}

/**
 * 规范化 executionMode。
 * - 合法 chat/work → 原值
 * - 缺失/非法 → legacyDefault（读旧会话用 LEGACY；显式新建用 DEFAULT）
 */
export function migrateExecutionMode(
  value: string | undefined | null,
  legacyDefault: ExecutionMode = LEGACY_EXECUTION_MODE,
): ExecutionMode {
  if (isExecutionMode(value)) return value
  return legacyDefault
}

export interface ExecutionModeConfig {
  label: string
  description: string
}

export const EXECUTION_MODE_CONFIG = {
  chat: {
    label: 'Chat',
    description: '只读讨论：可读/可搜/可对齐需求，不能改本地文件或派看板工人',
  },
  work: {
    label: 'Work',
    description: '真干活：写文件、命令、SubAgent/会诊/看板受权限档约束',
  },
} as const satisfies Record<ExecutionMode, ExecutionModeConfig>

/** 切换来源（仅用户侧合法；Agent 工具不得改模式） */
export type ExecutionModeChangeSource = 'user' | 'user-confirm-suggestion'

export function isExecutionModeChangeSource(
  value: string | undefined | null,
): value is ExecutionModeChangeSource {
  return value === 'user' || value === 'user-confirm-suggestion'
}

/** 审计条目（可选写入 meta） */
export interface ExecutionModeHistoryEntry {
  at: number
  from: ExecutionMode
  to: ExecutionMode
  source: ExecutionModeChangeSource
}

/** 建议条触发来源（不改变 mode，仅 UI） */
export type ExecutionModeSuggestionTrigger = 'chat-block' | 'agent-request' | 'manual'

/**
 * Agent / 系统建议切换形态（须用户确认才生效）
 * @see docs/plans/multi-runtime/02-chat-work-and-permissions.md §3.4
 */
export interface ExecutionModeSuggestion {
  sessionId: string
  /** 建议切到的目标 */
  targetMode: ExecutionMode
  /** 当前形态（建议发出时） */
  fromMode: ExecutionMode
  reason: string
  trigger: ExecutionModeSuggestionTrigger
  at: number
  /** chat-block 时被拦截的工具名 */
  toolName?: string
}

export function buildWorkSwitchSuggestion(args: {
  sessionId: string
  fromMode?: ExecutionMode
  trigger?: ExecutionModeSuggestionTrigger
  toolName?: string
  reason?: string
}): ExecutionModeSuggestion {
  const toolHint = args.toolName ? `（工具 \`${args.toolName}\` 在 Chat 下被拦截）` : ''
  return {
    sessionId: args.sessionId,
    targetMode: 'work',
    fromMode: args.fromMode ?? 'chat',
    trigger: args.trigger ?? 'chat-block',
    toolName: args.toolName,
    at: Date.now(),
    reason:
      args.reason?.trim() ||
      `当前需要修改代码或执行有副作用的操作。Chat 下不能改本地文件。${toolHint}`.trim(),
  }
}

export function buildChatSwitchSuggestion(args: {
  sessionId: string
  fromMode?: ExecutionMode
  trigger?: ExecutionModeSuggestionTrigger
  reason?: string
}): ExecutionModeSuggestion {
  return {
    sessionId: args.sessionId,
    targetMode: 'chat',
    fromMode: args.fromMode ?? 'work',
    trigger: args.trigger ?? 'agent-request',
    at: Date.now(),
    reason:
      args.reason?.trim() ||
      '需要和你对齐需求，避免在执行中途改方向时误写文件。',
  }
}
