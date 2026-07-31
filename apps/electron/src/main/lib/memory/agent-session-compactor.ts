/**
 * P1-3: Agent 会话客户端压缩工具
 *
 * Phase 2.1 从 TAgent_General 移植。读写改用 readSdkMessages / writeSdkMessages
 * （../agent/session-store），不碰面板 messages.jsonl；compactSession 增加 workspaceId 参数。
 *
 * 当 Claude Agent SDK 服务端 compaction 失败时（9120caac 那类情况）,
 * 由 Agent 主动调 compact_session tool 兜底压缩。
 *
 * 3 个策略:
 * - drop_old_tool_results: 最便宜, 不调 LLM, 直接丢老 tool_use/tool_result 对
 * - keep_last_n: 保留最近 N 条, 其余全丢
 * - summarize: 用 cheap LLM 总结老消息 (本期不实现)
 */

import type { CompactSessionInput, CompactSessionResult } from '@tagent/shared'
import { readSdkMessages, writeSdkMessages } from '../agent/session-store'

/** 首 N 条不丢（system + 项目背景 / 上下文）*/
export const PROTECT_FIRST_N = 3
/** 尾 N 条不丢（最近交互，避免误删当前正在进行的工作）*/
export const PROTECT_LAST_N = 6

/** 压缩前的单条消息（JSONL 解析结果，结构子集，index signature 允许额外字段）*/
export interface SDKMessageRow {
  type: string
  uuid?: string
  parent_tool_use_id?: string | null
  message?: {
    role?: string
    content?: Array<{
      type: string
      text?: string
      name?: string
      id?: string
      tool_use_id?: string
      [key: string]: unknown
    }>
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * 判断消息是否仅含指定块类型（用于识别可丢的纯 tool 消息）
 */
function isPureToolBlock(msg: SDKMessageRow, blockType: 'tool_use' | 'tool_result'): boolean {
  const content = msg.message?.content
  return Array.isArray(content) && content.length > 0 && content.every((b) => b.type === blockType)
}

/**
 * 提取消息中所有 tool_use_id（tool_use.id 与 tool_result.tool_use_id 并集）
 * 用于配对保护：若配对在 protected 区域，则不丢 middle 中的对应块
 */
function extractToolUseIds(msg: SDKMessageRow): Set<string> {
  const ids = new Set<string>()
  const content = msg.message?.content
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        ids.add(b.id)
      }
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        ids.add(b.tool_use_id)
      }
    }
  }
  return ids
}

/**
 * P1-3: 计算 drop_old_tool_results 策略应该丢哪些消息
 *
 * 首尾保护: 首 PROTECT_FIRST_N 条 + 末 PROTECT_LAST_N 条始终不丢,
 * 只在 middle 区域识别 tool_use / tool_result 块并丢弃。
 *
 * 配对保护: 若某条 tool_use / tool_result 对应的配对在 protected 区域
 * (firstN 或 lastN), 则该条不丢 (避免孤儿消息)。
 *
 * 规则:
 * - user 消息只含 tool_result 块 (无文本) → 丢
 * - assistant 消息只含 tool_use 块 (无文本) → 丢
 * - 含文本或混合块 → 保留
 * - system 消息 → 保留
 * - 其他未知类型 → 保留 (保守)
 */
export function planDropOldToolResults(messages: SDKMessageRow[]): {
  kept: SDKMessageRow[]
  dropped: SDKMessageRow[]
} {
  // 边界: 消息总数不足以分段, 不处理原样返回
  if (messages.length <= PROTECT_FIRST_N + PROTECT_LAST_N) {
    return { kept: [...messages], dropped: [] }
  }

  const firstN = messages.slice(0, PROTECT_FIRST_N)
  const middle = messages.slice(PROTECT_FIRST_N, -PROTECT_LAST_N)
  const lastN = messages.slice(-PROTECT_LAST_N)

  // 第一遍: 在 middle 中识别可丢的 tool_use / tool_result 块 (按原规则)
  const droppableInMiddle = new Set<SDKMessageRow>()
  for (const msg of middle) {
    if (msg.type === 'system') continue
    if (msg.type === 'user' && isPureToolBlock(msg, 'tool_result')) {
      droppableInMiddle.add(msg)
      continue
    }
    if (msg.type === 'assistant' && isPureToolBlock(msg, 'tool_use')) {
      droppableInMiddle.add(msg)
      continue
    }
  }

  // 配对保护: 收集 protected 区域的所有 tool_use_id
  const protectedToolUseIds = new Set<string>()
  for (const msg of [...firstN, ...lastN]) {
    for (const id of extractToolUseIds(msg)) {
      protectedToolUseIds.add(id)
    }
  }

  // 过滤 droppableInMiddle: 若其任一 tool_use_id 在 protected 区域, 则从可丢集合移除
  // 这样被保护的块会按原顺序保留在 middle 中
  const finalDropped: SDKMessageRow[] = []
  for (const msg of droppableInMiddle) {
    const ids = extractToolUseIds(msg)
    let shouldProtect = false
    for (const id of ids) {
      if (protectedToolUseIds.has(id)) {
        shouldProtect = true
        break
      }
    }
    if (shouldProtect) {
      droppableInMiddle.delete(msg)
    } else {
      finalDropped.push(msg)
    }
  }

  // 第二遍: 按原顺序遍历 middle, 保留非可丢的 (顺序不变)
  const keptInMiddle: SDKMessageRow[] = middle.filter((m) => !droppableInMiddle.has(m))

  return {
    kept: [...firstN, ...keptInMiddle, ...lastN],
    dropped: finalDropped,
  }
}

/**
 * P1-3: 计算 keep_last_n 策略应该丢哪些消息
 *
 * 首尾保护: 始终保留首 PROTECT_FIRST_N 条 + 末 effectiveLastN 条
 * (effectiveLastN = max(keepLastN, PROTECT_LAST_N), 即使用户传 N=0
 * 也强制保留尾 PROTECT_LAST_N 条, 避免误删当前交互)
 *
 * system 消息通常位于首部, 已被 PROTECT_FIRST_N 覆盖。
 * 若消息总数太少导致首尾区间重叠, 按引用去重。
 */
export function planKeepLastN(
  messages: SDKMessageRow[],
  keepLastN: number = 10
): {
  kept: SDKMessageRow[]
  dropped: SDKMessageRow[]
} {
  // effectiveLastN: 用户期望 N 与 PROTECT_LAST_N 取大, 保证兜底
  const effectiveLastN = Math.max(keepLastN, PROTECT_LAST_N)

  const firstN = messages.slice(0, PROTECT_FIRST_N)
  const lastN = messages.slice(-effectiveLastN)

  // 按引用去重 (避免消息总数太少时首尾区间重叠导致重复)
  const keptSet = new Set<SDKMessageRow>()
  const kept: SDKMessageRow[] = []
  for (const msg of [...firstN, ...lastN]) {
    if (!keptSet.has(msg)) {
      keptSet.add(msg)
      kept.push(msg)
    }
  }

  // dropped = 在原数组中但不在 keptSet 中的消息
  const dropped = messages.filter((m) => !keptSet.has(m))

  return { kept, dropped }
}

/**
 * P1-3: 主入口 — 执行压缩
 *
 * @param sessionId Agent session ID
 * @param input 压缩输入
 * @param workspaceId 工作区 ID（Desktop 2.0 路径组织；无则走旧 agent-sessions 路径）
 * @returns 压缩结果
 */
export async function compactSession(
  sessionId: string,
  input: CompactSessionInput,
  workspaceId?: string
): Promise<CompactSessionResult> {
  // 文件不存在 → 跳过
  const messages = readSdkMessages(workspaceId, sessionId) as SDKMessageRow[]

  if (messages.length === 0) {
    return {
      success: false,
      beforeCount: 0,
      afterCount: 0,
      droppedCount: 0,
      message: `Session ${sessionId} JSONL 不存在或为空, 无需压缩`,
    }
  }

  // 按策略选 plan 函数
  let plan: { kept: SDKMessageRow[]; dropped: SDKMessageRow[] } | null = null
  let strategyDesc: string | null = null
  switch (input.strategy) {
    case 'drop_old_tool_results':
      plan = planDropOldToolResults(messages)
      strategyDesc = 'drop_old_tool_results (丢老 tool_use/tool_result 对, 保留文本)'
      break
    case 'keep_last_n':
      plan = planKeepLastN(messages, input.keepLastN ?? 10)
      strategyDesc = `keep_last_n=${input.keepLastN ?? 10} (保留最近 N 条 user+assistant, 丢其余)`
      break
    case 'summarize':
      return {
        success: false,
        beforeCount: messages.length,
        afterCount: messages.length,
        droppedCount: 0,
        message: 'summarize 策略本期未实现 (M2+ 排期), 请用 drop_old_tool_results',
      }
  }

  if (!plan || !strategyDesc) {
    return {
      success: false,
      beforeCount: messages.length,
      afterCount: messages.length,
      droppedCount: 0,
      message: '未知策略, 压缩失败',
    }
  }

  // 写回 SDK JSONL（workspaceId 组织路径）
  writeSdkMessages(workspaceId, sessionId, plan.kept)

  return {
    success: true,
    beforeCount: messages.length,
    afterCount: plan.kept.length,
    droppedCount: plan.dropped.length,
    message: `${strategyDesc}: ${plan.dropped.length} 条已压缩`,
  }
}
