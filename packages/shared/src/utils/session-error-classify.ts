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

// ===== 用户可见错误分类（session_error 友好化） =====

/** 面向用户的错误类别码 */
export type UserFacingErrorCode =
  | 'prompt_too_long'
  | 'auth'
  | 'model_unavailable'
  | 'channel_disabled'
  | 'kscc_missing'
  | 'rate_limited'
  | 'billing'
  | 'network'
  | 'permission_denied'
  | 'unknown'

/** 用户可见错误（渲染层展示 title + message + retryable + 建议动作） */
export interface UserFacingError {
  code: UserFacingErrorCode
  title: string
  message: string
  /** 是否可重试（限流/网络可重试；账单/模型不可用不可重试） */
  retryable: boolean
  /** 建议动作（渲染层据此展示提示/按钮） */
  action?: 'settings' | 'switch_model' | 'compact' | 'none'
}

/** 错误文案 → 用户可见分类（正则匹配，按顺序，首中即止；未知走 unknown 保留原文） */
const USER_FACING_CLASSIFIERS: ReadonlyArray<{
  code: UserFacingErrorCode
  title: string
  pattern: RegExp
  retryable: boolean
  action?: UserFacingError['action']
}> = [
  {
    code: 'auth',
    title: '渠道认证失败',
    pattern: /api[- ]?key|authentication|未设置或解密失败|认证失败|登录失败|invalid.*token|unauthorized|401/i,
    retryable: true,
    action: 'settings',
  },
  {
    code: 'billing',
    title: '账户余额不足',
    pattern: /billing|insufficient|余额不足|账单|欠费|402|billing_error/i,
    retryable: false,
    action: 'settings',
  },
  {
    code: 'rate_limited',
    title: '请求过于频繁',
    pattern: /rate[- ]?limit|429|请求过于频繁|限流|too many requests/i,
    retryable: true,
  },
  {
    code: 'model_unavailable',
    title: '模型不可用',
    pattern: /model[_ ]?not[_ ]?found|invalid[_ ]?model|模型「[^」]+」不属于|模型「[^」]+」已停用|模型不存在|模型不可用/i,
    retryable: false,
    action: 'switch_model',
  },
  {
    code: 'channel_disabled',
    title: '渠道已停用',
    pattern: /渠道「[^」]+」已停用|channel.*disabled/i,
    retryable: false,
    action: 'settings',
  },
  {
    code: 'kscc_missing',
    title: 'kscc 未安装',
    pattern: /未检测到 kscc 命令|kscc.*not found|无法找到 kscc/i,
    retryable: false,
  },
  {
    code: 'network',
    title: '网络连接失败',
    pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang|连接失败|网络错误|连接被拒绝|超时|timeout/i,
    retryable: true,
  },
  {
    code: 'permission_denied',
    title: '权限被拒绝',
    pattern: /用户拒绝|权限拒绝|permission denied|deny/i,
    retryable: true,
  },
]

/**
 * 把一条错误文案分类为用户可见错误。
 * 过长上下文优先复用 isPromptTooLongMessage 的识别（多形态匹配），其余走模式表。
 */
export function classifyUserFacingError(message: string): UserFacingError {
  const text = message.trim()
  if (!text) return { code: 'unknown', title: '运行出错', message: text, retryable: false }

  if (isPromptTooLongMessage(text)) {
    return {
      code: 'prompt_too_long',
      title: PROMPT_TOO_LONG_ERROR_TITLE,
      message: PROMPT_TOO_LONG_ERROR_MESSAGE,
      retryable: false,
      action: 'compact',
    }
  }

  for (const classifier of USER_FACING_CLASSIFIERS) {
    if (classifier.pattern.test(text)) {
      return {
        code: classifier.code,
        title: classifier.title,
        message: text,
        retryable: classifier.retryable,
        action: classifier.action,
      }
    }
  }

  return { code: 'unknown', title: '运行出错', message: text, retryable: false }
}
