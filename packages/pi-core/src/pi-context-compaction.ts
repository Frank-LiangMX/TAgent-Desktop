/**
 * Pi 上下文自动压缩执行器（TAgent 自研）
 *
 * 算法用 Pi：estimateContextTokens / shouldCompact / estimateTokens / generateSummary
 *   以及 COMPACTION_SUMMARY_PREFIX/SUFFIX（官方导出的摘要包装文案）。
 * 编排用 TAgent：切点启发式（只在 user turn 边界切，避免拆散 tool_call/tool_result）、
 *   消息装配（把摘要合并进保留尾的首条 user，避免连续 user 破坏角色交替）、
 *   以及一个复用 Agent 既有 StreamFn 的 Models shim（摘要走与主对话相同的传输/鉴权）。
 *
 * 见 docs/plans/2026-07-29-pi-context-compaction.md §4.2/§4.3。
 *
 * 为什么不用 Pi 的 compactionSummary 角色：
 *   裸 Agent 的默认 convertToLlm 只保留 user/assistant/toolResult，会丢弃 compactionSummary，
 *   摘要将无法到达模型；且 [summary(user), retainedTail[0](user)] 会连续 user，被 Anthropic
 *   协议端点拒绝。故 Phase 1 采用「合并进首条 user」的可工作 MVP，限制见文件末尾注释。
 */

import {
  estimateContextTokens,
  shouldCompact,
  estimateTokens,
  generateSummary,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
} from '@earendil-works/pi-agent-core'
import type {
  AgentMessage,
  CompactionSettings,
  StreamFn,
} from '@earendil-works/pi-agent-core'
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  Models,
  SimpleStreamOptions,
  TextContent,
} from '@earendil-works/pi-ai'

// ===== 执行器 =====

export interface MaybeCompactOptions {
  /** 当前消息列表（transformContext 收到的本轮视图） */
  messages: AgentMessage[]
  /** 上下文窗口（分母） */
  contextWindow: number
  /** Pi 压缩配置（enabled/reserveTokens/keepRecentTokens） */
  settings: CompactionSettings
  /** 摘要请求走这个 Models（通常用 createCompactionModelsShim 复用 Agent 的 StreamFn） */
  models: Models
  /** 用于摘要 maxTokens/推理等级判断的模型（占位即可，StreamFn 会用真实端点） */
  model: Model<Api>
  /** 中止信号，透传给 generateSummary */
  signal?: AbortSignal
  /** 摘要附加指令（透传给 Pi generateSummary） */
  customInstructions?: string
  /**
   * 强制压缩：跳过 shouldCompact 阈值（手动压缩 / 过长重试用）。
   * 仍受 enabled=false、空消息、无安全切点约束。
   */
  force?: boolean
}

export interface MaybeCompactResult {
  /** 是否实际压缩 */
  compacted: boolean
  /** 压缩后的消息列表（未压缩时为原列表） */
  messages: AgentMessage[]
  /** 摘要文本（压缩成功时） */
  summary?: string
  /** 压缩前估算 token 数 */
  tokensBefore?: number
  /** 未压缩的原因（日志用） */
  reason?: string
}

/**
 * 评估并执行一次压缩。
 *
 * 流程：估算 token → Pi shouldCompact 判定 → 自研切点 → Pi generateSummary 摘要 → 装配新列表。
 * 任何环节失败都返回 { compacted: false, messages }（调用方 transformContext 契约要求不抛）。
 */
export async function maybeCompactMessages(opts: MaybeCompactOptions): Promise<MaybeCompactResult> {
  const { messages, contextWindow, settings, models, model, signal, customInstructions, force } = opts

  // 强制压缩（手动 / 过长重试）可绕过 enabled=false 的自动路径开关
  if (!force && !settings.enabled) return { compacted: false, messages, reason: 'disabled' }
  if (messages.length === 0) return { compacted: false, messages, reason: 'empty' }

  const estimate = estimateContextTokens(messages)
  if (!force && !shouldCompact(estimate.tokens, contextWindow, settings)) {
    return { compacted: false, messages, reason: 'below threshold', tokensBefore: estimate.tokens }
  }

  const cutIndex = findCompactionCutIndex(messages, settings.keepRecentTokens)
  if (cutIndex <= 0) {
    return {
      compacted: false,
      messages,
      reason: 'no safe cut point (need a user turn boundary in recent history)',
      tokensBefore: estimate.tokens,
    }
  }

  const toSummarize = messages.slice(0, cutIndex)
  const retainedTail = messages.slice(cutIndex)
  if (toSummarize.length === 0) {
    return { compacted: false, messages, reason: 'nothing to summarize', tokensBefore: estimate.tokens }
  }

  const summaryResult = await generateSummary(
    toSummarize,
    models,
    model,
    settings.reserveTokens,
    signal,
    customInstructions,
  )
  if (!summaryResult.ok) {
    return {
      compacted: false,
      messages,
      reason: `summarization failed: ${summaryResult.error.message}`,
      tokensBefore: estimate.tokens,
    }
  }

  const summary = summaryResult.value
  const newMessages = assembleCompactedMessages(summary, retainedTail)
  return { compacted: true, messages: newMessages, summary, tokensBefore: estimate.tokens }
}

// ===== 切点启发式（TAgent 自研） =====

/**
 * 找到压缩切点：从末尾往前累积 token，达到 keepRecentTokens 后，
 * 从该处往后找最近的 user 消息作为保留尾的起点（turn 边界）。
 *
 * 只在 user 消息处切，避免把 assistant(toolCall) 与其后继 toolResult 拆散
 * （拆散会导致模型看到孤立的 tool_result 而报错）。
 *
 * 返回保留尾起点的 index；找不到安全边界返回 -1。
 */
export function findCompactionCutIndex(messages: AgentMessage[], keepRecentTokens: number): number {
  let accumulated = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]!)
    if (accumulated >= keepRecentTokens) {
      // 从 i 往后找最近的 user 消息作为切点
      for (let j = i; j < messages.length; j++) {
        if (messages[j]!.role === 'user') return j
      }
      // 该 turn 内没有 user 边界 → 无法安全切
      return -1
    }
  }
  // 整段都 < keepRecentTokens：没有足够旧历史值得压缩
  return -1
}

// ===== 消息装配（TAgent 自研） =====

/**
 * 把摘要装配进保留尾：保留尾起点必为 user 消息（切点保证），
 * 将摘要（Pi 官方包装文案）合并进首条 user，避免连续 user 破坏角色交替。
 */
export function assembleCompactedMessages(summary: string, retainedTail: AgentMessage[]): AgentMessage[] {
  const summaryText = `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`
  const first = retainedTail[0]
  if (first && first.role === 'user') {
    const merged = mergeSummaryIntoUserMessage(first, summaryText)
    return [merged, ...retainedTail.slice(1)]
  }
  // 兜底：retainedTail 为空或起点非 user（正常路径不会走到）—— 单独塞一条 user 摘要
  return [
    { role: 'user', content: [{ type: 'text', text: summaryText }], timestamp: Date.now() } as AgentMessage,
  ]
}

/** 把摘要文本前置进一条 user 消息（支持 string 与 content block 数组两种 content 形态） */
function mergeSummaryIntoUserMessage(userMsg: AgentMessage, summaryText: string): AgentMessage {
  if (userMsg.role !== 'user') return userMsg
  const summaryBlock: TextContent = { type: 'text', text: `${summaryText}\n` }
  if (typeof userMsg.content === 'string') {
    return {
      role: 'user',
      content: [summaryBlock, { type: 'text', text: userMsg.content }],
      timestamp: userMsg.timestamp,
    } as AgentMessage
  }
  return {
    role: 'user',
    content: [summaryBlock, ...userMsg.content],
    timestamp: userMsg.timestamp,
  } as AgentMessage
}

// ===== Models shim（TAgent 自研，复用 Agent 既有 StreamFn） =====

/**
 * 构造一个仅服务于压缩摘要请求的 Models shim。
 *
 * Pi 的 generateSummary/compact 只会调用 models.completeSimple（经 completeSimpleWithRetries）。
 * 这里把 completeSimple 委托给 Agent 已有的 StreamFn，使摘要请求走与主对话**相同的传输、
 * apiKey、baseUrl**，无需另建 Provider/auth/OAuth 体系。
 *
 * 仅 completeSimple/streamSimple 有真实实现；其余 Models 方法在压缩路径不会被触达，
 * 提供安全桩以满足接口契约。
 */
export function createCompactionModelsShim(streamFn: StreamFn, model: Model<Api>): Models {
  const runStream = (
    _model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const opts: SimpleStreamOptions = {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.reasoning ? { reasoning: options.reasoning } : {}),
    }
    // StreamFn 可能同步返回流或返回 Promise<流>；http-direct streamFn 同步返回。
    return streamFn(model, context, opts) as AssistantMessageEventStream
  }

  const shim: Pick<Models, 'completeSimple' | 'streamSimple'> = {
    completeSimple: async (_model, context, options) => {
      const stream = await Promise.resolve(runStream(_model, context, options))
      return stream.result()
    },
    streamSimple: (_model, context, options) => runStream(_model, context, options),
  }

  // 其余方法压缩路径不会触达；给出安全桩后整体视为 Models。
  const fullShim = {
    ...shim,
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [],
    getModel: () => undefined,
    refresh: async () => ({ aborted: false, errors: new Map() }),
    checkAuth: async () => undefined,
    getAvailable: async () => [],
    getAuth: async () => undefined,
    login: async () => {
      throw new Error('[pi-compaction] Models shim 未实现 login（压缩流程不需要）')
    },
    logout: async () => undefined,
    stream: (_model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
      runStream(_model, context, options),
    complete: async (_model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      const stream = await Promise.resolve(runStream(_model, context, options))
      return stream.result()
    },
  }
  return fullShim as unknown as Models
}

/*
 * Phase 1 已知限制（见 plan §6 非目标 / §4.2）：
 * - 不处理 split-turn（保留尾内某 turn 被预算切断的情况）：只在 user 边界切，
 *   若近期历史全在一个长 turn 内无 user 边界，则跳过压缩（可能仍 prompt_too_long）。
 * - 不做迭代 previousSummary 链式更新：每次压缩都从当前历史重新生成摘要
 *   （已压缩过的摘要文本会作为历史一部分被再次纳入，可工作但有少量重复开销）。
 * - kscc bare 模式不接线压缩（无独立摘要端点）；仅外部渠道启用。
 * - 摘要角色采用「合并进首条 user」而非 Pi compactionSummary 角色，原因见文件顶部注释。
 * - UI 事件（compacting/compact_boundary）与手动压缩为 Phase 2；本轮仅 [pi-compaction] 日志。
 */
