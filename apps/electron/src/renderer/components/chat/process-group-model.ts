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
export const PROCESS_GROUP_AUTO_COLLAPSE_SETTLE_MS = 900
/** 倒计时秒数（对齐 Proma/General） */
export const PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS = 3

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
    if (userToggled || !autoExpandWhenLive) return 'keep'
    return 'expand'
  }
  if (userToggled) return 'keep'
  return wasLive ? 'countdown' : 'collapse'
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
