/**
 * 主会话无进展防循环（No-Progress Guard）—— 纯判定器
 *
 * 规格真源：docs/dev/core-loop/NO-PROGRESS-GUARD-SPEC.md（§6 / §7 / §8 / §10.1 / §20）。
 *
 * 本模块只做纯判定：签名归一化、单轮状态机、有效进展判定、阈值推进、结构化原因。
 * 不直接操作 UI / IPC / 具体 SDK —— KSCC 与 Pi 适配层把各自事件翻译成
 * {@link ToolBatchObservation} 再喂本判定器，再把 {@link NoProgressDecision} 翻译回各自机制
 *（PostToolBatch additionalContext / PreToolUse deny / query.interrupt / Pi afterToolCall+abort）。
 *
 * 设计要点（§19 纯判定、薄适配）：
 * - 纯函数归一化 + 单真源状态机，便于单测与跨核复用；
 * - 时间判定以 observation.observedAt 为准（便于回放测试注入），构造时再传一个 now() 兜底；
 * - 不接收 SDK / Pi 私有事件，核心逻辑不与某个内核绑定；
 * - sensitive 信息裁剪：签名 / 摘要均经 scrubNoise 去噪，不保留完整命令输出 / 文件正文 / 密钥。
 *
 * 默认阈值见 {@link DEFAULT_NO_PROGRESS_THRESHOLDS}（§7）；后续可按影子模式数据调整。
 */
import type {
  NoProgressDecision,
  NoProgressDecisionKind,
  NoProgressEvent,
  NoProgressEventPhase,
  NoProgressGuardMode,
  NoProgressPhase,
  NoProgressReasonCode,
  ToolAttemptAdvice,
  ToolBatchObservation,
} from '@tagent/shared'

/**
 * 把守卫 decision 翻成 IPC {@link NoProgressEvent}（§20.4）。双核共用，避免两套翻译。
 * emitPhase 为空时按 'cleared' 兜底；shadow 模式带 `shadow:true`，UI 忽略。
 */
export function buildNoProgressEventFromDecision(
  decision: NoProgressDecision,
  mode: NoProgressGuardMode,
): NoProgressEvent {
  return {
    type: 'no_progress',
    phase: decision.emitPhase ?? 'cleared',
    reasonCodes: decision.reasonCodes,
    batchCount: decision.batchCount,
    noProgressBatchCount: decision.noProgressBatchCount,
    summary: decision.userMessage,
    shadow: mode === 'shadow',
  }
}

// ===== 阈值（§7；初始值，可按影子模式数据调整） =====

export interface NoProgressThresholds {
  /** §7.1.1 同一动作签名 + 相同失败结果签名 → 一级提醒 */
  sameFailureRepeat: number
  /** §7.1.2 同一文件累计编辑而验证结果未变 → 一级提醒 */
  sameFileEditsNoVerifyChange: number
  /** §7.1.3 连续工具批次无有效进展 → 一级提醒 */
  consecutiveNoProgressBatches: number
  /** §7.1.4 同一命令出现 2 次「超时且 stdout/stderr 均为空」→ 一级提醒 */
  sameCommandEmptyTimeoutWarn: number
  /** §7.2 进入 reflection_required 后再 3 个无进展批次 → 强制复盘 */
  batchesAfterReflection: number
  /** §7.3.1 强制复盘后仍尝试重复工具调用 2 次 → 暂停 */
  finalResponseViolationsPause: number
  /** §7.3.2 累计 12 个工具批次无有效进展 → 暂停 */
  totalNoProgressBatchesPause: number
  /** §7.3.3 相同空输出超时达到 4 次 → 暂停 */
  totalEmptyTimeoutPause: number
  /** §7.3.4 无进展状态持续超过 10 分钟且无用户输入/新证据 → 暂停 */
  noProgressDurationMs: number
}

export const DEFAULT_NO_PROGRESS_THRESHOLDS: NoProgressThresholds = {
  sameFailureRepeat: 3,
  sameFileEditsNoVerifyChange: 5,
  consecutiveNoProgressBatches: 8,
  sameCommandEmptyTimeoutWarn: 2,
  batchesAfterReflection: 3,
  finalResponseViolationsPause: 2,
  totalNoProgressBatchesPause: 12,
  totalEmptyTimeoutPause: 4,
  noProgressDurationMs: 10 * 60 * 1000,
}

/** 状态机内部状态（§10.1 扩展：增加 per-file / per-command 追踪以支持 §7.1.2 / §7.1.4） */
export interface NoProgressState {
  phase: NoProgressPhase
  batchCount: number
  noProgressBatchCount: number
  repeatedFailureCount: number
  emptyTimeoutCount: number
  batchesSinceReflection: number
  finalResponseViolations: number
  lastProgressAt: number
  turnStartAt: number
  lastUserInputAt: number
  lastActionSignature?: string
  lastOutcomeSignature?: string
  triggerReasons: NoProgressReasonCode[]
}

/** 复盘注入文案（§7.1 一级软提醒 / §7.2 二级强制复盘 / §11.2 暂停） */
const REFLECTION_PROMPT_SOFT = [
  '检测到连续工具调用未产生新证据。暂停原有局部试错，先比较最近几次尝试的假设、预期与实际结果；',
  '判断问题是否在验证方法、环境或问题定义。没有实质不同的新策略时，不要继续调用工具，应向用户汇报当前卡点。',
].join('')

const REFLECTION_PROMPT_FINAL = [
  '已多次无进展，进入强制复盘。请停止调用工具，用一段话收束本轮：',
  '① 已确认的事实；② 重复的失败模式（相同动作 + 相同结果）；③ 尚未验证的假设；',
  '④ 为何当前策略无法继续。不要再尝试与之前相同的工具调用；如确无新策略，请向用户说明卡点并等待指示。',
].join('')

const PAUSE_USER_MESSAGE = '已暂停：连续多次操作未获得新进展'
const WARN_SUMMARY = '检测到重复失败，正在重新评估策略'
const REFLECTION_SUMMARY = '连续无进展，已要求策略复盘'

// ===== 归一化：噪声裁剪（§6.3 去除时间戳 / 临时路径 / 随机 ID / 耗时） =====

const SCRUB_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // ISO 时间戳（先于 epoch / uuid，避免时间戳里的数字被当 epoch）
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  // uuid（先于 epoch：uuid 末段若全为数字会被 \b\d{10,13}\b 误吃）
  [/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<uuid>'],
  // epoch 毫秒 / 秒（10~13 位独立数字）
  [/\b\d{10,13}\b/g, '<ts>'],
  // 源码行号：foo.ts:42 → foo.ts:<ln>（同错误不同行视为同结果）
  [/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|md|json|yaml|yml|sh|rb|lua):(\d+)/g, '.$1:<ln>'],
  // 耗时数字：12ms / 3.4s / elapsed 5s / took 2 seconds
  [/\b(?:elapsed|took|duration|in)\s+\d+(?:\.\d+)?\s*(?:ms|millis(?:econds?)?|s|sec(?:onds?)?|min(?:utes?)?)/gi, '<dur>'],
  [/\b\d+(?:\.\d+)?\s*(?:ms|millis(?:econds?)?|sec(?:onds?)?)\b/gi, '<dur>'],
  // 临时路径
  [/(?:\/tmp\/|\/var\/folders\/|C:\\Users\\[^\\]+\\AppData\\Local\\Temp\\|%TEMP%\\)[^\s"'`]*/g, '<tmp>'],
  // pid
  [/\bpid[=: ]+\d+/gi, '<pid>'],
]

/** 去噪：把时间戳 / uuid / 行号 / 耗时 / 临时路径 / pid 替换为稳定占位符，避免同错误被误判为新结果 */
export function scrubNoise(text: string): string {
  if (!text) return ''
  let out = text
  for (const [re, token] of SCRUB_PATTERNS) {
    out = out.replace(re, token)
  }
  return out
}

/** FNV-1a 32 位哈希 → base36（非加密；仅做稳定摘要，避免比较长文本） */
function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 输入摘要上限（防超长文本拖慢签名；超出按前缀 + 长度兜底） */
const DIGEST_CAP = 8192

/** 稳定摘要：长度桶 + 去噪文本的 FNV。同输出 → 同摘要；去噪后仍不同 → 多半是新证据 */
function digest(text: string): string {
  const s = scrubNoise(text)
  const len = s.length
  const bucket = len === 0 ? '0' : len < 50 ? '1' : len < 200 ? '2' : len < 1000 ? '3' : len < 10000 ? '4' : '5'
  const body = len > DIGEST_CAP ? s.slice(0, DIGEST_CAP) + `…+${len - DIGEST_CAP}` : s
  return `${bucket}:${fnv1a(body)}`
}

/** 路径归一：盘符小写、反斜杠→正斜杠、折叠重复斜杠、去尾部斜杠 */
export function normalizePath(p: unknown): string {
  if (typeof p !== 'string' || !p) return ''
  let s = p.trim()
  // Windows 盘符小写
  if (/^[A-Za-z]:[\\/]/.test(s)) s = s[0].toLowerCase() + s.slice(1)
  s = s.replace(/\\/g, '/')
  // 折叠 ./ 与重复斜杠
  s = s.replace(/\/\.\//g, '/').replace(/\/+/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** 长度桶（编辑区域 / 写入大小，不把全文进签名） */
function lengthBucket(n: number): string {
  if (n <= 0) return '0'
  if (n < 20) return '1'
  if (n < 100) return '2'
  if (n < 500) return '3'
  if (n < 2000) return '4'
  return '5'
}

/** 折叠空白 */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Bash 命令主干归一（§6.2 忽略无意义空格 / 输出重定向差异）。
 * 去掉 `cd ... &&` 前缀（cwd 另作 target）、`> file` / `2>&1` / `| tee` / `2>/dev/null` 等重定向。
 */
function normalizeCommand(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return ''
  let s = collapseWs(raw)
  // 去 `cd 'x' && ` / `cd "x" && ` / `cd x && ` 前缀
  s = s.replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/i, '')
  // 去输出重定向与分页噪声
  s = s.replace(/\s*(?:2>&1|2>\/dev\/null|1>\/dev\/null|>\s*\/dev\/null)\b/g, '')
  s = s.replace(/\s*>\s*[^\s|&;]+/g, '') // > file
  s = s.replace(/\s*\|\s*tee\s+[^\s|&;]+/gi, '')
  s = s.replace(/\s*\|\s*more\b.*$/gi, '') // Windows more 分页
  return collapseWs(s)
}

/** 从 input（对象）安全取字符串字段 */
function getField(input: unknown, ...keys: string[]): unknown {
  if (input == null || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  for (const k of keys) {
    if (o[k] != null) return o[k]
  }
  return undefined
}

/** MCP 工具名（mcp__server__tool）拆出 server / tool */
function splitMcpName(toolName: string): { server: string; tool: string } | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const parts = toolName.slice(5).split('__')
  if (parts.length < 2) return undefined
  return { server: parts[0], tool: parts.slice(1).join('__') }
}

/** 稳定输入串：JSON 排序键 + 去噪 + 截断（MCP / 未知工具用） */
function stableInputString(input: unknown): string {
  if (input == null) return ''
  try {
    const json = stableStringify(input)
    return scrubNoise(json).slice(0, 512)
  } catch {
    return scrubNoise(String(input)).slice(0, 512)
  }
}

/** 稳定 JSON stringify：对象键排序，避免键序导致签名漂移 */
function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = sortKeysDeep(o[k])
    return out
  }
  return v
}

/** Edit 区域摘要：old/new 长度桶 + 头尾 FNV（不把替换文本全文进签名，§6.2） */
function regionDigest(oldStr: unknown, newStr: unknown): string {
  const o = typeof oldStr === 'string' ? oldStr : ''
  const n = typeof newStr === 'string' ? newStr : ''
  const headTail = (s: string): string => {
    const t = scrubNoise(s)
    if (t.length <= 80) return t
    return t.slice(0, 40) + '…' + t.slice(-40)
  }
  return `${lengthBucket(o.length)}:${lengthBucket(n.length)}:${fnv1a(headTail(o) + '|' + headTail(n))}`
}

/**
 * 动作签名（§6.2）：toolName + normalizedTarget + normalizedSemanticInput。
 * 设计为「同一件事」稳定，「不同事」可区分，且不泄漏完整正文 / 输出。
 */
export function actionSignature(toolName: string, input: unknown): string {
  const name = toolName || 'unknown'
  if (name === 'Bash') {
    const cmd = normalizeCommand(getField(input, 'command'))
    const cwd = normalizePath(getField(input, 'cwd'))
    return `Bash:${cwd}|${cmd}`
  }
  if (name === 'Edit' || name === 'MultiEdit') {
    const file = normalizePath(getField(input, 'file_path', 'path'))
    if (name === 'MultiEdit') {
      const edits = getField(input, 'edits')
      const n = Array.isArray(edits) ? edits.length : 0
      return `${name}:${file}|n=${n}`
    }
    const region = regionDigest(getField(input, 'old_string'), getField(input, 'new_string'))
    return `Edit:${file}|${region}`
  }
  if (name === 'Write') {
    const file = normalizePath(getField(input, 'file_path', 'path'))
    const content = getField(input, 'content')
    const len = typeof content === 'string' ? content.length : 0
    return `Write:${file}|${lengthBucket(len)}`
  }
  if (name === 'Read') return `Read:${normalizePath(getField(input, 'file_path', 'path'))}`
  if (name === 'Grep') return `Grep:${String(getField(input, 'pattern') ?? '')}|${normalizePath(getField(input, 'path', 'glob'))}`
  if (name === 'Glob') return `Glob:${String(getField(input, 'pattern') ?? '')}|${normalizePath(getField(input, 'path'))}`
  const mcp = splitMcpName(name)
  if (mcp) return `mcp__${mcp.server}__${mcp.tool}:${stableInputString(input)}`
  return `${name}:${stableInputString(input)}`
}

// ===== 结果解析（§6.3：status + exitCode + timeoutKind + normalizedError + meaningfulOutputDigest） =====

export interface ParsedOutcome {
  status: 'ok' | 'fail'
  exitCode?: number
  timeoutKind?: 'timeout' | 'empty_timeout'
  errorDigest?: string
  outputDigest?: string
  isFailure: boolean
}

/** 从任意形状的工具输出里抽取文本（stdout/stderr/content/result 等常见字段） */
function extractText(output: unknown, error?: string): string {
  if (output == null) return error ?? ''
  if (typeof output === 'string') return output
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>
    if (typeof o.stdout === 'string' || typeof o.stderr === 'string') {
      return [o.stdout, o.stderr].filter((x): x is string => typeof x === 'string').join('\n')
    }
    if (typeof o.content === 'string') return o.content
    if (Array.isArray(o.content)) {
      return o.content
        .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text?: unknown }).text ?? '') : ''))
        .join('\n')
    }
    if (typeof o.text === 'string') return o.text
    if (typeof o.result === 'string') return o.result
    if (typeof o.message === 'string') return o.message
    if (typeof o.output === 'string') return o.output
  }
  return error ?? ''
}

function extractExitCode(output: unknown, error: string, text: string): number | undefined {
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>
    for (const k of ['exitCode', 'exit_code', 'code', 'status']) {
      const v = o[k]
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
  }
  const m = /exit code\s*(\d+)/i.exec(error) || /exit code\s*(\d+)/i.exec(text)
  if (m) return Number(m[1])
  return undefined
}

const TIMEOUT_RE = /timeout|timed out|etimedout|\bTIMEOUT\b/i
const TIMEOUT_EXIT_CODES = new Set([124, 137, 143])

/** 是否超时（错误文案 / 退出码 / TIMEOUT 标记任一命中） */
function isTimeoutCall(error: string, text: string, exitCode?: number): boolean {
  if (TIMEOUT_RE.test(error) || TIMEOUT_RE.test(text)) return true
  if (exitCode != null && TIMEOUT_EXIT_CODES.has(exitCode)) return true
  return false
}

/** 解析 Bash（验证类）结果 */
function parseBashOutcome(output: unknown, error?: string): ParsedOutcome {
  const err = typeof error === 'string' ? error : ''
  const text = extractText(output, err)
  const exitCode = extractExitCode(output, err, text)
  const timeout = isTimeoutCall(err, text, exitCode)
  const meaningful = scrubNoise(text).trim()
  const isEmpty = meaningful.length === 0
  const timeoutKind: ParsedOutcome['timeoutKind'] | undefined = timeout
    ? isEmpty
      ? 'empty_timeout'
      : 'timeout'
    : undefined
  const status: 'ok' | 'fail' = exitCode != null ? (exitCode === 0 ? 'ok' : 'fail') : err ? 'fail' : 'ok'
  return {
    status,
    exitCode,
    timeoutKind,
    errorDigest: err ? digest(err) : undefined,
    outputDigest: digest(meaningful),
    isFailure: status === 'fail',
  }
}

/** 解析 Edit/Write 结果（成功 / 失败；不进正文） */
function parseEditOutcome(output: unknown, error?: string): ParsedOutcome {
  const err = typeof error === 'string' ? error : ''
  let isFailure = !!err
  if (!isFailure && output && typeof output === 'object') {
    const o = output as Record<string, unknown>
    if (o.is_error === true || o.isError === true || o.error) isFailure = true
  }
  return {
    status: isFailure ? 'fail' : 'ok',
    errorDigest: err ? digest(err) : undefined,
    outputDigest: undefined,
    isFailure,
  }
}

/** 按 toolName 选解析器 */
function parseOutcome(toolName: string, output: unknown, error?: string): ParsedOutcome {
  if (toolName === 'Bash') return parseBashOutcome(output, error)
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') return parseEditOutcome(output, error)
  // 其它（Read/Grep/Glob/MCP/Task/未知）：最小结果，仅用于日志，不驱动进展判定
  const err = typeof error === 'string' ? error : ''
  return { status: err ? 'fail' : 'ok', errorDigest: err ? digest(err) : undefined, isFailure: !!err }
}

/** 结果签名（§6.3） */
export function outcomeSignature(o: ParsedOutcome): string {
  return [o.status, o.exitCode ?? '', o.timeoutKind ?? '', o.errorDigest ?? '', o.outputDigest ?? ''].join('|')
}

// ===== 工具类型分类（决定是否驱动进展计数） =====

type ToolClass = 'verify' | 'edit' | 'neutral'

function classifyTool(toolName: string): ToolClass {
  if (toolName === 'Bash') return 'verify'
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') return 'edit'
  // Read/Grep/Glob 调查类权重低（§12.3）；MCP/Task/未知保守不计入主会话循环
  return 'neutral'
}

/** 单个调用的批次内分类结果 */
interface CallClass {
  /** progress=新证据 / noProgress=重复无进展 / neutral=首次或调查，不计入 */
  cls: 'progress' | 'noProgress' | 'neutral'
  actionSig: string
  outcomeSig: string
  outcome: ParsedOutcome
}

// ===== 守卫 =====

export interface NoProgressGuardOptions {
  mode?: NoProgressGuardMode
  thresholds?: Partial<NoProgressThresholds>
  /** 时钟（默认 Date.now）；时间判定以 observation.observedAt 为准，此回调仅用于 resetForNewTurn 兜底 */
  now?: () => number
}

export class NoProgressGuard {
  private mode: NoProgressGuardMode
  private thresholds: NoProgressThresholds
  private readonly now: () => number

  private phase: NoProgressPhase = 'observing'
  private batchCount = 0
  private noProgressBatchCount = 0
  private emptyTimeoutCount = 0
  private batchesSinceReflection = 0
  private finalResponseViolations = 0
  private repeatedFailureCount = 0
  private lastProgressAt: number
  private turnStartAt: number
  private lastUserInputAt: number
  private lastActionSignature: string | undefined
  private lastOutcomeSignature: string | undefined
  private hadSuccessfulEditSinceLastProgress = false

  /** 同一动作签名 + 相同失败结果签名 → 次数（§7.1.1） */
  private readonly actionOutcomeCounts = new Map<string, number>()
  /** 同一文件累计编辑次数（§7.1.2） */
  private readonly perFileEditCount = new Map<string, number>()
  /** 同一命令空输出超时次数（§7.1.4 / §7.3.3） */
  private readonly perCommandEmptyTimeout = new Map<string, number>()
  /** 上一轮某动作的结果签名（用于「结果是否变化」基线） */
  private readonly prevOutcomeByAction = new Map<string, string>()

  constructor(opts: NoProgressGuardOptions = {}) {
    this.mode = opts.mode ?? 'enforce'
    this.thresholds = { ...DEFAULT_NO_PROGRESS_THRESHOLDS, ...opts.thresholds }
    this.now = opts.now ?? (() => Date.now())
    const t = this.now()
    this.lastProgressAt = t
    this.turnStartAt = t
    this.lastUserInputAt = t
  }

  /** 当前模式（适配层据此决定是否注入 / 拦截 / 暂停） */
  getMode(): NoProgressGuardMode {
    return this.mode
  }

  /** 设置模式（session-service 注入环境变量解析结果） */
  setMode(mode: NoProgressGuardMode): void {
    this.mode = mode
  }

  /** 只读状态快照（§13 结构化日志用；不含完整命令 / 输出） */
  getState(): NoProgressState {
    return {
      phase: this.phase,
      batchCount: this.batchCount,
      noProgressBatchCount: this.noProgressBatchCount,
      repeatedFailureCount: this.repeatedFailureCount,
      emptyTimeoutCount: this.emptyTimeoutCount,
      batchesSinceReflection: this.batchesSinceReflection,
      finalResponseViolations: this.finalResponseViolations,
      lastProgressAt: this.lastProgressAt,
      turnStartAt: this.turnStartAt,
      lastUserInputAt: this.lastUserInputAt,
      lastActionSignature: this.lastActionSignature,
      lastOutcomeSignature: this.lastOutcomeSignature,
      triggerReasons: this.currentReasons(),
    }
  }

  /**
   * 新一轮用户消息开始时重置状态（§8：每条新用户消息重置为 observing，历史保留但计数不延续）。
   * 返回 cleared 决策：若上一轮处于非 observing 阶段，emitPhase='cleared' 供适配层清 UI 提示。
   */
  resetForNewTurn(at?: number): NoProgressDecision {
    const wasNonObserving = this.phase !== 'observing'
    const t = at ?? this.now()
    this.phase = 'observing'
    this.batchCount = 0
    this.noProgressBatchCount = 0
    this.emptyTimeoutCount = 0
    this.batchesSinceReflection = 0
    this.finalResponseViolations = 0
    this.repeatedFailureCount = 0
    this.lastProgressAt = t
    this.turnStartAt = t
    this.lastUserInputAt = t
    this.lastActionSignature = undefined
    this.lastOutcomeSignature = undefined
    this.hadSuccessfulEditSinceLastProgress = false
    this.actionOutcomeCounts.clear()
    this.perFileEditCount.clear()
    this.perCommandEmptyTimeout.clear()
    this.prevOutcomeByAction.clear()
    return this.buildDecision('continue', [], wasNonObserving ? 'cleared' : null)
  }

  /**
   * 处理一个工具批次（§7：每个批次完成后运行）。
   * 返回本批次的状态机推进决策；`emitPhase` 指示适配层是否下发 IPC 事件。
   */
  observe(batch: ToolBatchObservation): NoProgressDecision {
    if (this.phase === 'paused') {
      // 已暂停：幂等返回 pause，不再推进（适配层应在暂停后停止喂批次）
      return this.buildDecision('pause', ['reflection_ignored'], 'paused')
    }
    this.batchCount += 1

    let hasProgress = false
    let hasNoProgress = false

    for (const call of batch.calls ?? []) {
      const cls = this.classifyCall(call.toolName, call.input, call.output, call.error)
      this.lastActionSignature = cls.actionSig
      this.lastOutcomeSignature = cls.outcomeSig

      // verify 类：更新基线（progress/noProgress 都更新；neutral 首次也写入基线）
      if (classifyTool(call.toolName) === 'verify') {
        this.prevOutcomeByAction.set(cls.actionSig, cls.outcomeSig)
      }

      if (cls.cls === 'progress') {
        hasProgress = true
      } else if (cls.cls === 'noProgress') {
        hasNoProgress = true
      }

      // 失败结果签名计数（§7.1.1）：每次失败都计一次（含首次 neutral），按动作+结果签名聚合
      if (cls.outcome.isFailure) {
        const key = cls.actionSig + String.fromCharCode(1) + cls.outcomeSig
        const next = (this.actionOutcomeCounts.get(key) ?? 0) + 1
        this.actionOutcomeCounts.set(key, next)
        if (next > this.repeatedFailureCount) this.repeatedFailureCount = next
      }

      // edit 类：成功标记 + per-file 计数（edit 恒 neutral，不计入 np；仅 per-file 与失败计数）
      if (classifyTool(call.toolName) === 'edit') {
        const file = normalizePath(getField(call.input, 'file_path', 'path'))
        if (file) {
          this.perFileEditCount.set(file, (this.perFileEditCount.get(file) ?? 0) + 1)
        }
        if (!cls.outcome.isFailure) this.hadSuccessfulEditSinceLastProgress = true
      }

      // verify 类空输出超时计数（§7.1.4 / §7.3.3）
      if (classifyTool(call.toolName) === 'verify' && cls.outcome.timeoutKind === 'empty_timeout') {
        this.emptyTimeoutCount += 1
        this.perCommandEmptyTimeout.set(
          cls.actionSig,
          (this.perCommandEmptyTimeout.get(cls.actionSig) ?? 0) + 1,
        )
      }
    }

    // —— 批次级状态推进 ——
    if (hasProgress) {
      return this.handleProgress(batch.observedAt)
    }
    // 非进展批次（含 noProgress 与 neutral）：统一走阶段推进；
    // 仅 noProgress 才计入 noProgressBatchCount（7.1.3 / 7.3.2），neutral（Edit/Read）不计入，
    // 但 neutral 仍可能触发 7.1.2（同文件 5 次编辑）与 batchesSinceReflection 推进。
    return this.handleNoProgress(batch.observedAt, hasNoProgress)
  }

  /**
   * PreToolUse / beforeToolCall：final_response_only 阶段拦截工具并计数违规（§7.2 / §7.3.1）。
   * 非该阶段返回 allow:true（守卫不越权拦截）。
   */
  onPreToolUse(toolName: string, _input: unknown): ToolAttemptAdvice {
    if (this.phase !== 'final_response_only') {
      return { allow: true }
    }
    this.finalResponseViolations += 1
    if (this.finalResponseViolations >= this.thresholds.finalResponseViolationsPause) {
      this.phase = 'paused'
      const decision = this.buildDecision('pause', ['reflection_ignored'], 'paused', {
        userMessage: PAUSE_USER_MESSAGE,
      })
      return { allow: false, blockReason: REFLECTION_PROMPT_FINAL, pause: true, decision }
    }
    return { allow: false, blockReason: REFLECTION_PROMPT_FINAL }
  }

  // ===== 内部：状态推进 =====

  private handleProgress(observedAt: number): NoProgressDecision {
    const wasNonObserving = this.phase !== 'observing'
    // 有效进展 → 重置无进展累计（§6.4 / §8：新证据回 observing）
    this.noProgressBatchCount = 0
    this.batchesSinceReflection = 0
    this.repeatedFailureCount = 0
    this.actionOutcomeCounts.clear()
    this.perFileEditCount.clear()
    this.perCommandEmptyTimeout.clear()
    this.hadSuccessfulEditSinceLastProgress = false
    this.lastProgressAt = observedAt
    this.phase = 'observing'
    return this.buildDecision('continue', [], wasNonObserving ? 'cleared' : null)
  }

  private handleNoProgress(
    observedAt: number,
    hasNoProgress: boolean,
  ): NoProgressDecision {
    if (hasNoProgress) this.noProgressBatchCount += 1

    // —— 三级暂停：硬上限优先（覆盖任意阶段） ——
    const pauseReasons: NoProgressReasonCode[] = []
    const maxEmptyTimeout = this.maxPerCommandEmptyTimeout()
    if (maxEmptyTimeout >= this.thresholds.totalEmptyTimeoutPause) {
      pauseReasons.push('empty_timeout_repeated')
    }
    if (this.noProgressBatchCount >= this.thresholds.totalNoProgressBatchesPause) {
      pauseReasons.push('no_new_evidence')
    }
    if (
      this.noProgressBatchCount > 0 &&
      observedAt - this.lastProgressAt >= this.thresholds.noProgressDurationMs &&
      observedAt - this.lastUserInputAt >= this.thresholds.noProgressDurationMs
    ) {
      pauseReasons.push('time_without_progress')
    }
    if (pauseReasons.length > 0) {
      this.phase = 'paused'
      return this.buildDecision('pause', pauseReasons, 'paused', { userMessage: PAUSE_USER_MESSAGE })
    }

    // —— 阶段相关推进 ——
    if (this.phase === 'final_response_only') {
      // 强制复盘后仍有工具批次完成（漏过 PreToolUse）→ 计违规
      this.finalResponseViolations += 1
      if (this.finalResponseViolations >= this.thresholds.finalResponseViolationsPause) {
        this.phase = 'paused'
        return this.buildDecision('pause', ['reflection_ignored'], 'paused', {
          userMessage: PAUSE_USER_MESSAGE,
        })
      }
      return this.buildDecision('continue', [], null)
    }

    if (this.phase === 'reflection_required') {
      // 任意非进展批次（含 neutral 编辑）都推进复盘宽限计数（§7.2）
      this.batchesSinceReflection += 1
      if (this.batchesSinceReflection >= this.thresholds.batchesAfterReflection) {
        this.phase = 'final_response_only'
        return this.buildDecision('require_reflection', ['no_new_evidence'], 'reflection', {
          modelContext: REFLECTION_PROMPT_FINAL,
          userMessage: REFLECTION_SUMMARY,
        })
      }
      return this.buildDecision('continue', [], null)
    }

    // observing：评估一级提醒原因（§7.1；neutral 编辑批次也可能命中 7.1.2）
    const warnReasons = this.evaluateWarnReasons()
    if (warnReasons.length > 0) {
      this.phase = 'reflection_required'
      return this.buildDecision('warn', warnReasons, 'warning', {
        modelContext: REFLECTION_PROMPT_SOFT,
        userMessage: WARN_SUMMARY,
      })
    }
    return this.buildDecision('continue', [], null)
  }

  /** 评估一级提醒原因（§7.1） */
  private evaluateWarnReasons(): NoProgressReasonCode[] {
    const reasons: NoProgressReasonCode[] = []
    let hasFailingVerifyRepeat = false

    if (this.repeatedFailureCount >= this.thresholds.sameFailureRepeat) {
      reasons.push('same_failure_repeated')
      hasFailingVerifyRepeat = true
    }
    if (this.maxPerFileEditCount() >= this.thresholds.sameFileEditsNoVerifyChange) {
      reasons.push('same_target_edited_without_verification_change')
    }
    if (this.noProgressBatchCount >= this.thresholds.consecutiveNoProgressBatches) {
      reasons.push('no_new_evidence')
    }
    if (this.maxPerCommandEmptyTimeout() >= this.thresholds.sameCommandEmptyTimeoutWarn) {
      reasons.push('empty_timeout_repeated')
      hasFailingVerifyRepeat = true
    }
    // §7.1.5 信号错位：工具持续成功但验证连续失败
    if (hasFailingVerifyRepeat && this.hadSuccessfulEditSinceLastProgress) {
      reasons.push('action_success_goal_unchanged')
    }
    return reasons
  }

  // ===== 内部：单调用分类 =====

  private classifyCall(
    toolName: string,
    input: unknown,
    output: unknown,
    error?: string,
  ): CallClass {
    const actionSig = actionSignature(toolName, input)
    const outcome = parseOutcome(toolName, output, error)
    const outcomeSig = outcomeSignature(outcome)
    const tclass = classifyTool(toolName)

    if (tclass === 'verify') {
      const prev = this.prevOutcomeByAction.get(actionSig)
      if (prev == null) {
        // 首次观测：建基线，不算进展也不算重复（避免首条失败即扣分）
        return { cls: 'neutral', actionSig, outcomeSig, outcome }
      }
      if (prev === outcomeSig) {
        // 同动作 + 同结果 → 重复无进展
        return { cls: 'noProgress', actionSig, outcomeSig, outcome }
      }
      // 结果实质变化 → 新证据
      return { cls: 'progress', actionSig, outcomeSig, outcome }
    }

    if (tclass === 'edit') {
      // Edit/Write 成功只是动作完成，非目标进展（§6.4）；不进 np 计数，仅 per-file 计数
      return { cls: 'neutral', actionSig, outcomeSig, outcome }
    }

    // 调查 / MCP / Task / 未知：权重低，不计入
    return { cls: 'neutral', actionSig, outcomeSig, outcome }
  }

  // ===== 内部：聚合查询 =====

  private maxPerFileEditCount(): number {
    let m = 0
    for (const v of this.perFileEditCount.values()) if (v > m) m = v
    return m
  }

  private maxPerCommandEmptyTimeout(): number {
    let m = 0
    for (const v of this.perCommandEmptyTimeout.values()) if (v > m) m = v
    return m
  }

  private currentReasons(): NoProgressReasonCode[] {
    const reasons: NoProgressReasonCode[] = []
    if (this.phase === 'paused') reasons.push('reflection_ignored')
    if (this.phase === 'reflection_required' || this.phase === 'final_response_only') {
      if (this.repeatedFailureCount >= this.thresholds.sameFailureRepeat) reasons.push('same_failure_repeated')
      if (this.maxPerFileEditCount() >= this.thresholds.sameFileEditsNoVerifyChange) {
        reasons.push('same_target_edited_without_verification_change')
      }
      if (this.noProgressBatchCount >= this.thresholds.consecutiveNoProgressBatches) reasons.push('no_new_evidence')
      if (this.maxPerCommandEmptyTimeout() >= this.thresholds.sameCommandEmptyTimeoutWarn) {
        reasons.push('empty_timeout_repeated')
      }
    }
    return reasons
  }

  // ===== 内部：构造决策 =====

  private buildDecision(
    kind: NoProgressDecisionKind,
    reasonCodes: NoProgressReasonCode[],
    emitPhase: NoProgressEventPhase | null,
    extra?: { modelContext?: string; userMessage?: string },
  ): NoProgressDecision {
    return {
      kind,
      reasonCodes,
      phase: this.phase,
      batchCount: this.batchCount,
      noProgressBatchCount: this.noProgressBatchCount,
      repeatedFailureCount: this.repeatedFailureCount,
      emptyTimeoutCount: this.emptyTimeoutCount,
      modelContext: extra?.modelContext,
      userMessage: extra?.userMessage,
      emitPhase,
    }
  }
}
