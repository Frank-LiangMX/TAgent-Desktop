/**
 * Unified diff 解析（自研）
 *
 * 解析标准 unified diff 文本（git diff / diff -u 输出）为结构化行：
 * - 文件头（--- / +++）
 * - hunk 头（@@ -a,b +c,d @@）
 * - 行（context / add / del，含 \ No newline 标记）
 *
 * 不依赖任何 diff 库；解析失败时返回 null 由调用方回落普通代码块。
 */

export type DiffLineType = 'context' | 'add' | 'del'

export interface DiffLine {
  type: DiffLineType
  /** 行内容（不含 +/-/空格 前缀） */
  text: string
  /** 是否上一行末尾无换行 */
  noNewline?: boolean
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface ParsedDiff {
  oldPath: string
  newPath: string
  hunks: DiffHunk[]
}

const HUNK_HEAD_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const FILE_HEAD_RE = /^(?:---|\+\+\+) (.+)/

export function parseUnifiedDiff(source: string): ParsedDiff | null {
  if (!source || typeof source !== 'string') return null

  const lines = source.replace(/\r\n/g, '\n').split('\n')
  // 源以换行结尾时尾部空串不是内容行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let oldPath = ''
  let newPath = ''
  const hunks: DiffHunk[] = []
  let currentHunk: DiffHunk | null = null
  let lastNoNewline = false

  for (const raw of lines) {
    const line = raw

    if (lastNoNewline) {
      // 上一行标注了 \ No newline，当前行内容实际上属于上一行
      lastNoNewline = false
      continue
    }

    if (line.startsWith('@@')) {
      const match = HUNK_HEAD_RE.exec(line)
      if (!match) continue
      currentHunk = {
        oldStart: Number(match[1]),
        oldLines: match[2] ? Number(match[2]) : 1,
        newStart: Number(match[3]),
        newLines: match[4] ? Number(match[4]) : 1,
        lines: [],
      }
      hunks.push(currentHunk)
      continue
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const match = FILE_HEAD_RE.exec(line)
      if (!match) continue
      const filePath = match[1] ?? ''
      if (line.startsWith('---')) oldPath = filePath
      else newPath = filePath
      continue
    }

    if (!currentHunk) continue // hunk 外的散行忽略

    if (line === '\\ No newline at end of file') {
      if (currentHunk.lines.length > 0) {
        currentHunk.lines[currentHunk.lines.length - 1]!.noNewline = true
      }
      continue
    }

    const type: DiffLineType =
      line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context'
    currentHunk.lines.push({ type, text: line.slice(1) })
  }

  if (hunks.length === 0) return null
  return { oldPath, newPath, hunks }
}

/** 统计 hunk 内行数（用于合并展示 "±N"） */
export function countDiffChanges(hunks: DiffHunk[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') add++
      else if (line.type === 'del') del++
    }
  }
  return { add, del }
}
