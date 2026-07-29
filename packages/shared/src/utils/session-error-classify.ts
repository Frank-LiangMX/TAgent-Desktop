/**
 * 会话错误分类（纯函数，主进程 + 单测共用）
 *
 * Round 4 会话可靠性：把 SDK / stderr / result 中的错误归到三类，驱动
 * 崩溃恢复（crash → re-spawn + resume 一次）与过长上下文降级
 * （prompt_too_long → 中文提示，不恢复）。
 * 见 docs/decisions/ADR-0002-longlived-process.md「已知缺口」。
 *
 * 设计为纯函数：无副作用、不读运行时状态，便于单测与跨核复用
 * （kscc 核进程崩 / Pi 核 Agent 抛错都可复用同一分类）。
 */

/** 错误分类结果（驱动 runtime 恢复/降级分流） */
export type SessionErrorKind = 'user_stop' | 'prompt_too_long' | 'crash' | 'unknown'

/**
 * 过长上下文匹配关键词。
 *
 * 覆盖多来源形态：
 * - Anthropic 原生：`prompt is too long` / `prompt_too_long`
 * - context length 系：`context_length_exceeded` / `maximum context length` / `exceeds ... context window`
 * - OpenAI 兼容（Pi 外部核可能）：`reduce the length of the messages`
 * - 中文（kscc 中转 / UI 文案）：`上下文过长` / `超出上下文` 等
 *
 * 刻意避免过宽（如裸 `too long` / `context window`），以免把正常上下文统计文案误判为错误。
 */
const PROMPT_TOO_LONG_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /prompt_too_long/i,
  /context[_ ]?length[_ ]?exceeded/i,
  /maximum context length/i,
  /exceeds?\s[\s\S]{0,40}context (?:window|length|size)/i,
  /input (?:length|size)[\s\S]{0,30}(?:too long|exceeds)/i,
  /reduce (?:the )?length of (?:the )?messages/i,
  /上下文过长|上下文超长|超出上下文|超过上下文|上下文[\s\S]{0,6}超/,
]

/**
 * 判断给定文本（可多段）是否为「过长上下文」类错误。
 * 任意一段命中即返回 true（SDK result.errors / 抛错 message / stderr 可能分段到达）。
 */
export function isPromptTooLongMessage(...texts: Array<string | null | undefined>): boolean {
  const combined = texts.filter(Boolean).join('\n')
  if (!combined) return false
  return PROMPT_TOO_LONG_PATTERNS.some((re) => re.test(combined))
}

/** 从 SDK result 消息提取 errors 文案数组（非 result 消息返回空） */
export function extractResultErrors(msg: unknown): string[] {
  if (msg == null || typeof msg !== 'object') return []
  const m = msg as { type?: unknown; errors?: unknown }
  if (m.type !== 'result') return []
  const errors = Array.isArray(m.errors) ? m.errors : []
  return errors.filter((e): e is string => typeof e === 'string')
}

/**
 * 判断 SDK result 消息是否为「过长上下文」错误。
 * 不限定 subtype：success result 无 errors 自然不命中；error 系 result 靠 errors 内容判定。
 */
export function isPromptTooLongResult(msg: unknown): boolean {
  if (msg == null || typeof msg !== 'object') return false
  const m = msg as { type?: unknown }
  if (m.type !== 'result') return false
  return isPromptTooLongMessage(...extractResultErrors(msg))
}

/** classifySessionError 输入 */
export interface ClassifySessionErrorInput {
  /** query generator 抛出的错误（可为非 Error） */
  error?: Error | unknown
  /** 累积的 stderr 文本（kscc 子进程 stderr） */
  stderr?: string
  /** SDK result 消息（含 errors 数组） */
  result?: unknown
  /** 用户主动 stop（destroy / interrupt）→ 优先判为 user_stop，不恢复 */
  stoppedByUser?: boolean
}

/**
 * 把会话错误归类为 user_stop / prompt_too_long / crash / unknown。
 *
 * 优先级：
 * 1. stoppedByUser → user_stop（用户主动停止，绝不自动恢复）
 * 2. 任一来源命中过长上下文 → prompt_too_long（降级提示，不恢复）
 * 3. 有明确错误信号但非过长 → crash（进程级故障，可尝试 resume 一次）
 * 4. 无任何信号 → unknown
 */
export function classifySessionError(input: ClassifySessionErrorInput): SessionErrorKind {
  if (input.stoppedByUser) return 'user_stop'

  const errText =
    input.error instanceof Error ? input.error.message : input.error != null ? String(input.error) : ''
  const stderrText = typeof input.stderr === 'string' ? input.stderr : ''
  const resultErrors = extractResultErrors(input.result)

  if (isPromptTooLongMessage(errText, stderrText, ...resultErrors)) return 'prompt_too_long'

  // 有明确错误信号但不是过长上下文 → 视为进程级 crash
  if (errText || stderrText || resultErrors.length > 0) return 'crash'

  return 'unknown'
}

/** 过长上下文中文错误文案（推给 renderer 的 session_error.message，见 Chat.tsx 渲染 `[错误] ...`） */
export const PROMPT_TOO_LONG_ERROR_TITLE = '对话上下文过长'
export const PROMPT_TOO_LONG_ERROR_MESSAGE =
  '当前会话的上下文已超出模型上限，无法继续。建议压缩上下文或新建会话后继续。'

/** 拼装过长上下文的可读错误文案（标题：正文） */
export function formatPromptTooLongError(): string {
  return `${PROMPT_TOO_LONG_ERROR_TITLE}：${PROMPT_TOO_LONG_ERROR_MESSAGE}`
}
