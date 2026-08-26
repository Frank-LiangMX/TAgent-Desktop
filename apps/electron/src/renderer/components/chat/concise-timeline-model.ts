/**
 * Cursor 式简洁时间线 — 纯函数投影
 *
 * 阶段生命周期（对齐 Cursor）：
 *   live：摘要行累积 + 底部当前动作滚动态（Grepping / 搜索中…）
 *   done：收成折叠块（不消失）
 *   expand：按时间序明细 — 思考 / 探索 / 编辑（含 +N -M），点击再看详情
 *
 * - work_stage.steps：阶段内 chronological 工具步骤；思考作为独立折叠段
 * - narrative.progress / final：方向短总结 / 最终正文
 */
import {
  cleanFilePathInput,
  compactStageProgress,
  isToolCallArtifactText,
  sanitizeAssistantTextForDisplay,
} from '@tagent/shared'
import type { FileEditPatch } from '@tagent/shared'
import type { ProcessEntry } from './session-turn-model'
import { formatThinkingSummary, resolveThinkingDurationSec } from './session-turn-model'
import { getToolPhrase } from './tool-phrase'

export type ToolFamily = 'explore' | 'edit' | 'shell' | 'search' | 'other'

export type ToolProcessEntry = Extract<ProcessEntry, { type: 'tool' }>

export type WorkStageStep =
  | { kind: 'thinking'; key: string; thinking: string; durationSec?: number }
  | {
      kind: 'tool'
      key: string
      tool: ToolProcessEntry
      diff?: { add: number; del: number }
    }

export type ConciseSegment =
  | {
      kind: 'thinking'
      key: string
      thinking: string
      summary: string
      durationSec?: number
    } // 首轮工具前 + 中段非琐碎思考（打断阶段，对齐 Cursor）
  | {
      kind: 'work_stage'
      key: string
      steps: WorkStageStep[]
      tools: ToolProcessEntry[]
      summary: string
      diffAdd?: number
      diffDel?: number
    }
  | { kind: 'guidance'; key: string; text: string }
  | { kind: 'narrative'; key: string; text: string; tone: 'progress' | 'final' }

const SEARCH_RE = /^(grep|search|semanticsearch|websearch)/i
const EXPLORE_RE =
  /^(read|glob|webfetch|list|ls|find|catalog)/i
const EDIT_RE =
  /^(edit|write|multiedit|notebookedit|strreplace|search_replace|apply|create|delete|remove|patch)/i
const SHELL_RE = /^(bash|shell|terminal|cmd|powershell|exec)/i

export function classifyToolFamily(name: string): ToolFamily {
  const n = name.trim()
  if (!n) return 'other'
  if (SEARCH_RE.test(n)) return 'search'
  if (EXPLORE_RE.test(n)) return 'explore'
  if (EDIT_RE.test(n)) return 'edit'
  if (SHELL_RE.test(n)) return 'shell'
  return 'other'
}

function toolFileHint(tool: ToolProcessEntry): string | null {
  const fp = toolFilePath(tool)
  if (!fp) return null
  return fp.split(/[/\\]/).pop() || fp
}

/** 编辑工具 input 中的完整路径（句尾 Files Changed 用） */
export function toolFilePath(tool: ToolProcessEntry): string | null {
  const input = tool.tool.input ?? {}
  const fp = input.file_path ?? input.filePath ?? input.path
  if (typeof fp !== 'string' || !fp.trim()) return null
  const cleaned = cleanFilePathInput(fp)
  return cleaned || null
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '',
      )
      .join('\n')
  }
  if (content == null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function lineCount(text: string): number {
  if (!text) return 0
  return text.split('\n').length
}

/**
 * 从工具 input 估算 +/-（对齐 TAgent_General computeDiffStats）：
 * Edit/StrReplace：old→new 行数；Write：content 行数视为新增。
 * 兼容 pi（oldText/newText）与 kscc（old_string/new_string）两套字段。
 */
export function computeDiffFromInput(
  toolName: string,
  input: Record<string, unknown>,
): { add: number; del: number } | undefined {
  const name = toolName.trim()
  if (/^write$/i.test(name)) {
    const content = input.content ?? input.new_string ?? input.newText
    if (typeof content !== 'string' || !content) return undefined
    return { add: lineCount(content), del: 0 }
  }
  if (/^(edit|strreplace|search_replace|multiedit)$/i.test(name)) {
    const oldString = input.old_string ?? input.oldText ?? input.old_str
    const newString = input.new_string ?? input.newText ?? input.new_str
    if (typeof oldString !== 'string' || typeof newString !== 'string') return undefined
    return { add: lineCount(newString), del: lineCount(oldString) }
  }
  return undefined
}

/** 从单条 tool result 解析 +N -M。优先成对 `+N -M`；缺边时单独识别 +N 或 -M；
 *  结果文案无统计时回退从 input 估算（Write/Edit 实际常只回 "ok"）。
 *  都得不到才返回 undefined（UI 隐藏空占位）。 */
export function extractToolDiff(
  tool: ToolProcessEntry,
): { add: number; del: number } | undefined {
  if (classifyToolFamily(tool.tool.name) !== 'edit') return undefined
  const text = resultText(tool.result?.content)
  if (text) {
    const both = text.match(/\+(\d+)\s+[^\d-]*-(\d+)/) || text.match(/\+(\d+).*?-(\d+)/)
    if (both) return { add: Number(both[1]) || 0, del: Number(both[2]) || 0 }
    const add = text.match(/\+\d+/)
    const del = text.match(/(?:\s|^)-(\d+)/)
    if (add || del) {
      return {
        add: add ? Number(add[0].replace('+', '')) || 0 : 0,
        del: del ? Number(del[1]) || 0 : 0,
      }
    }
  }
  return computeDiffFromInput(tool.tool.name, tool.tool.input ?? {})
}

/** 单族簇摘要（细节/兼容）；阶段行用 summarizeWorkStage */
export function summarizeToolCluster(
  family: ToolFamily,
  tools: ToolProcessEntry[],
): string {
  if (tools.length === 0) return '执行'
  const names = tools.map((t) => toolFileHint(t)).filter(Boolean) as string[]
  const unique = [...new Set(names)]
  const pending = tools.some((t) => !t.result)

  if (family === 'edit') {
    if (unique.length === 1) {
      return pending ? `正在编辑 ${unique[0]}` : `编辑了 ${unique[0]}`
    }
    return pending
      ? `正在编辑 ${tools.length} 个文件`
      : `编辑了 ${unique.length || tools.length} 个文件`
  }
  if (family === 'explore') {
    if (tools.length === 1) {
      const phrase = getToolPhrase(tools[0]!.tool.name, tools[0]!.tool.input ?? {})
      return pending ? phrase.loadingLabel : phrase.label
    }
    return pending
      ? `正在探索 ${tools.length} 项`
      : `探索了 ${tools.length} 个文件`
  }
  if (family === 'search') {
    return pending
      ? `正在搜索 ${tools.length} 次`
      : `${tools.length} 次搜索`
  }
  if (family === 'shell') {
    if (tools.length === 1) {
      const phrase = getToolPhrase(tools[0]!.tool.name, tools[0]!.tool.input ?? {})
      return pending ? phrase.loadingLabel : phrase.label
    }
    return pending ? `正在运行 ${tools.length} 条命令` : `运行了 ${tools.length} 条命令`
  }
  if (tools.length === 1) {
    const phrase = getToolPhrase(tools[0]!.tool.name, tools[0]!.tool.input ?? {})
    return pending ? phrase.loadingLabel : phrase.label
  }
  return pending ? `正在执行 ${tools.length} 步` : `执行了 ${tools.length} 步`
}

/**
 * 阶段摘要：编辑了 N 个文件，探索了 M 个文件，K 次搜索，运行了 C 条命令
 * 对齐 Cursor「Edited 7 files, explored 2 files…」——live 也用完成态措辞，
 * 只累积计数，避免顶栏「正在…」随工具切换掠过。
 * 单文件编辑例外：写「编辑了 Foo.tsx」，对齐 Cursor「Edited Foo.tsx +N -M」。
 */
export function summarizeWorkStage(tools: ToolProcessEntry[]): string {
  if (tools.length === 0) return '执行'
  const buckets: Record<ToolFamily, ToolProcessEntry[]> = {
    edit: [],
    explore: [],
    search: [],
    shell: [],
    other: [],
  }
  for (const t of tools) {
    buckets[classifyToolFamily(t.tool.name)].push(t)
  }

  const parts: string[] = []
  if (buckets.edit.length) {
    const names = buckets.edit
      .map((t) => toolFileHint(t))
      .filter(Boolean) as string[]
    const unique = [...new Set(names)]
    // 单文件：直接「编辑了 Foo.tsx」，对齐 Cursor「Edited Foo.tsx +N -M」；勿写「编辑了 1 个文件」
    if (unique.length === 1) {
      parts.push(`编辑了 ${unique[0]}`)
    } else {
      parts.push(`编辑了 ${unique.length || buckets.edit.length} 个文件`)
    }
  }
  if (buckets.explore.length) {
    const n = buckets.explore.length
    parts.push(`探索了 ${n} 个文件`)
  }
  if (buckets.search.length) {
    const n = buckets.search.length
    parts.push(`${n} 次搜索`)
  }
  if (buckets.shell.length) {
    const n = buckets.shell.length
    parts.push(`运行了 ${n} 条命令`)
  }
  if (buckets.other.length) {
    const n = buckets.other.length
    parts.push(`执行了 ${n} 步`)
  }
  return parts.join('，') || '已执行'
}

/** @deprecated 用 diffAdd/diffDel；保留聚合字符串给旧测试 */
export function extractDiffHint(tools: ToolProcessEntry[]): string | undefined {
  let add = 0
  let del = 0
  let found = false
  for (const t of tools) {
    const d = extractToolDiff(t)
    if (!d) continue
    add += d.add
    del += d.del
    found = true
  }
  if (!found) return undefined
  return `+${add} -${del}`
}

export function aggregateDiff(
  tools: ToolProcessEntry[],
): { add: number; del: number } | undefined {
  let add = 0
  let del = 0
  let found = false
  for (const t of tools) {
    const d = extractToolDiff(t)
    if (!d) continue
    add += d.add
    del += d.del
    found = true
  }
  return found ? { add, del } : undefined
}

/** 本轮编辑过的文件（按路径合并；句尾 Cursor 式 Files Changed） */
export type TurnEditedFile = {
  path: string
  name: string
  add: number
  del: number
}

export function collectTurnEditedFiles(process: ProcessEntry[]): TurnEditedFile[] {
  const map = new Map<string, TurnEditedFile>()
  for (const entry of process) {
    if (entry.type !== 'tool') continue
    if (classifyToolFamily(entry.tool.name) !== 'edit') continue
    // 尚无 result 的 live 编辑不进句尾（避免半截路径闪现）
    if (!entry.result) continue
    const path = toolFilePath(entry)
    if (!path) continue
    const diff = extractToolDiff(entry) ?? { add: 0, del: 0 }
    const key = path.replace(/\\/g, '/').toLowerCase()
    const prev = map.get(key)
    if (prev) {
      prev.add += diff.add
      prev.del += diff.del
    } else {
      map.set(key, {
        path,
        name: path.split(/[/\\]/).pop() || path,
        add: diff.add,
        del: diff.del,
      })
    }
  }
  return [...map.values()]
}

/**
 * 本轮编辑工具的行级补丁（供 Files Changed 审阅还原旧稿 / 算 unified diff）。
 *
 * 与 {@link collectTurnEditedFiles} 同源：只收 `family===edit` 且**已有 result** 的工具，
 * 路径用 {@link toolFilePath}；pending / Read 不收。MultiEdit 拆成多条 replace（按 edits[] 顺序）。
 *
 * 字段别名兼容 pi（oldText/newText/old_str/new_str）与 kscc（old_string/new_string）两套；
 * Write 的 content（或 new_*）视为整文件新内容 → kind:'write'（无 oldText，reconstructBefore 返回 ''）。
 */
export function collectTurnFilePatches(process: ProcessEntry[]): FileEditPatch[] {
  const patches: FileEditPatch[] = []
  for (const entry of process) {
    if (entry.type !== 'tool') continue
    if (classifyToolFamily(entry.tool.name) !== 'edit') continue
    if (!entry.result) continue
    const path = toolFilePath(entry)
    if (!path) continue
    const input = entry.tool.input ?? {}
    const name = entry.tool.name.trim()

    if (/^write$/i.test(name)) {
      const content = input.content ?? input.new_string ?? input.newText ?? input.new_str
      if (typeof content === 'string') {
        patches.push({ path, kind: 'write', newText: content })
      }
      continue
    }

    if (/^multiedit$/i.test(name)) {
      const edits = input.edits
      if (Array.isArray(edits)) {
        for (const e of edits) {
          if (!e || typeof e !== 'object') continue
          const o = (e as Record<string, unknown>).old_string
            ?? (e as Record<string, unknown>).oldText
            ?? (e as Record<string, unknown>).old_str
          const n = (e as Record<string, unknown>).new_string
            ?? (e as Record<string, unknown>).newText
            ?? (e as Record<string, unknown>).new_str
          if (typeof o === 'string' && typeof n === 'string') {
            patches.push({ path, kind: 'replace', oldText: o, newText: n })
          }
        }
      }
      continue
    }

    if (/^(edit|strreplace|search_replace)$/i.test(name)) {
      const o = input.old_string ?? input.oldText ?? input.old_str
      const n = input.new_string ?? input.newText ?? input.new_str
      if (typeof o === 'string' && typeof n === 'string') {
        patches.push({ path, kind: 'replace', oldText: o, newText: n })
      }
      continue
    }
  }
  return patches
}

/**
 * 展开行 / live 滚动态文案（对齐 Cursor「Editing X」「Grepping」「Thought briefly」）
 */
export function getWorkStepLabel(
  step: WorkStageStep,
  opts?: { pending?: boolean; liveElapsedSec?: number },
): string {
  if (step.kind === 'thinking') {
    return formatThinkingSummary(step.durationSec, {
      live: opts?.pending,
      liveElapsedSec: opts?.liveElapsedSec,
    })
  }
  const tool = step.tool
  const pending = opts?.pending ?? !tool.result
  const name = tool.tool.name
  const input = tool.tool.input ?? {}
  const family = classifyToolFamily(name)
  const file = toolFileHint(tool)

  if (pending) {
    // 对齐 Cursor live：「Editing X.tsx」——带具体文件/模式，不用空泛「编辑中」
    if (family === 'search') {
      const pattern = typeof input.pattern === 'string' ? input.pattern : ''
      const short = pattern.length > 28 ? `${pattern.slice(0, 28)}…` : pattern
      return short ? `搜索 ${short}` : '搜索中'
    }
    if (family === 'edit') {
      if (/^write$/i.test(name)) return file ? `写入 ${file}` : '正在写入'
      return file ? `编辑 ${file}` : '正在编辑'
    }
    if (family === 'explore') {
      if (/^read$/i.test(name) && file) return `读取 ${file}`
      return file ? `探索 ${file}` : '正在探索'
    }
    if (family === 'shell') {
      const cmd = typeof input.command === 'string' ? input.command.trim() : ''
      if (cmd) {
        const short = cmd.length > 42 ? `${cmd.slice(0, 42)}…` : cmd
        return `运行 ${short}`
      }
      return '运行命令中'
    }
    return getToolPhrase(name, input).loadingLabel
  }

  if (family === 'search') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const short = pattern.length > 36 ? `${pattern.slice(0, 36)}…` : pattern
    return short ? `搜索 ${short}` : '搜索'
  }
  if (family === 'edit') {
    // 对齐 Cursor「Edited Foo.tsx」；+N -M 由 StageStepRow DiffHint 另挂
    return file ? `编辑了 ${file}` : '编辑了文件'
  }
  if (family === 'explore' && /^read$/i.test(name)) {
    const offset = typeof input.offset === 'number' ? input.offset : undefined
    const limit = typeof input.limit === 'number' ? input.limit : undefined
    if (file && offset !== undefined && limit !== undefined) {
      return `读取 ${file} L${offset}-${offset + limit}`
    }
    return file ? `读取 ${file}` : '读取文件'
  }
  return getToolPhrase(name, input).label
}

/** live 阶段底部当前动作（对齐 Cursor「Editing X.tsx」：带具体文件/模式，可扫光）。
 *  末步是思考时回「正在思考…」，阶段收起时仍有扫光反馈。 */
export function getLiveStatusFromSteps(steps: WorkStageStep[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!
    if (s.kind === 'tool' && !s.tool.result) {
      return getWorkStepLabel(s, { pending: true })
    }
    if (s.kind === 'thinking') {
      return formatThinkingSummary(s.durationSec, { live: true })
    }
  }
  return undefined
}

export function isDeliverableThinking(text: string): boolean {
  const t = text.trim()
  if (t.length < 20) return false
  if (/\*\*[^*]+\*\*/.test(t)) return true
  if (/^#{1,3}\s+\S/m.test(t)) return true
  if (/(^|[\n。；])\s*(结论|综上|因此|所以|简言之|总的来说|我看了|看起来|改造深度)/.test(t)) {
    return true
  }
  if (t.length >= 100 && /[。！？]/.test(t) && !isTrivialThinking(t)) return true
  return false
}

export function isTrivialThinking(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/\*\*[^*]+\*\*/.test(t) || /^#{1,3}\s/m.test(t)) return false
  if (t.length <= 16) return true
  if (
    t.length <= 80 &&
    /^(好的|嗯|接下来|然后|让我|我来|我先|下一步|继续|先(看|读|查|跑|搜|打开))/m.test(t)
  ) {
    return true
  }
  return false
}

/**
 * 极短的段间进度短文判定（仅按长度）。历史用途：live 是否把短文当打字机 progress。
 *
 * 注意：REGRESS-N 已否决「idle 按长度一刀切 continue 丢短 progress」（原 J1/J4）——
 * 阈值无法区分 filler 与「正在跑验证」这类有信息短句，会把阶段性总结丢成「流完即消」。
 * 现在合并阶段只看 {@link isFillerProgressText}（纯 filler 才吞）；有信息短句常驻
 * `narrative.progress`。本函数保留给 live / 测试用，不再作 idle 丢弃判据。
 */
export const SHORT_PROGRESS_MAX_CHARS = 20

export function isShortProgressText(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  return t.length <= SHORT_PROGRESS_MAX_CHARS
}

/**
 * 纯 filler 段间短文：仅 acknowledger / 过渡词（「好的」「嗯」「继续」「然后」…），
 * 无动作对象、无结论。**仅此类**允许 idle 吞掉以合并连续工具 stage；
 * 有信息的进度句（哪怕短，如「正在跑验证」「准备编辑」「目录摸清了」）必须常驻
 * `narrative.progress`——REGRESS-N 否决 REGRESS-J(J1)「按长度一刀切 continue 丢短 progress」。
 *
 * 与 {@link isTrivialThinking} 同源（极短无信息），但更窄：带动词对象 / 状态 / 结论的不算 filler。
 * 回合末（round-final）文本不走此规则——即便字面是 filler 也可能是用户的短回答，不得丢。
 */
const FILLER_PROGRESS_RE =
  /^(好的|好|嗯|哦|ok|okay|行|可以|了解|收到|明白|继续|接着|接下来|然后|下一步)\s*[。.!！？?…~]*$/i

export function isFillerProgressText(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.length > 16) return false
  return FILLER_PROGRESS_RE.test(t)
}

function mergeAnswerIntoProcess(
  process: ProcessEntry[],
  answerTexts?: string[],
  streamingText?: string,
): ProcessEntry[] {
  const extras: string[] = []
  if (answerTexts) {
    for (const t of answerTexts) {
      const x = t.trim()
      if (x) extras.push(x)
    }
  }
  const stream = streamingText?.trim() ?? ''
  if (stream) {
    const lastExtra = extras[extras.length - 1]
    if (!lastExtra) extras.push(stream)
    else if (stream.startsWith(lastExtra) || lastExtra.startsWith(stream)) {
      extras[extras.length - 1] = stream.length >= lastExtra.length ? stream : lastExtra
    } else {
      extras.push(stream)
    }
  }
  if (extras.length === 0) return process

  const out = [...process]
  for (const text of extras) {
    const last = out[out.length - 1]
    if (last?.type === 'text') {
      const prev = last.text.trim()
      if (!prev) {
        out[out.length - 1] = { ...last, text }
        continue
      }
      if (text.startsWith(prev) || prev.startsWith(text)) {
        out[out.length - 1] = {
          ...last,
          text: text.length >= prev.length ? text : prev,
        }
        continue
      }
    }
    if (
      out.some(
        (p) =>
          p.type === 'text' &&
          (p.text.trim() === text || text.startsWith(p.text.trim())),
      )
    ) {
      continue
    }
    out.push({ type: 'text', key: `narrative-extra-${out.length}`, text })
  }
  return out
}

/**
 * 推一条 narrative 段（段间 progress / 句尾 final）。
 *
 * **稳定 key（REGRESS-O O1）**：narrative 的 React key 用「该 narrative 在段列表中的
 * 位置下标」`narrative-${index}`，**不用**过程条目 key（`stream-text` / `text-${owner}-${i}`）。
 * 现象：段间 progress 在 live 只活在 streamState → `holdStreamInProcess` 推 key=`stream-text`
 * 的过程条目；下一帧 partial 快照带 text 块到达、streamState 被清 → 过程条目 key 换成
 * `text-${owner}-${i}`。若 narrative key 跟着过程条目 key 走，NarrativeRow 会被 React 卸载
 * 重挂（seed 回 ''）→ REGRESS-N「无内容 return null」秒空 + 打字机重来一截。
 * 位置下标在同一生长段内稳定（其前的 thinking / work_stage / 前序 narrative 都已落盘不变，
 * 新 narrative 只往后追加）→ stream→commit 同段 key 不变 → 不 remount、不闪空。
 * 合并（同 tone 前缀）时保留既有 key（已是 `narrative-${index}`），不重编。
 */
function pushNarrative(
  segments: ConciseSegment[],
  _entryKey: string,
  text: string,
  tone: 'progress' | 'final',
): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const last = segments[segments.length - 1]
  if (last?.kind === 'narrative' && last.tone === tone) {
    const prev = last.text.trim()
    if (trimmed.startsWith(prev) || prev.startsWith(trimmed)) {
      last.text = trimmed.length >= prev.length ? text : last.text
      return
    }
    last.text = `${last.text.trim()}\n\n${trimmed}`
    return
  }
  const index = segments.filter((s) => s.kind === 'narrative').length
  segments.push({ kind: 'narrative', key: `narrative-${index}`, text, tone })
}

/**
 * 将过程条目投影为 Cursor 式简洁时间线段。
 */
export function buildConciseTimeline(
  process: ProcessEntry[],
  opts?: { answerTexts?: string[]; streamingText?: string; isLive?: boolean },
): ConciseSegment[] {
  const source = mergeAnswerIntoProcess(process, opts?.answerTexts, opts?.streamingText)
  const isLive = Boolean(opts?.isLive)

  let lastToolIdx = -1
  for (let i = 0; i < source.length; i++) {
    if (source[i]!.type === 'tool') lastToolIdx = i
  }

  const segments: ConciseSegment[] = []
  let leadingThink: string[] = []
  let leadingKey = 'think'
  let leadingDurationSec: number | undefined
  let stageSteps: WorkStageStep[] = []
  let stageStartKey = ''
  let sawTool = false
  const seenThinking = new Set<string>()

  const flushLeadingThink = (): void => {
    if (leadingThink.length === 0) return
    const text = leadingThink.join('\n\n')
    const durationSec = resolveThinkingDurationSec(text, leadingDurationSec)
    leadingThink = []
    leadingDurationSec = undefined
    segments.push({
      kind: 'thinking',
      key: `think-${leadingKey}`,
      thinking: text,
      durationSec,
      summary: formatThinkingSummary(durationSec),
    })
  }

  const flushStage = (): void => {
    const tools = stageSteps
      .filter((s): s is Extract<WorkStageStep, { kind: 'tool' }> => s.kind === 'tool')
      .map((s) => s.tool)
    if (tools.length === 0) {
      for (const s of stageSteps) {
        if (s.kind === 'thinking' && !sawTool) leadingThink.push(s.thinking)
      }
      stageSteps = []
      return
    }
    const diff = aggregateDiff(tools)
    segments.push({
      kind: 'work_stage',
      key: `stage-${stageStartKey || tools[0]!.key}`,
      steps: stageSteps,
      tools,
      summary: summarizeWorkStage(tools),
      diffAdd: diff?.add,
      diffDel: diff?.del,
    })
    stageSteps = []
    stageStartKey = ''
  }

  for (let i = 0; i < source.length; i++) {
    const cur = source[i]!

    if (cur.type === 'guidance') {
      if (!cur.text.trim()) continue
      // 引导是当前执行链的用户输入：保序插入，且作为阶段边界，避免和前后工具揉成一块。
      flushLeadingThink()
      flushStage()
      segments.push({ kind: 'guidance', key: cur.key, text: cur.text })
      continue
    }

    if (cur.type === 'thinking') {
      const t = cur.thinking.trim()
      if (!t) continue
      // SDK 的累计快照可能把同一段 thinking 以不同 key 重放；同一回合只保留一次。
      if (seenThinking.has(t)) continue
      seenThinking.add(t)
      // 首轮工具前：合并为顶部 ThinkingFold
      if (!sawTool && stageSteps.length === 0) {
        if (leadingThink.length === 0) {
          leadingKey = cur.key
          leadingDurationSec = cur.durationSec
        } else if (cur.durationSec != null) {
          leadingDurationSec = (leadingDurationSec ?? 0) + cur.durationSec
        }
        leadingThink.push(t)
        continue
      }
      // REGRESS-K1：idle 不再因 trivial 整段丢弃——短思考也要留「思考了片刻」可点开，
      // 否则 live 可见、结束后执行块无思考行（用户观感=流完即消）。
      // 中段思考保留在当前执行阶段的 chronological steps；阶段仍是唯一外层块，正文由阶段展开态承载。
      if (stageSteps.some((s) => s.kind === 'tool')) {
        const durationSec = resolveThinkingDurationSec(t, cur.durationSec)
        stageSteps.push({
          kind: 'thinking',
          key: `think-${cur.key}`,
          thinking: t,
          durationSec,
        })
        continue
      }
      // 阶段之外（跨阶段边界的收尾思考）：一律独立 ThinkingFold（含 trivial），保证执行链可回看。
      flushLeadingThink()
      flushStage()
      const durationSec = resolveThinkingDurationSec(t, cur.durationSec)
      segments.push({
        kind: 'thinking',
        key: `think-${cur.key}`,
        thinking: t,
        durationSec,
        summary: formatThinkingSummary(durationSec),
      })
      continue
    }

    if (cur.type === 'tool') {
      flushLeadingThink()
      sawTool = true
      if (stageSteps.length === 0) stageStartKey = cur.key
      stageSteps.push({
        kind: 'tool',
        key: cur.key,
        tool: cur,
        diff: extractToolDiff(cur),
      })
      continue
    }

    if (cur.type === 'text') {
      const rawDisplayText = sanitizeAssistantTextForDisplay(cur.text)
      flushLeadingThink()
      // REGRESS-N（否决 REGRESS-J J1/J4 的 isShortIdleProgress → continue）：
      // 旧规则按长度（≤ SHORT_PROGRESS_MAX_CHARS）一刀切，idle 把「正在跑验证」「准备编辑」
      // 这类**有信息**的段间短 progress 也直接 continue 丢掉——REGRESS-M 的 tool_start commit
      // 让它在 live 打字机可见、idle 重投影即被吃 → 用户观感「阶段性总结流完即消」。
      // 产品裁决：禁止 idle 为合并阶段而删有信息的段间 progress；**仅纯 filler**
      // （好的/嗯/继续…极短无信息过渡词，见 isFillerProgressText）可吞以合并阶段，
      // 有信息进度句一律常驻 narrative.progress。live/idle 同一套 segments 语义
      // （禁止 live 一套、idle 把总结删光）。回合末文本（isRoundFinal）即便是 filler 也保留
      // ——那可能是用户的短回答，不得丢。
      const isRoundFinal = i > lastToolIdx || lastToolIdx < 0
      const displayText = isRoundFinal ? rawDisplayText : compactStageProgress(rawDisplayText) ?? ''
      if (!displayText.trim()) continue
      const isFiller = !isRoundFinal && isFillerProgressText(displayText)
      // 工具调用前的 call / antml 尾段 / function_call 标记 → 不单独占 narrative 行
      const isArtifact = !isRoundFinal && isToolCallArtifactText(displayText)
      if (isFiller || isArtifact) continue
      flushStage()
      // live 时尾部正文先当 progress（运行队列打字机），避免 final 卡片闪现；
      // 回合结束后再升为 final。
      const tone: 'progress' | 'final' = i < lastToolIdx || isLive ? 'progress' : 'final'
      pushNarrative(segments, cur.key, displayText, tone)
    }
  }

  flushLeadingThink()
  flushStage()
  return segments
}
