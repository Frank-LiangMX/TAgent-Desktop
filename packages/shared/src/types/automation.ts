/**
 * Automation（定时任务）相关类型定义
 *
 * 用户用自然语言描述一个任务，调度器按设定间隔在后台自动新建子会话执行。
 * 每次执行都新建独立子会话（不污染来源会话，规避 orchestrator 同会话并发守卫）。
 */

// ===== 调度类型 =====

/** 调度模式 */
export type AutomationScheduleType = 'interval' | 'daily' | 'weekly' | 'monthly' | 'once'

/** 调度配置 */
export type ScheduleConfig =
  | { type: 'interval'; intervalMinutes: number }
  | { type: 'daily'; timeOfDay: string } // HH:MM
  | { type: 'weekly'; dayOfWeek: number; timeOfDay: string } // 0=Sun, 6=Sat
  | { type: 'monthly'; dayOfMonth: number; timeOfDay: string } // 1-31
  | { type: 'once'; scheduledAt: string } // ISO 8601

// ===== 会话策略 =====

/**
 * 定时任务的会话模式
 * - daily：同一自然日内的触发写入同一个子会话，跨日时自动新建（默认，兼顾上下文连续性与成本控制）
 * - reuse：始终复用同一个子会话（保留长期上下文，会话越长 token 成本越高，由用户自行承担）
 */
export type AutomationSessionMode = 'daily' | 'reuse'

/** 定时任务默认会话模式 */
export const AUTOMATION_DEFAULT_SESSION_MODE: AutomationSessionMode = 'daily'

// ===== 权限模式 =====

/**
 * 定时任务的权限模式（无人值守运行场景）
 * - auto：自动审批，SDK 内置审批器判断，危险操作可能挂起等待（不推荐用于无人值守）
 * - bypassPermissions：完全自动，所有工具调用自动允许
 */
export type AutomationPermissionMode = 'auto' | 'bypassPermissions'

/** 定时任务默认权限模式 */
export const AUTOMATION_DEFAULT_PERMISSION_MODE: AutomationPermissionMode = 'bypassPermissions'

// ===== 通知 =====

/** 定时任务通知触发条件 */
export type AutomationNotificationTrigger = 'always' | 'success' | 'error'

/** 通知配置 */
export interface NotificationConfig {
  /** 系统通知 */
  system: boolean
  /** 飞书通知 */
  feishu?: { enabled: boolean; chatId?: string }
  /** 钉钉通知 */
  dingtalk?: { enabled: boolean; chatId?: string }
  /** 微信通知 */
  wechat?: { enabled: boolean; chatId?: string }
  /** WPS 通知 */
  wps?: { enabled: boolean; chatId?: string }
  /** 通知触发条件：默认 always */
  trigger?: AutomationNotificationTrigger
}

// ===== 运行历史 =====

/** 运行状态 */
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'

/** 单次自动运行的记录 */
export interface AutomationRun {
  /** 本次触发的时间戳 */
  runAt: number
  /** 本轮新建/复用的子会话 ID（可点进去查看执行详情） */
  sessionId: string
  /** 运行结果 */
  status: RunStatus
  /** 耗时（毫秒） */
  durationMs?: number
  /** 失败原因（status === 'failed' 时） */
  error?: string
  /** 跳过原因（status === 'skipped' 时，如来源会话忙） */
  skipReason?: string
}

// ===== Automation 定义 =====

/** 运行历史最大保留条数（防止 json 无限膨胀） */
export const AUTOMATION_MAX_HISTORY = 20

/** 连续失败达到此次数自动暂停任务 */
export const AUTOMATION_MAX_CONSECUTIVE_FAILURES = 5

/** daily 模式下的上下文占用率切换阈值 */
export const DAILY_CONTEXT_ROLLOVER_THRESHOLD = 0.7

/** 定时任务定义 */
export interface Automation {
  id: string
  /** 任务名（默认从来源消息生成，可编辑） */
  name: string
  /** 自然语言任务描述（每次自动重跑发送的内容） */
  prompt: string
  /** 是否启用调度 */
  enabled: boolean
  /** 调度模式 */
  scheduleType: AutomationScheduleType
  /** 运行间隔（分钟），scheduleType==='interval' 时使用 */
  intervalMinutes: number
  /** 触发时刻 "HH:MM"，scheduleType==='daily'|'weekly'|'monthly' 时使用 */
  timeOfDay?: string
  /** 星期几（0=周日 … 6=周六），scheduleType==='weekly' 时使用 */
  dayOfWeek?: number
  /** 每月几号（1-31），scheduleType==='monthly' 时使用 */
  dayOfMonth?: number
  /** 一次性任务的绝对触发时间戳，scheduleType==='once' 时使用 */
  scheduledAt?: number
  /** 最大运行次数上限：实际执行次数（成功 + 失败，不含 skipped）达到后自动停用 */
  maxRuns?: number
  /** AI 渠道 ID */
  channelId: string
  /** 模型 ID（可选，继承来源会话或渠道默认） */
  modelId?: string
  /** 工作区 ID（可选，决定子会话 cwd） */
  workspaceId?: string
  /** 会话模式：daily=同一自然日内复用子会话，跨日新建（默认）；reuse=始终复用同一个子会话 */
  sessionMode?: AutomationSessionMode
  /** 权限模式（无人值守运行时的工具审批策略，默认 bypassPermissions） */
  permissionMode?: AutomationPermissionMode
  /** 运行完成后的外部通知目标 */
  notification?: NotificationConfig
  /** 创建来源会话 ID（作为模板，运行时复用或新建子会话） */
  sourceSessionId?: string
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
  /** 下次应触发的绝对时间戳（调度核心，避免长 interval 漂移） */
  nextRunAt: number
  /** 最近一次运行创建的会话 ID（每次运行都会新建会话，此字段仅用于跳转和排查） */
  lastSessionId?: string
  /** 上次运行时间 */
  lastRunAt?: number
  /** 连续失败次数（用于退避/自动暂停） */
  consecutiveFailures?: number
  /** 已实际执行次数（成功 + 失败，不含 skipped），用于与 maxRuns 比较 */
  runCount?: number
  /** 因跑满 maxRuns 或 once 完成而自动停用的时间戳 */
  completedAt?: number
  /** 用户接管标记（true=不再注入定时任务消息，避免污染用户私人会话） */
  automationGraduated?: boolean
  /** 最近运行历史（截断保留最新 AUTOMATION_MAX_HISTORY 条） */
  runHistory: AutomationRun[]
}

// ===== 创建/更新输入 =====

/** 创建定时任务的输入 */
export interface CreateAutomationInput {
  name: string
  prompt: string
  scheduleType: AutomationScheduleType
  intervalMinutes: number
  timeOfDay?: string
  dayOfWeek?: number
  dayOfMonth?: number
  scheduledAt?: number
  maxRuns?: number
  channelId: string
  modelId?: string
  workspaceId?: string
  sessionMode?: AutomationSessionMode
  permissionMode?: AutomationPermissionMode
  notification?: NotificationConfig
  sourceSessionId?: string
  /** 创建后是否立即启用（默认 true） */
  active?: boolean
}

/** 更新定时任务的输入（部分字段） */
export interface UpdateAutomationInput {
  id: string
  name?: string
  prompt?: string
  scheduleType?: AutomationScheduleType
  intervalMinutes?: number
  timeOfDay?: string
  dayOfWeek?: number
  dayOfMonth?: number
  scheduledAt?: number
  maxRuns?: number
  channelId?: string
  modelId?: string
  workspaceId?: string
  sessionMode?: AutomationSessionMode
  permissionMode?: AutomationPermissionMode
  notification?: NotificationConfig
  enabled?: boolean
}

// ===== IPC 通道 =====

/** Automation 相关 IPC 通道常量 */
export const AUTOMATION_IPC_CHANNELS = {
  /** 获取全部定时任务 */
  LIST: 'automation:list',
  /** 创建定时任务 */
  CREATE: 'automation:create',
  /** 更新定时任务 */
  UPDATE: 'automation:update',
  /** 删除定时任务 */
  DELETE: 'automation:delete',
  /** 切换启用/暂停 */
  TOGGLE: 'automation:toggle',
  /** 立即运行一次（不影响调度计时） */
  RUN_NOW: 'automation:run-now',
  /** 任务列表变更事件（main → renderer，运行完成/状态变化时推送） */
  CHANGED: 'automation:changed',
  /** Prompt 被安全拦截事件（main → renderer，runtime 拦截时推送，前端弹 toast） */
  PROMPT_BLOCKED: 'automation:prompt-blocked',
  /** 列出所有拦截日志摘要（不含完整 prompt 文本） */
  LIST_BLOCKED_LOGS: 'automation:list-blocked-logs',
  /** 获取单条拦截日志详情（含 originalPrompt / sanitizedPrompt） */
  GET_BLOCKED_LOG_DETAIL: 'automation:get-blocked-log-detail',
  /** 删除单条拦截日志 */
  DELETE_BLOCKED_LOG: 'automation:delete-blocked-log',
  /** 清空指定 automation 的所有拦截日志 */
  CLEAR_BLOCKED_LOGS_FOR_AUTOMATION: 'automation:clear-blocked-logs-for-automation',
} as const

/** 拦截来源：create / update / runtime */
export type AutomationBlockedStage = 'create' | 'update' | 'runtime'

/** 拦截日志摘要（列表展示用，不含完整 prompt 文本） */
export interface AutomationBlockedLogSummary {
  /** 日志文件名（用于查详情 / 删除） */
  fileName: string
  /** 拦截时间戳（毫秒） */
  timestamp: number
  /** 触发拦截的 automation ID */
  automationId: string
  /** automation 名称 */
  automationName: string
  /** 拦截原因列表 */
  reasons: string[]
  /** 命中的可疑模式源字符串 */
  patterns: string[]
  /** 拦截来源 */
  stage: AutomationBlockedStage
  /** 被剥离的 invisible unicode 字符数 */
  strippedInvisibleCount: number
}

/** 拦截日志详情（含完整 prompt 文本） */
export interface AutomationBlockedLogDetail {
  /** 拦截时间戳（毫秒） */
  timestamp: number
  /** 触发拦截的 automation ID */
  automationId: string
  /** automation 名称 */
  automationName: string
  /** 拦截原因列表 */
  reasons: string[]
  /** 命中的可疑模式源字符串 */
  patterns: string[]
  /** 原始 prompt（含 invisible unicode） */
  originalPrompt: string
  /** 剥离 invisible unicode 后的 prompt */
  sanitizedPrompt: string
  /** 被剥离的 invisible unicode 字符数 */
  strippedInvisibleCount: number
  /** 拦截来源 */
  stage: AutomationBlockedStage
}

/** runtime 拦截时通过 PROMPT_BLOCKED 通道推送给前端的事件 payload */
export interface AutomationPromptBlockedEvent {
  automationId: string
  automationName: string
  patterns: string[]
  reasons: string[]
  timestamp: number
}

/** Fields added by the durable scheduler. */
export interface Automation {
  lastTriggerAt?: number
}
