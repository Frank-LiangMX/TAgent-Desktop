/**
 * Cursor 式简洁时间线 — 纯函数投影
 *
 * 阶段生命周期（对齐 Cursor）：
 *   live：摘要行累积 + 底部当前动作滚动态（Grepping / 搜索中…）
 *   done：收成折叠块（不消失）
 *   expand：按时间序明细 — 思考 / 探索 / 编辑（含 +N -M），点击再看详情
 *
 * - work_stage.steps：阶段内 chronological 步骤（thinking + tool）
 * - narrative.progress / final：方向短总结 / 最终正文
 */
import { cleanFilePathInput } from '@tagent/shared'
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

/** 从单条 tool result 解析 +N -M。优先成对 `+N -M`；缺边时单独识别 +N 或 -M（如只有
 *  "Changed +5" / "removed 3"），都匹配不到才返回 undefined（UI 据此隐藏空占位，见
 *  TurnFilesChangedCard）。REGRESS-J(J5)：放宽单边匹配，避免常见单边文案 add/del 恒 0。 */
export function extractToolDiff(
  tool: ToolProcessEntry,
): { add: number; del: number } | undefined {
  if (classifyToolFamily(tool.tool.name) !== 'edit') return undefined
  const text = resultText(tool.result?.content)
  if (!text) return undefined
  const both = text.match(/\+(\d+)\s+[^\d-]*-(\d+)/) || text.match(/\+(\d+).*?-(\d+)/)
  if (both) return { add: Number(both[1]) || 0, del: Number(both[2]) || 0 }
  const add = text.match(/\+\d+/)
  const del = text.match(/(?:\s|^)-(\d+)/)
  if (!add && !del) return undefined
  return {
    add: add ? Number(add[0].replace('+', '')) || 0 : 0,
    del: del ? Number(del[1]) || 0 : 0,
  }
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

function countUniqueFiles(tools: ToolProcessEntry[]): number {
  const names = tools.map((t) => toolFileHint(t)).filter(Boolean) as string[]
  return new Set(names).size || tools.length
}

/**
 * 阶段摘要：编辑了 N 个文件，探索了 M 个文件，K 次搜索，运行了 C 条命令
 * 对齐 Cursor「Edited 7 files, explored 2 files…」——live 也用完成态措辞，
 * 只累积计数，避免顶栏「正在…」随工具切换掠过。
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
    const n = countUniqueFiles(buckets.edit)
    parts.push(`编辑了 ${n} 个文件`)
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
    return file ? `编辑 ${file}` : '编辑文件'
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
 * 极短的段间进度短文（如「先摸清目录结构」「已改完，跑一下验证」）：
 * 属于过程中的低信息「旁白」，不该切断正在累积的工具 stage（否则工具→短文→工具→短文
 * 会被拆成一条命令一阶段，刷「运行了 1 条命令」）。此类 text 在模型里直接忽略，
 * 工具继续累进同一 work_stage；较长的实质叙述 / 回合末最终交付才 flush 成独立 narrative。
 */
export const SHORT_PROGRESS_MAX_CHARS = 20

export function isShortProgressText(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  return t.length <= SHORT_PROGRESS_MAX_CHARS
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

function pushNarrative(
  segments: ConciseSegment[],
  key: string,
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
  segments.push({ kind: 'narrative', key, text, tone })
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

    if (cur.type === 'thinking') {
      const t = cur.thinking.trim()
      if (!t) continue
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
      // REGRESS-J(J3)：中段思考（当前阶段已执行过工具）一律并入 stage.steps——展开可见全文，
      // 不再按 isDeliverableThinking 升独立 fold。升 fold 会 flushStage 拆 stage，导致
      // 「思考游离在执行块之外、找不到完整思考」，且频繁打断工具合并。live/idle 一致，key=cur.key
      // 稳定不走 remount，避免「思考→工具」切换时思考从独立 fold 跌回 step 触发整段重排闪。
      if (stageSteps.some((s) => s.kind === 'tool')) {
        stageSteps.push({
          kind: 'thinking',
          key: cur.key,
          thinking: t,
          durationSec: resolveThinkingDurationSec(t, cur.durationSec),
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
      if (!cur.text.trim()) continue
      flushLeadingThink()
      // REGRESS-J(J1/J4)：非最终、极短的段间 progress 在 idle 不再无条件 flushStage。
      // 回合结束时工具之间的短旁白直接忽略，让连续 Bash/探索累进同一 work_stage，
      // 消除「运行了 1 条命令」刷屏。live 流式期间保留（打字机需即时可见，避免憋到结束）；
      // 回合结束后同一过程数组重投影即得合并的单一 work_stage。
      const isRoundFinal = i > lastToolIdx || lastToolIdx < 0
      const isShortIdleProgress = !isLive && !isRoundFinal && isShortProgressText(cur.text)
      if (isShortIdleProgress) continue
      flushStage()
      // live 时尾部正文先当 progress（运行队列打字机），避免 final 卡片闪现；
      // 回合结束后再升为 final。
      const tone: 'progress' | 'final' = i < lastToolIdx || isLive ? 'progress' : 'final'
      pushNarrative(segments, cur.key, cur.text, tone)
    }
  }

  flushLeadingThink()
  flushStage()
  return segments
}
