import { describe, expect, it } from 'vitest'

import {
  isLowQualityInsight,
  isLowQualityMemoryContent,
  memoryContentDedupeKey,
} from './memory-candidate-quality'

describe('isLowQualityMemoryContent', () => {
  it('rejects raw sanitizePath workspace slugs', () => {
    expect(isLowQualityMemoryContent('F--TAgent-Desktop')).toBe(true)
    expect(isLowQualityMemoryContent('H--j3-statics')).toBe(true)
    expect(isLowQualityMemoryContent('D--JX3-Unreal-Artwork')).toBe(true)
  })

  it('rejects prose that embeds path-slug tokens', () => {
    expect(
      isLowQualityMemoryContent(
        '工作相关项目 F--TAgent-Desktop 在会话中反复出现，可能关联UE插件开发环境',
      ),
    ).toBe(true)
    expect(
      isLowQualityMemoryContent('常用项目路径：D--JX3-Unreal-Artwork-Plugins-XSJArtTools'),
    ).toBe(true)
  })

  it('keeps real Windows paths and normal facts', () => {
    expect(
      isLowQualityMemoryContent(
        '目标形态是类似 H:\\j3_statics 的网页管理视图（浏览器访问 http://127.0.0.1:8766/manager/index.html）',
      ),
    ).toBe(false)
    expect(
      isLowQualityMemoryContent(
        'kscc 命令行集成关键：进程读 KSCC_AUTH_TOKEN 鉴权；--tools "" 会被 cmd /c 转义导致秒退',
      ),
    ).toBe(false)
    expect(isLowQualityMemoryContent('用户偏好：不得自作主张替换默认模型')).toBe(false)
  })

  it('rejects truncated correction fragments', () => {
    expect(
      isLowQualityMemoryContent('改为队列模式。', { type: 'correction', targetLayer: 'L3' }),
    ).toBe(true)
    expect(
      isLowQualityMemoryContent('改成员，Slate', { type: 'correction', targetLayer: 'L3' }),
    ).toBe(true)
    expect(
      isLowQualityMemoryContent('改变标签，跳过', { type: 'correction', targetLayer: 'L3' }),
    ).toBe(true)
    expect(
      isLowQualityMemoryContent('不是http协议，而是固定死的Claude', {
        type: 'correction',
        targetLayer: 'L3',
      }),
    ).toBe(false)
  })
    expect(
      isLowQualityMemoryContent('不是遇到困难就绕弯路。比如说这种，uasset就是不可读的，我纵使再努力也', {
        targetLayer: 'L3',
      }),
    ).toBe(true)
    expect(isLowQualityMemoryContent('回答必须简洁，')).toBe(true)
    expect(isLowQualityMemoryContent('回答必须简洁')).toBe(false)
})

describe('isLowQualityInsight', () => {
  it('rejects keyword-preference fluff from old rules fallback', () => {
    expect(
      isLowQualityInsight('用户在多个场景提到「Agent」，可能是一个重要偏好'),
    ).toBe(true)
    expect(
      isLowQualityInsight('用户在多个场景提到「的调用次」，可能是一个重要偏好'),
    ).toBe(true)
  })

  it('rejects low confidence insights', () => {
    expect(
      isLowQualityInsight('金价查询结果随搜索方式不同差异较大', { confidence: 0.6 }),
    ).toBe(true)
    expect(
      isLowQualityInsight(
        '用户重视通过代码硬限制而非 Prompt 约束来保证 Agent 行为边界',
        { confidence: 0.85 },
      ),
    ).toBe(false)
  })

  it('keeps durable cross-session insights', () => {
    expect(
      isLowQualityInsight(
        '用户项目的 Agent 设计遵循提议-确认-执行的确认门控模式',
      ),
    ).toBe(false)
  })
})

describe('memoryContentDedupeKey', () => {
  it('trims and scopes by layer', () => {
    expect(memoryContentDedupeKey('L1', '  TAgent-Desktop  ')).toBe('L1\0TAgent-Desktop')
    expect(memoryContentDedupeKey('L1', 'a')).not.toBe(memoryContentDedupeKey('L2', 'a'))
  })
})
