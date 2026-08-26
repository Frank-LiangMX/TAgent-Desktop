import { describe, expect, it } from 'vitest'
import { compactStageProgress, STAGE_PROGRESS_MAX_CHARS } from './stage-progress-summary'

describe('compactStageProgress', () => {
  it('保留短阶段进度', () => {
    expect(compactStageProgress('摸清了目录结构，开始检查缓存路径。')).toBe('摸清了目录结构，开始检查缓存路径。')
  })

  it('长过程只保留有限的事实/动作句', () => {
    const result = compactStageProgress(
      '我先看看当前目录。\n这目录确实没法让人眼瞅——全是二进制文件。\n换个能直接看的办法：我把缓存路径和资产名对照。\n然后再检查路径转换逻辑，最后补一个脚本。',
    )
    expect(result).toBeTruthy()
    expect(result!.length).toBeLessThanOrEqual(STAGE_PROGRESS_MAX_CHARS)
    expect(result).not.toContain('我先看看')
    expect(result).not.toContain('补一个脚本')
  })

  it('处理空内容', () => {
    expect(compactStageProgress('  \n  ')).toBeNull()
  })
})
