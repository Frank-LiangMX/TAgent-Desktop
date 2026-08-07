/**
 * 过程区纯逻辑：自动折叠状态机 + 思考/中间文本预览
 *
 * 从 ProcessGroupView 抽出，便于 node 环境单测（组件本体依赖 DOM 与 @tagent/ui）。
 */

import type { ProcessEntry } from './session-turn-model'

// ===== 自动折叠 =====

/**
 * live 结束到倒计时开始之间的静置时间。
 * 工具循环里 live 可能瞬时抖到 false，静置期内一旦回到 live，定时器被清掉，不会误收。
 */
export const PROCESS_GROUP_AUTO_COLLAPSE_SETTLE_MS = 2500
/** 倒计时秒数（对齐 Proma/General） */
export const PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS = 3

/**
 * 思考行 live→idle 后保持展开的 settle 时长（ms）：先让用户读完尾部，再 CSS 过渡折起。
 * 对齐 concise `ThinkingFold` 的 `THINK_SETTLE_MS`（1.5–2.5s 区间）；REGRESS-F 移植到 full 思考行。
 */
export const THINKING_ROW_SETTLE_MS = 1800

export type ProcessGroupCollapsePlan =
  /** 展开并保持（运行中） */
  | 'expand'
  /** 静置 + 倒计时后收起（本轮刚结束且用户没插手） */
  | 'countdown'
  /** 立即收起（非本轮结束的静态渲染，如历史轮挂载） */
  | 'collapse'
  /** 保持现状（用户手动 toggle 过） */
  | 'keep'

export interface ProcessGroupCollapseInput {
  /** 本轮仍在跑 */
  live: boolean
  /** 上一次求值时是否在跑 */
  wasLive: boolean
  /** 用户手动 toggle 过折叠态 */
  userToggled: boolean
  /** 调用方允许运行中自动展开（子代理详情页为 false） */
  autoExpandWhenLive: boolean
}

/**
 * 过程组折叠决策。
 *
 * 新一轮开始（`live && !wasLive`）时复位「用户手动 toggle」，本轮结束后仍能自动收起。
 */
export function planProcessGroupCollapse(
  input: ProcessGroupCollapseInput,
): ProcessGroupCollapsePlan {
  const { live, wasLive, autoExpandWhenLive } = input
  const userToggled = live && !wasLive ? false : input.userToggled

  if (live) {
    // 简洁 / 子代理：未手动展开时强制收起（勿用 keep——从 full 切过来会残留 expanded）
    if (!autoExpandWhenLive) return userToggled ? 'keep' : 'collapse'
    if (userToggled) return 'keep'
    return 'expand'
  }
  if (userToggled) return 'keep'
  // 简洁模式：body 本就默认收起，live→idle 不要倒计时
  if (!autoExpandWhenLive) return 'collapse'
  return wasLive ? 'countdown' : 'collapse'
}

// ===== 思考行 settle（REGRESS-F，对齐 concise ThinkingFold） =====

export type ThinkingRowSettlePlan =
  /** 进入新一轮 live：武装 settle（结束时再折） */
  | 'arm'
  /** live→idle：起 settle 定时器，到期后再折 */
  | 'settle'
  /** 无转换（仍 live / 仍 idle） */
  | 'noop'

/**
 * 思考行 settle 决策（纯函数，可单测）。
 *
 * - `isLive && !wasLive` → `arm`：新一轮开始，复位「已 settle」以便结束时再走 settle 窗口。
 * - `!isLive && wasLive` → `settle`：本轮刚结束，起 ~`THINKING_ROW_SETTLE_MS` 定时器后再折。
 * - 其余 → `noop`（仍 live / 仍 idle，无转换）。
 *
 * 组件据此在 effect 里更新 `wasLive` ref 与 settle 定时器；`open` 在 settle 窗口内保持 true，
 * 窗口外（且 collapsible、非用户 override）才折起——避免 live→false 瞬间 null 卸 body 换预览。
 */
export function planThinkingRowSettle(input: {
  isLive: boolean
  wasLive: boolean
}): ThinkingRowSettlePlan {
  const { isLive, wasLive } = input
  if (isLive) return wasLive ? 'noop' : 'arm'
  return wasLive ? 'settle' : 'noop'
}

// ===== 思考预览 =====

/** 折叠态纯文本预览行数上限 */
export const THINKING_PREVIEW_MAX_LINES = 4
/** 折叠态纯文本预览字符上限 */
export const THINKING_PREVIEW_MAX_CHARS = 200

/**
 * 是否「够长才值得折叠」。
 * 静态阈值判定，不读 DOM：live 段每帧变长也不会触发测量/重排抖动。
 */
export function shouldCollapseThinking(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return t.length > THINKING_PREVIEW_MAX_CHARS || t.split('\n').length > THINKING_PREVIEW_MAX_LINES
}

/** 折叠态纯文本预览：取前 N 行，整体再限字符数（不解析 Markdown） */
export function buildThinkingPreview(text: string): string {
  const lines = text.trim().split('\n')
  let preview = lines.slice(0, THINKING_PREVIEW_MAX_LINES).join('\n')
  if (preview.length > THINKING_PREVIEW_MAX_CHARS) {
    preview = `${preview.slice(0, THINKING_PREVIEW_MAX_CHARS)}…`
  } else if (lines.length > THINKING_PREVIEW_MAX_LINES) {
    preview = `${preview}…`
  }
  return preview
}

// ===== 过程内中间文本 =====

/** 中间文本折叠预览行的字符上限（仅用于预览行，展开后是全文） */
export const PROCESS_TEXT_PREVIEW_MAX_CHARS = 120
/** 超过此长度才提供折叠（短文段直接全展开） */
export const PROCESS_TEXT_COLLAPSE_CHAR_THRESHOLD = 600
/** 超过此行数才提供折叠 */
export const PROCESS_TEXT_COLLAPSE_LINE_THRESHOLD = 12

/** 中间文本是否长到值得给一个折叠开关（默认仍展开，只是可收） */
export function shouldCollapseProcessText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return (
    t.length > PROCESS_TEXT_COLLAPSE_CHAR_THRESHOLD ||
    t.split('\n').length > PROCESS_TEXT_COLLAPSE_LINE_THRESHOLD
  )
}

/** 折叠态单行预览（压掉换行） */
export function buildProcessTextPreview(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > PROCESS_TEXT_PREVIEW_MAX_CHARS
    ? `${t.slice(0, PROCESS_TEXT_PREVIEW_MAX_CHARS)}…`
    : t
}

// ===== 当前正在写的段 =====

/**
 * 末尾同类型条目的 key（live 时只有它算「正在写」）。
 * holdOpen 收窄的依据：历史思考段不该在整轮 live 期间全部强制展开。
 */
export function findLastProcessKey(
  process: ProcessEntry[],
  type: ProcessEntry['type'],
): string | null {
  for (let i = process.length - 1; i >= 0; i--) {
    const entry = process[i]
    if (entry?.type === type) return entry.key
  }
  return null
}

// ===== 简洁模式投影 =====

/**
 * 简洁模式过程投影（W2）：把所有 thinking 条目合并成**一个**思考块（拼接文本），
 * tool / text 条目保序保留。数据层 ProcessEntry[] 单真源不动——这里只产出
 * 「投影后」的渲染序列，供 ProcessGroupView 在 concise 展开 body 时渲染。
 *
 * - thinking：拼接所有非空思考文本（`\n\n` 分段），置于首个 thinking 出现位置；
 *   其余 thinking 条目折叠进这一块，避免「每段思考各占一行」。
 * - tool：原样保留（短句短语 + 默认不展 JSON 由 ProcessGroupView 行为保证）。
 * - text：原样保留（弱样式 / 折叠预览由 ProcessTextRow 处理，不抢回答区）。
 */
export function projectConciseProcess(process: ProcessEntry[]): ProcessEntry[] {
  const thinkingTexts: string[] = []
  for (const p of process) {
    if (p.type === 'thinking' && p.thinking.trim()) thinkingTexts.push(p.thinking.trim())
  }
  const merged = thinkingTexts.length > 0 ? thinkingTexts.join('\n\n') : ''
  const result: ProcessEntry[] = []
  let mergedEmitted = false
  for (const p of process) {
    if (p.type === 'thinking') {
      if (!mergedEmitted && merged) {
        result.push({ type: 'thinking', key: 'concise-thinking-merged', thinking: merged })
        mergedEmitted = true
      }
      continue
    }
    result.push(p)
  }
  return result
}

// ===== 过程组渲染拆分（REGRESS-K1） =====

export type ThinkingProcessEntry = Extract<ProcessEntry, { type: 'thinking' }>

export interface ProcessRenderSplit {
  /** 常驻渲染的思考行（toggle 头下，不受 showBody 影响） */
  thinking: ThinkingProcessEntry[]
  /** 过程正文：工具 + 中间文本（仅在 showBody 内渲染） */
  body: ProcessEntry[]
}

/**
 * 思考行 vs 过程正文（工具/中间文本）拆分（REGRESS-K1）。
 *
 * full 默认路径的过程组 idle 后会自动收起 `__body`（`showBody=false`）。若思考行留在
 * `__body` 内，整段 body 卸 DOM 时思考行一起消失——执行块连「思考了片刻」头都不剩。
 * 这里把思考行单独拆出，让组件在 toggle 头下**常驻渲染**思考行（不受 showBody 影响），
 * 工具/中间文本仍只在 `showBody` 内。思考正文继续默认收起（对齐 Cursor 扫光头），但不再
 * 随 body 卸载而消失。
 *
 * - concise：复用 `projectConciseProcess`（所有 thinking 合并成一块），拆出后仍是一个思考块。
 * - full：原 `process` 保序，thinking 与 tool/text 分到两条序列。
 */
export function splitProcessForRender(
  process: ProcessEntry[],
  displayMode: ProcessDisplayMode,
): ProcessRenderSplit {
  const projected = displayMode === 'concise' ? projectConciseProcess(process) : process
  const thinking: ThinkingProcessEntry[] = []
  const body: ProcessEntry[] = []
  for (const entry of projected) {
    if (entry.type === 'thinking') thinking.push(entry)
    else body.push(entry)
  }
  return { thinking, body }
}

// ===== 过程组标题 =====

export type ProcessDisplayMode = 'full' | 'concise'

export interface ProcessGroupHeaderInput {
  live: boolean
  /** 运行中一行提示（工具短语 / 思考截断）；非 live 可忽略 */
  liveHint: string | null
  toolCount: number
  thinkingCount: number
  /** 已完成的工具数（live 进度） */
  toolsDone: number
  /** 兜底 label（summarizeProcess.label） */
  fallbackLabel: string
  displayMode: ProcessDisplayMode
  /**
   * 思考时长（秒）。concise idle 用「思考了 N 秒」；
   * undefined 时退回「思考了几秒」或步数文案。
   */
  thinkingDurationSec?: number
}

/** 过程组折叠标题：full 用步数摘要；concise idle 对齐 Cursor「思考了 N 秒」 */
export function buildProcessGroupHeaderLabel(input: ProcessGroupHeaderInput): string {
  const {
    live,
    liveHint,
    toolCount,
    thinkingCount,
    toolsDone,
    fallbackLabel,
    displayMode,
    thinkingDurationSec,
  } = input

  if (live) {
    const steps = toolCount > 0 ? `${toolsDone}/${toolCount}` : null
    if (liveHint && steps) return `${liveHint} · ${steps}`
    if (liveHint) return liveHint
    return '正在思考与执行…'
  }

  if (displayMode === 'concise') {
    const thought =
      thinkingCount > 0
        ? thinkingDurationSec != null && thinkingDurationSec > 0
          ? `思考了 ${thinkingDurationSec} 秒`
          : '思考了几秒'
        : null
    if (thought && toolCount > 0) return `${thought} · ${toolCount} 步`
    if (thought) return thought
    if (toolCount > 0) return `已执行 ${toolCount} 步`
    return fallbackLabel
  }

  if (toolCount > 0 && thinkingCount > 0) {
    return `已执行 ${toolCount} 步 · 含 ${thinkingCount} 段思考`
  }
  if (toolCount > 0) return `已执行 ${toolCount} 步`
  if (thinkingCount > 0) return `思考 ${thinkingCount} 段`
  return fallbackLabel
}

