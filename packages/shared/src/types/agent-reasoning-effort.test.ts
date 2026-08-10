import { describe, expect, test } from 'vitest'
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_ORDER,
  migrateReasoningEffort,
  reasoningEffortToSdkEffort,
  reasoningEffortToPiThinkingLevel,
  type ReasoningEffort,
  type SdkEffortLevel,
  type PiThinkingLevel,
} from './agent'

describe('migrateReasoningEffort — 未设置走明确默认', () => {
  test('undefined → DEFAULT_REASONING_EFFORT (medium)', () => {
    expect(migrateReasoningEffort(undefined)).toBe(DEFAULT_REASONING_EFFORT)
    expect(DEFAULT_REASONING_EFFORT).toBe('medium')
  })

  test('非法值 → medium', () => {
    expect(migrateReasoningEffort('' as never)).toBe('medium')
    expect(migrateReasoningEffort('xhigh' as never)).toBe('medium')
    expect(migrateReasoningEffort('HIGH' as never)).toBe('medium')
  })

  test('合法值原样返回', () => {
    for (const e of REASONING_EFFORT_ORDER) {
      expect(migrateReasoningEffort(e)).toBe(e)
    }
  })
})

describe('reasoningEffortToSdkEffort — 不同档位产生不同 SDK effort', () => {
  const cases: Array<{ effort: ReasoningEffort; sdk: SdkEffortLevel }> = [
    { effort: 'low', sdk: 'low' },
    { effort: 'medium', sdk: 'medium' },
    { effort: 'high', sdk: 'high' },
    { effort: 'max', sdk: 'max' },
  ]

  for (const { effort, sdk } of cases) {
    test(`${effort} → ${sdk}`, () => {
      expect(reasoningEffortToSdkEffort(effort)).toBe(sdk)
    })
  }

  test('四个档位映射结果互不相同（证明“不同 reasoningEffort → 不同 SDK options.effort”）', () => {
    const mapped = REASONING_EFFORT_ORDER.map((e) => reasoningEffortToSdkEffort(e))
    expect(new Set(mapped).size).toBe(REASONING_EFFORT_ORDER.length)
  })

  test('max 直传 max（SDK 按模型静默降级，TAgent 侧不降级）', () => {
    expect(reasoningEffortToSdkEffort('max')).toBe('max')
  })

  test('不引入 xhigh（TAgent 枚举无 xhigh）', () => {
    const all = new Set(REASONING_EFFORT_ORDER.map((e) => reasoningEffortToSdkEffort(e)))
    expect(all.has('xhigh')).toBe(false)
  })
})

describe('reasoningEffortToPiThinkingLevel — Pi 核 thinkingLevel 映射', () => {
  const cases: Array<{ effort: ReasoningEffort; level: PiThinkingLevel }> = [
    { effort: 'low', level: 'low' },
    { effort: 'medium', level: 'medium' },
    { effort: 'high', level: 'high' },
    // Pi 无 max 档：max 降级到 high
    { effort: 'max', level: 'high' },
  ]

  for (const { effort, level } of cases) {
    test(`${effort} → ${level}`, () => {
      expect(reasoningEffortToPiThinkingLevel(effort)).toBe(level)
    })
  }

  test('Pi 映射档位去重后仍区分 low/medium/high', () => {
    const mapped = REASONING_EFFORT_ORDER.map((e) => reasoningEffortToPiThinkingLevel(e))
    expect(new Set(mapped).has('low')).toBe(true)
    expect(new Set(mapped).has('medium')).toBe(true)
    expect(new Set(mapped).has('high')).toBe(true)
  })
})
