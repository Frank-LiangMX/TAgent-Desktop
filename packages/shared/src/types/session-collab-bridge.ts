/**
 * 单会话 ↔ 协作室桥接契约层（14-SESSION-COLLAB-BRIDGE-SPEC §1–§3）
 *
 * 本切片只放类型、预算常量、裁剪/校验纯函数；不接服务层、不调 LLM、不读磁盘、
 * 不改 Electron IPC、不改 upgradeFusionSession / removeMember 主路径。供后续服务层
 * （summarize 调用 / upgrade·exit IPC / 写 room 背景 / 写回 session）按此契约接线。
 *
 * token 预算统一用字符近似：1 token ≈ 1.2 汉字（BRIDGE_CHARS_PER_TOKEN，14 §2）。
 * 这是审计近似，非精确 tokenizer；真正落盘裁剪以字符硬顶为准，tokenEstimate 仅供审计。
 */

// ===== 预算常量（须与 14 规格表 §2 一致） =====

/** 1 token ≈ 1.2 汉字（审计近似，非精确 tokenizer）。字符硬顶 = tokens × 该常量。 */
export const BRIDGE_CHARS_PER_TOKEN = 1.2

/** 进房前情提要：默认 3000 token / 硬顶 8000 token（14 §2）。 */
export const SESSION_TO_ROOM_BRIEF_DEFAULT_TOKENS = 3000
export const SESSION_TO_ROOM_BRIEF_HARD_MAX_TOKENS = 8000

/** 回写单会话：默认 2000 token / 硬顶 6000 token（14 §2，宁短勿长，保护长线程/记忆）。 */
export const ROOM_TO_SESSION_HANDOFF_DEFAULT_TOKENS = 2000
export const ROOM_TO_SESSION_HANDOFF_HARD_MAX_TOKENS = 6000

/** 协调者按需读原史：单次默认 1500 / 单次硬顶 2000 / 单轮累计硬顶 4000（14 §2）。 */
export const SOURCE_EXCERPT_PER_CALL_DEFAULT_TOKENS = 1500
export const SOURCE_EXCERPT_PER_CALL_HARD_MAX_TOKENS = 2000
export const SOURCE_EXCERPT_PER_TURN_HARD_MAX_TOKENS = 4000

// ===== 字符 ↔ token 换算（审计近似纯函数） =====

/**
 * 把 token 预算换算为字符硬顶。floor 取整偏保守（少给字符），使
 * `estimateBridgeTokenCount(text) <= tokens` 在 `text.length <= tokensToCharBudget(tokens)` 时成立。
 */
export function tokensToCharBudget(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return Math.floor(tokens * BRIDGE_CHARS_PER_TOKEN)
}

/**
 * 由文本长度反估 token 数（1.2 字符/token，ceil 偏保守）。
 *
 * 注意：这与 `@tagent/shared/utils` 的 `estimateTokenCount`（CJK≈1.5 / ASCII≈0.25 的精确
 * 启发式）是**不同函数**。本函数刻意用桥接规格 §2 的 1.2 近似，仅做预算审计。因 utils
 * 同名函数经顶层 `export *` barrel 已导出，此处用 `Bridge` 后缀避免 `export *` 冲突（TS2308）。
 */
export function estimateBridgeTokenCount(text: string): number {
  return Math.ceil(text.length / BRIDGE_CHARS_PER_TOKEN)
}

// ===== 通用文本裁剪 =====

export interface BridgeClampResult {
  /** 裁剪后的文本（可能等于原文本） */
  text: string
  /** 裁剪后文本的 token 估算（审计） */
  tokenEstimate: number
  /** 裁剪后文本的字符数 */
  charCount: number
  /** 是否发生了截断 */
  truncated: boolean
}

/**
 * 按字符硬顶裁剪文本：超则截断并尽量在**段落边界**（`\n\n`）截，找不到才硬切。
 * `maxTokens` 经 `tokensToCharBudget` 换算成字符上限。
 */
export function clampBridgeText(text: string, maxTokens: number): BridgeClampResult {
  const charBudget = tokensToCharBudget(maxTokens)
  if (text.length <= charBudget) {
    return {
      text,
      tokenEstimate: estimateBridgeTokenCount(text),
      charCount: text.length,
      truncated: false,
    }
  }
  const truncatedText = truncateAtParagraphBoundary(text, charBudget)
  return {
    text: truncatedText,
    tokenEstimate: estimateBridgeTokenCount(truncatedText),
    charCount: truncatedText.length,
    truncated: true,
  }
}

/** 把文本截到 maxChars 字符内，优先在段落边界 `\n\n` 截断；找不到段落边界才硬切。maxChars<=0 返回空。 */
function truncateAtParagraphBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return ''
  const slice = text.slice(0, maxChars)
  const para = slice.lastIndexOf('\n\n')
  if (para > 0) return slice.slice(0, para)
  return slice
}

// ===== 进房前情提要 SessionToRoomBrief =====

export interface SessionToRoomBrief {
  /** 当前目标 */
  goal: string
  /** 已确认结论（列表） */
  decisions: string[]
  /** 未决问题 */
  openQuestions: string[]
  /** 待办 */
  todos: string[]
  /** 关键路径 / 文件 / 约束 */
  artifacts: string[]
  /** 来源会话指针 */
  sourceSessionId: string
  /** 可选散文兜底；有结构化字段时投影优先用列表 */
  narrative?: string
  /** token 估算（审计近似，非精确 tokenizer） */
  tokenEstimate: number
  /** 字符数（审计） */
  charCount: number
}

/** buildSessionToRoomBrief 的输入：各字段原始值 + 来源会话 + 可选预算。 */
export interface SessionToRoomBriefInput {
  goal: string
  decisions: string[]
  openQuestions: string[]
  todos: string[]
  artifacts: string[]
  sourceSessionId: string
  narrative?: string
  /** token 预算；默认 DEFAULT，不得超过 HARD_MAX（超过即钳到 HARD_MAX） */
  budgetTokens?: number
}

const BRIEF_HEADER_GOAL = '## 目标'
const BRIEF_HEADER_SOURCE_SESSION = '## 来源会话'
const BRIEF_HEADER_DECISIONS = '## 已确认决定'
const BRIEF_HEADER_TODOS = '## 待办'
const BRIEF_HEADER_OPEN_QUESTIONS = '## 未决问题'
const BRIEF_HEADER_ARTIFACTS = '## 关键产物/路径'
const BRIEF_HEADER_NARRATIVE = '## 补充说明'

/**
 * 构造进房前情提要。按预算跨字段裁剪，优先级：
 * goal + sourceSessionId + decisions > todos > openQuestions > artifacts > narrative。
 * `budgetTokens` 缺省走 DEFAULT，超过 HARD_MAX 钳到 HARD_MAX。
 * `tokenEstimate` / `charCount` 基于拼装后的模板（即 formatSessionToRoomBriefForPrompt 的输出）。
 */
export function buildSessionToRoomBrief(input: SessionToRoomBriefInput): SessionToRoomBrief {
  const budgetTokens = clampBudget(
    input.budgetTokens,
    SESSION_TO_ROOM_BRIEF_DEFAULT_TOKENS,
    SESSION_TO_ROOM_BRIEF_HARD_MAX_TOKENS,
  )
  const charBudget = tokensToCharBudget(budgetTokens)
  const specs: ReadonlyArray<AllocFieldSpec> = [
    { key: 'goal', header: BRIEF_HEADER_GOAL, kind: 'string', raw: input.goal },
    { key: 'sourceSessionId', header: BRIEF_HEADER_SOURCE_SESSION, kind: 'string', raw: input.sourceSessionId },
    { key: 'decisions', header: BRIEF_HEADER_DECISIONS, kind: 'list', raw: input.decisions },
    { key: 'todos', header: BRIEF_HEADER_TODOS, kind: 'list', raw: input.todos },
    { key: 'openQuestions', header: BRIEF_HEADER_OPEN_QUESTIONS, kind: 'list', raw: input.openQuestions },
    { key: 'artifacts', header: BRIEF_HEADER_ARTIFACTS, kind: 'list', raw: input.artifacts },
    { key: 'narrative', header: BRIEF_HEADER_NARRATIVE, kind: 'string', raw: input.narrative ?? '' },
  ]
  const allocated = allocateFields(specs, charBudget)
  const goal = asString(allocated.get('goal'))
  const sourceSessionId = asString(allocated.get('sourceSessionId'))
  const decisions = asList(allocated.get('decisions'))
  const todos = asList(allocated.get('todos'))
  const openQuestions = asList(allocated.get('openQuestions'))
  const artifacts = asList(allocated.get('artifacts'))
  const narrative = asString(allocated.get('narrative'))
  const brief: SessionToRoomBrief = {
    goal,
    decisions,
    openQuestions,
    todos,
    artifacts,
    sourceSessionId,
    narrative: narrative.length > 0 ? narrative : undefined,
    tokenEstimate: 0,
    charCount: 0,
  }
  const rendered = renderSessionToRoomBrief(brief)
  brief.charCount = rendered.length
  brief.tokenEstimate = estimateBridgeTokenCount(rendered)
  return brief
}

/** 把 brief 渲染成稳定中文标题模板（不含硬顶 clamp），供 build 审计与 format 共用。 */
function renderSessionToRoomBrief(brief: SessionToRoomBrief): string {
  const blocks: string[] = []
  if (brief.goal.trim()) blocks.push(`${BRIEF_HEADER_GOAL}\n${brief.goal}`)
  if (brief.sourceSessionId.trim()) blocks.push(`${BRIEF_HEADER_SOURCE_SESSION}\n${brief.sourceSessionId}`)
  if (brief.decisions.length > 0) blocks.push(`${BRIEF_HEADER_DECISIONS}\n${renderList(brief.decisions)}`)
  if (brief.todos.length > 0) blocks.push(`${BRIEF_HEADER_TODOS}\n${renderList(brief.todos)}`)
  if (brief.openQuestions.length > 0) blocks.push(`${BRIEF_HEADER_OPEN_QUESTIONS}\n${renderList(brief.openQuestions)}`)
  if (brief.artifacts.length > 0) blocks.push(`${BRIEF_HEADER_ARTIFACTS}\n${renderList(brief.artifacts)}`)
  if (brief.narrative && brief.narrative.trim()) blocks.push(`${BRIEF_HEADER_NARRATIVE}\n${brief.narrative}`)
  return blocks.join('\n\n')
}

/**
 * 把 brief 渲染为可投影进 system / 房间背景的前情提要块；输出再过一次 HARD_MAX clamp（安全网，
 * 防止绕过 build 直接构造的巨大 brief 爆预算）。
 */
export function formatSessionToRoomBriefForPrompt(brief: SessionToRoomBrief): string {
  return clampBridgeText(renderSessionToRoomBrief(brief), SESSION_TO_ROOM_BRIEF_HARD_MAX_TOKENS).text
}

// ===== 回写单会话 RoomToSessionHandoff =====

export interface RoomToSessionHandoff {
  /** 协作结论 / 交付物 */
  outcomes: string[]
  /** 改了什么（文件 / 任务状态） */
  changes: string[]
  /** 未完成与风险 */
  risks: string[]
  /** 细节可查指针（房间） */
  roomId: string
  /** 来源会话指针 */
  sourceSessionId: string
  /** 可选散文兜底 */
  narrative?: string
  tokenEstimate: number
  charCount: number
}

/** buildRoomToSessionHandoff 的输入：各字段原始值 + 指针 + 可选预算。 */
export interface RoomToSessionHandoffInput {
  outcomes: string[]
  changes: string[]
  risks: string[]
  roomId: string
  sourceSessionId: string
  narrative?: string
  /** token 预算；默认 DEFAULT（更紧），不得超过 HARD_MAX */
  budgetTokens?: number
}

const HANDOFF_HEADER_OUTCOMES = '## 协作结论'
const HANDOFF_HEADER_SOURCE_ROOM = '## 来源房间'
const HANDOFF_HEADER_SOURCE_SESSION = '## 来源会话'
const HANDOFF_HEADER_CHANGES = '## 变更'
const HANDOFF_HEADER_RISKS = '## 风险与未完'
const HANDOFF_HEADER_NARRATIVE = '## 补充说明'

/**
 * 构造回写单会话摘要。对称于 buildSessionToRoomBrief，默认预算更紧（2000）。
 * 优先级：outcomes + roomId + sourceSessionId > changes > risks > narrative
 * （指针 roomId/sourceSessionId 极短，置于高位确保预算吃紧时仍存活）。
 */
export function buildRoomToSessionHandoff(input: RoomToSessionHandoffInput): RoomToSessionHandoff {
  const budgetTokens = clampBudget(
    input.budgetTokens,
    ROOM_TO_SESSION_HANDOFF_DEFAULT_TOKENS,
    ROOM_TO_SESSION_HANDOFF_HARD_MAX_TOKENS,
  )
  const charBudget = tokensToCharBudget(budgetTokens)
  const specs: ReadonlyArray<AllocFieldSpec> = [
    { key: 'outcomes', header: HANDOFF_HEADER_OUTCOMES, kind: 'list', raw: input.outcomes },
    { key: 'roomId', header: HANDOFF_HEADER_SOURCE_ROOM, kind: 'string', raw: input.roomId },
    { key: 'sourceSessionId', header: HANDOFF_HEADER_SOURCE_SESSION, kind: 'string', raw: input.sourceSessionId },
    { key: 'changes', header: HANDOFF_HEADER_CHANGES, kind: 'list', raw: input.changes },
    { key: 'risks', header: HANDOFF_HEADER_RISKS, kind: 'list', raw: input.risks },
    { key: 'narrative', header: HANDOFF_HEADER_NARRATIVE, kind: 'string', raw: input.narrative ?? '' },
  ]
  const allocated = allocateFields(specs, charBudget)
  const outcomes = asList(allocated.get('outcomes'))
  const roomId = asString(allocated.get('roomId'))
  const sourceSessionId = asString(allocated.get('sourceSessionId'))
  const changes = asList(allocated.get('changes'))
  const risks = asList(allocated.get('risks'))
  const narrative = asString(allocated.get('narrative'))
  const handoff: RoomToSessionHandoff = {
    outcomes,
    changes,
    risks,
    roomId,
    sourceSessionId,
    narrative: narrative.length > 0 ? narrative : undefined,
    tokenEstimate: 0,
    charCount: 0,
  }
  const rendered = renderRoomToSessionHandoff(handoff)
  handoff.charCount = rendered.length
  handoff.tokenEstimate = estimateBridgeTokenCount(rendered)
  return handoff
}

function renderRoomToSessionHandoff(handoff: RoomToSessionHandoff): string {
  const blocks: string[] = []
  if (handoff.outcomes.length > 0) blocks.push(`${HANDOFF_HEADER_OUTCOMES}\n${renderList(handoff.outcomes)}`)
  if (handoff.roomId.trim()) blocks.push(`${HANDOFF_HEADER_SOURCE_ROOM}\n${handoff.roomId}`)
  if (handoff.sourceSessionId.trim()) blocks.push(`${HANDOFF_HEADER_SOURCE_SESSION}\n${handoff.sourceSessionId}`)
  if (handoff.changes.length > 0) blocks.push(`${HANDOFF_HEADER_CHANGES}\n${renderList(handoff.changes)}`)
  if (handoff.risks.length > 0) blocks.push(`${HANDOFF_HEADER_RISKS}\n${renderList(handoff.risks)}`)
  if (handoff.narrative && handoff.narrative.trim()) blocks.push(`${HANDOFF_HEADER_NARRATIVE}\n${handoff.narrative}`)
  return blocks.join('\n\n')
}

/** 把 handoff 渲染为可写回单会话的摘要块；输出再过一次 HARD_MAX clamp。 */
export function formatRoomToSessionHandoffForPrompt(handoff: RoomToSessionHandoff): string {
  return clampBridgeText(renderRoomToSessionHandoff(handoff), ROOM_TO_SESSION_HANDOFF_HARD_MAX_TOKENS).text
}

// ===== 按需读原史：工具契约形状（只定义形状，不实现工具本体） =====

/** 协调者按需读原 session 摘录的请求（read_source_session_excerpt 工具契约）。 */
export interface SourceSessionExcerptRequest {
  sourceSessionId: string
  roomId: string
  /** 关键词或问题；实现层后续用 */
  query?: string
  /** 最近 N 条；实现层后续用 */
  recentMessageLimit?: number
  /** 调用方声明的 token 预算，须 ≤ PER_CALL hard max */
  maxTokens?: number
}

/** 按需读原史的响应。 */
export interface SourceSessionExcerptResult {
  sourceSessionId: string
  excerpt: string
  tokenEstimate: number
  charCount: number
  truncated: boolean
}

/**
 * 校验「按需读原史」的 token 预算：
 * - 单次 ≤ PER_CALL hard（超过即钳到 PER_CALL hard，不报错）；
 * - 单轮累计 ≤ PER_TURN hard（本调用 + 已用 ≤ PER_TURN hard，超出即按剩余给量）；
 * - 本轮预算耗尽或请求非正 → ok:false。
 * 成功返回实际允许的 `allowedTokens`（已钳到上述两条硬顶）。
 */
export function validateSourceExcerptBudget(
  requestedTokens: number | undefined,
  alreadyUsedThisTurnTokens: number,
): | { ok: true; allowedTokens: number }
  | { ok: false; reason: 'per-turn-budget-exhausted' | 'requested-non-positive' } {
  const used = Math.max(0, Math.trunc(alreadyUsedThisTurnTokens || 0))
  const perTurnRemaining = SOURCE_EXCERPT_PER_TURN_HARD_MAX_TOKENS - used
  if (perTurnRemaining <= 0) {
    return { ok: false, reason: 'per-turn-budget-exhausted' }
  }
  const requested =
    requestedTokens === undefined || Number.isNaN(requestedTokens)
      ? SOURCE_EXCERPT_PER_CALL_DEFAULT_TOKENS
      : Math.max(0, Math.trunc(requestedTokens))
  if (requested <= 0) {
    return { ok: false, reason: 'requested-non-positive' }
  }
  const allowedTokens = Math.min(
    requested,
    SOURCE_EXCERPT_PER_CALL_HARD_MAX_TOKENS,
    perTurnRemaining,
  )
  return { ok: true, allowedTokens }
}

// ===== 内部纯函数 =====

/** 字段预算分配规格：按顺序即优先级 = 显示顺序。 */
type AllocFieldSpec =
  | { readonly key: string; readonly header: string; readonly kind: 'string'; readonly raw: string }
  | { readonly key: string; readonly header: string; readonly kind: 'list'; readonly raw: ReadonlyArray<string> }

/**
 * 跨字段按优先级分配字符预算（贪心）：
 * 依次尝试纳入每个字段块（header + "\n" + 内容，块间 "\n\n"）；某块整块放不下时，
 * 字符串字段在段落边界截断到剩余空间，列表字段按完整条目纳入（放不下整条则丢弃该条及后续）。
 * 一旦预算耗尽，后续字段一律置空。
 */
function allocateFields(
  specs: ReadonlyArray<AllocFieldSpec>,
  charBudget: number,
): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>()
  let remaining = charBudget
  let includedCount = 0
  for (const spec of specs) {
    if (spec.kind === 'string') {
      if (spec.raw.trim().length === 0) {
        out.set(spec.key, '')
        continue
      }
      const overhead = spec.header.length + 1 + (includedCount > 0 ? 2 : 0)
      const available = remaining - overhead
      if (available <= 0) {
        out.set(spec.key, '')
        continue
      }
      const trimmed = truncateAtParagraphBoundary(spec.raw, available)
      if (trimmed.length === 0) {
        out.set(spec.key, '')
        continue
      }
      out.set(spec.key, trimmed)
      remaining -= overhead + trimmed.length
      includedCount += 1
    } else {
      const items = spec.raw.filter((s) => s.trim().length > 0)
      if (items.length === 0) {
        out.set(spec.key, [])
        continue
      }
      const overhead = spec.header.length + 1 + (includedCount > 0 ? 2 : 0)
      const available = remaining - overhead
      if (available <= 0) {
        out.set(spec.key, [])
        continue
      }
      const kept: string[] = []
      let used = 0
      for (const item of items) {
        const cost = (kept.length > 0 ? 1 : 0) + 2 + item.length // 前置 "\n"（非首条）+ "- " + 条目
        if (used + cost <= available) {
          kept.push(item)
          used += cost
        } else {
          break
        }
      }
      if (kept.length === 0) {
        out.set(spec.key, [])
        continue
      }
      out.set(spec.key, kept)
      remaining -= overhead + used
      includedCount += 1
    }
  }
  return out
}

/** 把列表渲染成 Markdown 无序列表行。 */
function renderList(items: ReadonlyArray<string>): string {
  return items.map((item) => `- ${item}`).join('\n')
}

/** 钳制预算：缺省→默认；负数→0；超过 hardMax→hardMax；正常→floor 取整。 */
function clampBudget(requested: number | undefined, defaultTokens: number, hardMax: number): number {
  if (requested === undefined || Number.isNaN(requested)) return defaultTokens
  if (requested < 0) return 0
  if (requested > hardMax) return hardMax
  return Math.floor(requested)
}

function asString(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : ''
}

function asList(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : []
}
