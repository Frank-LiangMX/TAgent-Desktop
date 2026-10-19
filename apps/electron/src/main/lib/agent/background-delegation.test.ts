import { describe, expect, it } from 'vitest'
import {
  enqueueBackgroundCallback,
  parseTaskDelegationMode,
  snapshotAgentMessages,
  wrapBackgroundCallbackPrompt,
  type BackgroundCallbackPayload,
} from './background-delegation'

function payload(
  patch: Partial<BackgroundCallbackPayload> = {},
): BackgroundCallbackPayload {
  return {
    taskId: 't1',
    description: '探索代码库',
    subagentType: 'explorer',
    status: 'completed',
    summary: '3 次工具 · 2s',
    resultText: '找到 2 处入口',
    durationMs: 2000,
    fork: [{ role: 'user', content: 'hello' }],
    ...patch,
  }
}

describe('parseTaskDelegationMode', () => {
  it('缺省和非法值走 background', () => {
    expect(parseTaskDelegationMode(undefined)).toBe('background')
    expect(parseTaskDelegationMode('')).toBe('background')
    expect(parseTaskDelegationMode('async')).toBe('background')
  })

  it('只有 foreground 才前台等待', () => {
    expect(parseTaskDelegationMode('foreground')).toBe('foreground')
    expect(parseTaskDelegationMode('background')).toBe('background')
  })
})

describe('wrapBackgroundCallbackPrompt', () => {
  it('标明回投并要求收口，不把结论当新任务', () => {
    const text = wrapBackgroundCallbackPrompt(payload())
    expect(text).toContain('【后台子代理回投】')
    expect(text).toContain('探索代码库')
    expect(text).toContain('找到 2 处入口')
    expect(text).toContain('请据此收口')
    expect(text).toContain('不要把这段话当成新的独立任务')
  })

  it('失败状态写进标题', () => {
    expect(wrapBackgroundCallbackPrompt(payload({ status: 'failed' }))).toContain('失败')
  })

  it('阶段结果不能被回投成完整交付', () => {
    expect(wrapBackgroundCallbackPrompt(payload({ status: 'partial' }))).toContain('尚未全部完成')
  })
})

describe('snapshotAgentMessages', () => {
  it('深拷贝，后续改 live 不影响 fork', () => {
    const live = [{ role: 'user', content: 'a' }]
    const fork = snapshotAgentMessages(live) as Array<{ content: string }>
    live[0]!.content = 'b'
    expect(fork[0]?.content).toBe('a')
  })

  it('非数组返回空', () => {
    expect(snapshotAgentMessages(null)).toEqual([])
  })
})

describe('enqueueBackgroundCallback', () => {
  it('同 taskId 去重，保留最新', () => {
    const q = enqueueBackgroundCallback(
      [payload({ resultText: '旧' })],
      payload({ resultText: '新' }),
    )
    expect(q).toHaveLength(1)
    expect(q[0]?.resultText).toBe('新')
  })

  it('超出上限丢掉最旧的', () => {
    const seed = [payload({ taskId: 'a' }), payload({ taskId: 'b' })]
    const q = enqueueBackgroundCallback(seed, payload({ taskId: 'c' }), 2)
    expect(q.map((item) => item.taskId)).toEqual(['b', 'c'])
  })
})
