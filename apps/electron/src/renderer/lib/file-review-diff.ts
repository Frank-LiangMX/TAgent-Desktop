/**
 * 本轮 Files Changed 审阅的行级 diff 纯函数（无 npm 依赖）。
 *
 * 数据流：
 *   本轮补丁 FileEditPatch[]（来自 collectTurnFilePatches）+ 磁盘当前内容 after
 *   → reconstructBefore 倒序替换还原旧稿 before
 *   → computeUnifiedHunks(before, after) 用 Myers O(ND) 算行级 diff
 *   → 长未改段折叠成 collapsed 行
 *
 * 兜底链（由 FilePreviewPane 编排，见 §3/§4）：
 *   - reconstructBefore 返回 null（replace 的 newText 在 after 里出现 0/2 次，无法唯一定位）
 *     → git HEAD 取旧稿再算 hunks；git 也没有 → 退回当前文件预览。
 *   - reconstructBefore 返回 ''（Write 整文件重写，旧稿不可得）
 *     → git HEAD 取旧稿；git 也没有 → 整文件当新增（全绿）。
 *   - 大文件（任一侧 > 8000 行或 old+new > 400_000 字符）不跑全量 LCS，
 *     回退 computePatchBlockHunks 按「本轮补丁块」展示（del 块 + add 块）。
 */
import type { FileEditPatch } from '@tagent/shared'

// ===== 类型 =====

export type DiffLine =
  | { type: 'ctx'; oldNo: number; newNo: number; text: string }
  | { type: 'del'; oldNo: number; text: string }
  | { type: 'add'; newNo: number; text: string }
  | { type: 'collapsed'; count: number; lines: DiffLine[] }

export interface DiffHunk {
  lines: DiffLine[]
}

// ===== 大文件保护阈值 =====

export const DIFF_LARGE_LINE_LIMIT = 8000
export const DIFF_LARGE_CHAR_LIMIT = 400_000

const DEFAULT_CONTEXT = 3
const DEFAULT_COLLAPSE_THRESHOLD = 6

// ===== 路径归一（与 collectTurnEditedFiles 同口径） =====

export function normalizeFilePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

// ===== 行切分 =====

/**
 * 把文本切成行（不含换行符）。末尾 '\n' 产生的空串不算一行——
 * 与多数行 diff 一致，避免「仅尾换行差异」噪音；行级 diff 无法表达尾换行有无。
 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const arr = text.split('\n')
  if (arr.length > 0 && arr[arr.length - 1] === '' && text.endsWith('\n')) arr.pop()
  return arr
}

// ===== reconstructBefore：倒序还原旧稿 =====

/**
 * 按「同一 path 的补丁、时间倒序」把 after 还原成 before。
 * - replace：after 里 newText 必须恰好出现 1 次，替换回 oldText；否则返回 null（歧义）。
 * - write：整文件重写，旧稿不可得 → 返回 ''（调用方走 git 兜底；都没有则全绿）。
 * - 空补丁 → null（调用方走 git 兜底）。
 *
 * 注意：用 indexOf+slice 而非 String.replace，避免 oldText 里的 $ 特殊替换模式。
 */
export function reconstructBefore(after: string, patches: FileEditPatch[]): string | null {
  if (patches.length === 0) return null
  let current = after
  for (let i = patches.length - 1; i >= 0; i--) {
    const p = patches[i]!
    if (p.kind === 'write') {
      // 整文件重写：旧稿不可得。若 write 之前还有更早的 replace，那些 replace 的 oldText
      // 是 write 之后的片段，倒序到这里直接返回 '' 即可（write 把旧稿整体替换掉了）。
      return ''
    }
    if (p.newText === '') {
      // 把内容删成空串：after 里无法定位「空串」，视为歧义 → git 兜底
      return null
    }
    const idx = current.indexOf(p.newText)
    if (idx < 0) return null
    // 必须恰好 1 次
    if (current.indexOf(p.newText, idx + p.newText.length) >= 0) return null
    current = current.slice(0, idx) + p.oldText + current.slice(idx + p.newText.length)
  }
  return current
}

// ===== Myers 行级 diff（O(ND)，无 npm 依赖） =====

type Op =
  | { type: 'equal'; a: number; b: number }
  | { type: 'delete'; a: number }
  | { type: 'insert'; b: number }

/**
 * Myers 最短编辑脚本。返回逐行 op 序列（equal/delete/insert）。
 * 参考 Eugene Myers 1986 论文 + James Coglan 的 backtrack 实现。
 * 用 Int32Array + offset 表示 v[k]（避免负索引、slice 可拷贝）。
 */
function myersDiff(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0) return b.map((_, bi) => ({ type: 'insert', b: bi } as const))
  if (m === 0) return a.map((_, ai) => ({ type: 'delete', a: ai } as const))

  const max = n + m
  const offset = max
  const size = 2 * max + 1
  let v = new Int32Array(size) // v[offset + k] = 该 d 步对角线 k 上的最远 x
  // 哨兵：v[offset + 1] = 0（d=0、k=0 时 x = v[k+1] = 0）。Int32Array 默认 0，无需显式设。
  const trace: Int32Array[] = []
  let d = 0
  outer: for (d = 0; d <= max; d++) {
    trace.push(v.slice()) // 该 d 步开始时的 v = d-1 前沿（供 backtrack 找来路）
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]! // 向下（insert）
      } else {
        x = v[offset + k - 1]! + 1 // 向右（delete）
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        break outer // trace 已含该 d 步的起始 v，长度 = d+1
      }
    }
  }

  return backtrack(trace, a, b, n, m)
}

function backtrack(
  trace: Int32Array[],
  a: string[],
  b: string[],
  n: number,
  m: number,
): Op[] {
  const offset = n + m
  let x = n
  let y = m
  const ops: Op[] = []
  // 从 (n,m) 回溯到 (0,0)。trace[d] 是第 d 步开始时的 v（= d-1 前沿）。
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
      prevK = k + 1 // 来自下方（insert）
    } else {
      prevK = k - 1 // 来自左方（delete）
    }
    const prevX = v[offset + prevK]!
    const prevY = prevX - prevK
    // 蛇身：从 (prevX/prevY 或其 +1) 回到 (x,y) 的 equal 段
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', a: x - 1, b: y - 1 })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) {
        // 向下移动：插入 b[y-1]
        ops.push({ type: 'insert', b: y - 1 })
        y--
      } else {
        // 向右移动：删除 a[x-1]
        ops.push({ type: 'delete', a: x - 1 })
        x--
      }
    }
  }
  // 起点蛇身到 (0,0)
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', a: x - 1, b: y - 1 })
    x--
    y--
  }
  while (x > 0) {
    ops.push({ type: 'delete', a: x - 1 })
    x--
  }
  while (y > 0) {
    ops.push({ type: 'insert', b: y - 1 })
    y--
  }
  ops.reverse()
  return ops
}

/** ops → 带 1-based 行号的 flat DiffLine 序列 */
function opsToDiffLines(ops: Op[], a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const op of ops) {
    if (op.type === 'equal') {
      out.push({ type: 'ctx', oldNo: oldNo + 1, newNo: newNo + 1, text: a[op.a] ?? '' })
      oldNo++
      newNo++
    } else if (op.type === 'delete') {
      out.push({ type: 'del', oldNo: oldNo + 1, text: a[op.a] ?? '' })
      oldNo++
    } else {
      out.push({ type: 'add', newNo: newNo + 1, text: b[op.b] ?? '' })
      newNo++
    }
  }
  return out
}

// ===== 折叠长未改段 + 装成 hunk =====

/**
 * 把 flat DiffLine 序列收成审阅视图：仅保留 change 周围内容，长未改段折叠成 collapsed 行。
 * - 首段未改（首个 change 之前）：保留最后 context 行，其前折叠（若 > collapseThreshold）。
 * - 末段未改（末个 change 之后）：保留最前 context 行，其后折叠。
 * - 中间未改段：保留首尾各 context 行，中间折叠（若 > collapseThreshold）。
 * - 未改段 ≤ collapseThreshold：原样保留。
 * 整体作为单个 hunk 返回（GitHub 单文件 review 式连续视图，collapsed 可就地展开）。
 */
function collapseToHunk(flat: DiffLine[], context: number, collapseThreshold: number): DiffHunk[] {
  const n = flat.length
  if (n === 0) return []
  let firstChange = -1
  let lastChange = -1
  for (let i = 0; i < n; i++) {
    const t = flat[i]!.type
    if (t === 'del' || t === 'add') {
      if (firstChange === -1) firstChange = i
      lastChange = i
    }
  }
  if (firstChange === -1) return [] // 无变化

  const result: DiffLine[] = []
  let idx = 0
  while (idx < n) {
    const startType = flat[idx]!.type
    const isCtx = startType === 'ctx'
    let end = idx
    while (end < n && flat[end]!.type === startType) end++
    const segment = flat.slice(idx, end)

    if (!isCtx) {
      for (const l of segment) result.push(l)
    } else {
      const isLeading = end <= firstChange
      const isTrailing = idx > lastChange
      if (segment.length <= collapseThreshold) {
        for (const l of segment) result.push(l)
      } else if (isLeading) {
        const keepStart = Math.max(0, segment.length - context)
        if (keepStart > 0) {
          result.push({ type: 'collapsed', count: keepStart, lines: segment.slice(0, keepStart) })
        }
        for (let j = keepStart; j < segment.length; j++) result.push(segment[j]!)
      } else if (isTrailing) {
        const keepEnd = Math.min(segment.length, context)
        for (let j = 0; j < keepEnd; j++) result.push(segment[j]!)
        const rest = segment.length - keepEnd
        if (rest > 0) {
          result.push({ type: 'collapsed', count: rest, lines: segment.slice(keepEnd) })
        }
      } else {
        // 中间段
        const first = Math.min(context, segment.length)
        const last = Math.max(first, segment.length - context)
        for (let j = 0; j < first; j++) result.push(segment[j]!)
        if (last > first) {
          result.push({ type: 'collapsed', count: last - first, lines: segment.slice(first, last) })
        }
        for (let j = last; j < segment.length; j++) result.push(segment[j]!)
      }
    }
    idx = end
  }

  return result.length > 0 ? [{ lines: result }] : []
}

// ===== computeUnifiedHunks =====

/**
 * 行级 unified diff（Myers LCS）。返回 DiffHunk[]（通常单个 hunk，内含 collapsed 折叠段）。
 * - context：change 周围保留的未改行数（默认 3）。
 * - collapseThreshold：未改段 > 该值则折叠中间（默认 6）。
 * 无变化返回 []。
 */
export function computeUnifiedHunks(
  oldText: string,
  newText: string,
  opts?: { context?: number; collapseThreshold?: number },
): DiffHunk[] {
  const context = opts?.context ?? DEFAULT_CONTEXT
  const collapseThreshold = opts?.collapseThreshold ?? DEFAULT_COLLAPSE_THRESHOLD
  if (oldText === newText) return []
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  if (oldLines.length === 0 && newLines.length === 0) return []
  const ops = myersDiff(oldLines, newLines)
  const flat = opsToDiffLines(ops, oldLines, newLines)
  return collapseToHunk(flat, context, collapseThreshold)
}

// ===== 大文件兜底：按本轮补丁块 =====

function countNewlinesUpto(text: string, upto: number): number {
  let count = 0
  const end = Math.min(upto, text.length)
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) count++
  return count
}

/**
 * 大文件回退：不跑全量 LCS，把每个 replace 当一个 hunk（del 块 + add 块），
 * Write 当全绿。newText 在 after 里的位置用于估算新行号（best-effort，旧行号近似同位置）。
 */
/**
 * 本轮审阅主路径：按 Edit 补丁做 old↔new 的 unified hunk（不是整文件 LCS）。
 * 整文件 LCS 会把仍留在文件里的旧行收成上下文，补丁里的删除就看不见红。
 */
export function computeTurnReviewHunks(patches: FileEditPatch[], after: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  for (const p of patches) {
    if (p.kind === 'write') {
      hunks.push(...allNewHunks(p.newText))
      continue
    }
    const raw = computeUnifiedHunks(p.oldText, p.newText)
    if (raw.length === 0) continue
    const atIdx = after.indexOf(p.newText)
    const offset = atIdx >= 0 ? countNewlinesUpto(after, atIdx) : 0
    for (const h of raw) {
      hunks.push({
        lines: h.lines.map((l) => {
          if (l.type === 'add') return { ...l, newNo: l.newNo + offset }
          if (l.type === 'del') return { ...l, oldNo: l.oldNo + offset }
          if (l.type === 'ctx') {
            return { ...l, oldNo: l.oldNo + offset, newNo: l.newNo + offset }
          }
          return l
        }),
      })
    }
  }
  return hunks
}

export function computePatchBlockHunks(patches: FileEditPatch[], after: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  for (const p of patches) {
    if (p.kind === 'write') {
      const lines = splitLines(p.newText)
      if (lines.length > 0) {
        hunks.push({
          lines: lines.map((text, i) => ({ type: 'add', newNo: i + 1, text })),
        })
      }
      continue
    }
    const oldLines = splitLines(p.oldText)
    const newLines = splitLines(p.newText)
    if (oldLines.length === 0 && newLines.length === 0) continue
    const atIdx = after.indexOf(p.newText)
    const newStart = atIdx >= 0 ? countNewlinesUpto(after, atIdx) + 1 : 1
    const lines: DiffLine[] = []
    oldLines.forEach((text, i) => lines.push({ type: 'del', oldNo: newStart + i, text }))
    newLines.forEach((text, i) => lines.push({ type: 'add', newNo: newStart + i, text }))
    if (lines.length > 0) hunks.push({ lines })
  }
  return hunks
}

// ===== 全绿（新增文件） =====

/** Write 且 git 也没有：整文件当新增，全行 add。 */
export function allNewHunks(newText: string): DiffHunk[] {
  const lines = splitLines(newText)
  if (lines.length === 0) return []
  return [{ lines: lines.map((text, i) => ({ type: 'add', newNo: i + 1, text })) }]
}

// ===== 大文件判定 =====

export function isLargeDiff(before: string, after: string): boolean {
  const oldLines = splitLines(before).length
  const newLines = splitLines(after).length
  return (
    oldLines > DIFF_LARGE_LINE_LIMIT ||
    newLines > DIFF_LARGE_LINE_LIMIT ||
    before.length + after.length > DIFF_LARGE_CHAR_LIMIT
  )
}

// ===== hunk 计数（顶栏 +N -M 兜底） =====

export function countDiffHunks(hunks: DiffHunk[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') add++
      else if (l.type === 'del') del++
    }
  }
  return { add, del }
}
