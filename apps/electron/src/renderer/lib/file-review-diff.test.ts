import { describe, expect, it } from 'vitest'
import type { ProcessEntry } from '../components/chat/session-turn-model'
import type { FileEditPatch } from '@tagent/shared'
import { collectTurnFilePatches } from '../components/chat/concise-timeline-model'
import {
  allNewHunks,
  computePatchBlockHunks,
  computeTurnReviewHunks,
  computeUnifiedHunks,
  countDiffHunks,
  isLargeDiff,
  reconstructBefore,
  splitLines,
  type DiffHunk,
  type DiffLine,
} from './file-review-diff'

function getLineText(l: DiffLine): string {
  return l.type === 'collapsed' ? l.lines.map(getLineText).join('\n') : l.text
}
// ===== 辅助：把 hunk lines 拍平成可读字符串（ctx=空格/del=-/add=+/collapsed=~N） =====
function dump(hunks: DiffHunk[]): string {
  return hunks
    .flatMap((h) => h.lines)
    .map((l) => {
      if (l.type === 'ctx') return ` ${getLineText(l)}`
      if (l.type === 'del') return `-${getLineText(l)}`
      if (l.type === 'add') return `+${getLineText(l)}`
      return `~${l.count}`
    })
    .join('\n')
}

function patch(p: any): FileEditPatch {
  return { path: p.path ?? 'a.ts', ...p } as FileEditPatch
}

function tool(
  name: string,
  id: string,
  input: Record<string, unknown> = {},
  done = true,
): ProcessEntry {
  return {
    type: 'tool',
    key: id,
    tool: { type: 'tool_use', id, name, input },
    result: done
      ? { type: 'tool_result', toolUseId: id, content: 'ok', isError: false }
      : undefined,
  }
}

// ===== splitLines =====
describe('splitLines', () => {
  it('drops the trailing empty produced by a final newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b'])
    expect(splitLines('\n')).toEqual([''])
  })
})

// ===== reconstructBefore =====
describe('reconstructBefore', () => {
  it('reverses two ordered replaces', () => {
    // 正序（forward）：before --world->world!--> --foo->FOO--> after
    const after = 'hello world!\nFOO bar\nbaz'
    const patches: FileEditPatch[] = [
      patch({ kind: 'replace', oldText: 'world', newText: 'world!' }),
      patch({ kind: 'replace', oldText: 'foo', newText: 'FOO' }),
    ]
    // 倒序还原：FOO→foo，world!→world → before
    expect(reconstructBefore(after, patches)).toBe('hello world\nfoo bar\nbaz')
  })

  it('returns null when newText appears 0 times in after', () => {
    const after = 'hello world'
    const patches: FileEditPatch[] = [patch({ kind: 'replace', oldText: 'x', newText: 'y' })]
    expect(reconstructBefore(after, patches)).toBeNull()
  })

  it('returns null when newText appears 2 times in after (ambiguous)', () => {
    const after = 'foo\nfoo'
    const patches: FileEditPatch[] = [patch({ kind: 'replace', oldText: 'bar', newText: 'foo' })]
    // newText=foo 在 after 里出现 2 次 → 歧义
    expect(reconstructBefore(after, patches)).toBeNull()
  })

  it('returns "" for a write patch (old content unrecoverable)', () => {
    const after = 'brand new content'
    const patches: FileEditPatch[] = [patch({ kind: 'write', newText: 'brand new content' })]
    expect(reconstructBefore(after, patches)).toBe('')
  })

  it('returns "" when a write follows earlier replaces (write wins, file is new from write)', () => {
    const after = 'final'
    const patches: FileEditPatch[] = [
      patch({ kind: 'replace', oldText: 'init', newText: 'final' }),
      patch({ kind: 'write', newText: 'final' }),
    ]
    // 倒序：先遇到 write → 返回 ''（write 之前旧稿不可得）
    expect(reconstructBefore(after, patches)).toBe('')
  })

  it('returns null on empty patches', () => {
    expect(reconstructBefore('x', [])).toBeNull()
  })

  it('handles replacement whose newText contains the oldText prefix (single occurrence still ok)', () => {
    const after = 'abcXYZ'
    const patches: FileEditPatch[] = [patch({ kind: 'replace', oldText: 'abc', newText: 'abcXYZ' })]
    expect(reconstructBefore(after, patches)).toBe('abc')
  })
})

// ===== computeUnifiedHunks =====
describe('computeUnifiedHunks', () => {
  it('returns [] when texts are identical', () => {
    expect(computeUnifiedHunks('a\nb\nc', 'a\nb\nc')).toEqual([])
  })

  it('insert: adds lines in the middle collapse long unchanged run', () => {
    const oldText = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'line8', 'line9', 'line10', 'line11', 'line12'].join('\n')
    const newText = ['line1', 'line2', 'line3', 'INSERTED', 'line4', 'line5', 'line6', 'line7', 'line8', 'line9', 'line10', 'line11', 'line12'].join('\n')
    const hunks = computeUnifiedHunks(oldText, newText)
    const d = dump(hunks)
    // leading 未改段 line1..line3（3 行 ≤ 6）全保留；INSERTED（add）；trailing 段 line4..line12
    // （9 行 > 6）保留前 3 行（line4/line5/line6）+ 折叠余下 6 行
    expect(d.startsWith(' line1\n line2\n line3')).toBe(true)
    expect(d).toContain('+INSERTED')
    expect(d).toContain(' line4\n line5\n line6')
    expect(d).toContain('~6') // 9 - 3 = 6
    expect(d.endsWith('~6')).toBe(true)
  })

  it('delete: removed line shows as del with old line number', () => {
    const oldText = 'a\nb\nc\nd\ne'
    const newText = 'a\nb\nd\ne'
    const hunks = computeUnifiedHunks(oldText, newText)
    const lines = hunks.flatMap((h) => h.lines)
    const del = lines.find((l) => l.type === 'del')
    expect(del).toBeDefined()
    expect((del as Extract<DiffLine, { type: 'del' }>).text).toBe('c')
    expect((del as Extract<DiffLine, { type: 'del' }>).oldNo).toBe(3)
    const add = lines.find((l) => l.type === 'add')
    expect(add).toBeUndefined()
  })

  it('replace: del + add adjacent', () => {
    const oldText = 'a\nb\nc\nd'
    const newText = 'a\nB\nc\nd'
    const hunks = computeUnifiedHunks(oldText, newText)
    const d = dump(hunks)
    expect(d).toContain('-b')
    expect(d).toContain('+B')
    // b 是旧行 2，B 是新行 2
    const lines = hunks.flatMap((h) => h.lines)
    const del = lines.find((l) => l.type === 'del') as Extract<DiffLine, { type: 'del' }>
    const add = lines.find((l) => l.type === 'add') as Extract<DiffLine, { type: 'add' }>
    expect(del.oldNo).toBe(2)
    expect(add.newNo).toBe(2)
  })

  it('collapses a long interior unchanged run between two changes', () => {
    const head = ['h1', 'h2', 'h3'].join('\n')
    const mid = Array.from({ length: 20 }, (_, i) => `m${i}`).join('\n')
    const tail = ['t1', 't2', 't3'].join('\n')
    const oldText = `${head}\nCHANGE1\n${mid}\nCHANGE2\n${tail}`
    const newText = `${head}\nchanged1\n${mid}\nchanged2\n${tail}`
    const hunks = computeUnifiedHunks(oldText, newText)
    const d = dump(hunks)
    expect(d).toContain('-CHANGE1')
    expect(d).toContain('+changed1')
    expect(d).toContain('-CHANGE2')
    expect(d).toContain('+changed2')
    // 中间 20 行未改 > 6 → 折叠：保留 CHANGE1 后 3 行 + collapsed + CHANGE2 前 3 行
    expect(d).toContain('~14') // 20 - 2*3 = 14
  })

  it('keeps a short unchanged run (<=6) between two changes fully visible', () => {
    const oldText = 'A\nx\nB'
    const newText = 'a\nx\nb'
    const hunks = computeUnifiedHunks(oldText, newText)
    const d = dump(hunks)
    expect(d).toBe('-A\n+a\n x\n-B\n+b')
  })

  it('line numbers stay monotonic and correct across del/add/ctx', () => {
    const oldText = 'l1\nl2\nl3\nl4\nl5'
    const newText = 'l1\nl2NEW\nl3\nl4\nl6NEW'
    const hunks = computeUnifiedHunks(oldText, newText)
    const lines = hunks.flatMap((h) => h.lines)
    // 找到 add l2NEW（新行 2）与 del l2（旧行 2）
    const add2 = lines.find((l) => l.type === 'add' && getLineText(l) === 'l2NEW') as Extract<DiffLine, { type: 'add' }>
    const del2 = lines.find((l) => l.type === 'del' && getLineText(l) === 'l2') as Extract<DiffLine, { type: 'del' }>
    expect(add2.newNo).toBe(2)
    expect(del2.oldNo).toBe(2)
    // l6NEW 是新行 5（原 l5 被删，l6NEW 加在末尾，newText 行：l1,l2NEW,l3,l4,l6NEW → 5 行）
    const add5 = lines.find((l) => l.type === 'add' && getLineText(l) === 'l6NEW') as Extract<DiffLine, { type: 'add' }>
    expect(add5.newNo).toBe(5)
  })

  it('insert at very start (no leading context)', () => {
    const oldText = 'b\nc\nd'
    const newText = 'A\nb\nc\nd'
    const hunks = computeUnifiedHunks(oldText, newText)
    const d = dump(hunks)
    expect(d.startsWith('+A')).toBe(true)
  })
})

describe('computeTurnReviewHunks', () => {
  it('shows deleted lines that whole-file LCS would hide as context', () => {
    const oldText = 'keep\nremoved-only\nkeep2'
    const newText = 'keep\nadded-only\nkeep2'
    const after = `header\n${newText}\nfooter`
    const hunks = computeTurnReviewHunks(
      [patch({ kind: 'replace', oldText, newText })],
      after,
    )
    const lines = hunks.flatMap((h) => h.lines)
    expect(lines.some((l) => l.type === 'del' && getLineText(l) === 'removed-only')).toBe(true)
    expect(lines.some((l) => l.type === 'add' && getLineText(l) === 'added-only')).toBe(true)
    const del = lines.find((l) => l.type === 'del') as Extract<DiffLine, { type: 'del' }>
    expect(del.oldNo).toBeGreaterThan(1)
  })

  it('keeps insert-only patches green-only', () => {
    const hunks = computeTurnReviewHunks(
      [patch({ kind: 'replace', oldText: 'a\nb', newText: 'a\nNEW\nb' })],
      'a\nNEW\nb',
    )
    const lines = hunks.flatMap((h) => h.lines)
    expect(lines.some((l) => l.type === 'add' && getLineText(l) === 'NEW')).toBe(true)
    expect(lines.some((l) => l.type === 'del')).toBe(false)
  })
})

// ===== computePatchBlockHunks（大文件兜底） =====
describe('computePatchBlockHunks', () => {
  it('emits del block + add block per replace patch', () => {
    const after = 'foo\nbar\nbaz'
    const patches: FileEditPatch[] = [patch({ kind: 'replace', oldText: 'bar', newText: 'BAR' })]
    const hunks = computePatchBlockHunks(patches, after)
    const lines = hunks[0]!.lines
    expect(lines.map((l) => `${l.type}:${getLineText(l)}`)).toEqual(['del:bar', 'add:BAR'])
  })

  it('emits all-green add lines for a write patch', () => {
    const after = 'line1\nline2'
    const patches: FileEditPatch[] = [patch({ kind: 'write', newText: 'line1\nline2' })]
    const hunks = computePatchBlockHunks(patches, after)
    const lines = hunks[0]!.lines
    expect(lines.every((l) => l.type === 'add')).toBe(true)
    expect(lines.map((l) => getLineText(l))).toEqual(['line1', 'line2'])
  })
})

// ===== allNewHunks / isLargeDiff / countDiffHunks =====
describe('allNewHunks', () => {
  it('marks every line as add with 1-based new line numbers', () => {
    const hunks = allNewHunks('a\nb\nc')
    const lines = hunks[0]!.lines as Extract<DiffLine, { type: 'add' }>[]
    expect(lines.map((l) => `${l.newNo}:${getLineText(l)}`)).toEqual(['1:a', '2:b', '3:c'])
  })
  it('returns [] for empty content', () => {
    expect(allNewHunks('')).toEqual([])
  })
})

describe('isLargeDiff', () => {
  it('false for small files', () => {
    expect(isLargeDiff('a\nb', 'a\nc')).toBe(false)
  })
  it('true when char total exceeds limit', () => {
    const big = 'x'.repeat(400_001)
    expect(isLargeDiff(big, 'y')).toBe(true)
  })
})

describe('countDiffHunks', () => {
  it('counts add/del across hunks', () => {
    const hunks: DiffHunk[] = [
      { lines: [{ type: 'add', newNo: 1, text: 'a' }, { type: 'del', oldNo: 1, text: 'b' }] },
      { lines: [{ type: 'add', newNo: 2, text: 'c' }, { type: 'ctx', oldNo: 2, newNo: 3, text: 'd' }] },
    ]
    expect(countDiffHunks(hunks)).toEqual({ add: 2, del: 1 })
  })
})

// ===== collectTurnFilePatches（来自 concise-timeline-model） =====
describe('collectTurnFilePatches', () => {
  it('collects Edit + StrReplace with field aliases + Write; skips pending / Read', () => {
    const process: ProcessEntry[] = [
      tool('Read', 'r1', { file_path: 'a.ts' }),
      tool('Edit', 'e1', { file_path: 'a.ts', old_string: 'old1', new_string: 'new1' }),
      tool('StrReplace', 'e2', { path: 'a.ts', oldText: 'old2', newText: 'new2' }),
      tool('Write', 'e3', { filePath: 'a.ts', content: 'full\ncontent' }),
      tool('Edit', 'pending', { file_path: 'wip.ts', old_string: 'x', new_string: 'y' }, false),
    ]
    const patches = collectTurnFilePatches(process)
    expect(patches).toEqual([
      { path: 'a.ts', kind: 'replace', oldText: 'old1', newText: 'new1' },
      { path: 'a.ts', kind: 'replace', oldText: 'old2', newText: 'new2' },
      { path: 'a.ts', kind: 'write', newText: 'full\ncontent' },
    ])
  })

  it('expands MultiEdit.edits into ordered replace patches', () => {
    const process: ProcessEntry[] = [
      tool('MultiEdit', 'm1', {
        file_path: 'b.ts',
        edits: [
          { old_string: 'o1', new_string: 'n1' },
          { old_string: 'o2', new_string: 'n2' },
        ],
      }),
    ]
    const patches = collectTurnFilePatches(process)
    expect(patches).toEqual([
      { path: 'b.ts', kind: 'replace', oldText: 'o1', newText: 'n1' },
      { path: 'b.ts', kind: 'replace', oldText: 'o2', newText: 'n2' },
    ])
  })

  it('ignores edits without a resolvable path', () => {
    const process: ProcessEntry[] = [
      tool('Edit', 'e1', { old_string: 'o', new_string: 'n' }), // 无 file_path
    ]
    expect(collectTurnFilePatches(process)).toEqual([])
  })

  it('normalizes path casing/separators when grouping by file', () => {
    const process: ProcessEntry[] = [
      tool('Edit', 'e1', { file_path: 'src/Foo.ts', old_string: 'o', new_string: 'n' }),
      tool('Edit', 'e2', { file_path: 'src\\foo.ts', old_string: 'o2', new_string: 'n2' }),
    ]
    const patches = collectTurnFilePatches(process)
    // 两条都收（patches 不按文件合并，只是收集；同文件会都进 patches，reconstructBefore 倒序处理）
    expect(patches.length).toBe(2)
  })
})
