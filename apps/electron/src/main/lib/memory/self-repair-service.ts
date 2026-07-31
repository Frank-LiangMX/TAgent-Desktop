/**
 * SelfRepairService - 记忆自进化 Self-Repair 机制
 *
 * Phase 2.1 从 TAgent_General 移植。路径改用 getMemoryDir / getConfigDir（基于 getConfigDir()）。
 *
 * 根据设计文档 §6.5.7 实现：
 * - 每月 1 日 04:00（或启动时距上次 >35 天）触发
 * - L3 命中率统计：低命中率的 correction 标 stale
 * - L5 反向引用验证：原始 L2/L4 被删除 → L5 archive
 * - L0 跨模式一致性：general vs TA 差异 >5 条 → 报告
 * - 月度报告：写到 logs/reflect/monthly-{date}.log
 *
 * 触发条件：
 * - 定时：每月 1 日 04:00
 * - 启动时：距上次 >35 天
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { getConfigDir } from '../config/config-paths'
import { getMemoryDir, memoryLayerService, type MemoryMode } from './memory-layer-service'

// ===== 类型定义 =====

/** Self-Repair 执行结果 */
export interface SelfRepairResult {
  success: boolean
  l3StaleMarked: number
  l5Archived: number
  l0DiffReport: string | null
  reportPath: string | null
  error?: string
}

/** Self-Repair 状态 */
interface SelfRepairState {
  lastRunTime: number | null
}

// ===== 配置 =====

/** Self-Repair 间隔（毫秒）：35 天 */
const SELF_REPAIR_INTERVAL_MS = 35 * 24 * 60 * 60 * 1000

/** L3 命中率统计窗口：30 天 */
const L3_HIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** L3 低命中率阈值：30 天内 <2 次引用视为低价值 */
const L3_LOW_HIT_THRESHOLD = 2

// ===== SelfRepairService =====

class SelfRepairService {
  /** 各模式的 Self-Repair 状态 */
  private states: Map<MemoryMode, SelfRepairState> = new Map()

  /** 定时器 ID */
  private timerId: NodeJS.Timeout | null = null

  /**
   * 获取日志目录路径
   */
  private getLogsDir(): string {
    return path.join(getConfigDir(), 'logs', 'reflect')
  }

  /**
   * 初始化服务
   */
  initialize(): void {
    this.loadState('general')
    this.loadState('ta')

    this.checkAndRun('general')
    this.checkAndRun('ta')

    this.scheduleNextRun()
  }

  /**
   * 加载状态
   */
  private loadState(mode: MemoryMode): void {
    const dir = getMemoryDir(mode)
    const statePath = path.join(dir, 'self_repair_state.json')

    try {
      if (fs.existsSync(statePath)) {
        const content = fs.readFileSync(statePath, 'utf-8')
        const state = JSON.parse(content) as SelfRepairState
        this.states.set(mode, state)
      } else {
        this.states.set(mode, { lastRunTime: null })
      }
    } catch {
      this.states.set(mode, { lastRunTime: null })
    }
  }

  /**
   * 保存状态
   */
  private saveState(mode: MemoryMode): void {
    const dir = getMemoryDir(mode)
    const state = this.states.get(mode)
    if (!state) return

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const statePath = path.join(dir, 'self_repair_state.json')
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
  }

  /**
   * 检查并运行 Self-Repair
   *
   * 首次运行或距上次 >35 天才执行。去重判断，避免重复触发。
   */
  private checkAndRun(mode: MemoryMode): void {
    const state = this.states.get(mode)
    if (!state) return

    const now = Date.now()
    if (state.lastRunTime && now - state.lastRunTime < SELF_REPAIR_INTERVAL_MS) {
      return
    }

    this.runSelfRepair(mode).catch((e) => {
      console.error(`[SelfRepairService] ${mode} 模式 Self-Repair 失败:`, e)
    })
  }

  /**
   * 计算下次运行时间（下月 1 日 04:00）
   *
   * 长延时超 32 位上限会触发 TimeoutOverflowWarning，
   * 改为每天检查一次是否到月初。
   */
  private scheduleNextRun(): void {
    // 每 6 小时检查一次是否到月初 04:00
    const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

    this.timerId = setInterval(() => {
      const now = new Date()
      if (now.getDate() === 1 && now.getHours() >= 4) {
        this.runSelfRepair('general').catch(console.error)
        this.runSelfRepair('ta').catch(console.error)
      }
    }, CHECK_INTERVAL_MS)

    console.log(`[SelfRepairService] 定时检查已启动：每 6 小时检查一次月初，下月 1 日 04:00 触发`)
  }

  /**
   * 执行 Self-Repair
   */
  async runSelfRepair(mode: MemoryMode): Promise<SelfRepairResult> {
    const dir = getMemoryDir(mode)
    const result: SelfRepairResult = {
      success: false,
      l3StaleMarked: 0,
      l5Archived: 0,
      l0DiffReport: null,
      reportPath: null,
    }

    try {
      const reportLines: string[] = []
      const reportDate = new Date().toISOString().slice(0, 10)
      reportLines.push(`# Self-Repair 月度报告 - ${mode} 模式 - ${reportDate}`)
      reportLines.push('')

      // 1. L3 命中率统计
      const l3Result = this.checkL3HitRate(dir)
      result.l3StaleMarked = l3Result.staleMarked
      reportLines.push('## L3 纠错命中率')
      reportLines.push(`- 总条数: ${l3Result.total}`)
      reportLines.push(`- 低命中率标记 stale: ${l3Result.staleMarked}`)
      reportLines.push('')

      // 2. L5 反向引用验证
      const l5Result = this.verifyL5References(dir, mode)
      result.l5Archived = l5Result.archived
      reportLines.push('## L5 洞察反向引用')
      reportLines.push(`- 总条数: ${l5Result.total}`)
      reportLines.push(`- 原始引用已删除，archive: ${l5Result.archived}`)
      reportLines.push('')

      // 3. L0 跨模式一致性（仅 general 模式跑一次对比）
      if (mode === 'general') {
        const l0Result = this.checkL0CrossModeConsistency()
        result.l0DiffReport = l0Result.report
        if (l0Result.report) {
          reportLines.push('## L0 跨模式一致性')
          reportLines.push(l0Result.report)
          reportLines.push('')
        }
      }

      // 4. 写报告
      const reportPath = this.writeReport(reportDate, mode, reportLines.join('\n'))
      result.reportPath = reportPath

      result.success = true
      console.log(
        `[SelfRepairService] ${mode} 模式 Self-Repair 完成: L3 stale=${result.l3StaleMarked}, L5 archive=${result.l5Archived}, 报告=${reportPath}`
      )

      // 更新状态
      const state = this.states.get(mode) ?? { lastRunTime: null }
      state.lastRunTime = Date.now()
      this.states.set(mode, state)
      this.saveState(mode)
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
      console.error(`[SelfRepairService] ${mode} 模式 Self-Repair 失败:`, error)
    }

    return result
  }

  /**
   * L3 命中率统计
   *
   * 扫描 corrections.jsonl，按 correction 文本分组统计最近 30 天出现次数。
   * 低命中率（<2 次）的标 stale，写到 stale_corrections.json（不删原数据）。
   */
  private checkL3HitRate(dir: string): { total: number; staleMarked: number } {
    const filePath = path.join(dir, 'corrections.jsonl')
    if (!fs.existsSync(filePath)) {
      return { total: 0, staleMarked: 0 }
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())
      if (lines.length === 0) return { total: 0, staleMarked: 0 }

      const cutoff = Date.now() - L3_HIT_WINDOW_MS
      const hitCounts = new Map<string, { count: number; lastTs: number }>()

      for (const line of lines) {
        try {
          const record = JSON.parse(line) as {
            timestamp?: number
            correction?: string
          }
          if (!record.timestamp || !record.correction) continue
          if (record.timestamp < cutoff) continue

          const key = record.correction
          const existing = hitCounts.get(key) ?? { count: 0, lastTs: 0 }
          existing.count++
          existing.lastTs = Math.max(existing.lastTs, record.timestamp)
          hitCounts.set(key, existing)
        } catch {
          // 跳过无法解析的行
        }
      }

      // 低命中率的写到 stale_corrections.json
      const staleEntries: Array<{ correction: string; hitCount: number; lastTs: number }> = []
      for (const [correction, info] of hitCounts) {
        if (info.count < L3_LOW_HIT_THRESHOLD) {
          staleEntries.push({ correction, hitCount: info.count, lastTs: info.lastTs })
        }
      }

      if (staleEntries.length > 0) {
        const stalePath = path.join(dir, 'stale_corrections.json')
        fs.writeFileSync(stalePath, JSON.stringify(staleEntries, null, 2), 'utf-8')
      }

      return { total: hitCounts.size, staleMarked: staleEntries.length }
    } catch {
      return { total: 0, staleMarked: 0 }
    }
  }

  /**
   * L5 反向引用验证
   *
   * 每条 L5 找 L2/L4 是否还有相关内容（关键词重叠）。
   * 原始引用都删除 → L5 archive 到 L5_archive.md。
   */
  private verifyL5References(dir: string, mode: MemoryMode): { total: number; archived: number } {
    const l5Path = path.join(dir, 'L5_insights.md')
    if (!fs.existsSync(l5Path)) {
      return { total: 0, archived: 0 }
    }

    try {
      const l5Content = fs.readFileSync(l5Path, 'utf-8')
      const l5Lines = l5Content
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.replace(/<!--.*?-->/, '').trim())

      if (l5Lines.length === 0) return { total: 0, archived: 0 }

      // 读 L2 + L4 内容作为引用源
      const l2Content = this.readMdFile(path.join(dir, 'L2_facts.md'))
      const l4Sessions = memoryLayerService.listRecentSessions(mode, 100)
      const l4Content = l4Sessions.map((s) => `${s.title} ${s.summary}`).join(' ')

      const archiveLines: string[] = []
      const keepLines: string[] = []

      for (const line of l5Lines) {
        // 提取 L5 行的关键词（中文 2-4 字 / 英文 3+ 字母）
        const keywords = line.match(/[一-龥]{2,4}|[a-zA-Z]{3,}/g) ?? []
        if (keywords.length === 0) {
          keepLines.push(line)
          continue
        }

        // 检查 L2/L4 是否还有任意关键词
        const hasReference = keywords.some((kw) => l2Content.includes(kw) || l4Content.includes(kw))

        if (hasReference) {
          keepLines.push(line)
        } else {
          archiveLines.push(line)
        }
      }

      // 写 archive
      if (archiveLines.length > 0) {
        const archivePath = path.join(dir, 'L5_archive.md')
        const timestamp = new Date().toISOString().slice(0, 10)
        const archiveContent = `# L5 Archived Insights\n\n> ${timestamp} Self-Repair 归档（原始引用已删除）\n\n${archiveLines.join('\n')}\n`
        if (fs.existsSync(archivePath)) {
          fs.appendFileSync(archivePath, archiveContent, 'utf-8')
        } else {
          fs.writeFileSync(archivePath, archiveContent, 'utf-8')
        }

        // 更新 L5_insights.md 只保留 keepLines
        const newL5 = `# L5 提炼洞察\n\n> 每日 Reflect 自动生成\n\n${keepLines.join('\n')}\n`
        fs.writeFileSync(l5Path, newL5, 'utf-8')
      }

      return { total: l5Lines.length, archived: archiveLines.length }
    } catch {
      return { total: 0, archived: 0 }
    }
  }

  /**
   * L0 跨模式一致性检查
   *
   * 对比 general / TA 模式的 L0_user.md，差异 >5 条 → 返回报告。
   */
  private checkL0CrossModeConsistency(): { report: string | null } {
    const generalL0 = this.readMdFile(path.join(getMemoryDir('general'), 'L0_user.md'))
    const taL0 = this.readMdFile(path.join(getMemoryDir('ta'), 'L0_user.md'))

    if (!generalL0 && !taL0) return { report: null }

    const generalLines = this.parseMdLines(generalL0)
    const taLines = this.parseMdLines(taL0)

    const generalOnly = generalLines.filter((l) => !taLines.includes(l))
    const taOnly = taLines.filter((l) => !generalLines.includes(l))
    const diff = generalOnly.length + taOnly.length

    if (diff < 5) {
      return { report: null }
    }

    const report = [
      `### L0 跨模式差异: ${diff} 条`,
      `- 仅 general 模式有: ${generalOnly.length} 条`,
      `- 仅 TA 模式有: ${taOnly.length} 条`,
      '- 建议：开启"L0 共享"开关后合并（设置 → 记忆 → 跨模式共享）',
    ].join('\n')

    return { report }
  }

  /**
   * 读取 Markdown 文件
   */
  private readMdFile(filePath: string): string {
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf-8')
  }

  /**
   * 解析 Markdown 行（去掉元数据注释后的纯文本）
   */
  private parseMdLines(content: string): string[] {
    return content
      .split('\n')
      .filter((line) => line.trim() && line.startsWith('- '))
      .map((line) => line.replace(/<!--.*?-->/, '').trim())
  }

  /**
   * 写月度报告
   */
  private writeReport(date: string, mode: MemoryMode, content: string): string {
    const logsDir = this.getLogsDir()
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
    }
    const reportPath = path.join(logsDir, `monthly-${date}-${mode}.log`)
    fs.writeFileSync(reportPath, content, 'utf-8')
    return reportPath
  }

  /**
   * 关闭服务
   */
  close(): void {
    if (this.timerId) {
      clearInterval(this.timerId)
      this.timerId = null
    }
  }
}

// 导出单例
export const selfRepairService = new SelfRepairService()
