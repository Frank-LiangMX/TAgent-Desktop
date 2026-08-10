import { describe, expect, test } from 'vitest'
import { resolveSdkEffort } from './claude-agent-adapter'
import type { Options as SdkOptions } from '@anthropic-ai/claude-agent-sdk'
import { REASONING_EFFORT_ORDER } from '@tagent/shared'

/**
 * 证明 session meta.reasoningEffort 真正落到 Claude Agent SDK query options.effort。
 * buildSdkOptions 用 resolveSdkEffort 注入 `effort`；这里直接验其产出即 options.effort 值。
 */
describe('resolveSdkEffort — reasoningEffort → SDK options.effort', () => {
  test('四个档位产出互不相同的 effort（不同 reasoningEffort → 不同 SDK options）', () => {
    const efforts = REASONING_EFFORT_ORDER.map((e) => resolveSdkEffort(e))
    expect(new Set(efforts).size).toBe(REASONING_EFFORT_ORDER.length)
  })

  test('low/medium/high/max 分别直传', () => {
    expect(resolveSdkEffort('low')).toBe('low')
    expect(resolveSdkEffort('medium')).toBe('medium')
    expect(resolveSdkEffort('high')).toBe('high')
    expect(resolveSdkEffort('max')).toBe('max')
  })

  test('产出类型符合 SdkOptions["effort"]（EffortLevel: low|medium|high|xhigh|max）', () => {
    const e: SdkOptions['effort'] = resolveSdkEffort('high')
    expect(e).toBe('high')
  })

  test('max 不被 TAgent 侧降级（交由 SDK 按模型静默降级）', () => {
    expect(resolveSdkEffort('max')).toBe('max')
  })
})
