import { describe, expect, test } from 'vitest'
import {
  resolveSdkEffort,
  ksccPostToolBatchToObservation,
  normalizeResultToPausedNoProgress,
} from './claude-agent-adapter'
import { NoProgressGuard, buildNoProgressEventFromDecision } from '../../agent/no-progress-guard'
import type { Options as SdkOptions } from '@anthropic-ai/claude-agent-sdk'
import { REASONING_EFFORT_ORDER, type SDKMessage, type SDKResultMessage } from '@tagent/shared'

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

/**
 * No-Progress Guard KSCC 接线（§10.2 / §14.2）。
 * 不 spawn SDK，直接验 hook 驱动的纯函数：观察翻译、终态归一化、事件构造、
 * 以及 PostToolBatch→observe→additionalContext（warn）的驱动链路。
 */
describe('No-Progress Guard KSCC 接线', () => {
  test('ksccPostToolBatchToObservation 翻译 hook 输入为统一观察', () => {
    const obs = ksccPostToolBatchToObservation(
      {
        tool_calls: [
          { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu-1', tool_response: '' },
        ],
      },
      's1',
      't1',
      1000,
    )
    expect(obs.provider).toBe('kscc')
    expect(obs.sessionId).toBe('s1')
    expect(obs.turnId).toBe('t1')
    expect(obs.observedAt).toBe(1000)
    expect(obs.calls).toHaveLength(1)
    expect(obs.calls[0]).toMatchObject({ toolUseId: 'tu-1', toolName: 'Bash', input: { command: 'npm test' } })
  })

  test('normalizeResultToPausedNoProgress 归一化为唯一 paused_no_progress（§20.5）', () => {
    const errMaxTurns: SDKMessage = {
      type: 'result',
      subtype: 'error_max_turns',
      usage: { input_tokens: 0, output_tokens: 0 },
      errors: ['已达最大工具循环轮次'],
    } as SDKResultMessage
    const out = normalizeResultToPausedNoProgress(errMaxTurns) as SDKResultMessage
    expect(out.type).toBe('result')
    expect(out.subtype).toBe('paused_no_progress')
    expect(out.errors?.[0]).toContain('已暂停')
    // 非 result 不改
    const assistant: SDKMessage = { type: 'assistant', message: { content: [] }, parent_tool_use_id: null } as never
    expect(normalizeResultToPausedNoProgress(assistant)).toBe(assistant)
  })

  test('buildNoProgressEventFromDecision: shadow 带 shadow=true；enforce 不带', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0.js'
    g.observe({
      sessionId: 's', turnId: 't', provider: 'kscc', observedAt: 100,
      calls: [{ toolUseId: 'a', toolName: 'Bash', input: { command: cmd }, output: '', error: 'Command timed out after 30s (exit code 124)' }],
    })
    const d = g.observe({
      sessionId: 's', turnId: 't', provider: 'kscc', observedAt: 200,
      calls: [{ toolUseId: 'b', toolName: 'Bash', input: { command: cmd }, output: '', error: 'Command timed out after 30s (exit code 124)' }],
    })
    expect(d.kind).toBe('warn')
    expect(buildNoProgressEventFromDecision(d, 'shadow').shadow).toBe(true)
    expect(buildNoProgressEventFromDecision(d, 'enforce').shadow).toBe(false)
    expect(buildNoProgressEventFromDecision(d, 'enforce').phase).toBe('warning')
    expect(buildNoProgressEventFromDecision(d, 'enforce').reasonCodes).toContain('empty_timeout_repeated')
  })

  test('PostToolBatch 驱动链路：一级提醒只注入上下文，不终止（§14.2）', () => {
    // 模拟 buildNoProgressHooks 的 PostToolBatch 回调逻辑（不 spawn SDK）：
    // 翻译观察 → guard.observe → warn 时返回 additionalContext（非 pause）。
    // SDK Bash tool_response 形如 { stdout, stderr, exitCode }；空输出超时靠 exitCode 识别。
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0.js'
    const emptyTimeoutResponse = { exitCode: 124, stdout: '', stderr: '', interrupted: true }
    const drive = (hookInput: { tool_calls: any[] }, at: number) => {
      const decision = g.observe(ksccPostToolBatchToObservation(hookInput, 's', 't', at))
      if (decision.kind === 'pause') return { paused: true }
      if (decision.modelContext) return { additionalContext: decision.modelContext }
      return {}
    }
    const r1 = drive({ tool_calls: [{ tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: '1', tool_response: emptyTimeoutResponse }] }, 100)
    expect(r1).toEqual({}) // 首次 neutral，无注入
    const r2 = drive({ tool_calls: [{ tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: '2', tool_response: emptyTimeoutResponse }] }, 200)
    expect(r2).toHaveProperty('additionalContext') // warn → 注入复盘上下文
    expect((r2 as { additionalContext: string }).additionalContext).toContain('未产生新证据')
    expect(r2).not.toHaveProperty('paused') // 一级提醒不终止
  })
})
