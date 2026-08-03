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
  /** 自动路径：先返回原消息并后台压；force 时同步压 */
  asyncAuto?: boolean
  /** L-rag 检索回调（主进程注入 memoryLayerService.searchSessions 等） */
  retrieveRag?: (query: string) => Promise<RagHit[]> | RagHit[]
  onCompacted?: (result: MaybeCompactResult) => void
}

export interface ReconcileResult {
  messages: AgentMessage[]
  compacted: boolean
  tokensBefore?: number
  summary?: string
  reason?: string
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

function injectPrefixMessages(
  messages: AgentMessage[],
  prefixBlocks: Array<{ role: 'user' | 'assistant'; text: string }>,
): AgentMessage[] {
  if (prefixBlocks.length === 0) return messages
  const prefix = prefixBlocks.map((b): AgentMessage => {
    if (b.role === 'assistant') {
      return {
        role: 'assistant',
        content: [{ type: 'text', text: b.text }],
        api: 'openai-completions',
        provider: 'tagent-memory',
        model: 'memory-prefix',
        stopReason: 'stop',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      }
    }
    return {
      role: 'user',
      content: b.text,
      timestamp: Date.now(),
    }
  })
  return [...prefix, ...messages]
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
    const tokens = estimate.tokens

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
    const shortBudget = budgets.lshort
    const needCompact = opts.force || tokens > shortBudget

    if (!needCompact) {
      return {
        messages: this.assembleWithLayers(opts.messages, ragHits),
        compacted: false,
        tokensBefore: tokens,
        reason: 'below threshold',
        layerBudgets: budgets,
        ragHits,
      }
    }

    // 异步自动压缩：本轮先返回原消息（可带 L-rag），后台跑
    if (opts.asyncAuto && !opts.force) {
      if (!this.state.compressInFlight) {
        this.state.compressInFlight = true
        void this.runCompact(opts)
          .then((r) => {
            this.state.compressInFlight = false
            if (r.compacted && r.summary) {
              this.state.lmidChain.push(r.summary)
              // 链过长：保留最近 5 条
              if (this.state.lmidChain.length > 5) {
                this.state.lmidChain = this.state.lmidChain.slice(-5)
              }
            }
            opts.onCompacted?.(r)
          })
          .catch(() => {
            this.state.compressInFlight = false
          })
      }
      return {
        messages: this.assembleWithLayers(opts.messages, ragHits),
        compacted: false,
        tokensBefore: tokens,
        reason: 'async pending',
        layerBudgets: budgets,
        ragHits,
      }
    }

    // 同步压缩（force / 非 async）
    const result = await this.runCompact(opts)
    if (result.compacted && result.summary) {
      this.state.lmidChain.push(result.summary)
      if (this.state.lmidChain.length > 5) {
        this.state.lmidChain = this.state.lmidChain.slice(-5)
      }
    }
    const assembled = this.assembleWithLayers(result.messages, ragHits)
    return {
      messages: assembled,
      compacted: result.compacted,
      tokensBefore: result.tokensBefore,
      summary: result.summary,
      reason: result.reason,
      layerBudgets: budgets,
      ragHits,
    }
  }

  private async runCompact(opts: ReconcileOptions): Promise<MaybeCompactResult> {
    return maybeCompactMessages({
      messages: opts.messages,
      contextWindow: opts.contextWindow,
      settings: opts.settings,
      models: opts.models,
      model: opts.model,
      signal: opts.signal,
      force: opts.force,
      customInstructions:
        '请产出简洁逻辑骨架摘要；保留用户偏好、项目约定、关键决策；模糊无关细节。',
    })
  }

  private assembleWithLayers(messages: AgentMessage[], ragHits: RagHit[]): AgentMessage[] {
    const prefixes: Array<{ role: 'user' | 'assistant'; text: string }> = []
    if (ragHits.length > 0) {
      const body = ragHits
        .slice(0, 5)
        .map((h, i) => `${i + 1}. [${h.source}] ${h.text.slice(0, 400)}`)
        .join('\n')
      prefixes.push({
        role: 'user',
        text: `## 相关记忆（按需检索）\n\n${body}\n\n（以上为系统检索注入，请结合当前问题使用）`,
      })
      prefixes.push({
        role: 'assistant',
        text: '已收到相关记忆，将结合其回答。',
      })
    }
    if (this.state.lmidChain.length > 0) {
      const mid = this.state.lmidChain.slice(-3).join('\n---\n')
      prefixes.push({
        role: 'user',
        text: `## 会话滚动摘要（L-mid）\n\n${mid}`,
      })
      prefixes.push({
        role: 'assistant',
        text: '已接收滚动摘要。',
      })
    }
    return injectPrefixMessages(messages, prefixes)
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
