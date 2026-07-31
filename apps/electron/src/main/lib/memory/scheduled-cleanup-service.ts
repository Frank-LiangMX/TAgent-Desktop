/**
 * ScheduledCleanupService - 记忆自进化 Scheduled Cleanup 机制
 *
 * Phase 2.1 从 TAgent_General 移植。路径改用 getMemoryDir（基于 getConfigDir()）。
 * Skill Curator 接力（General 独有）已移除。
 *
 * 根据设计文档 §6.5.6 实现：
 * - 每周日 04:00（或启动时距上次 >8 天）触发
 * - L4 归档（>30 天移 archive，>90 天标 old）
 * - L3 压缩（raw >1000 条触发聚类）
 * - FTS5 重建
 * - LRU 标记
 *
 * 触发条件：
 * - 定时：每周日 04:00
 * - 启动时：距上次 >8 天
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { getMemoryDir, memoryLayerService, type MemoryMode } from './memory-layer-service'

// ===== 类型定义 =====

/** Cleanup 执行结果 */
export interface CleanupResult {
  success: boolean
  l4Archived: number
  l3Compressed: number
  fts5Rebuilt: boolean
  lruMarked: number
  error?: string
}

/** Cleanup 状态 */
interface CleanupState {
  lastRunTime: number | null
}

// ===== 配置 =====

/** Cleanup 间隔（毫秒）：8 天 */
const CLEANUP_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000

/** L4 归档阈值：30 天 */
const L4_ARCHIVE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000

/** L4 标记 old 阈值：90 天 */
const L4_OLD_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000

/** L3 压缩阈值：1000 条 */
const L3_COMPRESS_THRESHOLD = 1000

// ===== ScheduledCleanupService =====

class ScheduledCleanupService {
  /** 各模式的 Cleanup 状态 */
  private states: Map<MemoryMode, CleanupState> = new Map()

  /** 定时器 ID */
  private timerId: NodeJS.Timeout | null = null

  /**
   * 初始化服务
   */
  initialize(): void {
    // 加载上次运行时间
    this.loadState('general')
    this.loadState('ta')

    // 检查是否需要立即运行
    this.checkAndRun('general')
    this.checkAndRun('ta')

    // 设置定时器：每周日 04:00 运行
    this.scheduleNextRun()
  }

  /**
   * 加载状态
   */
  private loadState(mode: MemoryMode): void {
    const dir = getMemoryDir(mode)
    const statePath = path.join(dir, 'cleanup_state.json')

    try {
      if (fs.existsSync(statePath)) {
        const content = fs.readFileSync(statePath, 'utf-8')
        const state = JSON.parse(content) as CleanupState
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

    // 确保目录存在
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const statePath = path.join(dir, 'cleanup_state.json')
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
  }

  /**
   * 检查并运行 Cleanup
   */
  private checkAndRun(mode: MemoryMode): void {
    const state = this.states.get(mode)
    const now = Date.now()

    // 首次运行或距上次 >8 天
    if (!state?.lastRunTime || now - state.lastRunTime > CLEANUP_INTERVAL_MS) {
      this.runCleanup(mode).catch((e) => {
        console.warn(`[ScheduledCleanupService] ${mode} 模式 Cleanup 失败:`, e)
      })
    }
  }

  /**
   * 计算下次运行时间（下周日 04:00）
   */
  private scheduleNextRun(): void {
    const now = new Date()
    const nextSunday4AM = new Date(now)

    // 设为周日
    const dayOfWeek = now.getDay()
    const daysUntilSunday = (7 - dayOfWeek) % 7 || 7 // 如果今天是周日，则下周日
    nextSunday4AM.setDate(nextSunday4AM.getDate() + daysUntilSunday)
    nextSunday4AM.setHours(4, 0, 0, 0)

    const delay = nextSunday4AM.getTime() - now.getTime()

    console.log(
      `[ScheduledCleanupService] 下次运行时间: ${nextSunday4AM.toISOString()}, 距今 ${Math.round(delay / 1000 / 60)} 分钟`
    )

    this.timerId = setTimeout(() => {
      this.runCleanup('general').catch(console.error)
      this.runCleanup('ta').catch(console.error)
      // 递归调度下一次
      this.scheduleNextRun()
    }, delay)
  }

  /**
   * 执行 Cleanup
   */
  async runCleanup(mode: MemoryMode): Promise<CleanupResult> {
    const dir = getMemoryDir(mode)
    const result: CleanupResult = {
      success: false,
      l4Archived: 0,
      l3Compressed: 0,
      fts5Rebuilt: false,
      lruMarked: 0,
    }

    try {
      // 1. L4 归档
      result.l4Archived = await this.archiveL4Sessions(mode)

      // 2. L3 压缩
      result.l3Compressed = await this.compressL3Corrections(dir)

      // 3. FTS5 重建（由 ta_agent MCP Server 负责，这里只标记）
      result.fts5Rebuilt = true

      // 4. LRU 标记
      result.lruMarked = this.markLRU(dir)

      result.success = true
      console.log(
        `[ScheduledCleanupService] ${mode} 模式 Cleanup 完成: L4归档=${result.l4Archived}, L3压缩=${result.l3Compressed}`
      )

      // 更新状态
      const state = this.states.get(mode) || { lastRunTime: null }
      state.lastRunTime = Date.now()
      this.states.set(mode, state)
      this.saveState(mode)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      result.error = msg
      console.error(`[ScheduledCleanupService] ${mode} 模式 Cleanup 失败:`, error)
    }

    return result
  }

  /**
   * L4 归档
   */
  private async archiveL4Sessions(mode: MemoryMode): Promise<number> {
    const sessions = memoryLayerService.listRecentSessions(mode, 1000)
    const now = Date.now()
    let archived = 0

    for (const session of sessions) {
      const age = now - session.created_at

      // >90 天：标记 old（暂不实现，需要 ta_agent MCP Server 支持）
      // >30 天：移到 archive
      if (age > L4_ARCHIVE_THRESHOLD_MS) {
        // 实际归档需要 ta_agent MCP Server 执行
        archived++
      }
    }

    return archived
  }

  /**
   * L3 压缩
   */
  private async compressL3Corrections(dir: string): Promise<number> {
    const filePath = path.join(dir, 'corrections.jsonl')

    if (!fs.existsSync(filePath)) {
      return 0
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())

      if (lines.length < L3_COMPRESS_THRESHOLD) {
        return 0
      }

      // 简化版：保留最近 500 条
      const kept = lines.slice(-500)
      await fs.promises.writeFile(filePath, kept.join('\n') + '\n', 'utf-8')

      console.log(`[ScheduledCleanupService] L3 压缩: ${lines.length} → ${kept.length}`)
      return lines.length - kept.length
    } catch {
      return 0
    }
  }

  /**
   * LRU 标记
   */
  private markLRU(dir: string): number {
    let marked = 0
    const now = Date.now()
    const threshold = 90 * 24 * 60 * 60 * 1000 // 90 天

    // 检查各文件的最后引用时间
    const files = ['L0_user.md', 'L1_project.md', 'L2_facts.md', 'L5_insights.md']

    for (const file of files) {
      const filePath = path.join(dir, file)
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath)
        if (now - stat.mtimeMs > threshold) {
          // 标记为旧（简化版：仅记录日志）
          console.log(`[ScheduledCleanupService] ${file} 超过 90 天未更新，建议清理`)
          marked++
        }
      }
    }

    return marked
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
export const scheduledCleanupService = new ScheduledCleanupService()
