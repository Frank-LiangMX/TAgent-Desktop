import { describe, expect, it } from 'vitest'
import { compactStageProgress } from '@tagent/shared'

describe('shared stage summary wiring', () => {
  it('resolves the updated shared compactor through the workspace package', () => {
    const result = compactStageProgress(
      '我先看看当前目录。\n这目录确实没法让人眼瞅——全是二进制文件。\n换个能直接看的办法：我把缓存路径和资产名对照。\n然后再检查路径转换逻辑，最后补一个脚本。',
    )
    expect(result).not.toContain('我先看看')
    expect(result).not.toContain('补一个脚本')
  })
})
