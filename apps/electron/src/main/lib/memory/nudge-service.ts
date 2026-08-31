/**
 * NudgeService - 记忆自进化 Nudge 机制
 *
 * Phase 2.1 从 TAgent_General 移植。路径改用 getMemoryDir（基于 getConfigDir()）。
 * 后台 LLM review（nudge-llm-review.ts）Desktop 未移植，暂 stub（见 runLLMReview）。
 *
 * 根据设计文档 §6.5.4 实现：
 * - 每 5 turn 检查用户行为模式
 * - 检测重复行为/事实/纠正
 * - 弹出提示询问用户是否记住
 *
 * 检测模式（2026-07-06 P0 临时止血后阈值）：
 * - 行为重复：同一行为 ≥5 次 → L0 (peer_view)
 * - 事实重复：同一事实 ≥3 次 → L2
 * - 显式纠正："不是 X，是 Y" → L3 raw（自动写）
 * - 项目重复：加载项目 ≥2 次相似 → L1
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { getWorkspaceById } from '../workspace/workspace-manager'
import { getProjectMemoryDir } from '../config/config-paths'
import { isLowQualityMemoryContent } from './memory-candidate-quality'
import { getMemoryDir, memoryLayerService, type MemoryMode } from './memory-layer-service'
import { readStageQueue } from './stage-queue-service'

// ===== 类型定义 =====

/** Nudge 类型 */
export type NudgeType = 'behavior_repeat' | 'fact_repeat' | 'correction' | 'project_repeat'
export type MemoryScope = 'global' | 'project'
export type MemoryRecordStatus = 'candidate' | 'pending_approval' | 'active' | 'rejected' | 'deferred'


/** Nudge 候选项 */
export interface NudgeCandidate {
  id: string
  type: NudgeType
  targetLayer: 'L0' | 'L1' | 'L2' | 'L3'
  pattern: string
  evidence: string[]
  suggestedContent: string
  userMessage: string // LLM 改写后的用户友好提示
  scope?: MemoryScope
  workspaceSlug?: string
  evidenceIds?: string[]
  status?: MemoryRecordStatus
}

/** Nudge 结果 */
export interface NudgeResult {
  accepted: boolean
  deferred: boolean
  rejected: boolean
}

/** 模式检测结果 */
interface PatternMatch {
  type: NudgeType
  pattern: string
  count: number
  evidence: string[]
}


function correctionEvidence(content: string): string {
  // 让 LLM 看到完整用户语句；不要把 regex 的局部命中直接当作记忆正文。
  return content.replace(/\s+/g, ' ').trim().slice(0, 240)
}

const PROJECT_TITLE_STOP_WORDS = new Set(['项目', '会话', '问题', '继续', '处理', '修复', '相关'])

function projectTitleTerms(title: string): Set<string> {
  const terms = new Set<string>()
  for (const part of title.toLocaleLowerCase().match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (/^[\u4e00-\u9fff]+$/.test(part)) {
      for (let i = 0; i < part.length - 1; i++) {
        const term = part.slice(i, i + 2)
        if (!PROJECT_TITLE_STOP_WORDS.has(term)) terms.add(term)
      }
    } else if (!PROJECT_TITLE_STOP_WORDS.has(part)) {
      terms.add(part)
    }
  }
  return terms
}

function hasRelatedProjectTitles(titles: string[]): boolean {
  const termSets = titles.map(projectTitleTerms)
  for (let i = 0; i < termSets.length; i++) {
    for (let j = i + 1; j < termSets.length; j++) {
      const left = termSets[i] ?? new Set<string>()
      const right = termSets[j] ?? new Set<string>()
      const overlap = [...left].filter((term) => right.has(term))
      if (overlap.length >= 2) return true
    }
  }
  return false
}
// ===== 配置 =====

/** 各层冷却 turn 数（2026-07-06 P0 临时止血：L0=10 / L1=20 / L2=10 / L3=30） */
const LAYER_COOLDOWN_TURNS: Record<string, number> = {
  L0: 10,
  L1: 20,
  L2: 10,
  L3: 30,
}

/**
 * 检测间隔 turn 数
 *
 * 2026-07-06 P0 临时止血：从 1 改回 5。
 * 2026-07-06 P2.3 warm-up：此常量保留作为"老会话固定间隔"，
 * 新会话用 warm-up 序列 1→2→4→8→10（见 getWarmUpThreshold）。
 */
const NUUDGE_CHECK_INTERVAL = 5

/**
 * warm-up 指数触发阈值序列（借鉴 TencentDB）
 *
 * 新会话早提取（1→2→4→8→10），老会话固定 10。
 * 第 N 次触发（1-indexed）的阈值：
 * - 1st: 1 turn
 * - 2nd: 2 turn（累计）
 * - 3rd: 4 turn
 * - 4th: 8 turn
 * - 5th+: 10 turn（固定）
 */
const WARMUP_THRESHOLDS = [1, 2, 4, 8, 10]
const MATURE_THRESHOLD = 10

/**
 * 获取下一次触发的累计 turn 阈值
 *
 * @param triggerCount 已触发次数（0 = 首次，1 = 第二次，...）
 * @returns 累计 turn 阈值
 */
function getWarmUpThreshold(triggerCount: number): number {
  if (triggerCount < WARMUP_THRESHOLDS.length) {
    return WARMUP_THRESHOLDS[triggerCount] ?? MATURE_THRESHOLD
  }
  // 进入成熟期后固定 10 轮一次
  const lastWarmup = WARMUP_THRESHOLDS[WARMUP_THRESHOLDS.length - 1] ?? MATURE_THRESHOLD
  return lastWarmup + (triggerCount - WARMUP_THRESHOLDS.length + 1) * MATURE_THRESHOLD
}

/** 每批最大候选数 */
const MAX_CANDIDATES_PER_BATCH = 3

/**
 * L1 索引层行数硬约束（P4.2，借鉴 GenericAgent L1 ≤30 行）
 *
 * L1 只放反直觉触发词（2-4 字），禁写机制/方法/步骤。
 * 超过此行数拒绝写入，需要用户清理后重试。
 */
const MAX_L1_LINES = 30

// ===== NudgeService =====

class NudgeService {
  /** 各会话的 turn 计数 */
  private sessionTurnCounts: Map<string, number> = new Map()

  /** 各会话的 review 触发次数（warm-up 用，决定下次触发的累计 turn 阈值） */
  private sessionTriggerCounts: Map<string, number> = new Map()

  /** 各会话的各层冷却计数 */
  private sessionLayerCooldowns: Map<string, Map<string, number>> = new Map()

  /** 待处理的 Nudge 候选项 */
  private pendingNudges: Map<string, NudgeCandidate[]> = new Map()

  /** Nudge 结果回调 */
  private nudgeCallbacks: Map<string, (nudge: NudgeCandidate, result: NudgeResult) => void> =
    new Map()

  /**
   * drift 检测用文件 hash 缓存（P3.2）
   *
   * 记录上次读取记忆文件时的 hash，写入前比对。
   * 如果 hash 变了，说明被外部改过（用户手动编辑 / 外部工具），
   * 备份当前文件到 nudges/drift_backup/ 后再覆盖。
   */
  private fileHashes: Map<string, string> = new Map()

  /**
   * turn_start 钩子 - 检测是否需要运行 Nudge
   *
   * @param sessionId 会话 ID
   * @param recentMessages 最近 5 turn 的消息
   * @param mode 记忆模式
   * @returns Nudge 候选项列表（可能为空）
   */
  onTurnStart(
    sessionId: string,
    recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
    mode: MemoryMode,
    workspaceSlug?: string
  ): NudgeCandidate[] {
    // 增加 turn 计数
    const currentTurn = (this.sessionTurnCounts.get(sessionId) || 0) + 1
    this.sessionTurnCounts.set(sessionId, currentTurn)

    // 减少各层冷却
    this.decrementCooldowns(sessionId)

    const userMsgs = recentMessages.filter((m) => m.role === 'user').map((m) => m.content)
    console.log(
      `[Nudge] onTurnStart: sessionId=${sessionId.slice(0, 8)}, turn=${currentTurn}, mode=${mode}, recentUserMsgs=${JSON.stringify(userMsgs.slice(-3))}`
    )

    // warm-up 指数触发（P2.3）：1→2→4→8→10→10... 替代固定间隔
    // 借鉴 TencentDB，让新会话早提取、老会话省成本
    const triggerCount = this.sessionTriggerCounts.get(sessionId) || 0
    const nextThreshold = getWarmUpThreshold(triggerCount)
    if (currentTurn < nextThreshold) {
      console.log(
        `[Nudge] 跳过：currentTurn ${currentTurn} < nextThreshold ${nextThreshold}（triggerCount=${triggerCount}）`
      )
      return []
    }

    // 达到阈值：递增 triggerCount + 记录证据到 evidence sink（ADR-0006 Phase 1）
    // 不再直接调用 LLM review，由后续空闲 MemoryConsolidationService 批量处理
    this.sessionTriggerCounts.set(sessionId, triggerCount + 1)
    console.log(
      `[Nudge] 达到阈值（第 ${triggerCount + 1} 次，threshold=${nextThreshold}），记录证据到 sink`
    )

    // 本地检测候选（不调用 LLM），达到阈值的候选写入 evidence sink
    const localCandidates = this.detectPatterns(recentMessages, mode)
    if (localCandidates.length > 0) {
      // fire-and-forget：同步检测候选，异步写入 evidence sink
      const candidatesToRecord = localCandidates
        .map((pattern) => this.createNudgeCandidate(pattern, workspaceSlug))
        .filter((c) => !this.isInCooldown(sessionId, c.targetLayer))

      if (candidatesToRecord.length > 0) {
        void import('./memory-evidence-sink')
          .then(({ memoryEvidenceSink }) => {
            for (const candidate of candidatesToRecord) {
              memoryEvidenceSink.writeNudgeEvidence(mode, sessionId, candidate)
            }
          })
          .catch((e) => {
            console.warn(`[Nudge] 写入 evidence sink 失败:`, e)
          })
      }
    }

    // 同步返回空（不立刻弹 toast），证据由空闲批次处理
    return []
  }

  /**
   * 后台 LLM review（P2.1，借鉴 Hermes Turn-based Nudge）
   *
   * TODO(2.2)：Desktop 未移植 nudge-llm-review.ts，本方法暂不接线；
   * 记忆证据统一走 evidence sink → 空闲 MemoryConsolidationService 批量整理。
   * 保留方法签名与 handleLLMReviewResult，接线时恢复。
   *
   * 详见 docs/plans/2026-07-06-silent-memory-research/TAgent_Memory_Master_Design.md §3.2
   */
  private async runLLMReview(
    sessionId: string,
    recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
    mode: MemoryMode
  ): Promise<void> {
    console.log(
      `[Nudge] LLM review 未接线（Desktop 2.1 未移植 nudge-llm-review），跳过 sessionId=${sessionId.slice(0, 8)} mode=${mode}`
    )
    void recentMessages
  }

  /**
   * 处理 LLM review 结果
   *
   * - nothing → 什么都不做
   * - save → 创建 NudgeCandidate + 走原 pendingNudges 路径弹 toast
   *   （P2.2 将改为走 stage 队列，不立刻弹 toast）
   */
  private async handleLLMReviewResult(
    sessionId: string,
    mode: MemoryMode,
    result: {
      action: 'nothing' | 'save'
      items?: Array<{ type: string; content: string; targetLayer: string }>
    },
    recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<void> {
    if (result.action !== 'save' || !result.items || result.items.length === 0) {
      console.log(`[Nudge] LLM review: Nothing to save`)
      return
    }

    console.log(
      `[Nudge] LLM review: 值得记 ${result.items.length} 项: ${JSON.stringify(result.items)}`
    )

    // 转换为 NudgeCandidate
    const candidates: NudgeCandidate[] = result.items
      .slice(0, MAX_CANDIDATES_PER_BATCH)
      .map((item) => ({
        id: `nudge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: (item.type === 'behavior'
          ? 'behavior_repeat'
          : item.type === 'correction'
            ? 'correction'
            : 'fact_repeat') as NudgeType,
        targetLayer: (item.targetLayer === 'L0'
          ? 'L0'
          : item.targetLayer === 'L3'
            ? 'L3'
            : 'L2') as 'L0' | 'L1' | 'L2' | 'L3',
        pattern: item.content,
        evidence: recentMessages
          .filter((m) => m.role === 'user')
          .map((m) => m.content.slice(0, 100)),
        suggestedContent: item.content,
        userMessage: `LLM 审查建议记忆：${item.content}`,
      }))

    if (candidates.length === 0) {
      return
    }

    // 过滤冷却中的层
    const filtered = candidates.filter((c) => {
      const inCooldown = this.isInCooldown(sessionId, c.targetLayer)
      if (inCooldown) {
        console.log(`[Nudge] 候选 ${c.type}（${c.targetLayer}）在冷却中，过滤掉`)
      }
      return !inCooldown
    })

    if (filtered.length === 0) {
      return
    }

    // P2.2 写入门控三态：background nudge → stage 队列（不立刻弹 toast）
    // 用户可在记忆页面批量 accept/reject
    const { enqueueStage } = await import('./stage-queue-service')
    for (const candidate of filtered) {
      enqueueStage(mode, candidate)
    }

    // 缓存候选项（兼容旧 toast 路径，P2.2 后 toast 不再触发）
    this.pendingNudges.set(sessionId, filtered)
    console.log(`[Nudge] ${filtered.length} 项候选已入 stage 队列（不弹 toast，等待用户批量审批）`)
  }

  /**
   * 检测模式
   */
  private detectPatterns(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    mode: MemoryMode
  ): PatternMatch[] {
    const patterns: PatternMatch[] = []
    const userMessages = messages.filter((m) => m.role === 'user').map((m) => m.content)

    // 1. 检测行为重复（同一表述 ≥3 次）
    const behaviorPatterns = this.detectBehaviorRepeat(userMessages)
    patterns.push(...behaviorPatterns)

    // 2. 检测事实重复（跨 session 检测需要历史数据，这里简化为当前 session 内 ≥2 次）
    const factPatterns = this.detectFactRepeat(userMessages, mode)
    patterns.push(...factPatterns)

    // 3. 检测显式纠正（"不是 X，是 Y"）
    const correctionPatterns = this.detectCorrections(messages)
    patterns.push(...correctionPatterns)

    // 4. 检测项目重复（同一 workspace_slug 下 ≥2 个会话 → 候选 L1）
    const projectPatterns = this.detectProjectRepeat(mode)
    patterns.push(...projectPatterns)

    return patterns
  }

  /**
   * 检测项目重复
   *
   * 需要至少 3 个历史会话，且标题之间有主题重叠，才生成候选 L1。
   *
   * 实现：读 L4 最近 50 个会话，按 workspace_slug 分组，
   * 仅凭“打开过同一 workspace”不足以形成项目记忆。
   *
   * 跨 session 检测——与 fact_repeat / behavior_repeat（当前 session 内检测）不同，
   * project_repeat 依赖 L4 历史数据，是真正的跨会话记忆。
   */
  private detectProjectRepeat(mode: MemoryMode): PatternMatch[] {
    const patterns: PatternMatch[] = []

    try {
      const sessions = memoryLayerService.listRecentSessions(mode, 50)
      if (sessions.length < 2) return patterns

      // 已处理过的 workspace（用户点过"记住"或"不记"）不再触发
      const handledSlugs = this.loadHandledProjects(mode)

      // 按 workspace_slug 分组（跳过 null + 跳过已处理）
      const byWorkspace = new Map<string, typeof sessions>()
      for (const s of sessions) {
        if (!s.workspace_slug) continue
        if (handledSlugs.has(s.workspace_slug)) continue
        const arr = byWorkspace.get(s.workspace_slug) ?? []
        arr.push(s)
        byWorkspace.set(s.workspace_slug, arr)
      }

      // 同一 workspace ≥2 个会话 → 候选（正文用人可读项目名，不把 sanitizePath slug 当记忆）
      for (const [slug, group] of byWorkspace) {
        if (group.length < 3) continue

        const titles = group
          .map((s) => s.title || '')
          .filter(Boolean)
          .slice(0, 5) // 证据最多 5 条
        if (titles.length === 0) continue
        if (!hasRelatedProjectTitles(titles)) continue

        const label = this.resolveProjectLabel(slug)
        patterns.push({
          type: 'project_repeat',
          pattern: label,
          count: group.length,
          evidence: [`workspace:${slug}`, ...titles],
        })
      }
    } catch (e) {
      console.warn('[Nudge] detectProjectRepeat 失败:', e)
    }

    return patterns
  }

  /**
   * workspace slug → 人可读项目名（优先 workspace-meta.name，否则 basename / 去盘符前缀）。
   */
  private resolveProjectLabel(slug: string): string {
    try {
      const ws = getWorkspaceById(slug)
      const name = ws?.name?.trim()
      if (name) return name
      if (ws?.projectDirectory) {
        const base = path.basename(ws.projectDirectory)
        if (base) return base
      }
    } catch {
      // workspace-meta 缺失时走 fallback
    }
    // F--TAgent-Desktop → TAgent-Desktop
    const m = slug.match(/^[A-Za-z]--(.+)$/)
    if (m?.[1]) return m[1]
    return slug
  }

  /**
   * 加载已处理过的 project workspace slug 集合
   *
   * 用户点过"记住"（写入 L1_project.md）或"不记"（写入 nudges/rejected.jsonl）
   * 的 workspace，不再重复触发 project_repeat Nudge。
   * 已在 pending_approval 队列中的项目同样视为已处理，避免每晚 consolidation 再堆一条。
   *
   * 跨 session 持久化——与 L0/L1/L2/L3 冷却（按 sessionId 隔离）不同，
   * project_repeat 是跨 session 检测，已处理的 workspace 应该永久跳过。
   */
  private loadHandledProjects(mode: MemoryMode): Set<string> {
    const handled = new Set<string>()
    const handledLabels = new Set<string>()
    const dir = getMemoryDir(mode)

    // 1. 从 L1_project.md 读已存为模板的 workspace slug
    //    （L1 写入格式：`- [日期] 内容 <!-- ... src:slug8 -->`，但 pattern 字段就是 slug）
    const l1Path = path.join(dir, 'L1_project.md')
    if (fs.existsSync(l1Path)) {
      try {
        const content = fs.readFileSync(l1Path, 'utf-8')
        const lines = content.split('\n').filter((l) => l.startsWith('- '))
        for (const line of lines) {
          // 提取 src:xxx 元数据，或回退到整行包含 slug
          const srcMatch = line.match(/src:([^\s>]+)/)
          if (srcMatch) {
            handled.add(srcMatch[1]!)
          }
        }
      } catch {
        // 忽略读取失败
      }
    }

    // 2. 从 nudges/rejected.jsonl 读已拒绝的 project_repeat
    const rejectedPath = path.join(dir, 'nudges', 'rejected.jsonl')
    if (fs.existsSync(rejectedPath)) {
      try {
        const content = fs.readFileSync(rejectedPath, 'utf-8')
        const lines = content.split('\n').filter((l) => l.trim())
        for (const line of lines) {
          try {
            const record = JSON.parse(line) as { type?: string; pattern?: string }
            if (record.type === 'project_repeat' && record.pattern) {
              handled.add(record.pattern)
              handledLabels.add(record.pattern)
            }
          } catch {
            // 跳过无法解析的行
          }
        }
      } catch {
        // 忽略读取失败
      }
    }

    // 3. 已在 stage 队列中的项目：按 workspace:slug 证据或历史裸 slug pattern 标记
    try {
      for (const entry of readStageQueue(mode)) {
        if (entry.type !== 'project_repeat') continue
        handledLabels.add(entry.pattern)
        if (/^[A-Za-z]--/.test(entry.pattern)) {
          handled.add(entry.pattern)
        }
        for (const ev of entry.evidence) {
          if (ev.startsWith('workspace:')) {
            handled.add(ev.slice('workspace:'.length))
          }
        }
      }
    } catch {
      // 忽略 stage 读取失败
    }

    // 4. 人可读标签 → slug（rejected / pending 写的是项目名时）
    try {
      const sessions = memoryLayerService.listRecentSessions(mode, 50)
      for (const s of sessions) {
        if (!s.workspace_slug) continue
        const label = this.resolveProjectLabel(s.workspace_slug)
        if (handledLabels.has(label) || handled.has(label)) {
          handled.add(s.workspace_slug)
        }
      }
    } catch {
      // 忽略
    }

    return handled
  }

  /**
   * 检测行为重复
   */
  private detectBehaviorRepeat(userMessages: string[]): PatternMatch[] {
    const patterns: PatternMatch[] = []

    // 提取用户偏好表述
    const preferencePatterns = [
      /不要[^\s]{2,10}/g, // "不要 emoji"
      /用[^\s]{2,10}不用[^\s]{2,10}/g, // "用中文不用英文"
      /保持[^\s]{2,10}/g, // "保持简洁"
    ]

    for (const regex of preferencePatterns) {
      const matches = new Map<string, Map<number, string>>()

      for (let messageIndex = 0; messageIndex < userMessages.length; messageIndex++) {
        const msg = userMessages[messageIndex] ?? ''
        const found = msg.match(regex)
        if (found) {
          for (const match of found) {
            const evidence = matches.get(match) || new Map<number, string>()
            evidence.set(messageIndex, msg.slice(0, 100))
            matches.set(match, evidence)
          }
        }
      }

      // ≥5 次的行为作为候选（2026-07-06 P0 临时止血：从 ≥2 改到 ≥5）
      for (const [pattern, evidenceByMessage] of matches) {
        if (evidenceByMessage.size >= 5) {
          const evidence = [...evidenceByMessage.values()]
          patterns.push({
            type: 'behavior_repeat',
            pattern,
            count: evidenceByMessage.size,
            evidence,
          })
        }
      }
    }

    return patterns
  }

  /**
   * 检测事实重复
   */
  private detectFactRepeat(userMessages: string[], _mode: MemoryMode): PatternMatch[] {
    const patterns: PatternMatch[] = []

    // 提取事实性表述（包含"是"、"叫"、"在"等）
    const factPatterns = [
      /我[的之][^\s]{1,20}是[^\s]{1,20}/g, // "我的名字是 Frank"
      /(名字|邮箱|账号|地址|性别|年龄|职业|公司|学校|专业)[^\s]{0,5}[是为][^\s]{1,20}/g, // "名字是 Frank"
      /我叫[^\s]{1,20}/g, // "我叫 Frank"
      /我是[^\s]{1,20}/g, // "我是 Frank"
      /我喜欢[^\s]{1,20}/g, // "我喜欢简洁"
      /我爱[^\s]{1,20}/g, // "我爱吃火锅"
      /我用[^\s]{1,20}/g, // "我用 Mac"
      /我在[^\s]{1,20}/g, // "我在北京"
    ]

    for (const regex of factPatterns) {
      const matches = new Map<string, Map<number, string>>()

      for (let messageIndex = 0; messageIndex < userMessages.length; messageIndex++) {
        const msg = userMessages[messageIndex] ?? ''
        const found = msg.match(regex)
        if (found) {
          for (const match of found) {
            const evidence = matches.get(match) || new Map<number, string>()
            evidence.set(messageIndex, msg.slice(0, 100))
            matches.set(match, evidence)
          }
        }
      }

      // ≥3 次的事实作为候选（2026-07-06 P0 临时止血：从 ≥1 改到 ≥3）
      for (const [pattern, evidenceByMessage] of matches) {
        if (evidenceByMessage.size >= 3) {
          const evidence = [...evidenceByMessage.values()]
          patterns.push({
            type: 'fact_repeat',
            pattern,
            count: evidenceByMessage.size,
            evidence,
          })
        }
      }
    }

    return patterns
  }

  /**
   * 检测显式纠正
   */
  private detectCorrections(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): PatternMatch[] {
    const patterns: PatternMatch[] = []

    // 检测纠正模式
    const correctionPatterns = [
      /不是[^\s]{1,20}[,，是][^\s]{1,20}/g, // "不是 X，是 Y"
      /不对[，,]?应该是/g, // "不对，应该是"
      /改[成变为][^\s]{1,20}/g, // "改成 X"
    ]

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg || msg.role !== 'user') continue

      for (const regex of correctionPatterns) {
        const found = msg.content.match(regex)
        if (found) {
          // 找到对应的 assistant 消息作为上下文
          let context = ''
          const prevMsg = messages[i - 1]
          if (i > 0 && prevMsg && prevMsg.role === 'assistant') {
            context = prevMsg.content.slice(0, 200)
          }

          for (const match of found) {
            const content = correctionEvidence(msg.content)
            if (!match) continue
            if (isLowQualityMemoryContent(content, { type: 'correction', targetLayer: 'L3' })) {
              continue
            }
            patterns.push({
              type: 'correction',
              pattern: content,
              count: 1,
              evidence: [context ? `AI: ${context}` : '', `用户: ${content}`],
            })
          }
        }
      }
    }

    return patterns
  }

  /**
   * 获取类型对应的层
   */
  private getLayerForType(type: NudgeType): 'L0' | 'L1' | 'L2' | 'L3' {
    switch (type) {
      case 'behavior_repeat':
        return 'L0'
      case 'project_repeat':
        return 'L1'
      case 'fact_repeat':
        return 'L2'
      case 'correction':
        return 'L3'
    }
  }

  /**
   * 创建 Nudge 候选项
   */
  private createNudgeCandidate(pattern: PatternMatch, workspaceSlug?: string): NudgeCandidate {
    const id = `${pattern.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const targetLayer = this.getLayerForType(pattern.type)

    // 生成用户友好的提示（简化版，生产环境应调用 LLM）
    const userMessage = this.generateUserMessage(pattern)

    return {
      id,
      type: pattern.type,
      targetLayer,
      pattern: pattern.pattern,
      evidence: pattern.evidence,
      suggestedContent: pattern.pattern,
      userMessage,
      scope: workspaceSlug ? 'project' : 'global',
      workspaceSlug,
      evidenceIds: [id],
      status: 'candidate',
    }
  }

  /**
   * 生成用户提示（简化版）
   */
  private generateUserMessage(pattern: PatternMatch): string {
    switch (pattern.type) {
      case 'behavior_repeat':
        return `我注意到你多次提到"${pattern.pattern}"，要我记住这个偏好吗？`
      case 'fact_repeat':
        return `我看到你反复提到"${pattern.pattern}"，要我存为长期事实吗？`
      case 'correction':
        return `我把你这次的纠正记下来了`
      case 'project_repeat':
        return `你在「${pattern.pattern}」项目下有过 ${pattern.count} 次会话，要我存为项目模板吗？`
    }
  }

  /**
   * 检查层是否在冷却中
   */
  private isInCooldown(sessionId: string, layer: 'L0' | 'L1' | 'L2' | 'L3'): boolean {
    const cooldowns = this.sessionLayerCooldowns.get(sessionId)
    if (!cooldowns) return false
    return (cooldowns.get(layer) || 0) > 0
  }

  /**
   * 减少各层冷却计数
   */
  private decrementCooldowns(sessionId: string): void {
    const cooldowns = this.sessionLayerCooldowns.get(sessionId)
    if (!cooldowns) return

    for (const [layer, count] of cooldowns) {
      if (count > 0) {
        cooldowns.set(layer, count - 1)
      }
    }
  }

  /**
   * 设置层冷却
   */
  private setCooldown(sessionId: string, layer: 'L0' | 'L1' | 'L2' | 'L3'): void {
    let cooldowns = this.sessionLayerCooldowns.get(sessionId)
    if (!cooldowns) {
      cooldowns = new Map()
      this.sessionLayerCooldowns.set(sessionId, cooldowns)
    }
    const turns = LAYER_COOLDOWN_TURNS[layer] ?? 5
    cooldowns.set(layer, turns)
  }

  /**
   * 获取指定会话待处理的 Nudge 候选项
   *
   * 由 IPC `GET_PENDING_NUDGES` 通道调用，供 UI（如设置页"待处理记忆"列表）拉取。
   * 主流程仍走事件推送（onTurnStart → memory:nudge-event），此方法仅作拉取兜底。
   */
  getPendingNudges(sessionId: string): NudgeCandidate[] {
    return this.pendingNudges.get(sessionId) ?? []
  }

  /**
   * 处理用户对 Nudge 的响应
   *
   * @param sessionId 会话 ID
   * @param nudgeId Nudge ID
   * @param action 用户操作：'accept' | 'reject' | 'defer'
   * @param mode 记忆模式
   */
  async handleNudgeResponse(
    sessionId: string,
    nudgeId: string,
    action: 'accept' | 'reject' | 'defer',
    mode: MemoryMode
  ): Promise<void> {
    const candidates = this.pendingNudges.get(sessionId)
    if (!candidates) return

    const nudge = candidates.find((c) => c.id === nudgeId)
    if (!nudge) return

    const result: NudgeResult = {
      accepted: action === 'accept',
      deferred: action === 'defer',
      rejected: action === 'reject',
    }

    // 设置冷却（无论用户如何选择）
    this.setCooldown(sessionId, nudge.targetLayer)

    if (action === 'accept') {
      // 写入对应层
      await this.writeToLayer(nudge, mode)
    } else if (action === 'reject') {
      // 记录拒绝，防止重复弹
      await this.recordRejection(nudge, mode)
    } else if (action === 'defer') {
      // 记录延后，下个周期再问
      await this.recordDeferral(nudge, mode)
    }

    // 从待处理列表移除
    const remaining = candidates.filter((c) => c.id !== nudgeId)
    if (remaining.length > 0) {
      this.pendingNudges.set(sessionId, remaining)
    } else {
      this.pendingNudges.delete(sessionId)
    }

    // 触发回调
    const callback = this.nudgeCallbacks.get(sessionId)
    if (callback) {
      callback(nudge, result)
    }
  }

  /**
   * 写入对应层
   *
   * 禁易变状态白名单校验（P4.3，借鉴 GenericAgent "禁止存储易变状态"公理）：
   * - 严禁存储：时间戳 / PID / 临时 SessionID / 具体绝对路径 / 连接设备信息
   * - 校验失败 → 拒绝写入 + 日志告知
   */
  private async writeToLayer(nudge: NudgeCandidate, mode: MemoryMode): Promise<void> {
    // P4.3 禁易变状态白名单校验
    const violation = this.checkVolatileState(nudge.suggestedContent)
    if (violation !== null) {
      console.warn(
        `[Nudge] 禁易变状态校验失败（${violation}），拒绝写入: ${nudge.suggestedContent.slice(0, 50)}`
      )
      return
    }

    const dir = getMemoryDir(mode)

    switch (nudge.targetLayer) {
      case 'L0':
        // L0 用户画像 - 追加到 peer_view
        await this.appendMdFileWithDedup(path.join(dir, 'L0_user.md'), 'peer_view', nudge)
        break
      case 'L1': {
        // L1 项目画像 + 索引层（P4.2 ≤30 行硬约束）
        const l1Dir = nudge.workspaceSlug ? getProjectMemoryDir(nudge.workspaceSlug) : dir
        const l1Path = path.join(l1Dir, 'L1_project.md')
        if (fs.existsSync(l1Path)) {
          const l1Content = fs.readFileSync(l1Path, 'utf-8')
          const l1Lines = l1Content
            .split('\n')
            .filter(
              (l) => l.trim() && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('>')
            ).length
          if (l1Lines >= MAX_L1_LINES) {
            console.warn(
              `[Nudge] L1 索引层行数约束：当前 ${l1Lines} 行 >= ${MAX_L1_LINES} 行硬约束，拒绝写入。请清理 L1 后重试。`
            )
            break
          }
        }
        await this.appendMdFileWithDedup(l1Path, 'project', nudge)
        break
      }
      case 'L2':
        // L2 稳定事实
        await this.appendMdFileWithDedup(path.join(dir, 'L2_facts.md'), 'fact', nudge)
        break
      case 'L3':
        // L3 纠错记录 - 追加到 corrections.jsonl
        const correctionDir = nudge.scope === 'project' && nudge.workspaceSlug
          ? getProjectMemoryDir(nudge.workspaceSlug)
          : dir
        await this.appendCorrection(correctionDir, nudge)
        break
    }
  }

  /**
   * 禁易变状态白名单校验（P4.3）
   *
   * 检查写入内容是否包含以下禁止存储的内容：
   * - 时间戳（ISO 8601 / Unix timestamp）
   * - PID（进程 ID，纯数字 4-6 位）
   * - 临时 SessionID（UUID 格式）
   * - 具体绝对路径（/Users/... 或 /home/... 或 C:\...）
   * - 连接设备信息（IP 地址 / MAC 地址 / 端口号）
   *
   * 返回违反类型（字符串），无违反返回 null。
   */
  private checkVolatileState(content: string): string | null {
    // 时间戳（ISO 8601：2026-07-06T12:34:56 / Unix timestamp：1719999999）
    if (/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(content)) return 'ISO 8601 时间戳'
    if (/\b1[67]\d{8}\b/.test(content)) return 'Unix 时间戳'

    // PID（4-6 位纯数字，排除常见非 PID 数字）
    if (/\bpid[:\s]*\d{4,6}\b/i.test(content)) return 'PID'

    // 临时 SessionID（UUID 格式：8-4-4-4-12）
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(content))
      return '临时 SessionID (UUID)'

    // 具体绝对路径（macOS/Linux /Users/... /home/... 或 Windows C:\... D:\...）
    if (/(\/Users\/|\/home\/|\/tmp\/)[^\s]{5,}/.test(content)) return '绝对路径 (macOS/Linux)'
    if (/[A-Z]:\\[^\s]{5,}/.test(content)) return '绝对路径 (Windows)'

    // 连接设备信息（IP 地址）
    if (/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d{1,5})?\b/.test(content)) return 'IP 地址'

    // MAC 地址
    if (
      /\b[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}\b/i.test(content)
    )
      return 'MAC 地址'

    return null
  }

  /**
   * Stage 队列条目写入对应层（P2.2，公开方法供 IPC 调用）
   *
   * 用户在记忆页面点 accept 后，IPC 处理器调此方法。
   * 复用 writeToLayer 的 patch-only + 去重逻辑。
   */
  async writeStageEntryToLayer(
    entry: {
      type: NudgeType
      targetLayer: 'L0' | 'L1' | 'L2' | 'L3'
      pattern: string
      evidence: string[]
      suggestedContent: string
      userMessage: string
      scope?: MemoryScope
      workspaceSlug?: string
      evidenceIds?: string[]
      status?: MemoryRecordStatus
    },
    mode: MemoryMode
  ): Promise<void> {
    const nudge: NudgeCandidate = {
      id: `stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: entry.type,
      targetLayer: entry.targetLayer,
      pattern: entry.pattern,
      evidence: entry.evidence,
      suggestedContent: entry.suggestedContent,
      userMessage: entry.userMessage,
      scope: entry.scope,
      workspaceSlug: entry.workspaceSlug,
      evidenceIds: entry.evidenceIds ?? [entry.pattern],
      status: entry.status ?? 'active',
    }
    await this.writeToLayer(nudge, mode)
  }

  /**
   * 追加内容到 Markdown 文件（带去重 + 结构化元数据）
   *
   * v1.5 升级（hermes-borrow-plan §5.2 修复 3）：
   * - 格式：`- [日期] 内容 <!-- hit:N last_ref:YYYY-MM-DD src:session8 -->`
   * - 去重：pattern 已存在则更新 hit_count + last_referenced_at，不重复写
   * - 元数据用 HTML 注释，markdown 渲染器忽略，人类仍可读
   * - 供 LRU / Self-Repair 使用
   *
   * Patch-only 原则（v1.5 新增，借鉴 GenericAgent "神圣不可删改 + 只 patch 不 overwrite"）：
   * - 新增条目：appendFile 追加单行（不覆盖整文件）
   * - 更新 hit_count：read full → 单行 string.replace → write back（语义上是行级 patch）
   * - 创建文件：写 header + 首行（仅当文件不存在时）
   * - 严禁整文件 overwrite 已有内容（会丢失用户手编辑的条目）
   *
   * drift 检测（P3.2，借鉴 Hermes）：
   * - 写入前读取文件时记录 hash
   * - 更新 hit_count 时比对 hash，如果变了说明被外部改过（用户手动编辑 / 外部工具）
   * - 备份当前文件到 nudges/drift_backup/ 后再覆盖
   */
  private async appendMdFileWithDedup(
    filePath: string,
    section: string,
    nudge: NudgeCandidate
  ): Promise<void> {
    const timestamp = new Date().toISOString().slice(0, 10)
    const content = nudge.suggestedContent
    const sourceSession = nudge.evidence[0]?.slice(0, 8) ?? ''

    if (!fs.existsSync(filePath)) {
      // 创建新文件（header + 首行）
      const line = this.formatMemoryLine(timestamp, content, 1, timestamp, sourceSession, nudge)
      const header = `# ${section}\n\n${line}\n`
      await fs.promises.writeFile(filePath, header, 'utf-8')
      // 记录 hash
      this.fileHashes.set(filePath, this.computeFileHash(header))
      return
    }

    // 读现有内容
    const existing = await fs.promises.readFile(filePath, 'utf-8')
    const dedupResult = this.findExistingLine(existing, content)

    if (dedupResult.found && dedupResult.line) {
      // drift 检测：更新 hit_count 前，比对文件 hash 是否被外部改过
      const currentHash = this.computeFileHash(existing)
      const cachedHash = this.fileHashes.get(filePath)
      if (cachedHash !== undefined && cachedHash !== currentHash) {
        // drift 检测：文件被外部改过，备份当前文件后覆盖
        console.warn(
          `[Nudge] drift 检测：${filePath} 被外部修改（hash 变化），备份到 drift_backup/`
        )
        await this.backupDriftFile(filePath)
      }

      // 单行 patch 更新 hit_count + last_referenced_at
      const updatedLine = this.bumpHitCount(dedupResult.line, timestamp, sourceSession)
      const newContent = existing.replace(dedupResult.line, updatedLine)
      // Patch-only invariant 校验：新内容必须保留原有所有行（除了被 patch 的那一行）
      const existingLineCount = existing.split('\n').length
      const newLineCount = newContent.split('\n').length
      if (newLineCount !== existingLineCount) {
        console.error(
          `[Nudge] patch-only invariant 违反：行数从 ${existingLineCount} 变为 ${newLineCount}，拒绝写入（防止丢内容）`
        )
        return
      }
      await fs.promises.writeFile(filePath, newContent, 'utf-8')
      // 更新 hash
      this.fileHashes.set(filePath, this.computeFileHash(newContent))
      console.log(`[Nudge] 去重更新：pattern="${content.slice(0, 30)}..." hit_count 增加`)
    } else {
      // 新增：appendFile 追加单行（patch 语义，不动现有内容）
      const line = this.formatMemoryLine(timestamp, content, 1, timestamp, sourceSession, nudge)
      await fs.promises.appendFile(filePath, line + '\n', 'utf-8')
      // 更新 hash（读文件重新计算，因为 appendFile 后文件内容变了）
      const updated = await fs.promises.readFile(filePath, 'utf-8')
      this.fileHashes.set(filePath, this.computeFileHash(updated))
    }
  }

  /**
   * drift 检测辅助：计算文件内容 hash（P3.2）
   *
   * 用简单字符串 hash（非加密），足够检测外部篡改。
   */
  private computeFileHash(content: string): string {
    // 简单 DJB2 hash，64-bit，足够检测内容变化
    let hash = 5381n
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5n) + hash + BigInt(content.charCodeAt(i))) & 0xffffffffn
    }
    return hash.toString(16)
  }

  /**
   * drift 检测辅助：备份文件到 nudges/drift_backup/（P3.2）
   *
   * 文件名格式：{原文件名}.{timestamp}.bak
   * 保留最近 10 个备份（防止无限堆积）。
   */
  private async backupDriftFile(filePath: string): Promise<void> {
    try {
      const dir = path.dirname(filePath)
      const backupDir = path.join(dir, 'nudges', 'drift_backup')
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true })
      }

      const fileName = path.basename(filePath)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = path.join(backupDir, `${fileName}.${timestamp}.bak`)

      const content = await fs.promises.readFile(filePath, 'utf-8')
      await fs.promises.writeFile(backupPath, content, 'utf-8')
      console.log(`[Nudge drift] 备份 ${fileName} → ${backupPath}`)

      // 保留最近 10 个备份（清理旧的）
      const backups = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith(fileName + '.') && f.endsWith('.bak'))
        .sort()
      while (backups.length > 10) {
        const oldest = backups.shift()
        if (oldest) {
          fs.unlinkSync(path.join(backupDir, oldest))
        }
      }
    } catch (e) {
      console.warn(`[Nudge drift] 备份失败:`, e)
    }
  }

  /**
   * 格式化记忆行（带结构化元数据注释）
   */
  private formatMemoryLine(
    date: string,
    content: string,
    hitCount: number,
    lastRef: string,
    sourceSession: string,
    nudge?: NudgeCandidate,
  ): string {
    const metadata = [
      `hit:${hitCount}`,
      `last_ref:${lastRef}`,
      `src:${sourceSession}`,
      `scope:${nudge?.scope ?? 'global'}`,
      nudge?.workspaceSlug ? `workspace:${encodeURIComponent(nudge.workspaceSlug)}` : '',
      `status:${nudge?.status ?? 'active'}`,
    ]
      .filter(Boolean)
      .join(' ')
    return `- [${date}] ${content} <!-- ${metadata} -->`
  }

  /**
   * 在现有 .md 内容中查找已存在相同 pattern 的行
   *
   * 匹配规则：行包含 pattern 文本（去除元数据注释后比较）
   */
  private findExistingLine(content: string, pattern: string): { found: boolean; line?: string } {
    const lines = content.split('\n')
    for (const line of lines) {
      if (!line.startsWith('- ')) continue
      // 去掉 HTML 注释后的纯文本
      const textOnly = line.replace(/<!--.*?-->/, '').trim()
      if (textOnly.includes(pattern)) {
        return { found: true, line }
      }
    }
    return { found: false }
  }

  /**
   * 增加 hit_count + 更新 last_referenced_at
   */
  private bumpHitCount(line: string, newDate: string, sourceSession: string): string {
    const match = line.match(/<!-- hit:(\d+) last_ref:([^ ]+) src:([^ ]*)(?: [^>]*)? -->/)
    if (!match) {
      // 老格式行（无元数据），补上元数据
      const textOnly = line.replace(/<!--.*?-->/, '').trim()
      return `${textOnly} <!-- hit:2 last_ref:${newDate} src:${sourceSession} scope:global status:active -->`
    }
    const currentHit = parseInt(match[1] ?? '1', 10)
    const newHit = currentHit + 1
    return line.replace(
      /<!-- hit:\d+ last_ref:[^ ]+ src:[^ ]*/,
      `<!-- hit:${newHit} last_ref:${newDate} src:${sourceSession}`
    )
  }

  /**
   * 追加纠正记录
   */
  private async appendCorrection(dir: string, nudge: NudgeCandidate): Promise<void> {
    const filePath = path.join(dir, 'corrections.jsonl')
    const record = {
      timestamp: Date.now(),
      correction: nudge.suggestedContent,
      context: nudge.evidence.join('\n'),
      scope: nudge.scope ?? 'global',
      workspaceSlug: nudge.workspaceSlug,
      status: 'active',
      evidenceIds: nudge.evidenceIds ?? [nudge.id],
      sourceSession: nudge.evidence[0]?.slice(0, 8) ?? '',
    }
    const line = JSON.stringify(record) + '\n'

    if (!fs.existsSync(filePath)) {
      await fs.promises.writeFile(filePath, line, 'utf-8')
    } else {
      await fs.promises.appendFile(filePath, line, 'utf-8')
    }
  }

  /**
   * 记录拒绝
   */
  private async recordRejection(nudge: NudgeCandidate, mode: MemoryMode): Promise<void> {
    const dir = getMemoryDir(mode)
    const filePath = path.join(dir, 'nudges', 'rejected.jsonl')

    // 确保目录存在
    const nudgesDir = path.join(dir, 'nudges')
    if (!fs.existsSync(nudgesDir)) {
      await fs.promises.mkdir(nudgesDir, { recursive: true })
    }

    const record = {
      timestamp: Date.now(),
      type: nudge.type,
      pattern: nudge.pattern,
    }
    await fs.promises.appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8')
  }

  /**
   * 记录延后
   */
  private async recordDeferral(nudge: NudgeCandidate, mode: MemoryMode): Promise<void> {
    const dir = getMemoryDir(mode)
    const filePath = path.join(dir, 'nudges', 'deferred.jsonl')

    // 确保目录存在
    const nudgesDir = path.join(dir, 'nudges')
    if (!fs.existsSync(nudgesDir)) {
      await fs.promises.mkdir(nudgesDir, { recursive: true })
    }

    const record = {
      timestamp: Date.now(),
      type: nudge.type,
      pattern: nudge.pattern,
      nudgeId: nudge.id,
    }
    await fs.promises.appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8')
  }

  /**
   * 注册 Nudge 回调
   */
  registerCallback(
    sessionId: string,
    callback: (nudge: NudgeCandidate, result: NudgeResult) => void
  ): void {
    this.nudgeCallbacks.set(sessionId, callback)
  }

  /**
   * 注销回调
   */
  unregisterCallback(sessionId: string): void {
    this.nudgeCallbacks.delete(sessionId)
    this.pendingNudges.delete(sessionId)
  }

  /**
   * 清理会话状态
   */
  clearSession(sessionId: string): void {
    this.sessionTurnCounts.delete(sessionId)
    this.sessionLayerCooldowns.delete(sessionId)
    this.pendingNudges.delete(sessionId)
    this.nudgeCallbacks.delete(sessionId)
  }

  private static srcPrefix(sessionId: string): string {
    return `src:${sessionId}`
  }

  /**
   * 标记会话已删除（D+3 孤儿引用修复）
   *
   * 会话被永久删除时，遍历 L0/L2/L3/L5 文件，
   * 把 `src:<sessionId>` 的行加 `deleted:1` 标记（patch-only，不删行）。
   *
   * 调用场景：会话删除流程末尾。
   * 为避免循环依赖，此方法不直接 import 会话管理模块，而是由调用方在确定会话 ID 后主动调。
   */
  async markSessionDeleted(sessionId: string): Promise<void> {
    const src = NudgeService.srcPrefix(sessionId)
    for (const mode of ['general', 'ta'] as const) {
      const dir = getMemoryDir(mode)
      for (const fileName of ['L0_user.md', 'L2_facts.md', 'L3_corrections.md', 'L5_insights.md']) {
        const filePath = path.join(dir, fileName)
        if (!fs.existsSync(filePath)) continue

        let content: string
        try {
          content = fs.readFileSync(filePath, 'utf-8')
        } catch {
          continue
        }
        if (!content.includes(src)) continue

        const lines = content.split('\n')
        let changed = false
        const patched = lines.map((line) => {
          if (!line.startsWith('- ') || !line.includes(src)) return line
          if (/deleted:\s*1/.test(line)) return line
          changed = true
          return `${line.replace(/-->$/, '')} deleted:1 -->`
        })
        if (!changed) continue
        try {
          fs.writeFileSync(filePath, patched.join('\n'), 'utf-8')
          this.fileHashes?.delete(filePath)
          console.log(`[Nudge] 标记会话已删除 ${sessionId}: ${fileName}`)
        } catch (err) {
          console.warn(`[Nudge] 标记会话已删除失败 ${filePath}:`, err)
        }
      }
    }
  }
}

// 导出类（供测试注入独立实例）+ 单例
export { NudgeService }
export const nudgeService = new NudgeService()
