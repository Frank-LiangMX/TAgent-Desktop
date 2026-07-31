/**
 * Stage 队列服务（P2.2，借鉴 Hermes 写入门控三态）
 *
 * Phase 2.1 从 TAgent_General 移植。路径改用 getMemoryDir（基于 getConfigDir()）。
 *
 * background nudge（LLM review）写入暂存到 pending_approval.jsonl，
 * 不立刻落盘到 L0/L1/L2，等用户批量审批。
 *
 * 三态门控：
 * - allow: foreground 主动写 / 用户已 accept → 立即写盘
 * - stage: background nudge 自动写 → 暂存待审批（本服务）
 * - blocked: drift 检测失败 → 拒绝 + backup（P3.2 实现）
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { getMemoryDir, type MemoryMode } from './memory-layer-service'
import type { NudgeCandidate, NudgeType } from './nudge-service'

/** stage 队列条目 */
export interface StageEntry {
  /** 唯一 id（与 NudgeCandidate.id 共享） */
  id: string
  /** 入队时间戳 */
  enqueuedAt: number
  /** 来源：background（LLM review 自动） */
  origin: 'background'
  /** Nudge 类型 */
  type: NudgeType
  /** 目标层 */
  targetLayer: 'L0' | 'L1' | 'L2' | 'L3'
  /** 记忆内容 */
  pattern: string
  /** 证据消息（用户消息截断） */
  evidence: string[]
  /** 建议内容 */
  suggestedContent: string
  /** 用户友好提示 */
  userMessage: string
  /** 来源会话 id 前 8 位 */
  sourceSession: string
}

/** 30 天未审批自动 reject */
const AUTO_REJECT_DAYS = 30
const AUTO_REJECT_MS = AUTO_REJECT_DAYS * 24 * 60 * 60 * 1000

/**
 * 获取 stage 队列文件路径
 *
 * 路径：~/.tagent[-dev]/memory/pending_approval.jsonl
 *
 * 文件不存在时返回路径，不创建文件（lazy 创建）。
 */
function getStageFilePath(mode: MemoryMode): string {
  return path.join(getMemoryDir(mode), 'pending_approval.jsonl')
}

/**
 * 读取 stage 队列
 *
 * 文件不存在返回空数组。
 * 自动过滤超过 30 天未审批的条目（auto reject）。
 */
export function readStageQueue(mode: MemoryMode): StageEntry[] {
  const filePath = getStageFilePath(mode)
  if (!fs.existsSync(filePath)) {
    return []
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const now = Date.now()
    const entries: StageEntry[] = []

    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as StageEntry
        // 30 天未审批自动 reject（不在读取时落盘 reject，由调用方决定）
        if (now - entry.enqueuedAt < AUTO_REJECT_MS) {
          entries.push(entry)
        }
      } catch (parseErr) {
        console.warn(
          `[StageQueue] 单行 JSON 解析失败，跳过: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
        )
      }
    }

    return entries
  } catch (e) {
    console.warn(`[StageQueue] 读取队列文件失败: ${filePath}`, e)
    return []
  }
}

/**
 * 入队 stage（background nudge 写入暂存）
 *
 * 幂等：相同 id 的条目不重复入队（内部查重，不改变 public contract）。
 * 文件不存在时自动创建（lazy）。
 */
export function enqueueStage(mode: MemoryMode, candidate: NudgeCandidate): void {
  const filePath = getStageFilePath(mode)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // 幂等检查：相同 id 的条目不重复入队
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const existing = JSON.parse(line) as StageEntry
          if (existing.id === candidate.id) {
            console.log(`[StageQueue] 跳过重复入队: ${candidate.id}`)
            return
          }
        } catch (parseErr) {
          console.warn(
            `[StageQueue] 幂等检查：单行解析失败跳过: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
          )
        }
      }
    } catch (readErr) {
      console.warn(
        `[StageQueue] 幂等检查：读取失败，跳过去重: ${readErr instanceof Error ? readErr.message : String(readErr)}`
      )
    }
  }

  const entry: StageEntry = {
    id: candidate.id,
    enqueuedAt: Date.now(),
    origin: 'background',
    type: candidate.type,
    targetLayer: candidate.targetLayer,
    pattern: candidate.pattern,
    evidence: candidate.evidence,
    suggestedContent: candidate.suggestedContent,
    userMessage: candidate.userMessage,
    sourceSession: candidate.evidence[0]?.slice(0, 8) ?? '',
  }

  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8')
  console.log(
    `[StageQueue] 入队 ${mode}/pending_approval: ${candidate.id} (${candidate.targetLayer})`
  )
}

/**
 * 从队列移除一个条目（accept 或 reject 后调用）
 */
export function removeFromStage(mode: MemoryMode, id: string): void {
  const filePath = getStageFilePath(mode)
  if (!fs.existsSync(filePath)) {
    return
  }

  const entries = readStageQueue(mode).filter((e) => e.id !== id)
  writeStageQueue(mode, entries)
}

/**
 * 全量重写队列（accept/reject 后用）
 */
function writeStageQueue(mode: MemoryMode, entries: StageEntry[]): void {
  const filePath = getStageFilePath(mode)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const content =
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '')
  fs.writeFileSync(filePath, content, 'utf-8')
}

/**
 * 批量 accept：返回所有待审批条目（调用方负责 writeToLayer）
 *
 * 清空队列。
 */
export function acceptAll(mode: MemoryMode): StageEntry[] {
  const entries = readStageQueue(mode)
  if (entries.length === 0) {
    return []
  }
  writeStageQueue(mode, [])
  console.log(`[StageQueue] 批量 accept ${mode}: ${entries.length} 项`)
  return entries
}

/**
 * 批量 reject：清空队列 + 记录到 nudges/rejected.jsonl
 */
export function rejectAll(mode: MemoryMode, reason: string = 'batch_rejected'): StageEntry[] {
  const entries = readStageQueue(mode)
  if (entries.length === 0) {
    return []
  }

  // 记录到 rejected.jsonl
  const memoryDir = getMemoryDir(mode)
  const rejectedPath = path.join(memoryDir, 'nudges', 'rejected.jsonl')
  const rejectedDir = path.dirname(rejectedPath)
  if (!fs.existsSync(rejectedDir)) {
    fs.mkdirSync(rejectedDir, { recursive: true })
  }

  const now = Date.now()
  const rejectLines =
    entries
      .map((e) =>
        JSON.stringify({
          id: e.id,
          timestamp: now,
          type: e.type,
          pattern: e.pattern,
          reason,
        })
      )
      .join('\n') + '\n'
  fs.appendFileSync(rejectedPath, rejectLines, 'utf-8')

  // 清空队列
  writeStageQueue(mode, [])
  console.log(`[StageQueue] 批量 reject ${mode}: ${entries.length} 项 (reason=${reason})`)
  return entries
}

/**
 * 获取队列统计（UI 用）
 */
export function getStageStats(mode: MemoryMode): {
  count: number
  oldestEnqueuedAt: number | null
} {
  const entries = readStageQueue(mode)
  if (entries.length === 0 || entries[0] === undefined) {
    return { count: 0, oldestEnqueuedAt: null }
  }
  const oldest = entries.reduce(
    (min, e) => (e.enqueuedAt < min ? e.enqueuedAt : min),
    entries[0].enqueuedAt
  )
  return { count: entries.length, oldestEnqueuedAt: oldest }
}
