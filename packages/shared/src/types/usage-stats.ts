/**
 * Usage Stats Types - 使用统计类型定义
 */

/** 时间范围 */
export type TimeRange = 'today' | 'week' | 'month' | 'all'

/** 单次调用记录 */
export interface UsageCallRecord {
  sessionId: string
  sessionTitle: string
  modelId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

/** 会话 Token 统计 */
export interface SessionTokenStats {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  totalCostUsd: number
  turnCount: number
}

/** 会话当前 Context 窗口占用（来自 JSONL 最后一条带 usage 的消息） */
export interface SessionContextStatus {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  contextWindow?: number
}

/** 模型使用统计 */
export interface ModelUsageStats {
  modelId: string
  sessions: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  totalCostUsd: number
  avgInputPerSession: number
  avgOutputPerSession: number
}

/** 时间范围统计 */
export interface TimeRangeStats {
  period: 'today' | 'week' | 'month' | 'all'
  sessions: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  byModel: ModelUsageStats[]
}

/** 使用统计总览 */
export interface UsageStatsOverview {
  totalSessions: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  totalCostUsd: number
  byModel: ModelUsageStats[]
  byTimeRange: {
    today: TimeRangeStats
    week: TimeRangeStats
    month: TimeRangeStats
    all: TimeRangeStats
  }
  /** 最近调用记录（按时间倒序） */
  recentCalls: UsageCallRecord[]
}

/** 使用统计 IPC 通道常量 */
export const USAGE_STATS_IPC_CHANNELS = {
  /** 获取使用统计总览 */
  GET_OVERVIEW: 'usage-stats:get-overview',
  /** 获取单个会话的 Token 统计 */
  GET_SESSION_TOKEN_STATS: 'usage-stats:get-session-token-stats',
  /** 获取单个会话当前 Context 占用（最后一轮，非累计） */
  GET_SESSION_CONTEXT_STATUS: 'usage-stats:get-session-context-status',
} as const

/** 存储类别 */
export interface StorageCategory {
  key: string
  label: string
  bytes: number
  orphanBytes: number
  hasOrphans: boolean
}

/** 存储统计 */
export interface StorageStats {
  totalBytes: number
  categories: StorageCategory[]
}

/** 清理结果 */
export interface CleanupResult {
  freedBytes: number
  deletedCount: number
  errors?: string[]
}
