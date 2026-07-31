/**
 * Agent context 管理工具函数（P0-1 / P1-1 / P0-2）
 *
 * Phase 2.1 从 TAgent_General 移植。
 *
 * 抽离到独立文件以便单测:
 * - computeMaxContextMessages: 动态算能取多少条历史
 * - summarizeToolResult: 工具结果按 token 截断 (头尾保留)
 * - sessionContextWindowCache: 每个 session 的 context window 缓存
 */

/** 单条工具摘要默认字符预算 (P1-1 改成按 token 算, 这里保留作为默认 fallback) */
export const MAX_TOOL_SUMMARY_LENGTH = 200

/** 1 token ≈ 4 chars (粗估, 与 §8.4 P1-1 算法一致) */
export const CHARS_PER_TOKEN = 4

/** 单消息平均 token 估算 (含图片: 1500-5000, 纯文本: ~500) */
export const AVG_TOKENS_PER_MESSAGE = 500

/**
 * P0-1: 缓存每个 session 已知的 context window
 *
 * 来源: Claude Agent SDK 的 `result.modelUsage[...].contextWindow`
 * 拿到后, buildContextPrompt 用它动态算能取多少条历史, 而非硬编码 20 条
 */
const sessionContextWindowCache = new Map<string, number>()

/** 设置 session 的 context window 缓存 */
export function setSessionContextWindow(sessionId: string, contextWindow: number): void {
  if (contextWindow > 0) {
    sessionContextWindowCache.set(sessionId, contextWindow)
  }
}

/** 读 session 的 context window 缓存, 没记录时返回 undefined */
export function getSessionContextWindow(sessionId: string): number | undefined {
  return sessionContextWindowCache.get(sessionId)
}

/** 清除 session 的缓存 (用于测试或 reset) */
export function clearSessionContextWindow(sessionId: string): void {
  sessionContextWindowCache.delete(sessionId)
}

/** 清除所有 session 的缓存 (用于测试) */
export function clearAllSessionContextWindows(): void {
  sessionContextWindowCache.clear()
}

/**
 * P0-1: 根据 context window 动态算能取多少条历史消息
 *
 * 预算 = contextWindow - system(prompt) - tools - reserved(给模型输出的 max_tokens)
 * @returns 至少 5 条, 最多按预算切
 */
export function computeMaxContextMessages(
  contextWindow: number,
  systemReservedTokens: number = 4000,
  outputReservedTokens: number = 8000
): number {
  const budget = contextWindow - systemReservedTokens - outputReservedTokens
  if (budget <= 0) return 5 // 预算不够, 至少 5 条保命
  return Math.max(5, Math.floor(budget / AVG_TOKENS_PER_MESSAGE))
}

/**
 * P1-1: 按 token 估算截断, 保留头尾 (tail 通常含关键结果)
 *
 * @param content 原始工具摘要
 * @param budgetTokens token 预算 (默认 500)
 * @returns 截断后字符串
 */
export function summarizeToolResult(content: string, budgetTokens: number = 500): string {
  const tokens = Math.ceil(content.length / CHARS_PER_TOKEN)
  if (tokens <= budgetTokens) return content

  const headRatio = 0.4
  const headChars = Math.floor(budgetTokens * headRatio * CHARS_PER_TOKEN)
  const tailChars = Math.floor(budgetTokens * (1 - headRatio) * CHARS_PER_TOKEN)
  return content.slice(0, headChars) + '\n... [truncated] ...\n' + content.slice(-tailChars)
}

/**
 * P1-2: 图片占位符文本
 *
 * 用于 buildContextPrompt: 统计消息内 image block 数量, 注入中文提示,
 * 避免历史消息中的图片被整块丢弃后 Agent "失忆"。
 *
 * @param imageCount 图片块数量 (≥ 0)
 * @returns placeholder 字符串 (imageCount=0 时返回 '')
 */
export function formatImagePlaceholder(imageCount: number): string {
  if (imageCount <= 0) return ''
  return imageCount === 1 ? ' [本消息含 1 张图片]' : ` [本消息含 ${imageCount} 张图片]`
}
