/**
 * 模型上下文窗口解析（Phase 1.1）
 *
 * 统一从 ChannelModel 解析 contextWindow / safeContextLimit，
 * 供 pi-agent-adapter / session-service / 软重置 / 渲染层 fallback 共用，
 * 避免 4 处各自硬编码（现状 buildPlaceholderModel 写死 128k，渲染层又写死 128k）。
 *
 * 优先级（safeContextLimit，软重置/压缩触发用）：
 *   ChannelModel.safeContextLimit > learnedSafeContextLimit(Phase5) > ChannelModel.contextWindow × 0.7 > fallback
 *
 * contextWindow（8k 四层预算比例用）直接取 ChannelModel.contextWindow，缺失走 fallback。
 *
 * 见 docs（.context/memory-phase1-data-foundation.md §1.1）。
 */
import type { Channel, ChannelModel } from '@tagent/shared'

/** 窗口兜底（与 pi-context-settings TAGENT_PI_COMPACTION_FALLBACK_CONTEXT_WINDOW 对齐） */
export const FALLBACK_CONTEXT_WINDOW = 200_000

/** safeContextLimit 缺省折扣：标称窗口 × 0.7 */
const SAFE_LIMIT_DEFAULT_RATIO = 0.7

/**
 * 取渠道下某 modelId 的 ChannelModel 配置。
 * 找不到返回 undefined。
 */
export function findChannelModel(channel: Channel, modelId: string): ChannelModel | undefined {
  return channel.models.find((m) => m.id === modelId)
}

/**
 * 解析模型标称上下文窗口（token）。用于 8k 四层预算比例、compaction 阈值分母。
 * 缺失走 FALLBACK_CONTEXT_WINDOW（200k）。
 */
export function resolveModelContextWindow(channel: Channel | undefined, modelId: string | undefined): number {
  if (channel && modelId) {
    const m = findChannelModel(channel, modelId)
    if (m?.contextWindow && m.contextWindow > 0) return m.contextWindow
  }
  return FALLBACK_CONTEXT_WINDOW
}

/**
 * 解析模型实测安全上限（token）。用于软重置/压缩提前触发，避免撞真实爆点。
 *
 * 优先级：ChannelModel.safeContextLimit > learnedSafeContextLimit > contextWindow × 0.7 > fallback × 0.7
 *
 * @param learnedSafeContextLimit Phase 5 自学习回写值（爆点 × 0.9 中位数），无则传 undefined
 */
export function resolveModelSafeContextLimit(
  channel: Channel | undefined,
  modelId: string | undefined,
  learnedSafeContextLimit?: number,
): number {
  // 1. 手动标的实测安全线（最高优先级，如 GLM-5.2 标 180k）
  if (channel && modelId) {
    const m = findChannelModel(channel, modelId)
    if (m?.safeContextLimit && m.safeContextLimit > 0) return m.safeContextLimit
  }
  // 2. 自学习回写值（Phase 5）
  if (learnedSafeContextLimit && learnedSafeContextLimit > 0) return learnedSafeContextLimit
  // 3. 标称窗口 × 0.7
  const window = resolveModelContextWindow(channel, modelId)
  return Math.ceil(window * SAFE_LIMIT_DEFAULT_RATIO)
}
