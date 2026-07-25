import type { ContextUsageSnapshot } from '../types/context-usage'

import { resolveDisplayContextWindow } from './context-window'

/** 按当前模型规则重新计算展示用 maxTokens / percentage（兼容旧磁盘缓存） */
export function normalizeContextUsageSnapshot(
  snapshot: ContextUsageSnapshot
): ContextUsageSnapshot {
  const rawMaxTokens = snapshot.rawMaxTokens ?? snapshot.maxTokens
  const maxTokens = resolveDisplayContextWindow(snapshot.model, rawMaxTokens)
  const percentage = maxTokens > 0 ? (snapshot.totalTokens / maxTokens) * 100 : snapshot.percentage

  if (
    maxTokens === snapshot.maxTokens &&
    percentage === snapshot.percentage &&
    snapshot.rawMaxTokens === rawMaxTokens
  ) {
    return snapshot
  }

  return {
    ...snapshot,
    rawMaxTokens,
    maxTokens,
    percentage,
  }
}
