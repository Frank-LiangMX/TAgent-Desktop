/**
 * MoA 历史注入纯函数。
 *
 * 按 SPEC §2 把会话面板消息（user / assistant 文本）拼成参考席 / 汇总席的「近期会话上下文」。
 * 渲染层只负责拉历史，主进程 `runMoaTurn` 在落盘 user 后调用 `buildMoAHistoryFromMessages`
 * 拼上下文块，再喂给 `runReferenceModels` / `runAggregatorModel`。
 *
 * 设计取舍：
 * - 不依赖 `@tagent/shared` 之外的依赖，便于单测；
 * - 接受已转 IR 后的 `{ type, content }[]`（`TAgentMessage` 形态）而非原始 SDKMessage；
 *   主进程调用方在传入前用 `sdkMessageToIR` 转一次。这样纯函数只关心文本提取逻辑。
 * - 字符预算 12000（默认，可参数化）：超限从最旧截断，保留近轮，**整条超长则截断到预算**。
 * - 跳过：纯工具噪声（assistant 全是 tool_use / tool_result）、非 user/assistant 类型；
 *   提取文本块（type='text'）拼接；tool_result 当作 user 旁白以 `[工具结果]` 前缀收下。
 * - 实现选择「落盘 user 后组历史」→ 历史**不**含本轮刚写入的 user（避免重复）。
 *   与 brief SPEC §2 的「组完再 persist」路径相反；runMoaTurn 调用顺序决定。
 */

import type { TAgentMessage } from './tagent-message'
import type { SDKMessage } from './agent'
import { sdkMessageToIR } from '../utils/kscc-message-adapter'

/** 默认字符预算（对齐 SPEC §2） */
export const DEFAULT_MOA_HISTORY_CHAR_BUDGET = 12_000

/** 一轮对话的纯文本片段（提取后） */
export interface MoAHistoryTurn {
  /** 'user' / 'assistant' */
  role: 'user' | 'assistant'
  /** 拼接后的纯文本（不含工具调用 / thinking） */
  text: string
}

/** 单轮文本提取选项（默认空） */
export interface ExtractMoAHistoryTurnOptions {
  /** 单轮最大字符数；超出会被截断（避免单条巨型工具结果炸预算） */
  perTurnMaxChars?: number
}

/** 从单条 IR 消息提取纯文本片段；非 user/assistant 返回 null。 */
export function extractMoATurnText(
  msg: TAgentMessage,
  opts: ExtractMoAHistoryTurnOptions = {},
): MoAHistoryTurn | null {
  if (msg.type !== 'user' && msg.type !== 'assistant') return null
  const parts: string[] = []
  for (const block of msg.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push(block.text)
    } else if (block.type === 'thinking') {
      // assistant thinking 不进 MoA 历史（占预算且无业务价值）
      continue
    } else if (block.type === 'tool_use') {
      // 参考席 + 汇总席都无工具，工具调用结构对它们无意义；跳过
      continue
    } else if (block.type === 'tool_result') {
      // 工具结果作为 user 旁白：保留文本提示上下文（用户视角的「这条命令的回执」）
      const c = block.content
      if (typeof c === 'string') parts.push(`[工具结果] ${c}`)
      else if (Array.isArray(c)) {
        const text = c
          .filter((x): x is { type: 'text'; text: string } =>
            !!x && typeof x === 'object' && (x as { type?: string }).type === 'text')
          .map((x) => x.text)
          .join('\n')
        if (text) parts.push(`[工具结果] ${text}`)
      }
    }
    // 其它未知块类型忽略
  }
  if (parts.length === 0) return null
  let text = parts.join('\n').trim()
  if (!text) return null
  const max = opts.perTurnMaxChars ?? 2000
  if (text.length > max) text = `${text.slice(0, max)}\n…[已截断]`
  return { role: msg.type, text }
}

/** 拼装选项 */
export interface BuildMoAHistoryOptions {
  /** 字符预算；超限从最旧端截断。默认 12000 */
  charBudget?: number
  /** 单轮最大字符数（默认 2000） */
  perTurnMaxChars?: number
  /**
   * 丢弃末条消息：调用方已把「本轮 user」落盘到面板末尾，拼历史时应排除它，
   * 避免与稍后拼接的「本轮议题」重复（新会话首条尤甚：历史本应为空，否则议题
   * 会被当成「上一轮 user」再问一遍——参考席 2 倍、汇总席 4 倍重复）。
   *
   * `runMoaTurn` 在 `persistAndPushUser` 之后调用：末条即本轮 user → 传 true 排除。
   * 默认 false（历史 = 全部传入消息，兼容旧调用 / 单测）。
   */
  excludeTrailingTurn?: boolean
}

/**
 * 从面板消息数组拼出 `[会话上下文]…\n\n` 字符串。预算超限从最旧截断。
 *
 * 返回字符串形如：
 * ```
 * [会话上下文]
 * [user] 上一轮的问题…
 * [assistant] 上一轮的回答…
 *
 * ```
 *
 * 空历史返回 `''`（调用方直接拼议题即可）。
 */
export function buildMoAHistoryFromMessages(
  messages: readonly TAgentMessage[],
  opts: BuildMoAHistoryOptions = {},
): string {
  const charBudget = opts.charBudget ?? DEFAULT_MOA_HISTORY_CHAR_BUDGET
  // 末条 = 本轮 user（调用方 persistAndPushUser 刚落盘）：排除以免与「本轮议题」重复
  const source =
    opts.excludeTrailingTurn && messages.length > 0 ? messages.slice(0, -1) : messages
  if (charBudget <= 0 || source.length === 0) return ''
  const perTurnMax = opts.perTurnMaxChars ?? 2000

  // 1. 顺序遍历 → 抽取每轮纯文本；保留索引便于后段截断
  const turns: MoAHistoryTurn[] = []
  for (const m of source) {
    const t = extractMoATurnText(m, { perTurnMaxChars: perTurnMax })
    if (t) turns.push(t)
  }
  if (turns.length === 0) return ''

  // 2. 从尾部往前累加，超预算时停止
  const HEADER = '[会话上下文]\n'
  const FOOTER = '\n\n'
  const labelOf = (r: 'user' | 'assistant'): string => (r === 'user' ? '[用户]' : '[助手]')
  const segments: string[] = []
  let total = HEADER.length + FOOTER.length
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    const seg = `${labelOf(t.role)} ${t.text}\n`
    if (total + seg.length > charBudget) {
      // 单条就超预算：截断到剩余预算（保首段，因最新轮最有价值；不过此处是倒序累加，
      // 已经是相对新的轮，丢弃老轮已能保近轮）
      const remaining = charBudget - total
      if (remaining > 0) {
        const clipped = `${seg.slice(0, Math.max(0, remaining - 6))}…\n`
        segments.unshift(clipped)
        total += clipped.length
      }
      break
    }
    segments.unshift(seg)
    total += seg.length
  }
  if (segments.length === 0) return ''
  return HEADER + segments.join('') + FOOTER
}

/**
 * 把会话上下文拼到本轮议题前。
 *
 * 若 historyText 为空，只返回 prompt；否则返回 `[会话上下文]…\n\n[本轮议题]\n{prompt}`。
 *
 * 这就是参考席 / 汇总席最终收到的 user message 文本。汇总席的 system prompt 仍由
 * `buildAggregatorPrompt` 生成；本函数只负责 user 侧前缀。
 */
export function composeMoaPrompt(
  prompt: string,
  historyText: string,
): string {
  if (!historyText) return prompt
  return `${historyText}[本轮议题]\n${prompt}`
}

// ===== 续聊注入：面板原始消息 → 历史 =====

/**
 * 面板原始消息（SDKMessage 或 IR）→ IR（TAgentMessage）；非 user/assistant 返回 null。
 *
 * 面板格式跨核混排：
 * - kscc 普通路径落盘 **SDKMessage**（`message.content` 嵌套）；
 * - pi 普通路径落盘 **IR**（`content` 顶层）；
 * - MoA `persistAndPushUser` / `persistAndPushFinalAssistant` 一律落 **SDKMessage**（双写）。
 * 故「会诊后普通续聊」的面板可能 SDKMessage / IR 混排——例如外部渠会诊落 SDKMessage、
 * 随后 pi 普通续聊落 IR。本函数对每条先按形态归一再喂给 `buildMoAHistoryFromMessages`，
 * 复用其字符预算 / `[用户]·[助手]` 标签 / 超限截断，避免在调用方再写一遍提取逻辑。
 */
export function panelMessageToHistoryIR(raw: unknown): TAgentMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as { type?: string; message?: { content?: unknown }; content?: unknown }
  const type = m.type
  if (type !== 'user' && type !== 'assistant') return null
  // IR 形态（pi 面板）：content 数组在顶层 → 直接当 IR
  if (Array.isArray(m.content)) return raw as TAgentMessage
  // SDKMessage 形态（kscc 面板 / MoA 落盘）：content 嵌套在 message.content → 走转译
  if (m.message && Array.isArray(m.message.content)) {
    const { message } = sdkMessageToIR(raw as SDKMessage)
    return message ?? null
  }
  // 兜底：交 sdkMessageToIR 尝试（仍可能返回 null，如空 content）
  const { message } = sdkMessageToIR(raw as SDKMessage)
  return message ?? null
}

/**
 * 续聊注入：把面板原始消息（SDKMessage / IR 混排）转 IR，再拼 `[会话上下文]…` 历史。
 *
 * 用途（`AUDIT-fresh-session-consult-FINDINGS` · P0 #1）：普通路径首条 spawn 且无
 * `sdkSessionId`（会诊后 / 迁移期老会话 / Pi 重启无内存 state）时，把近期历史拼进本轮
 * prompt，避免新进程零上文（模型回「这个会话没有上文」）。kscc 无 sdkSessionId 不能
 * resume JSONL；Pi 无 resume 概念、首条 Agent `messages:[]`——两核均靠此注入补上下文。
 *
 * 复用 `buildMoAHistoryFromMessages`：字符预算 12000、`[用户]·[助手]` 标签、超限从最旧截断。
 *
 * `excludeTrailingTurn` 默认 **true**：调用方（`session-service.handleSend`）已把本轮 user
 * 落盘到面板末尾，拼历史时排除它，以免与稍后拼接的「本轮议题」重复（新会话首条尤甚：
 * 历史本应为空，否则议题会被当成「上一轮 user」再问一遍）。传 false 则保留末条（兼容旧调用）。
 *
 * 读失败 / 历史为空 → 返回 ''（调用方直接拼议题，行为不变）。
 */
export function buildResumeHistoryFromPanel(
  rawPanel: readonly unknown[],
  opts: {
    excludeTrailingTurn?: boolean
    charBudget?: number
    perTurnMaxChars?: number
  } = {},
): string {
  const irs: TAgentMessage[] = []
  for (const raw of rawPanel) {
    const ir = panelMessageToHistoryIR(raw)
    if (ir) irs.push(ir)
  }
  return buildMoAHistoryFromMessages(irs, {
    excludeTrailingTurn: opts.excludeTrailingTurn ?? true,
    charBudget: opts.charBudget,
    perTurnMaxChars: opts.perTurnMaxChars,
  })
}