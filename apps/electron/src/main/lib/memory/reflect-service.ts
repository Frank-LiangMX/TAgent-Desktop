/**
 * ReflectService - 记忆自进化 Reflect 机制
 *
 * Phase 2.1 从 TAgent_General 移植。路径改用 getMemoryDir（基于 getConfigDir()）。
 * LLM 提炼（callLLM）依赖 General 独有渠道客户端（settings-service / channel-manager /
 * proxy-fetch），Desktop 未移植 → 暂 stub，extractInsights 自动回退规则版关键词提取。
 *
 * 根据设计文档 §6.5.5 实现：
 * - 每日 03:00（或启动时距上次 >36h）触发
 * - 从 L2_facts + L4_sessions 提炼洞察写入 L5
 * - anti_echo_filter 防回音壁（简化版：关键词重叠过滤）
 * - contradiction_check 矛盾检查（v1.6 待实现）
 *
 * 触发条件：
 * - 定时：每日 03:00
 * - 启动时：距上次 >36h
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { getMemoryDir, memoryLayerService, type MemoryMode } from './memory-layer-service'
import type { Insight, Contradiction } from './memory-consolidation-service'

// ===== 类型定义 =====

/** Reflect 执行结果 outcome */
export type ReflectionOutcome =
  | 'success'
  | 'skipped_clean'
  | 'skipped_insufficient_evidence'
  | 'skipped_budget'
  | 'failed'

/** Reflect 执行结果 */
export interface ReflectResult {
  success: boolean
  outcome: ReflectionOutcome
  insightsGenerated: number
  insights: string[]
  error?: string
  errorCode?: string
  inputCounts: { l2Facts: number; l4Sessions: number; l3Corrections: number; l5Insights: number }
  outputCounts: { insightsGenerated: number; contradictionsFound: number }
}

/** Reflect 状态（v2 — 可观测） */
interface ReflectionState {
  lastRunTime: number | null // 兼容旧版本
  lastInsights: string[] // 兼容旧版本
  lastAttemptTime: number | null
  lastSuccessTime: number | null
  lastOutcome: ReflectionOutcome | null
  lastErrorCode: string | null
  inputCounts: { l2Facts: number; l4Sessions: number; l3Corrections: number; l5Insights: number }
  outputCounts: { insightsGenerated: number; contradictionsFound: number }
  cursor: { lastProcessedSessionId: number | null; lastProcessedAt: number | null }
}

// 旧状态格式，用于向后兼容迁移
interface LegacyReflectState {
  lastRunTime: number | null
  lastInsights: string[]
}

// ===== 配置 =====

/** Reflect 间隔（毫秒）：36 小时 */
const REFLECT_INTERVAL_MS = 36 * 60 * 60 * 1000

/** 最大洞察数 */
const MAX_INSIGHTS = 20

// ===== ReflectService =====

class ReflectService {
  /** 各模式的 Reflect 状态 */
  private states: Map<MemoryMode, ReflectionState> = new Map()

  /** 定时器 ID */
  private timerId: NodeJS.Timeout | null = null

  /**
   * 初始化服务
   *
   * @param scheduleLLM 是否调度 LLM 驱动的 checkAndRun 和定时器。
   *                     默认 true（保持向后兼容）。
   *                     新 consolidation 上线后设为 false 只加载状态，
   *                     不触发任何 LLM 调用，scheduler 在接线阶段禁用。
   */
  initialize(scheduleLLM: boolean = true): void {
    // 加载上次运行时间
    this.loadState('general')
    this.loadState('ta')

    if (!scheduleLLM) {
      // 只加载状态，不 checkAndRun/scheduleNextRun
      return
    }

    // 检查是否需要立即运行
    this.checkAndRun('general')
    this.checkAndRun('ta')

    // 设置定时器：每日 03:00 运行
    this.scheduleNextRun()
  }

  /**
   * 加载状态
   */
  private loadState(mode: MemoryMode): void {
    const dir = getMemoryDir(mode)
    const statePath = path.join(dir, 'reflect_state.json')

    try {
      if (fs.existsSync(statePath)) {
        const content = fs.readFileSync(statePath, 'utf-8')
        const raw = JSON.parse(content)

        // 检测旧格式（仅有 lastRunTime + lastInsights）
        if ('lastRunTime' in raw && 'inputCounts' in raw === false) {
          const legacy = raw as LegacyReflectState
          const migrated: ReflectionState = {
            lastRunTime: legacy.lastRunTime,
            lastInsights: legacy.lastInsights,
            lastAttemptTime: legacy.lastRunTime,
            lastSuccessTime: legacy.lastRunTime,
            lastOutcome: legacy.lastRunTime ? 'success' : null,
            lastErrorCode: null,
            inputCounts: { l2Facts: 0, l4Sessions: 0, l3Corrections: 0, l5Insights: 0 },
            outputCounts: {
              insightsGenerated: legacy.lastInsights.length,
              contradictionsFound: 0,
            },
            cursor: { lastProcessedSessionId: null, lastProcessedAt: legacy.lastRunTime },
          }
          this.states.set(mode, migrated)
          // 立即写回新版状态
          this.saveState(mode)
        } else {
          this.states.set(mode, raw as ReflectionState)
        }
      } else {
        this.createFreshState(mode)
      }
    } catch {
      this.createFreshState(mode)
    }
  }

  private createFreshState(mode: MemoryMode): ReflectionState {
    const state: ReflectionState = {
      lastRunTime: null,
      lastInsights: [],
      lastAttemptTime: null,
      lastSuccessTime: null,
      lastOutcome: null,
      lastErrorCode: null,
      inputCounts: { l2Facts: 0, l4Sessions: 0, l3Corrections: 0, l5Insights: 0 },
      outputCounts: { insightsGenerated: 0, contradictionsFound: 0 },
      cursor: { lastProcessedSessionId: null, lastProcessedAt: null },
    }
    this.states.set(mode, state)
    return state
  }

  /**
   * 保存状态
   */
  private saveState(mode: MemoryMode): void {
    const dir = getMemoryDir(mode)
    const state = this.states.get(mode)
    if (!state) return

    // 确保目录存在
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const statePath = path.join(dir, 'reflect_state.json')
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
  }

  /**
   * 检查并运行 Reflect
   */
  private checkAndRun(mode: MemoryMode): void {
    const state = this.states.get(mode)
    const now = Date.now()

    // 使用 lastAttemptTime 判断（兼容旧版 lastRunTime）
    const lastCheck = state?.lastAttemptTime ?? state?.lastRunTime ?? null
    if (!lastCheck || now - lastCheck > REFLECT_INTERVAL_MS) {
      this.runReflect(mode).catch((e) => {
        console.warn(`[ReflectService] ${mode} 模式 Reflect 失败:`, e)
      })
    }
  }

  /**
   * 计算下次运行时间（明天 03:00）
   */
  private scheduleNextRun(): void {
    const now = new Date()
    const next3AM = new Date(now)
    next3AM.setHours(3, 0, 0, 0)

    // 如果今天 03:00 已过，设为明天 03:00
    if (next3AM <= now) {
      next3AM.setDate(next3AM.getDate() + 1)
    }

    const delay = next3AM.getTime() - now.getTime()

    console.log(
      `[ReflectService] 下次运行时间: ${next3AM.toISOString()}, 距今 ${Math.round(delay / 1000 / 60)} 分钟`
    )

    this.timerId = setTimeout(async () => {
      const resultGeneral = await this.runReflect('general')
      const resultTa = await this.runReflect('ta')
      console.log(
        `[ReflectService] 定时触发的 Reflect 完成: general=${resultGeneral.outcome}(insights=${resultGeneral.insightsGenerated}), ta=${resultTa.outcome}(insights=${resultTa.insightsGenerated})`
      )
      // 递归调度下一次
      this.scheduleNextRun()
    }, delay)
  }

  /**
   * 执行 Reflect
   */
  async runReflect(mode: MemoryMode): Promise<ReflectResult> {
    const dir = getMemoryDir(mode)
    const now = Date.now()
    const state = this.states.get(mode) || this.createFreshState(mode)

    const result: ReflectResult = {
      success: false,
      outcome: 'failed',
      insightsGenerated: 0,
      insights: [],
      inputCounts: { l2Facts: 0, l4Sessions: 0, l3Corrections: 0, l5Insights: 0 },
      outputCounts: { insightsGenerated: 0, contradictionsFound: 0 },
    }

    try {
      // 记录本次调度尝试
      state.lastAttemptTime = now
      state.lastErrorCode = null

      // 1. 读取 L2_facts
      const l2Content = this.readMdFile(path.join(dir, 'L2_facts.md'))
      const l2Facts = this.parseMdLines(l2Content)

      // 2. 读取 L4_sessions（最近 7 天，按 activityAt 判断）
      const l4Sessions = this.getRecentSessions(mode, 7)

      // 3. 读取 L3 corrections
      const l3Content = this.readJsonl(path.join(dir, 'corrections.jsonl'))
      const l3Corrections = this.parseJsonlLines(l3Content)

      // 4. 读取现有 L5_insights
      const l5Content = this.readMdFile(path.join(dir, 'L5_insights.md'))
      const existingInsights = this.parseMdLines(l5Content)

      // 记录输入计数
      result.inputCounts = {
        l2Facts: l2Facts.length,
        l4Sessions: l4Sessions.length,
        l3Corrections: l3Corrections.length,
        l5Insights: existingInsights.length,
      }
      state.inputCounts = { ...result.inputCounts }

      // 5. 如果数据不足，跳过
      if (l2Facts.length < 2 && l4Sessions.length < 1) {
        console.log(`[ReflectService] ${mode} 模式数据不足，跳过 Reflect`)
        state.lastOutcome = 'skipped_insufficient_evidence'
        this.states.set(mode, state)
        this.saveState(mode)
        result.outcome = 'skipped_insufficient_evidence'
        return result
      }

      // 6. 提炼洞察（LLM 优先，失败回退规则版）
      const { insights: newInsights, contradictionCount } = await this.extractInsights(
        l2Facts,
        l4Sessions,
        existingInsights,
        dir
      )

      // 7. anti_echo_filter: 过滤重复
      const filteredInsights = newInsights.filter((insight) => {
        return !existingInsights.some((existing) => this.isSimilar(insight, existing))
      })

      // 8. 限制数量
      const insightsToWrite = filteredInsights.slice(0, MAX_INSIGHTS - existingInsights.length)

      if (insightsToWrite.length > 0) {
        // 9. 写入 L5_insights.md
        await this.appendInsights(dir, insightsToWrite)

        result.success = true
        result.insightsGenerated = insightsToWrite.length
        result.insights = insightsToWrite
        result.outcome = 'success'

        console.log(`[ReflectService] ${mode} 模式生成了 ${insightsToWrite.length} 条新洞察`)
      } else {
        result.success = true
        result.outcome = 'success'
        console.log(`[ReflectService] ${mode} 模式无新洞察`)
      }

      // 更新输出计数 — result 与 state 必须一致
      result.outputCounts = {
        insightsGenerated: insightsToWrite.length,
        contradictionsFound: contradictionCount,
      }

      // 更新成功状态
      state.lastRunTime = now // 兼容字段：每次成功 attempt 更新
      state.lastSuccessTime = now
      state.lastOutcome = result.outcome
      state.outputCounts = { ...result.outputCounts }
      state.lastInsights = insightsToWrite
      this.states.set(mode, state)
      this.saveState(mode)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const errorCode =
        error instanceof Error && 'status' in error
          ? String((error as { status: unknown }).status)
          : 'UNKNOWN'
      result.error = msg
      result.errorCode = errorCode
      result.outcome = 'failed'

      state.lastOutcome = 'failed'
      state.lastErrorCode = errorCode
      this.states.set(mode, state)
      this.saveState(mode)

      console.error(`[ReflectService] ${mode} 模式 Reflect 失败:`, error)
    }

    return result
  }

  /**
   * 读取 Markdown 文件
   */
  private readMdFile(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      return ''
    }
    return fs.readFileSync(filePath, 'utf-8')
  }

  /**
   * 解析 Markdown 行
   */
  private parseMdLines(content: string): string[] {
    return content
      .split('\n')
      .filter((line) => line.trim() && line.startsWith('-'))
      .map((line) => line.replace(/^-\s*/, '').trim())
  }

  /**
   * 读取 JSONL 文件
   */
  private readJsonl(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      return ''
    }
    return fs.readFileSync(filePath, 'utf-8')
  }

  /**
   * 解析 JSONL 行
   */
  private parseJsonlLines(content: string): string[] {
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          const parsed = JSON.parse(line)
          return typeof parsed.correction === 'string' ? parsed.correction : line
        } catch {
          return line
        }
      })
  }

  /**
   * 获取最近的 L4 会话
   */
  private getRecentSessions(mode: MemoryMode, days: number): string[] {
    const sessions = memoryLayerService.listRecentSessions(mode, 50)
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

    return sessions
      .filter((s) => {
        // activityAt = max(created_at, ended_at ?? created_at)
        const activityAt = Math.max(s.created_at, s.ended_at ?? s.created_at)
        return activityAt > cutoff
      })
      .map((s) => `${s.title}: ${s.summary}`)
  }

  /**
   * 提炼洞察（LLM 优先，失败回退规则版）
   *
   * v1.5 升级：从关键词计数改为 LLM 提炼，产出真正的"偏好 / 工作流规律 / 领域洞察"。
   * 设计 §6.5.5：cheap 模型 max 500 tokens。
   *
   * LLM 不可用（Desktop 未接线 / 无渠道配置 / 调用失败）时回退规则版，保证 Reflect 不阻塞。
   */
  private async extractInsights(
    l2Facts: string[],
    l4Sessions: string[],
    existingInsights: string[],
    dir: string
  ): Promise<{ insights: string[]; contradictionCount: number }> {
    // 先尝试 LLM 提炼
    try {
      const result = await this.extractInsightsWithLLM(l2Facts, l4Sessions, existingInsights, dir)
      if (result.insights.length > 0) {
        console.log(`[ReflectService] LLM 提炼出 ${result.insights.length} 条洞察`)
        return result
      }
      console.log('[ReflectService] LLM 未产出洞察，回退规则版')
    } catch (e) {
      console.warn('[ReflectService] LLM 提炼失败，回退规则版:', e)
    }

    // 回退：规则版关键词提取（同时利用 L2 和 L4，无矛盾检测）
    const rulesInsights = this.extractInsightsWithRules(l2Facts, l4Sessions, existingInsights)
    return { insights: rulesInsights, contradictionCount: 0 }
  }

  /**
   * 调 LLM 完整文本（非流式 UI）
   *
   * TODO(2.2)：Desktop 未移植 settings-service / channel-manager / proxy-fetch，
   * 原实现走 streamSSE 调默认渠道。此处 stub 抛错，由 extractInsights 回退规则版。
   */
  private async callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
    const { completeMemoryLlm } = await import('./memory-llm-client')
    return completeMemoryLlm({ systemPrompt, userPrompt })
  }

  /**
   * LLM 提炼洞察
   *
   * 输出结构化 JSON：{ insights: string[], contradictions: string[] }
   * - insights: 新洞察，写入 L5
   * - contradictions: 与现有 L5 矛盾的洞察，写入 L3 corrections（设计 §6.5.5 contradiction_check）
   */
  private async extractInsightsWithLLM(
    l2Facts: string[],
    l4Sessions: string[],
    existingInsights: string[],
    dir: string
  ): Promise<{ insights: string[]; contradictionCount: number }> {
    const systemPrompt = `你是一个记忆反思助手。基于用户最近 7 天的稳定事实（L2）和会话摘要（L4），提炼高阶洞察。

要求：
1. 每条洞察必须是**抽象结论**（不是事实复述），例如"用户偏好 X" / "工作流规律是 Y" / "领域知识 Z"
2. 跨 session 共性优先（多个事实/会话共同指向的结论）
3. 不要与现有洞察重复
4. 用中文，每条 ≤50 字
5. 如果新洞察与现有洞察**矛盾**（如"喜欢简洁" vs "喜欢详细"），放入 contradictions 数组
6. 输出严格的 JSON 对象：{"insights": ["洞察1", "洞察2"], "contradictions": ["矛盾1"]}

现有洞察（避免重复 / 检查矛盾）：
${existingInsights.length > 0 ? existingInsights.map((i) => `- ${i}`).join('\n') : '（暂无）'}`

    const userPrompt = `=== L2 稳定事实 ===
${l2Facts.length > 0 ? l2Facts.map((f) => `- ${f}`).join('\n') : '（暂无）'}

=== L4 会话摘要（最近 7 天）===
${l4Sessions.length > 0 ? l4Sessions.map((s) => `- ${s}`).join('\n') : '（暂无）'}

请提炼 3-5 条洞察，并标注与现有洞察矛盾的项，输出 JSON 对象：`

    const text = await this.callLLM(systemPrompt, userPrompt)
    const parsed = this.parseInsightsResponse(text)

    // contradictions 写入 L3 corrections（设计 §6.5.5 contradiction_check）
    const contradictionCount = parsed.contradictions.length
    if (contradictionCount > 0) {
      try {
        await this.appendContradictionsToL3(dir, parsed.contradictions)
        console.log(`[ReflectService] ${contradictionCount} 条矛盾洞察写入 L3 corrections`)
      } catch (e) {
        console.warn('[ReflectService] 写入 L3 contradictions 失败:', e)
      }
    }

    return { insights: parsed.insights, contradictionCount }
  }

  /**
   * 解析 LLM 输出（容错：提取首个 JSON 对象，兼容旧版纯数组输出）
   */
  private parseInsightsResponse(text: string): { insights: string[]; contradictions: string[] } {
    const trimmed = text.trim()

    // 优先尝试对象格式 {"insights": [...], "contradictions": [...]}
    const objStart = trimmed.indexOf('{')
    const objEnd = trimmed.lastIndexOf('}')
    if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
      try {
        const obj = JSON.parse(trimmed.slice(objStart, objEnd + 1)) as {
          insights?: unknown
          contradictions?: unknown
        }
        const insights = Array.isArray(obj.insights)
          ? obj.insights.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          : []
        const contradictions = Array.isArray(obj.contradictions)
          ? obj.contradictions.filter(
              (s): s is string => typeof s === 'string' && s.trim().length > 0
            )
          : []
        return { insights, contradictions }
      } catch {
        // 降级到数组解析
      }
    }

    // 兼容旧版纯数组输出
    return { insights: this.parseInsightsJSON(trimmed), contradictions: [] }
  }

  /**
   * 把矛盾洞察写入 L3 corrections.jsonl
   *
   * 设计 §6.5.5：新 insight 与现有 L5 矛盾 → 写 L3 raw 而非 L5
   */
  /* internal */ async appendContradictionsToL3(
    dir: string,
    contradictions: string[]
  ): Promise<void> {
    const filePath = path.join(dir, 'corrections.jsonl')
    const timestamp = Date.now()
    const lines =
      contradictions
        .map((c) => JSON.stringify({ timestamp, correction: c, context: 'L5 contradiction' }))
        .join('\n') + '\n'

    if (!fs.existsSync(filePath)) {
      await fs.promises.writeFile(filePath, lines, 'utf-8')
    } else {
      await fs.promises.appendFile(filePath, lines, 'utf-8')
    }
  }

  /**
   * 为指定会话异步提炼 keyFacts 并回填 L4
   *
   * 在会话流结束后 fire-and-forget 调用，不阻塞 UI。
   * LLM 失败时静默跳过（keyFacts 保持空数组，不影响主流程）。
   */
  async backfillKeyFactsForSession(
    sessionId: string,
    title: string,
    summary: string,
    mode: MemoryMode
  ): Promise<void> {
    if (!title && !summary) return

    try {
      const systemPrompt = `你是一个会话关键事实提取器。基于会话标题和摘要，提取 1-3 个关键事实（key facts）。

要求：
1. 每条事实是**具体信息**（不是抽象结论），例如"用户名叫 Frank" / "项目用 React + TypeScript" / "调试了 Nudge toast 不弹的 bug"
2. 用中文，每条 ≤30 字
3. 输出严格的 JSON 数组格式：["事实1", "事实2"]`

      const userPrompt = `=== 会话标题 ===
${title || '（无）'}

=== 会话摘要 ===
${summary || '（无）'}

请提取 1-3 个关键事实，输出 JSON 数组：`

      const text = await this.callLLM(systemPrompt, userPrompt)
      const keyFacts = this.parseInsightsJSON(text)

      if (keyFacts.length > 0) {
        memoryLayerService.updateSessionKeyFacts(sessionId, keyFacts, mode)
        console.log(
          `[ReflectService] 会话 ${sessionId.slice(0, 8)} keyFacts 回填 ${keyFacts.length} 条`
        )
      }
    } catch (e) {
      console.warn(`[ReflectService] backfillKeyFacts 失败 sessionId=${sessionId.slice(0, 8)}:`, e)
    }
  }

  /**
   * 解析 LLM 输出的 JSON 数组（容错：提取首个 JSON 数组）
   */
  private parseInsightsJSON(text: string): string[] {
    const trimmed = text.trim()
    // 找首个 [ 到匹配的 ]
    const start = trimmed.indexOf('[')
    const end = trimmed.lastIndexOf(']')
    if (start === -1 || end === -1 || end <= start) {
      console.warn('[ReflectService] LLM 输出未找到 JSON 数组:', trimmed.slice(0, 200))
      return []
    }

    try {
      const arr = JSON.parse(trimmed.slice(start, end + 1))
      if (!Array.isArray(arr)) return []
      return arr.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    } catch (e) {
      console.warn('[ReflectService] JSON 解析失败:', e)
      return []
    }
  }

  /**
   * 规则版关键词提取（fallback）
   *
   * LLM 不可用时用，产出质量较低但保证 Reflect 不阻塞。
   */
  private extractInsightsWithRules(
    l2Facts: string[],
    l4Sessions: string[],
    existingInsights: string[]
  ): string[] {
    const insights: string[] = []
    const keywordCounts = new Map<string, number>()

    // 同时从 L2 事实和 L4 会话中提取关键词
    for (const fact of l2Facts) {
      const keywords = fact.match(/[一-龥]{2,4}|[a-zA-Z]{3,}/g) || []
      for (const keyword of keywords) {
        keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1)
      }
    }
    for (const session of l4Sessions) {
      const keywords = session.match(/[一-龥]{2,4}|[a-zA-Z]{3,}/g) || []
      for (const keyword of keywords) {
        keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1)
      }
    }

    // 合并所有文本用于关联检查
    const allTexts = [...l2Facts, ...l4Sessions]

    for (const [keyword, count] of keywordCounts) {
      if (count >= 2 && !existingInsights.some((i) => i.includes(keyword))) {
        const relatedTexts = allTexts.filter((t) => t.includes(keyword))
        if (relatedTexts.length >= 2) {
          insights.push(`用户在多个场景提到「${keyword}」，可能是一个重要偏好`)
        }
      }
    }

    return insights.slice(0, 5)
  }

  /**
   * 检查两段文本是否相似
   */
  /* internal */ isSimilar(a: string, b: string): boolean {
    // 空关键词边沿：两段无关键词文本仅在内容完全相等时视为相似
    const keywordsA = new Set(a.match(/[一-龥]{2,4}|[a-zA-Z]{3,}/g) || [])
    const keywordsB = new Set(b.match(/[一-龥]{2,4}|[a-zA-Z]{3,}/g) || [])
    if (keywordsA.size === 0 && keywordsB.size === 0) {
      return a.trim().toLowerCase() === b.trim().toLowerCase()
    }

    let overlap = 0
    for (const kw of keywordsA) {
      if (keywordsB.has(kw)) overlap++
    }

    // 超过 50% 重叠视为相似
    const threshold = Math.max(keywordsA.size, keywordsB.size) * 0.5
    return overlap >= threshold
  }

  /**
   * 追加洞察到 L5_insights.md
   */
  /* internal */ async appendInsights(dir: string, insights: string[]): Promise<void> {
    const filePath = path.join(dir, 'L5_insights.md')
    const timestamp = new Date().toISOString().slice(0, 10)

    const lines = insights.map((i) => `- [${timestamp}] ${i}\n`).join('')

    if (!fs.existsSync(filePath)) {
      const header = `# L5 提炼洞察\n\n> 每日 Reflect 自动生成\n\n${lines}`
      await fs.promises.writeFile(filePath, header, 'utf-8')
    } else {
      await fs.promises.appendFile(filePath, '\n' + lines, 'utf-8')
    }
  }

  /**
   * 追加结构化洞察及其元数据到 L5_insights.md
   *
   * 每条 insight 写入两行：
   *   - [date] content
   *     <!-- {"confidence":0.8,"evidenceIds":["ev-1"]} -->
   *
   * 第二行以空格开头（非 dash），parseMdLines / runReflect 的读取不受影响，
   * 向后兼容。不创建新文件。
   */
  private async appendStructuredInsights(dir: string, insights: Insight[]): Promise<void> {
    const filePath = path.join(dir, 'L5_insights.md')
    const timestamp = new Date().toISOString().slice(0, 10)

    // markdown block with optional <!-- ... --> metadata lines
    const mdEntries: string[] = []
    for (const insight of insights) {
      mdEntries.push(`- [${timestamp}] ${insight.content}`)
      if (insight.confidence !== undefined || (insight.evidenceIds?.length ?? 0) > 0) {
        const meta: Record<string, unknown> = {}
        if (insight.confidence !== undefined) meta.confidence = insight.confidence
        if (insight.evidenceIds?.length) meta.evidenceIds = insight.evidenceIds
        mdEntries.push(`  <!-- ${JSON.stringify(meta)} -->`)
      }
    }
    const text = '\n' + mdEntries.join('\n') + '\n'

    if (!fs.existsSync(filePath)) {
      const header = '# L5 提炼洞察\n\n> 每日 Reflect 自动生成\n\n'
      await fs.promises.writeFile(filePath, header + text.trimStart(), 'utf-8')
    } else {
      await fs.promises.appendFile(filePath, text, 'utf-8')
    }
  }

  /**
   * 纯本地应用整理的 insights 与 contradictions（ADR-0006 Phase 2）
   *
   * 由 MemoryConsolidationService 在完成批量 LLM 整理后调用。
   * - 不调用 LLM（纯本地）
   * - 对 persisted 内容做 anti-echo 去重
   * - 对 incoming batch 做内部去重（同 batch 相似 insight 只写 1 条）
   * - 保留 provenance 元数据（confidence / evidenceIds / existingId）
   *
   * @param mode 记忆模式
   * @param insights 新洞察列表（含结构化元数据，已由 consolidation 的 LLM 提取）
   * @param contradictions 矛盾列表（含 existingId/content/evidenceIds）
   * @returns 应用的计数
   */
  async applyConsolidationInsights(
    mode: MemoryMode,
    insights: Insight[],
    contradictions: Contradiction[]
  ): Promise<{ insightsApplied: number; contradictionsApplied: number }> {
    const dir = getMemoryDir(mode)
    let insightsApplied = 0
    let contradictionsApplied = 0

    // 1. 读取现有 L5 洞察做 anti-echo 过滤
    const l5Content = this.readMdFile(path.join(dir, 'L5_insights.md'))
    const existingInsights = this.parseMdLines(l5Content)

    // 2. anti-echo 去重：对 persisted + batch-internal 都去重
    //    使用 isSimilar 对 batch 内部做语义去重（保留每个相似 group 的首条）
    const acceptedInsights: Insight[] = []
    const filteredInsights = insights.filter((insight) => {
      // 对 persisted 去重
      if (existingInsights.some((existing) => this.isSimilar(insight.content, existing))) {
        return false
      }
      // 对 batch 内部已接受的条目去重（isSimilar 语义去重）
      if (acceptedInsights.some((acc) => this.isSimilar(acc.content, insight.content))) {
        return false
      }
      acceptedInsights.push(insight)
      return true
    })

    // 3. 写入去重后的新洞察（含 metadata）
    if (filteredInsights.length > 0) {
      await this.appendStructuredInsights(dir, filteredInsights)
      insightsApplied = filteredInsights.length
    }

    // 4. contradictions 去重（按 content 与现有 corrections 比较）
    const l3Content = this.readJsonl(path.join(dir, 'corrections.jsonl'))
    const existingCorrections = this.parseJsonlLines(l3Content)
    const acceptedContradictions: Contradiction[] = []
    const filteredContradictions = contradictions.filter((c) => {
      if (existingCorrections.some((ec) => this.isSimilar(c.content, ec))) return false
      if (acceptedContradictions.some((acc) => this.isSimilar(acc.content, c.content))) return false
      acceptedContradictions.push(c)
      return true
    })

    if (filteredContradictions.length > 0) {
      // 写入完整 provenance（correction + evidenceIds + existingId）
      const filePath = path.join(dir, 'corrections.jsonl')
      const timestamp = Date.now()
      const lines =
        filteredContradictions
          .map((c) =>
            JSON.stringify({
              timestamp,
              correction: c.content,
              context: 'L5 contradiction',
              evidenceIds: c.evidenceIds ?? [],
              existingId: c.existingId ?? null,
            })
          )
          .join('\n') + '\n'

      if (!fs.existsSync(filePath)) {
        await fs.promises.writeFile(filePath, lines, 'utf-8')
      } else {
        await fs.promises.appendFile(filePath, lines, 'utf-8')
      }
      contradictionsApplied = filteredContradictions.length
    }

    return { insightsApplied, contradictionsApplied }
  }

  /**
   * 关闭服务
   */
  close(): void {
    if (this.timerId) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
  }
}

// 导出单例
export const reflectService = new ReflectService()
