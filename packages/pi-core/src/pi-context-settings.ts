/**
 * Pi 上下文自动压缩 —— 自研配置（TAgent）
 *
 * 算法用 Pi，编排用 TAgent。这里只做阈值/窗口的换算与配置组装，
 * 不引用任何外部项目（无 Proma）。见 docs/plans/2026-07-29-pi-context-compaction.md §4.1。
 *
 * - 触发占比 thresholdRatio：约 80% 窗口触发
 * - reserveTokens = ceil(contextWindow * (1 - thresholdRatio))  —— 公式自研，写在 TAgent 仓库
 * - 当 contextTokens > contextWindow - reserveTokens 时视为应压缩（与 Pi shouldCompact 语义一致）
 * - keepRecentTokens 取 Pi DEFAULT_COMPACTION_SETTINGS 的合理默认，压后保留近期量
 */

import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-agent-core'
import type { CompactionSettings } from '@earendil-works/pi-agent-core'

/** 触发压缩的窗口占比（约 80% 窗口触发） */
export const TAGENT_PI_COMPACTION_THRESHOLD_RATIO = 0.8

/** 窗口推断兜底：模型未声明 contextWindow（占位为 0/undefined）时使用 */
export const TAGENT_PI_COMPACTION_FALLBACK_CONTEXT_WINDOW = 200_000

/**
 * 由窗口与触发占比换算 reserveTokens：
 *   reserveTokens = ceil(contextWindow * (1 - thresholdRatio))
 * 与 Pi shouldCompact 的 `contextTokens > contextWindow - reserveTokens` 语义对齐。
 */
export function calculateReserveTokens(
  contextWindow: number,
  thresholdRatio: number = TAGENT_PI_COMPACTION_THRESHOLD_RATIO,
): number {
  return Math.ceil(contextWindow * (1 - thresholdRatio))
}

/**
 * 推断上下文窗口：优先用模型声明值，缺失/非法则兜底。
 * Pi 裸 Agent 用的是占位 Model（contextWindow 可能是硬编码占位），仍以传入值为准。
 */
export function resolveContextWindow(contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0) return TAGENT_PI_COMPACTION_FALLBACK_CONTEXT_WINDOW
  return contextWindow
}

/** TAgent 自研压缩配置（含窗口推断结果，便于日志/UI 展示） */
export interface TagentCompactionSettings {
  /** 是否自动压缩 */
  enabled: boolean
  /** 触发占比（约 80%） */
  thresholdRatio: number
  /** 推断后的上下文窗口（分母） */
  contextWindow: number
  /** 保留给摘要提示与输出的 token 数（= 窗口 × (1 - 占比)） */
  reserveTokens: number
  /** 压后保留的近期 token 量 */
  keepRecentTokens: number
}

/**
 * 组装 TAgent 压缩配置：
 * - enabled 默认 true
 * - reserveTokens 由窗口 × (1 - thresholdRatio) 自研换算
 * - keepRecentTokens 默认取 Pi DEFAULT_COMPACTION_SETTINGS.keepRecentTokens
 */
export function buildTagentCompactionSettings(
  contextWindow: number,
  options?: { enabled?: boolean; thresholdRatio?: number; keepRecentTokens?: number },
): TagentCompactionSettings {
  const enabled = options?.enabled ?? true
  const thresholdRatio = options?.thresholdRatio ?? TAGENT_PI_COMPACTION_THRESHOLD_RATIO
  const window = resolveContextWindow(contextWindow)
  const reserveTokens = calculateReserveTokens(window, thresholdRatio)
  const keepRecentTokens = options?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens
  return { enabled, thresholdRatio, contextWindow: window, reserveTokens, keepRecentTokens }
}

/** 将 TAgent 配置转为 Pi CompactionSettings（喂给 Pi shouldCompact / compact） */
export function toPiCompactionSettings(settings: TagentCompactionSettings): CompactionSettings {
  return {
    enabled: settings.enabled,
    reserveTokens: settings.reserveTokens,
    keepRecentTokens: settings.keepRecentTokens,
  }
}
