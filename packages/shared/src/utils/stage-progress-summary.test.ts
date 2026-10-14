import { describe, expect, it } from 'vitest'
import {
  compactStageProgress,
  isNearDuplicateStageProgress,
  STAGE_PROGRESS_MAX_CHARS,
} from './stage-progress-summary'

describe('compactStageProgress', () => {
  it('保留短阶段进度', () => {
    expect(compactStageProgress('摸清了目录结构，开始检查缓存路径。')).toBe('摸清了目录结构，开始检查缓存路径。')
  })

  it('丢掉连续探索口播，保留关键发现', () => {
    expect(compactStageProgress('先看看入口文件。')).toBeNull()
    expect(compactStageProgress('接着查一下缓存路径。')).toBeNull()
    expect(compactStageProgress('定位到落盘门控把旁白当成了进度。')).toBe(
      '定位到落盘门控把旁白当成了进度。',
    )
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

  it('识别同一根因的改写，但不吞掉不同文件/不同证据', () => {
    expect(
      isNearDuplicateStageProgress(
        '根因很像：读文件/搜索被当成没进展，软提醒后再读几次就会强制复盘。',
        '根因很清楚：软提醒后，读文件/搜索也被算进还没进展，满 3 批就强制复盘。',
      ),
    ).toBe(true)
    expect(
      isNearDuplicateStageProgress('读取 a.ts，准备检查入口。', '读取 b.ts，准备检查入口。'),
    ).toBe(false)
  })

  it('识别视口未打通的中文同义改写', () => {
    expect(
      isNearDuplicateStageProgress(
        '已有 Actor 标签查阅，但还没确认视口里能不能看见。',
        '查询链路有了，视口显示还没有。',
      ),
    ).toBe(true)
    expect(
      isNearDuplicateStageProgress(
        '场景 Actor 已能解析网格上的标签，只是视口没通。',
        '场景 Actor 已能解析网格上的标签，视口已经正常显示。',
      ),
    ).toBe(false)
  })
})
