/**
 * 模型 context window 推断 — Desktop 与主进程共用。
 *
 * SDK 流式过程通常不返回 contextWindow，只有 result.modelUsage 才带实测值。
 * 推断值仅作 fallback；result 提供的真实值优先。
 */

export const DEFAULT_CONTEXT_WINDOW = 200_000
export const ONE_MILLION_CONTEXT_WINDOW = 1_000_000

/**
 * 是否支持 1M context（与 Claude Code 判定对齐的子集）
 *
 * 只列确认支持 1M 的模型。
 * Claude Sonnet/Opus 4 标准 200k，1M 需申请 beta，不默认开启。
 */
export function supports1MContext(modelId: string): boolean {
  if (!modelId) return false
  const m = modelId.toLowerCase()
  if (m.includes('haiku')) return false
  if (m.includes('claude')) return false // 标准 200k，1M 需申请
  if (m.includes('mimo-v2.5') || m.includes('mimo2.5')) return true
  if (m.includes('glm-5.2') || m.includes('glm5.2')) return true
  if (m.includes('deepseek-v4') || m.includes('deepseekv4')) return true
  if (m.includes('minimax-m3') || m.includes('minimaxm3')) return true
  if (m.includes('glm-x-preview[1m]')) return true
  return false
}

/** 按模型名推断 contextWindow（token 数） */
export function inferContextWindow(model?: string): number | undefined {
  if (!model) return undefined
  const m = model.toLowerCase()

  // 10M
  if (m.includes('llama-4-scout') || m.includes('llama4-scout') || m.includes('scout'))
    return 10_000_000

  // 2M
  if (m.includes('gemini-2') && m.includes('pro')) return 2_000_000
  if (m.includes('gemini-2.0-pro') || m.includes('gemini-2.5-pro')) return 2_000_000

  // 1M（确认支持的）
  if (m.includes('gemini-2') && m.includes('flash')) return 1_000_000
  if (m.includes('llama-4-maverick') || m.includes('llama4-maverick') || m.includes('maverick'))
    return 1_000_000
  if (m.includes('glm-x-preview[1m]')) return 1_000_000
  if (supports1MContext(model)) return ONE_MILLION_CONTEXT_WINDOW

  // 200k
  if (m.includes('claude-sonnet-4') || m.includes('claude-opus-4')) return 200_000 // 标准 200k，1M 需申请
  if (m.includes('claude-haiku')) return 200_000
  if (m.includes('openai-o1') || m.includes('openai-o3') || m.includes('/o1') || m.includes('/o3'))
    return 200_000
  if (m.includes('glm-5.1') || m.includes('glm5.1')) return 200_000

  // 128k
  if (
    m.includes('gpt-4o') ||
    m.includes('gpt-4-turbo') ||
    m.includes('gpt4o') ||
    m.includes('gpt4-turbo')
  )
    return 128_000
  if (m.includes('deepseek-v3') || m.includes('deepseek')) return 128_000 // V3=128k, V4=1M（走 supports1MContext）
  if (m.includes('glm-4') || m.includes('glm-5') || m.includes('glm4') || m.includes('glm5'))
    return 128_000
  if (
    m.includes('qwen-2.5') ||
    m.includes('qwen2.5') ||
    m.includes('qwen-2') ||
    m.includes('qwen2')
  )
    return 128_000
  if (m.includes('mistral-large') || m.includes('mistral large')) return 128_000

  // 默认 200k
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * 兼容端点（MiniMax / DeepSeek 等）走 Claude Agent SDK 时，SDK 常固定回 200K，
 * 即使模型原生支持 1M。在 Claude 系列以外、且模型在 supports1MContext 列表内时，
 * 将 200K 展示窗口升级为 1M，避免圆环/分项虚高。
 *
 * 注意：SDK 内部压缩阈值可能仍按 200K 运行，UI 分母仅作展示对齐。
 */
export function resolveDisplayContextWindow(
  modelId: string | undefined,
  sdkWindow: number | undefined
): number {
  const inferred = inferContextWindow(modelId) ?? DEFAULT_CONTEXT_WINDOW
  if (sdkWindow === undefined) return inferred

  // SDK 已给出大于默认 200K 的值，先检查模型是否有明确映射
  if (sdkWindow > DEFAULT_CONTEXT_WINDOW) {
    // 如果模型有明确映射（不是默认 200k），且映射值比 SDK 返回的小，用映射值
    // 避免 SDK 对兼容端点返回错误的默认值（如 glm-5.1 实际 200k 但 SDK 返回 1M）
    const hasExplicitMapping = inferred !== DEFAULT_CONTEXT_WINDOW
    if (hasExplicitMapping && inferred < sdkWindow) {
      return inferred
    }
    return sdkWindow
  }

  const model = modelId?.toLowerCase() ?? ''
  const isCompatUnderreport =
    sdkWindow === DEFAULT_CONTEXT_WINDOW &&
    modelId != null &&
    supports1MContext(modelId) &&
    !model.includes('claude')

  if (isCompatUnderreport) {
    return ONE_MILLION_CONTEXT_WINDOW
  }

  return sdkWindow
}

/** 从 result.modelUsage 多 entry 中选代表性 contextWindow（取最大，贴近主模型视角） */
export function pickResultContextWindow(
  modelUsage?: Record<string, { contextWindow?: number }>
): number | undefined {
  if (!modelUsage) return undefined
  let bestWindow: number | undefined
  let bestModel: string | undefined
  for (const [modelId, info] of Object.entries(modelUsage)) {
    const win = info?.contextWindow ?? inferContextWindow(modelId)
    if (win === undefined) continue
    if (bestWindow === undefined || win > bestWindow) {
      bestWindow = win
      bestModel = modelId
    }
  }
  if (bestWindow === undefined) return undefined
  return resolveDisplayContextWindow(bestModel, bestWindow)
}
