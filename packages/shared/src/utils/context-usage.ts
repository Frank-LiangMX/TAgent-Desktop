/**
 * Context 占用率计算 — 主进程与渲染进程共用。
 *
 * usedTokens 口径与 Claude Code / Proma 一致：
 * input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 */

export interface UsageTokensLike {
  input_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** 与 Claude Code statusline 一致的「当前 context 已用 token」口径 */
export function sumContextUsedTokens(usage: UsageTokensLike): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

/** 计算 context 占用率（0–1）；无效输入返回 undefined */
export function calculateContextUsageRatio(
  usedTokens: number | undefined,
  contextWindow: number | undefined
): number | undefined {
  if (
    usedTokens === undefined ||
    contextWindow === undefined ||
    !Number.isFinite(usedTokens) ||
    !Number.isFinite(contextWindow) ||
    usedTokens < 0 ||
    contextWindow <= 0
  ) {
    return undefined
  }
  return usedTokens / contextWindow
}
