/**
 * Cursor 式简洁时间线 — 纯函数投影
 *
 * - **text** → narrative（硬边界，开新阶段）
 * - 阶段内按时间序投影（不再把全部 thinking 抽到段首）：
 *   - 工具前的思考 → 一个折叠
 *   - 工具间/后的琐碎思考 → 隐藏或并入已有折叠（避免刷屏）
 *   - 工具间/后的「可交付」思考（加粗/标题/结论口吻）→ **narrative**，不当折叠埋掉
 * - 同族 tool 跨琐碎 thinking 合并；text / 可交付 narrative 打断簇
 */
import type { ProcessEntry } from './session-turn-model'
import { getToolPhrase } from './tool-phrase'

export type ToolFamily = 'explore' | 'edit' | 'shell' | 'other'

export type ToolProcessEntry = Extract<ProcessEntry, { type: 'tool' }>

export type ConciseSegment =
  | { kind: 'thinking'; key: string; thinking: string; summary: string }
  | {
      kind: 'tool_cluster'
      key: string
      family: ToolFamily
      tools: ToolProcessEntry[]
      summary: string
    }
  | { kind: 'narrative'; key: string; text: string }

const EXPLORE_RE =
  /^(read|grep|glob|search|semanticsearch|websearch|webfetch|list|ls|find|catalog)/i
const EDIT_RE = /^(edit|write|multiedit|notebookedit|apply|create|delete|remove|patch)/i
const SHELL_RE = /^(bash|shell|terminal|cmd|powershell|exec)/i

export function classifyToolFamily(name: string): ToolFamily {
  const n = name.trim()
  if (!n) return 'other'
  if (EXPLORE_RE.test(n)) return 'explore'
  if (EDIT_RE.test(n)) return 'edit'
  if (SHELL_RE.test(n)) return 'shell'
  return 'other'
}

function toolFileHint(tool: ToolProcessEntry): string | null {
  const input = tool.tool.input ?? {}
  const fp = input.file_path ?? input.filePath ?? input.path
  if (typeof fp === 'string' && fp.trim()) {
    return fp.split(/[/\\]/).pop() || fp
  }
  return null
}

/** 簇摘要：对齐 Cursor「编辑了 A / 探索了 N 个文件」语感 */
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
 * 工具之后的思考是否像「给用户看的结论」（应升为 narrative，而非埋进折叠）。
 * 有加粗/标题/结论口吻，或足够长的成段说明。
 */
export function isDeliverableThinking(text: string): boolean {
  const t = text.trim()
  if (t.length < 20) return false
  if (/\*\*[^*]+\*\*/.test(t)) return true
  if (/^#{1,3}\s+\S/m.test(t)) return true
  if (/(^|[\n。；])\s*(结论|综上|因此|所以|简言之|总的来说|我看了|看起来|改造深度)/.test(t)) {
    return true
  }
  // 多句成段且不太像「让我先…」元话语
  if (t.length >= 100 && /[。！？]/.test(t) && !isTrivialThinking(t)) return true
  return false
}

/** 工具间隙的短元思考：隐藏，避免 think→tool→think 刷屏 */
export function isTrivialThinking(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/\*\*[^*]+\*\*/.test(t) || /^#{1,3}\s/m.test(t)) return false
  if (t.length <= 48) return true
  if (
    t.length <= 100 &&
    /^(好的|嗯|接下来|然后|让我|我来|我先|下一步|继续|先(看|读|查|跑|搜|打开))/m.test(t)
  ) {
    return true
  }
  return false
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

function pushNarrative(segments: ConciseSegment[], key: string, text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const last = segments[segments.length - 1]
  if (last?.kind === 'narrative') {
    const prev = last.text.trim()
    if (trimmed.startsWith(prev) || prev.startsWith(trimmed)) {
      last.text = trimmed.length >= prev.length ? text : last.text
      return
    }
    // 相邻可交付段合并，避免碎成多块
    last.text = `${last.text.trim()}\n\n${trimmed}`
    return
  }
  segments.push({ kind: 'narrative', key, text })
}

type PendingCluster = {
  family: ToolFamily
  tools: ToolProcessEntry[]
  startKey: string
}

/**
 * 阶段内按序投影：保留「工具 → 结论正文」穿插，不把加粗结论抽回段首思考折叠。
 */
function projectPhase(entries: ProcessEntry[]): ConciseSegment[] {
  const out: ConciseSegment[] = []
  let thinkingBuf: string[] = []
  let thinkKey = 'think'
  let toolsSeen = false
  let pending: PendingCluster | null = null

  const flushCluster = (): void => {
    if (!pending) return
    out.push({
      kind: 'tool_cluster',
      key: `cluster-${pending.family}-${pending.startKey}`,
      family: pending.family,
      tools: pending.tools,
      summary: summarizeToolCluster(pending.family, pending.tools),
    })
    pending = null
  }

  const appendToExistingThinking = (text: string): void => {
    for (let i = out.length - 1; i >= 0; i--) {
      const s = out[i]!
      if (s.kind === 'narrative') break
      if (s.kind === 'thinking') {
        s.thinking = `${s.thinking.trim()}\n\n${text}`
        return
      }
    }
  }

  const flushThinking = (): void => {
    if (thinkingBuf.length === 0) return
    const text = thinkingBuf.join('\n\n')
    const key = thinkKey
    thinkingBuf = []

    if (!toolsSeen) {
      // 工具前：合并为一折叠
      const last = out[out.length - 1]
      if (last?.kind === 'thinking') {
        last.thinking = `${last.thinking.trim()}\n\n${text}`
      } else {
        out.push({
          kind: 'thinking',
          key: `think-${key}`,
          thinking: text,
          summary: '思考了片刻',
        })
      }
      return
    }

    // 工具后：可交付 → 正文；琐碎 → 丢弃；其余并入已有思考折叠（不新开一行）
    if (isDeliverableThinking(text)) {
      flushCluster()
      pushNarrative(out, `narr-think-${key}`, text)
      return
    }
    if (isTrivialThinking(text)) return
    appendToExistingThinking(text)
  }

  const pushTool = (tool: ToolProcessEntry): void => {
    flushThinking()
    toolsSeen = true
    const family = classifyToolFamily(tool.tool.name)
    if (pending && pending.family === family) {
      pending.tools.push(tool)
      return
    }
    flushCluster()
    pending = { family, tools: [tool], startKey: tool.key }
  }

  for (const e of entries) {
    if (e.type === 'thinking') {
      const t = e.thinking.trim()
      if (!t) continue
      if (thinkingBuf.length === 0) thinkKey = e.key
      thinkingBuf.push(t)
      continue
    }
    if (e.type === 'tool') {
      pushTool(e)
    }
  }
  flushThinking()
  flushCluster()
  return out
}

/**
 * 将过程条目投影为 Cursor 式简洁时间线段。
 */
export function buildConciseTimeline(
  process: ProcessEntry[],
  opts?: { answerTexts?: string[]; streamingText?: string },
): ConciseSegment[] {
  const source = mergeAnswerIntoProcess(process, opts?.answerTexts, opts?.streamingText)
  const segments: ConciseSegment[] = []
  let phaseEntries: ProcessEntry[] = []

  const flushPhase = (): void => {
    if (phaseEntries.length === 0) return
    segments.push(...projectPhase(phaseEntries))
    phaseEntries = []
  }

  for (const cur of source) {
    if (cur.type === 'text') {
      if (!cur.text.trim()) continue
      flushPhase()
      pushNarrative(segments, cur.key, cur.text)
      continue
    }
    if (cur.type === 'thinking' || cur.type === 'tool') {
      phaseEntries.push(cur)
    }
  }
  flushPhase()
  return segments
}
