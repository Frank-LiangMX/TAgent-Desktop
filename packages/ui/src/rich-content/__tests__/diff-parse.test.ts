import { describe, expect, it } from 'vitest'

import { countDiffChanges, parseUnifiedDiff } from '../diff-parse'

const SAMPLE = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,6 +1,8 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
`

describe('parseUnifiedDiff', () => {
  it('解析文件头与 hunk', () => {
    const parsed = parseUnifiedDiff(SAMPLE)
    expect(parsed).not.toBeNull()
    expect(parsed!.oldPath).toBe('a/src/index.ts')
    expect(parsed!.newPath).toBe('b/src/index.ts')
    expect(parsed!.hunks).toHaveLength(1)
    const hunk = parsed!.hunks[0]!
    expect(hunk.oldStart).toBe(1)
    expect(hunk.newStart).toBe(1)
    expect(hunk.lines).toHaveLength(5)
  })

  it('行类型正确', () => {
    const parsed = parseUnifiedDiff(SAMPLE)!
    const types = parsed.hunks[0]!.lines.map((line) => line.type)
    expect(types).toEqual(['context', 'del', 'add', 'add', 'context'])
  })

  it('空输入返回 null', () => {
    expect(parseUnifiedDiff('')).toBeNull()
    expect(parseUnifiedDiff('no diff here')).toBeNull()
  })

  it('多 hunk 与 \\ No newline 标记', () => {
    const multi = `--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 a
-b
+c
@@ -5,1 +5,1 @@
 e
\\ No newline at end of file
+f
`
    const parsed = parseUnifiedDiff(multi)
    expect(parsed).not.toBeNull()
    expect(parsed!.hunks).toHaveLength(2)
    expect(parsed!.hunks[1]!.lines[0]!.type).toBe('context')
    expect(parsed!.hunks[1]!.lines[0]!.noNewline).toBe(true)
  })

  it('countDiffChanges 统计增删', () => {
    const parsed = parseUnifiedDiff(SAMPLE)!
    expect(countDiffChanges(parsed.hunks)).toEqual({ add: 2, del: 1 })
  })
})
