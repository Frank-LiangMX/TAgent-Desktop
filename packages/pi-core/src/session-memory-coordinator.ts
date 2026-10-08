/**
 * 会话内 8k 四层协调器（Phase 3）
 *
 * L-fact 已在 system（Frozen）；本协调器管 messages 区：
 *   L-rag（8%）+ L-mid（12%）+ L-short（80%），小/大窗口自适应。
 *
 * 接入点：pi-agent-adapter transformContext → coordinator.reconcile
 * 压缩算法仍用 maybeCompactMessages；本文件加状态（lmidChain / rag 缓存）与预算装配。
 */
import type { AgentMessage, CompactionSettings, StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model, Models } from '@earendil-works/pi-ai'
import { estimateContextTokens } from '@earendil-works/pi-agent-core'
import { maybeCompactMessages, type MaybeCompactResult } from './pi-context-compaction.ts'
import { TAGENT_PI_COMPACTION_THRESHOLD_RATIO } from './pi-context-settings.ts'

export interface LayerBudgets {
  lrag: number
  lmid: number
  lshort: number
  total: number
}

export interface RagHit {
  source: string
  text: string
  score?: number
}

export interface CoordinatorState {
  lmidChain: string[]
  lastRagQuery?: string
  lastRagHits: RagHit[]
  /** 后台压缩进行中 */
  compressInFlight: boolean
}

export interface ReconcileOptions {
  messages: AgentMessage[]
  contextWindow: number
  settings: CompactionSettings
  models: Models
  model: Model<Api>
  signal?: AbortSignal
  force?: boolean
  /**
   * @deprecated 保留兼容字段；自动压缩现在始终在发送前同步完成，绝不后台放行。
   */
  asyncAuto?: boolean
  /**
   * 没有上一轮 provider usage 时，用于补足 system prompt + tools 的估算。
   * 有上一轮 usage 时，provider usage 已经包含静态上下文，不能重复相加。
   */
  staticContextTokens?: number
  /** L-rag 检索回调（主进程注入 memoryLayerService.searchSessions 等） */
  retrieveRag?: (query: string) => Promise<RagHit[]> | RagHit[]
  onCompacted?: (result: MaybeCompactResult) => void
}

export interface ReconcileResult {
  /** 本轮请求视图，允许包含临时 RAG/摘要上下文。 */
  messages: AgentMessage[]
  /** 应写回 Agent state 的持久消息；不包含本轮临时注入。 */
  stateMessages: AgentMessage[]
  compacted: boolean
  tokensBefore?: number
  summary?: string
  reason?: string
  /** 本次请求已达到自动压缩线，但压缩没有完成。调用方必须阻止发送。 */
  compactionRequired?: boolean
  compactionError?: string
  layerBudgets: LayerBudgets
  ragHits: RagHit[]
}

/** 按 contextWindow 分配四层预算（messages 区三层） */
export function allocateLayerBudgets(contextWindow: number): LayerBudgets {
  // 预留 system/tools/output ~20%
  const total = Math.max(4_000, Math.floor(contextWindow * 0.8))
  if (contextWindow < 32_000) {
    return {
      total,
      lrag: Math.floor(total * 0.04),
      lmid: Math.floor(total * 0.06),
      lshort: Math.floor(total * 0.9),
    }
  }
  if (contextWindow > 200_000) {
    return {
      total,
      lrag: Math.floor(total * 0.08),
      lmid: Math.floor(total * 0.2),
      lshort: Math.floor(total * 0.72),
    }
  }
  return {
    total,
    lrag: Math.floor(total * 0.08),
    lmid: Math.floor(total * 0.12),
    lshort: Math.floor(total * 0.8),
  }
}

function extractLastUserText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown }
    if (m?.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .map((b) =>
          b && typeof b === 'object' && (b as { type?: string }).type === 'text'
            ? String((b as { text?: string }).text ?? '')
            : '',
        )
        .join('')
    }
  }
  return ''
}

function mergeContextIntoFirstUser(
  messages: AgentMessage[],
  contextText: string,
): AgentMessage[] {
  if (!contextText.trim()) return messages
  const firstUserIndex = messages.findIndex((message) => message.role === 'user')
  if (firstUserIndex < 0) {
    return [
      { role: 'user', content: contextText, timestamp: Date.now() } as AgentMessage,
      ...messages,
    ]
  }

  const firstUser = messages[firstUserIndex]!
  if (firstUser.role !== 'user') return messages
  const prefix = { type: 'text', text: `${contextText}\n\n` }
  const content =
    typeof firstUser.content === 'string'
      ? [prefix, { type: 'text', text: firstUser.content }]
      : [prefix, ...firstUser.content]
  const merged = { ...firstUser, content } as AgentMessage
  const result = [...messages]
  result[firstUserIndex] = merged
  return result
}

/**
 * per-session 协调器
 */
export class SessionMemoryCoordinator {
  readonly state: CoordinatorState = {
    lmidChain: [],
    lastRagHits: [],
    compressInFlight: false,
  }

  constructor(public readonly sessionId: string) {}

  async reconcile(opts: ReconcileOptions): Promise<ReconcileResult> {
    const budgets = allocateLayerBudgets(opts.contextWindow)
    const estimate = estimateContextTokens(opts.messages)
    // Pi 的 estimateContextTokens 会优先使用上一轮 provider usage，并把本轮
    // 新增消息估算后缀加回去。只有没有 provider usage 的首轮，才需要补 system/tools。
    const staticTokens = estimate.lastUsageIndex === null ? opts.staticContextTokens ?? 0 : 0
    const tokens = estimate.tokens + staticTokens

    // L-rag：取末条 user 作 query
    let ragHits = this.state.lastRagHits
    const query = extractLastUserText(opts.messages).slice(0, 500)
    if (opts.retrieveRag && query) {
      if (this.state.lastRagQuery === query && this.state.lastRagHits.length > 0) {
        ragHits = this.state.lastRagHits
      } else {
        try {
          ragHits = await opts.retrieveRag(query)
          this.state.lastRagQuery = query
          this.state.lastRagHits = ragHits
        } catch {
          ragHits = []
        }
      }
    }

    // 未达阈值且非 force：只注入 L-rag/L-mid 前缀
    // 触发线必须和 UI/配置保持一致：contextWindow * 80%。
    // lshort 是 L-short 的内容预算，不是自动压缩阈值；对 500k 窗口使用它会
    // 把实际阈值错误地降到约 288k。
    const triggerTokens = Math.ceil(opts.contextWindow * TAGENT_PI_COMPACTION_THRESHOLD_RATIO)
    const needCompact =
      opts.force || (opts.settings.enabled && tokens >= triggerTokens)

    if (!needCompact) {
      return {
        messages: this.assembleWithLayers(opts.messages, ragHits),
        stateMessages: opts.messages,
        compacted: false,
        tokensBefore: tokens,
        reason: 'below threshold',
        layerBudgets: budgets,
        ragHits,
      }
    }

    // 发送前同步压缩。达到边界时 force 传给执行器，是为了覆盖 Pi 内部
    // 严格 `>` 的边界判断，使 TAgent 的 `>= 80%` 语义真正生效。
    const result = await this.runCompact(opts, true)
    const assembled = this.assembleWithLayers(result.messages, ragHits)
    if (!result.compacted) {
      return {
        messages: assembled,
        stateMessages: opts.messages,
        compacted: false,
        tokensBefore: tokens,
        reason: result.reason,
        compactionRequired: true,
        compactionError: result.reason ?? 'context compaction did not complete',
        layerBudgets: budgets,
        ragHits,
      }
    }
    return {
      messages: assembled,
      stateMessages: result.messages,
      compacted: result.compacted,
      tokensBefore: result.tokensBefore,
      summary: result.summary,
      reason: result.reason,
      layerBudgets: budgets,
      ragHits,
    }
  }

  private async runCompact(opts: ReconcileOptions, forceOverride = false): Promise<MaybeCompactResult> {
    return maybeCompactMessages({
      messages: opts.messages,
      contextWindow: opts.contextWindow,
      settings: opts.settings,
      models: opts.models,
      model: opts.model,
      signal: opts.signal,
      force: forceOverride || opts.force,
      customInstructions:
        '请产出简洁逻辑骨架摘要；保留用户偏好、项目约定、关键决策；模糊无关细节。',
    })
  }

  private assembleWithLayers(messages: AgentMessage[], ragHits: RagHit[]): AgentMessage[] {
    const sections: string[] = []
    if (ragHits.length > 0) {
      const body = ragHits
        .slice(0, 5)
        .map((h, i) => `${i + 1}. [${h.source}] ${h.text.slice(0, 400)}`)
        .join('\n')
      sections.push(`## 相关记忆（按需检索）\n\n${body}\n\n（以上为系统检索注入，请结合当前问题使用）`)
    }
    if (this.state.lmidChain.length > 0) {
      const mid = this.state.lmidChain.slice(-3).join('\n---\n')
      sections.push(`## 会话滚动摘要（L-mid）\n\n${mid}`)
    }
    return mergeContextIntoFirstUser(messages, sections.join('\n\n'))
  }
}

/** 全局 per-session 协调器表 */
const coordinators = new Map<string, SessionMemoryCoordinator>()

export function getSessionMemoryCoordinator(sessionId: string): SessionMemoryCoordinator {
  let c = coordinators.get(sessionId)
  if (!c) {
    c = new SessionMemoryCoordinator(sessionId)
    coordinators.set(sessionId, c)
  }
  return c
}

export function disposeSessionMemoryCoordinator(sessionId: string): void {
  coordinators.delete(sessionId)
}
