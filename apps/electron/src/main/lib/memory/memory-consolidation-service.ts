/**
 * MemoryConsolidationService — 空闲批量记忆整理核心（ADR-0006 Phase 2）
 *
 * Phase 2.1 从 TAgent_General 移植。路径改用 getMemoryDir（基于 getConfigDir()）。
 * defaultExecutor（LLM 批量整理）依赖 General 独有渠道客户端，暂 stub（见文件内 TODO）。
 *
 * 前台逐 turn 辅助 LLM 调用被移除后，由本服务在空闲窗口执行一次批量整理：
 * - 读取自上次成功游标之后的增量证据
 * - 一次 LLM 请求完成 keyFacts、Nudge 候选、洞察和矛盾检查
 * - 幂等写入，失败重试不污染 L0-L5
 *
 * 设计要点：
 * - general/ta 独立状态；独立运行状态文件，不给 L4 加列
 * - 依赖可注入：evidence source、executor、applier、clock、foreground 检查、状态路径、lease 路径
 * - 全局单并发（跨模式共享 lease 文件）；lease 有过期时间，失败/成功都释放
 * - 成功才推进 cursor 并清理已处理证据；失败不清理、不推进
 * - batch 最多 100 条 evidence、文本最多 40000 字符
 * - runIfEligible 单次最多调用 executeConsolidation 1 次（无内部重试）
 * - 每次真正发出的 Provider 请求都计数，SDK event 不计数
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

import { getMemoryDir, type MemoryMode } from './memory-layer-service'
import type { MemoryEvidenceEntry } from './memory-evidence-sink'

// ===== 类型定义 =====

/** 整理结果 outcome */
export type ConsolidationOutcome =
  | 'success'
  | 'skipped_clean'
  | 'skipped_insufficient_evidence'
  | 'skipped_foreground_active'
  | 'skipped_silence_window'
  | 'skipped_debounce'
  | 'skipped_budget'
  | 'skipped_locked'
  | 'skipped_retry_backoff'
  | 'failed'

/** 带结构化元数据的洞察（ADR §3） */
export interface Insight {
  content: string
  confidence: number
  evidenceIds: string[]
}

/** 带结构化元数据的矛盾（ADR §3） */
export interface Contradiction {
  existingId?: string
  content: string
  evidenceIds: string[]
}

/** 批量整理的结构化输出（ADR §3 完整结构） */
export interface BatchOutput {
  sessionKeyFacts: Array<{ sessionId: string; facts: string[] }>
  memoryCandidates: Array<{
    targetLayer: 'L0' | 'L1' | 'L2' | 'L3'
    content: string
    confidence: number
    evidenceIds: string[]
  }>
  insights: Insight[]
  contradictions: Contradiction[]
}

/** 传递给 executor 的请求结构 */
export interface ConsolidationRequest {
  evidence: MemoryEvidenceEntry[]
  mode: MemoryMode
}

/** runIfEligible 的选项 */
export interface RunOptions {
  /** 跳过空闲等待（静默窗 + debounce），但不能跳过前台互斥、单并发、预算 */
  force?: boolean
}

/** 每次 runIfEligible 的完整结果 */
export interface RunResult {
  outcome: ConsolidationOutcome
  requestsUsed: number
  sessionsProcessed: number
  evidenceProcessed: number
  batchOutput: BatchOutput | null
}

/** 持久化状态（每模式独立） */
export interface ConsolidationState {
  lastAttemptTime: number | null
  lastSuccessTime: number | null
  lastOutcome: ConsolidationOutcome | null
  lastErrorCode: string | null
  cursor: string | null // 复合游标 "createdAt_id"
  requestsUsedToday: number
  budgetDate: string // YYYY-MM-DD
  leaseUntil: number | null
  inputCounts: { sessions: number; evidenceCount: number }
  outputCounts: {
    keyFacts: number
    memoryCandidates: number
    insights: number
    contradictions: number
  }
  // --- Phase 2 新增字段（向后兼容） ---
  version?: number
  retryAfter?: number | null // 下次允许重试的时间戳（退避）
  lastBatchId?: string | null // 最后成功执行的 batchId（向后兼容）
  pendingApplication?: PendingApplication | null // 待重放的应用记录
}

/** 全局 lease 文件结构 */
export interface GlobalLeaseState {
  holder: MemoryMode | null
  leaseUntil: number | null
  acquiredAt: number | null
}

/** 持久化的待应用记录（executor 成功后、apply 前保存） */
export interface PendingApplication {
  batchId: string
  evidenceIds: string[]
  cursor: string
  output: BatchOutput
  counts: {
    inputSessions: number
    inputEvidenceCount: number
    outputKeyFacts: number
    outputMemoryCandidates: number
    outputInsights: number
    outputContradictions: number
  }
  createdAt: number
}

/** 可注入依赖 */
export interface ConsolidationDeps {
  /** 读取待处理证据 */
  getPendingEvidence: (mode: MemoryMode) => MemoryEvidenceEntry[]
  /** 检查模式是否有 dirty 标记 */
  isModeDirty: (mode: MemoryMode) => boolean
  /** 清除模式的 dirty 标记 */
  markModeClean: (mode: MemoryMode) => void
  /** 按 processed evidence ID 精确删除（temp+rename 原子重写），返回剩余未消费的条目数 */
  consumeProcessedEvidence: (mode: MemoryMode, processedIds: string[]) => number

  /** 执行一次批量 LLM 整理 */
  executeConsolidation: (request: ConsolidationRequest) => Promise<BatchOutput>
  /** 将整理的输出写入记忆层（传 batchId 用于幂等 stage 生成） */
  applyBatchOutput: (output: BatchOutput, mode: MemoryMode, batchId?: string) => Promise<void>

  /** 当前时间戳 */
  now: () => number
  /** 前台是否有活跃的 Agent 交互 */
  isForegroundActive: () => boolean
  /** 状态文件路径（每模式独立） */
  getStatePath: (mode: MemoryMode) => string
  /** 全局 lease 文件路径（general/ta 共享，测试可注入） */
  getLeasePath: () => string
}

// ===== 错误类型 =====

/**
 * 整理过程中的错误，带稳定错误码。
 *
 * 错误码用于：
 * - 决定是否计入 Provider 请求计数（不会发请求的错误不计数）
 * - 记录到 lastErrorCode 便于诊断
 * - 判断是否允许重试
 */
export class ConsolidationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ConsolidationError'
  }
}

/** 不会真正发出 Provider 请求的稳定错误码集合 */
const PREFLIGHT_ERROR_CODES: ReadonlySet<string> = new Set([
  'NO_CHANNEL',
  'CHANNEL_NOT_FOUND',
  'KSCC_UNSUPPORTED',
  'NO_API_KEY',
])

/**
 * 计算紧凑确定性 batchId（SHA-256 派生）。
 *
 * 输入：mode + evidence IDs → 16 位 hex（64 bit）。
 * 内部对 IDs 排序副本，保证相同集合无论传入顺序都产生相同 ID。
 */
export function computeBatchId(mode: MemoryMode, evidenceIds: string[]): string {
  const sorted = [...evidenceIds].sort()
  const payload = `${mode}:${sorted.join(',')}`
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

// ===== 配置 =====

/** 首次空闲静默窗口：10 分钟 */
const SILENCE_WINDOW_MS = 10 * 60 * 1000

/** 批处理 debounce：30 分钟（从最新证据 createdAt 算起） */
const DEBOUNCE_MS = 30 * 60 * 1000

/** 每模式每活跃日常规预算 */
const BUDGET_PER_DAY = 1

/** 允许的最大请求数（含失败后重试） */
const MAX_REQUESTS_PER_DAY = 2

/** 单次最多处理的证据条目 */
const MAX_EVIDENCE_PER_BATCH = 100

/** 单次请求最大文本字符数 */
const MAX_TEXT_LENGTH = 40000

/** Lease 过期时间：5 分钟 */
const LEASE_DURATION_MS = 5 * 60 * 1000

/** 失败后退避时间：30 分钟 */
const RETRY_BACKOFF_MS = 30 * 60 * 1000

// ===== 默认 executor =====

/**
 * 默认的 LLM executor。
 *
 * 记忆整理使用独立的轻量 LLM 请求；模型只负责提炼结构化结果，
 * 真实写盘仍由本服务的 applier 完成。
 */
export async function defaultExecutor(request: ConsolidationRequest): Promise<BatchOutput> {
  try {
    const { completeMemoryLlm } = await import('./memory-llm-client')
    const evidenceText = request.evidence
      .map(
        (e, i) =>
          `[${i}] session=${e.sessionId.slice(0, 8)} source=${e.source} createdAt=${e.createdAt}` +
          (e.sessionTitle ? ` title=${e.sessionTitle}` : '') +
          (e.sessionSummary ? ` summary=${e.sessionSummary}` : '') +
          (e.userMessages?.length ? ` userMessages=${JSON.stringify(e.userMessages)}` : '') +
          (e.nudgeCandidate
            ? ` nudge=${JSON.stringify({
                id: e.id,
                type: e.nudgeCandidate.type,
                targetLayer: e.nudgeCandidate.targetLayer,
                pattern: e.nudgeCandidate.pattern,
                suggestedContent: e.nudgeCandidate.suggestedContent,
              })}`
            : '') +
          (e.toolsUsed?.length ? ` tools=${e.toolsUsed.join(',')}` : ''),
      )
      .join('\n')

    const systemPrompt = `你是一个记忆整理助手。基于增量证据输出结构化 JSON。
要求：
1. sessionKeyFacts：每会话 1-3 个关键事实
2. memoryCandidates：L0/L1/L2/L3 候选（高置信度优先）
3. insights：跨会话洞察（content≤80字、confidence 0-1、evidenceIds）
4. contradictions：矛盾发现
5. 如果证据中包含 nudge，必须将有效 nudge 映射为 memoryCandidates，不能只返回 sessionKeyFacts；evidenceIds 必须使用给出的证据 id。
严格 JSON：
{"sessionKeyFacts":[{"sessionId":"...","facts":["..."]}],"memoryCandidates":[{"targetLayer":"L2","content":"...","confidence":0.9,"evidenceIds":[]}],"insights":[{"content":"...","confidence":0.8,"evidenceIds":[]}],"contradictions":[{"content":"...","evidenceIds":[]}]}`

    const userPrompt = `=== 增量证据 ===\n${evidenceText || '（无）'}\n\n请输出 JSON：`
    const raw = await completeMemoryLlm({ systemPrompt, userPrompt })
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) {
      return addDeterministicNudgeCandidates(
        { sessionKeyFacts: [], memoryCandidates: [], insights: [], contradictions: [] },
        request.evidence,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.slice(start, end + 1))
    } catch {
      return addDeterministicNudgeCandidates(
        { sessionKeyFacts: [], memoryCandidates: [], insights: [], contradictions: [] },
        request.evidence,
      )
    }
    return addDeterministicNudgeCandidates(sanitizeBatchOutput(parsed), request.evidence)
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? String((e as { code: string }).code) : 'LLM_FAILED'
    const msg = e instanceof Error ? e.message : String(e)
    throw new ConsolidationError(code || 'LLM_FAILED', `consolidation LLM 失败: ${msg}`)
  }
}

/**
 * LLM 即使请求成功，也可能只返回 sessionKeyFacts，遗漏本地已经判定过的 nudge。
 * 这些 nudge 已满足重复/纠正门控，不能因此丢失；用本地候选做安全兜底，
 * 仍然进入 pending_approval，不直接写入 L0-L3。
 */
export function addDeterministicNudgeCandidates(
  output: BatchOutput,
  evidence: MemoryEvidenceEntry[],
): BatchOutput {
  const candidates = [...output.memoryCandidates]
  const seen = new Set(
    candidates.map((candidate) => `${candidate.targetLayer}\u0000${candidate.content.trim()}`),
  )

  for (const entry of evidence) {
    const nudge = entry.nudgeCandidate
    if (!nudge) continue
    const content = String(nudge.suggestedContent ?? nudge.pattern ?? '').trim()
    if (!content) continue
    const key = `${nudge.targetLayer}\u0000${content}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({
      targetLayer: nudge.targetLayer,
      content,
      confidence: 0.86,
      evidenceIds: [entry.id],
    })
  }

  return { ...output, memoryCandidates: candidates }
}

const VALID_TARGET_LAYERS = ['L0', 'L1', 'L2', 'L3'] as const

type Rec = Record<string, unknown>

function isObj(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string')
}

function isValidConfidence(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

/**
 * 严格校验并过滤 BatchOutput 的每个字段，只保留符合 ADR 规范的有效部分。
 *
 * - sessionKeyFacts：需含 sessionId(string)、facts(string[])
 * - memoryCandidates：需含 targetLayer('L0'|'L1'|'L2'|'L3')、content(string, trim 非空)、confidence(number, 0..1)、evidenceIds(string[])
 * - insights：需含 content(string, trim 非空)、confidence(number, 0..1)、evidenceIds(string[])
 * - contradictions：existingId 可选但若存在必须 string；content(string, trim 非空)、evidenceIds(string[])
 */
export function sanitizeBatchOutput(raw: unknown): BatchOutput {
  if (!isObj(raw)) {
    return { sessionKeyFacts: [], memoryCandidates: [], insights: [], contradictions: [] }
  }

  const sessionKeyFacts = Array.isArray(raw.sessionKeyFacts)
    ? (raw.sessionKeyFacts as unknown[]).filter(
        (s): s is { sessionId: string; facts: string[] } =>
          isObj(s) && typeof s.sessionId === 'string' && isStrArray(s.facts) && s.facts.length > 0
      )
    : []

  const memoryCandidates = Array.isArray(raw.memoryCandidates)
    ? (raw.memoryCandidates as unknown[]).filter(
        (
          c
        ): c is {
          targetLayer: 'L0' | 'L1' | 'L2' | 'L3'
          content: string
          confidence: number
          evidenceIds: string[]
        } =>
          isObj(c) &&
          typeof c.content === 'string' &&
          c.content.trim().length > 0 &&
          isValidConfidence(c.confidence) &&
          VALID_TARGET_LAYERS.includes(c.targetLayer as (typeof VALID_TARGET_LAYERS)[number]) &&
          isStrArray(c.evidenceIds)
      )
    : []

  const insights = Array.isArray(raw.insights)
    ? (raw.insights as unknown[]).filter(
        (ins): ins is Insight =>
          isObj(ins) &&
          typeof ins.content === 'string' &&
          ins.content.trim().length > 0 &&
          isValidConfidence(ins.confidence) &&
          isStrArray(ins.evidenceIds)
      )
    : []

  const contradictions = Array.isArray(raw.contradictions)
    ? (raw.contradictions as unknown[]).filter(
        (c): c is Contradiction =>
          isObj(c) &&
          (c.existingId === undefined || typeof c.existingId === 'string') &&
          typeof c.content === 'string' &&
          c.content.trim().length > 0 &&
          isStrArray(c.evidenceIds)
      )
    : []

  return { sessionKeyFacts, memoryCandidates, insights, contradictions }
}

// ===== 默认 applier =====

/**
 * 默认的 applier：将 BatchOutput 写入记忆层。
 *
 * 幂等性保证：
 * - sessionKeyFacts → memoryLayerService.updateSessionKeyFacts（UPDATE 幂等）
 * - memoryCandidates → enqueueStage 按 ID 去重，stage ID 由 batchId+序号稳定生成
 * - insights + contradictions → reflectService.applyConsolidationInsights（纯本地，anti-echo）
 */
export async function defaultApplier(
  output: BatchOutput,
  mode: MemoryMode,
  batchId?: string
): Promise<void> {
  const { memoryLayerService } = await import('./memory-layer-service')
  const { enqueueStage } = await import('./stage-queue-service')
  const { reflectService } = await import('./reflect-service')

  // 1. 批量更新 L4 keyFacts（幂等：逐 session UPDATE）
  for (const item of output.sessionKeyFacts) {
    if (item.sessionId && Array.isArray(item.facts) && item.facts.length > 0) {
      memoryLayerService.updateSessionKeyFacts(item.sessionId, item.facts, mode)
    }
  }

  // 2. memoryCandidates 入 stage 队列（ID 由 batchId+序号稳定生成）
  for (let i = 0; i < output.memoryCandidates.length; i++) {
    const c = output.memoryCandidates[i]!
    if (c.targetLayer && c.content) {
      const stableId = batchId
        ? `consolidation-${batchId}-${i}`
        : `consolidation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      enqueueStage(mode, {
        id: stableId,
        type:
          c.targetLayer === 'L0'
            ? ('behavior_repeat' as const)
            : c.targetLayer === 'L1'
              ? ('project_repeat' as const)
              : c.targetLayer === 'L3'
                ? ('correction' as const)
                : ('fact_repeat' as const),
        targetLayer: c.targetLayer,
        pattern: c.content,
        evidence: c.evidenceIds,
        suggestedContent: c.content,
        userMessage: `后台整理建议写入 ${c.targetLayer}：${c.content.slice(0, 80)}`,
      })
    }
  }

  // 3. insights + contradictions 通过 ReflectService 纯本地应用（不调 LLM）
  if (output.insights.length > 0 || output.contradictions.length > 0) {
    await reflectService.applyConsolidationInsights(mode, output.insights, output.contradictions)
  }
}

// ===== 默认依赖工厂 =====

/**
 * 构建默认依赖实现（async 因为动态 import）。
 *
 * 注入点可被测试覆盖，测试传 mock 即跳过真实文件/网络/LLM。
 */
export async function buildDefaultDeps(): Promise<ConsolidationDeps> {
  const { memoryEvidenceSink } = await import('./memory-evidence-sink')

  return {
    getPendingEvidence: (mode) => memoryEvidenceSink.getPendingEvidence(mode),
    isModeDirty: (mode) => memoryEvidenceSink.isModeDirty(mode),
    markModeClean: (mode) => memoryEvidenceSink.markModeClean(mode),
    consumeProcessedEvidence: (mode, processedIds) => {
      return memoryEvidenceSink.consumeEvidenceByIds(mode, processedIds)
    },
    executeConsolidation: defaultExecutor,
    applyBatchOutput: defaultApplier,
    now: () => Date.now(),
    isForegroundActive: () => false,
    getStatePath: (mode) => path.join(getMemoryDir(mode), 'consolidation_state.json'),
    getLeasePath: () => {
      return path.join(getMemoryDir('general'), 'consolidation_lease.json')
    },
  }
}

// ===== ConsolidationService =====

export class ConsolidationService {
  /** 持久化状态缓存（按 mode） */
  private states: Map<MemoryMode, ConsolidationState> = new Map()

  constructor(public readonly deps: ConsolidationDeps) {}

  /**
   * 尝试运行一次空闲批量整理。
   *
   * 按以下顺序检查条件并返回对应的 outcome：
   * 1. dirty/evidence → skipped_clean
   * 2. 证据有效内容 → skipped_insufficient_evidence
   * 3. 前台活跃 → skipped_foreground_active
   * 4. 静默窗 → skipped_silence_window
   * 5. debounce → skipped_debounce
   * 6. 失败后退避 → skipped_retry_backoff
   * 7. 单并发（全局 lease）→ skipped_locked
   * 8. 预算 → skipped_budget
   * 9. 执行整理（executeConsolidation 最多 1 次）
   */
  async runIfEligible(mode: MemoryMode, options?: RunOptions): Promise<RunResult> {
    const now = this.deps.now()
    let state = this.loadState(mode)
    const force = options?.force ?? false

    // 确保 budgetDate 与当天匹配（跨天重置）
    state = this.ensureBudgetDate(state, now)

    // ---- 0. 待重放的 pending application（跳过 dirty/evidence/budget，遵守前台/退避/lease） ----
    if (state.pendingApplication) {
      if (this.deps.isForegroundActive()) {
        return this.recordAttempt(state, mode, 'skipped_foreground_active', now)
      }
      // retryAfter 非 null 且在未来 → 正在退避中，任何 outcome 都跳过
      if (state.retryAfter != null && now < state.retryAfter) {
        return this.recordAttempt(state, mode, 'skipped_retry_backoff', now)
      }
      if (this.isGlobalLeaseHeld(now)) {
        return this.recordAttempt(state, mode, 'skipped_locked', now)
      }
      return this.replayPending(mode, state, now)
    }

    // ---- 1. 无 dirty 或证据 ----
    if (!this.deps.isModeDirty(mode)) {
      return this.recordAttempt(state, mode, 'skipped_clean', now)
    }

    const pending = this.deps.getPendingEvidence(mode)
    if (pending.length === 0) {
      return this.recordAttempt(state, mode, 'skipped_clean', now)
    }

    // ---- 2. 证据无有效内容 ----
    const cursor = state.cursor
    const eligible = cursor ? filterAfterCursor(pending, cursor) : pending
    const hasMeaningful = eligible.some(
      (e) =>
        (e.source === 'session' && (e.sessionTitle || e.sessionSummary)) ||
        (e.source === 'nudge' && e.nudgeCandidate?.pattern)
    )
    if (!hasMeaningful) {
      return this.recordAttempt(state, mode, 'skipped_insufficient_evidence', now)
    }

    // ---- 3. 前台活跃 ----
    // force 也不能跳过前台互斥
    if (this.deps.isForegroundActive()) {
      return this.recordAttempt(state, mode, 'skipped_foreground_active', now)
    }

    // ---- 4. 静默窗（10 分钟） ----
    const latestCreated = Math.max(...eligible.map((e) => e.createdAt))
    const lastEvidenceAge = now - latestCreated
    if (!force && lastEvidenceAge < SILENCE_WINDOW_MS) {
      return this.recordAttempt(state, mode, 'skipped_silence_window', now)
    }

    // ---- 5. Debounce（30 分钟，从最新证据 createdAt 算起） ----
    if (!force && lastEvidenceAge < DEBOUNCE_MS) {
      return this.recordAttempt(state, mode, 'skipped_debounce', now)
    }

    // ---- 6. 失败后退避检查 ----
    // retryAfter 非 null 且在未来 → 正在退避中，任何 outcome 都跳过
    if (state.retryAfter != null && now < state.retryAfter) {
      return this.recordAttempt(state, mode, 'skipped_retry_backoff', now)
    }

    // ---- 7. 全局单并发（跨模式 lease 文件） ----
    if (this.isGlobalLeaseHeld(now)) {
      return this.recordAttempt(state, mode, 'skipped_locked', now)
    }

    // ---- 8. 预算 ----
    // 如果今天已经成功过，常规预算已用完
    const succeededToday =
      state.lastSuccessTime !== null && todayStr(state.lastSuccessTime) === todayStr(now)
    // 如果当天唯一一次请求成功但没有产出任何 L0-L3 候选，允许一次修复重试。
    // 否则模型/解析问题会把当天预算消耗掉，修复发布后也要等到第二天才会再次尝试。
    const hasMemoryCandidates = (state.outputCounts?.memoryCandidates ?? 0) > 0
    const repairRetryAvailable =
      succeededToday && !hasMemoryCandidates && state.requestsUsedToday < MAX_REQUESTS_PER_DAY
    if (succeededToday && state.requestsUsedToday >= BUDGET_PER_DAY && !repairRetryAvailable) {
      return this.recordAttempt(state, mode, 'skipped_budget', now)
    }
    if (state.requestsUsedToday >= MAX_REQUESTS_PER_DAY) {
      return this.recordAttempt(state, mode, 'skipped_budget', now)
    }

    // ---- 9. 执行整理（单次，无内部重试） ----
    return this.executeBatch(mode, state, eligible, now)
  }

  /**
   * 执行一批整理。
   *
   * 内部处理：batch 大小限制、文本长度限制、lease 管理、游标推进。
   * executor 成功后立即持久化 pending application record，再执行本地 apply/consume。
   * apply 或 consume 失败时保留 pending，下次 run 以 requestsUsed=0 本地重放。
   */
  private async executeBatch(
    mode: MemoryMode,
    state: ConsolidationState,
    eligible: MemoryEvidenceEntry[],
    now: number
  ): Promise<RunResult> {
    // 取 batch（最多 100 条，按 createdAt,id 排序）
    const sorted = [...eligible].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    const batch = sorted.slice(0, MAX_EVIDENCE_PER_BATCH)

    // 检查文本长度，必要时缩小 batch
    const textLength = batch.reduce((sum, e) => {
      let len = e.sessionId.length + e.source.length + 30
      if (e.sessionTitle) len += e.sessionTitle.length
      if (e.sessionSummary) len += e.sessionSummary.length
      if (e.nudgeCandidate?.pattern) len += e.nudgeCandidate.pattern.length
      return sum + len
    }, 0)
    if (textLength > MAX_TEXT_LENGTH) {
      while (batch.length > 0) {
        batch.pop()
        const newLen = batch.reduce((s, e) => {
          return (
            s +
            e.sessionId.length +
            e.source.length +
            30 +
            (e.sessionTitle?.length ?? 0) +
            (e.sessionSummary?.length ?? 0) +
            (e.nudgeCandidate?.pattern?.length ?? 0)
          )
        }, 0)
        if (newLen <= MAX_TEXT_LENGTH) break
      }
    }

    // 空 batch（文本裁剪后）：dirty 为真但有效证据被裁空，记 insufficient 而非 clean
    if (batch.length === 0) {
      return this.recordAttempt(state, mode, 'skipped_insufficient_evidence', now)
    }

    // 计算紧凑确定性 batchId（SHA-256 派生，内部排序）
    const batchId = computeBatchId(
      mode,
      batch.map((e) => e.id)
    )

    // 获取全局 lease
    this.acquireGlobalLease(mode, now)

    try {
      // 执行一次 LLM 整理
      const rawOutput = await this.deps.executeConsolidation({
        evidence: batch,
        mode,
      })
      const output = sanitizeBatchOutput(rawOutput as unknown)
      const requestsUsed = 1

      // 构建 pending application record（在任何 apply 之前持久化）
      const lastEntry = batch[batch.length - 1]!
      const cursor = `${lastEntry.createdAt}_${lastEntry.id}`
      const uniqueSessions = new Set(batch.map((e) => e.sessionId))
      const pending: PendingApplication = {
        batchId,
        evidenceIds: batch.map((e) => e.id),
        cursor,
        output,
        counts: {
          inputSessions: uniqueSessions.size,
          inputEvidenceCount: batch.length,
          outputKeyFacts: output.sessionKeyFacts.reduce((s, item) => s + item.facts.length, 0),
          outputMemoryCandidates: output.memoryCandidates.length,
          outputInsights: output.insights.length,
          outputContradictions: output.contradictions.length,
        },
        createdAt: now,
      }
      state.pendingApplication = pending

      // Provider 请求计数：executor 成功 → +1
      state.requestsUsedToday = Math.min(
        state.requestsUsedToday + requestsUsed,
        MAX_REQUESTS_PER_DAY
      )
      state.lastAttemptTime = this.deps.now()
      this.saveState(mode, state)

      // 应用结果
      try {
        await this.deps.applyBatchOutput(output, mode, batchId)
      } catch (applyError) {
        state.lastOutcome = 'failed'
        state.lastErrorCode = applyError instanceof Error ? 'APPLY_FAILED' : 'UNKNOWN'
        state.retryAfter = now + RETRY_BACKOFF_MS
        this.saveState(mode, state)
        return {
          outcome: 'failed',
          requestsUsed,
          sessionsProcessed: 0,
          evidenceProcessed: batch.length,
          batchOutput: output,
        }
      }

      // 消费已处理证据
      try {
        const remaining = this.deps.consumeProcessedEvidence(mode, pending.evidenceIds)
        if (remaining === 0) {
          this.deps.markModeClean(mode)
        }
      } catch {
        state.lastOutcome = 'failed'
        state.lastErrorCode = 'CONSUME_FAILED'
        state.retryAfter = now + RETRY_BACKOFF_MS
        this.saveState(mode, state)
        return {
          outcome: 'failed',
          requestsUsed,
          sessionsProcessed: 0,
          evidenceProcessed: batch.length,
          batchOutput: output,
        }
      }

      // 全部成功：推进游标、更新计数、清理 pending
      state.pendingApplication = null
      state.cursor = pending.cursor
      state.lastSuccessTime = this.deps.now()
      state.lastBatchId = batchId
      state.lastOutcome = 'success'
      state.lastErrorCode = null
      state.retryAfter = null
      state.inputCounts = {
        sessions: pending.counts.inputSessions,
        evidenceCount: pending.counts.inputEvidenceCount,
      }
      state.outputCounts = {
        keyFacts: pending.counts.outputKeyFacts,
        memoryCandidates: pending.counts.outputMemoryCandidates,
        insights: pending.counts.outputInsights,
        contradictions: pending.counts.outputContradictions,
      }
      this.saveState(mode, state)

      return {
        outcome: 'success',
        requestsUsed,
        sessionsProcessed: pending.counts.inputSessions,
        evidenceProcessed: batch.length,
        batchOutput: output,
      }
    } catch (error) {
      // executor 抛错
      const isPreflight =
        error instanceof ConsolidationError && PREFLIGHT_ERROR_CODES.has(error.code)
      const requestsUsed = isPreflight ? 0 : 1

      state.lastAttemptTime = this.deps.now()
      state.lastOutcome = 'failed'
      state.lastErrorCode =
        error instanceof ConsolidationError
          ? error.code
          : error instanceof Error
            ? 'EXECUTION_FAILED'
            : 'UNKNOWN'
      if (requestsUsed > 0) {
        state.requestsUsedToday = Math.min(
          state.requestsUsedToday + requestsUsed,
          MAX_REQUESTS_PER_DAY
        )
      }
      state.retryAfter = now + RETRY_BACKOFF_MS
      this.saveState(mode, state)

      return {
        outcome: 'failed',
        requestsUsed,
        sessionsProcessed: 0,
        evidenceProcessed: batch.length,
        batchOutput: null,
      }
    } finally {
      this.releaseGlobalLease(mode)
    }
  }

  /**
   * 重放已持久化的 pending application（requestsUsed=0，不调用 executor）。
   *
   * 幂等性保证：apply 和 consume 都是幂等操作，重放不会重复写入。
   * 重放仍遵守前台互斥、退避和全局 lease 约束。
   */
  private async replayPending(
    mode: MemoryMode,
    state: ConsolidationState,
    now: number
  ): Promise<RunResult> {
    const pending = state.pendingApplication!

    this.acquireGlobalLease(mode, now)
    try {
      // 幂等重放：apply
      try {
        await this.deps.applyBatchOutput(pending.output, mode, pending.batchId)
      } catch (applyError) {
        state.lastAttemptTime = this.deps.now()
        state.lastOutcome = 'failed'
        state.lastErrorCode =
          applyError instanceof ConsolidationError ? applyError.code : 'APPLY_FAILED'
        state.retryAfter = now + RETRY_BACKOFF_MS
        this.saveState(mode, state)
        return {
          outcome: 'failed',
          requestsUsed: 0,
          sessionsProcessed: 0,
          evidenceProcessed: pending.evidenceIds.length,
          batchOutput: pending.output,
        }
      }

      // 幂等重放：consume 精确 ID
      try {
        const remaining = this.deps.consumeProcessedEvidence(mode, pending.evidenceIds)
        if (remaining === 0) {
          this.deps.markModeClean(mode)
        }
      } catch (err) {
        state.lastAttemptTime = this.deps.now()
        state.lastOutcome = 'failed'
        state.lastErrorCode = err instanceof ConsolidationError ? err.code : 'CONSUME_FAILED'
        state.retryAfter = now + RETRY_BACKOFF_MS
        this.saveState(mode, state)
        return {
          outcome: 'failed',
          requestsUsed: 0,
          sessionsProcessed: 0,
          evidenceProcessed: pending.evidenceIds.length,
          batchOutput: pending.output,
        }
      }

      // 全部成功：推进游标、更新计数、清理 pending
      state.pendingApplication = null
      state.cursor = pending.cursor
      state.lastSuccessTime = this.deps.now()
      state.lastBatchId = pending.batchId
      state.lastAttemptTime = this.deps.now()
      state.lastOutcome = 'success'
      state.lastErrorCode = null
      state.retryAfter = null
      state.inputCounts = {
        sessions: pending.counts.inputSessions,
        evidenceCount: pending.counts.inputEvidenceCount,
      }
      state.outputCounts = {
        keyFacts: pending.counts.outputKeyFacts,
        memoryCandidates: pending.counts.outputMemoryCandidates,
        insights: pending.counts.outputInsights,
        contradictions: pending.counts.outputContradictions,
      }
      this.saveState(mode, state)

      return {
        outcome: 'success',
        requestsUsed: 0,
        sessionsProcessed: pending.counts.inputSessions,
        evidenceProcessed: pending.counts.inputEvidenceCount,
        batchOutput: pending.output,
      }
    } finally {
      this.releaseGlobalLease(mode)
    }
  }

  // ===== 全局跨模式 Lease 管理 =====

  /**
   * 检查全局 lease 是否被持有（跨模式）。
   *
   * 读取共享 lease 文件，检查 holder 和过期时间。
   * 过期 lease 可回收（返回 false 表示可获取）。
   */
  private isGlobalLeaseHeld(now: number): boolean {
    const leasePath = this.deps.getLeasePath()
    try {
      if (fs.existsSync(leasePath)) {
        const content = fs.readFileSync(leasePath, 'utf-8')
        const lease = JSON.parse(content) as GlobalLeaseState
        if (lease.leaseUntil != null && now < lease.leaseUntil) {
          return true // lease still valid
        }
        // 过期 lease 可回收
        return false
      }
    } catch {
      // 文件损坏视为无 lease
    }
    return false
  }

  /** 获取全局 lease */
  private acquireGlobalLease(mode: MemoryMode, now: number): void {
    const leasePath = this.deps.getLeasePath()
    const dir = path.dirname(leasePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const lease: GlobalLeaseState = {
      holder: mode,
      leaseUntil: now + LEASE_DURATION_MS,
      acquiredAt: now,
    }
    fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2), 'utf-8')
  }

  /** 释放全局 lease */
  private releaseGlobalLease(mode: MemoryMode): void {
    const leasePath = this.deps.getLeasePath()
    try {
      if (fs.existsSync(leasePath)) {
        const content = fs.readFileSync(leasePath, 'utf-8')
        const lease = JSON.parse(content) as GlobalLeaseState
        // 只释放自己持有的 lease
        if (lease.holder === mode) {
          fs.writeFileSync(
            leasePath,
            JSON.stringify({ holder: null, leaseUntil: null, acquiredAt: null }, null, 2),
            'utf-8'
          )
        }
      }
    } catch {
      // 忽略
    }
  }

  /**
   * 检查 lease 是否仍在有效期内（公开供外部健康检查用）。
   */
  isLeaseHeld(mode: MemoryMode): boolean {
    const leasePath = this.deps.getLeasePath()
    try {
      if (fs.existsSync(leasePath)) {
        const content = fs.readFileSync(leasePath, 'utf-8')
        const lease = JSON.parse(content) as GlobalLeaseState
        if (lease.holder !== mode) return false
        if (lease.leaseUntil == null) return false
        return this.deps.now() < lease.leaseUntil
      }
    } catch {
      // 忽略
    }
    return false
  }

  // ===== 状态管理 =====

  private getOrCreateState(mode: MemoryMode): ConsolidationState {
    let state = this.states.get(mode)
    if (!state) {
      state = this.loadState(mode)
    }
    return state
  }

  private loadState(mode: MemoryMode): ConsolidationState {
    const existing = this.states.get(mode)
    if (existing) return existing

    const statePath = this.deps.getStatePath(mode)
    try {
      if (fs.existsSync(statePath)) {
        const content = fs.readFileSync(statePath, 'utf-8')
        const parsed = JSON.parse(content) as ConsolidationState
        // 向后兼容：补全新增可选字段，迁移旧版本
        if (parsed.version === undefined) parsed.version = 1
        if (parsed.retryAfter === undefined) parsed.retryAfter = null
        if (parsed.lastBatchId === undefined) parsed.lastBatchId = null
        if (parsed.pendingApplication === undefined) parsed.pendingApplication = null
        // v1 → v2 迁移：pendingApplication 字段新增；只默认为 null，
        // 不覆盖已有的 valid pending（可能持有 paid Provider 结果待重放）。
        if (parsed.version < 2) {
          parsed.version = 2
        }
        this.states.set(mode, parsed)
        return parsed
      }
    } catch {
      // 文件损坏，创建新状态
    }

    return this.createFreshState(mode)
  }

  private createFreshState(mode: MemoryMode): ConsolidationState {
    const state: ConsolidationState = {
      lastAttemptTime: null,
      lastSuccessTime: null,
      lastOutcome: null,
      lastErrorCode: null,
      cursor: null,
      requestsUsedToday: 0,
      budgetDate: todayStr(),
      leaseUntil: null,
      inputCounts: { sessions: 0, evidenceCount: 0 },
      outputCounts: { keyFacts: 0, memoryCandidates: 0, insights: 0, contradictions: 0 },
      version: 2,
      retryAfter: null,
      lastBatchId: null,
      pendingApplication: null,
    }
    this.states.set(mode, state)
    return state
  }

  private saveState(mode: MemoryMode, state: ConsolidationState): void {
    const statePath = this.deps.getStatePath(mode)
    const dir = path.dirname(statePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    // 原子写：temp + rename
    const tmpPath = statePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
    fs.renameSync(tmpPath, statePath)
    this.states.set(mode, state)
  }

  /**
   * 确保 budgetDate 与当天一致；跨天时重置请求计数。
   */
  private ensureBudgetDate(state: ConsolidationState, now: number): ConsolidationState {
    const today = todayStr(now)
    if (state.budgetDate !== today) {
      state.budgetDate = today
      state.requestsUsedToday = 0
    }
    return state
  }

  /** 记录一次 attempt（不执行整理），主要用于 skip 分支 */
  private recordAttempt(
    state: ConsolidationState,
    mode: MemoryMode,
    outcome: ConsolidationOutcome,
    now: number
  ): RunResult {
    state.lastAttemptTime = now
    state.lastOutcome = outcome
    // skipped 不改变 budget 或 cursor
    this.saveState(mode, state)

    return {
      outcome,
      requestsUsed: 0,
      sessionsProcessed: 0,
      evidenceProcessed: 0,
      batchOutput: null,
    }
  }

  /**
   * 获取当前状态（用于监控/UI）
   */
  getState(mode: MemoryMode): ConsolidationState {
    return { ...this.getOrCreateState(mode) }
  }

  /**
   * 清理内存状态（测试用）
   */
  clearStateCache(): void {
    this.states.clear()
  }

  /**
   * 清理全局 lease 文件（测试用）
   */
  clearGlobalLease(): void {
    const leasePath = this.deps.getLeasePath()
    try {
      if (fs.existsSync(leasePath)) {
        fs.writeFileSync(
          leasePath,
          JSON.stringify({ holder: null, leaseUntil: null, acquiredAt: null }, null, 2),
          'utf-8'
        )
      }
    } catch {
      // 忽略
    }
  }
}

// ===== 工具函数 =====

/** 获取今天的 YYYY-MM-DD 字符串 */
export function todayStr(now?: number): string {
  const d = now !== undefined ? new Date(now) : new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 过滤 cursor 之后的证据条目。
 *
 * cursor 格式: "createdAt_id"
 * 返回 createdAt > cursorCreatedAt 或在同 createdAt 时 id > cursorId 的条目。
 */
export function filterAfterCursor(
  entries: MemoryEvidenceEntry[],
  cursor: string
): MemoryEvidenceEntry[] {
  const [cursorTimeStr, cursorId] = cursor.split('_', 2)
  const cursorTime = Number(cursorTimeStr)
  if (isNaN(cursorTime)) return entries

  return entries.filter((e) => {
    if (e.createdAt > cursorTime) return true
    if (e.createdAt === cursorTime && cursorId) {
      return e.id > cursorId
    }
    return false
  })
}
