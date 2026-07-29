import { describe, expect, it } from 'vitest'
import { shouldCompact } from '@earendil-works/pi-agent-core'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Model, Models } from '@earendil-works/pi-ai'

import {
  calculateReserveTokens,
  resolveContextWindow,
  buildTagentCompactionSettings,
  toPiCompactionSettings,
  TAGENT_PI_COMPACTION_THRESHOLD_RATIO,
  TAGENT_PI_COMPACTION_FALLBACK_CONTEXT_WINDOW,
} from './pi-context-settings'
import {
  maybeCompactMessages,
  findCompactionCutIndex,
  assembleCompactedMessages,
} from './pi-context-compaction'

// ===== 测试用消息构造 =====

function userMsg(text: string, timestamp = 0): AgentMessage {
  return { role: 'user', content: text, timestamp } as AgentMessage
}

function userMsgBlocks(text: string, timestamp = 0): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp } as AgentMessage
}

/** assistant 消息；totalTokens 控制 estimateContextTokens 的 usage 读数（触发 shouldCompact 用） */
function assistantMsg(text: string, totalTokens = 0, timestamp = 0): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens },
    model: 'mock',
    timestamp,
  } as unknown as AgentMessage
}

const MOCK_MODEL = {
  id: 'mock',
  name: 'mock',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_192,
} as unknown as Model<Api>

/** 摘要请求的 mock Models：completeSimple 返回固定摘要，不走真实网络 */
function createMockModels(summaryText: string): Models {
  const mockAssistant = {
    role: 'assistant',
    content: [{ type: 'text', text: summaryText }],
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    model: 'mock',
  } as unknown as AssistantMessage
  return { completeSimple: async () => mockAssistant } as unknown as Models
}

// ===== 配置换算 =====

describe('pi-context-settings', () => {
  it('calculateReserveTokens = ceil(window * (1 - ratio))', () => {
    expect(calculateReserveTokens(100_000, 0.8)).toBe(20_000)
    // 200_000 * 0.2 = 40_000（整）
    expect(calculateReserveTokens(200_000, 0.8)).toBe(40_000)
    // 非整需向上取整：100_000 * 0.15 = 15_000；100_001 * 0.2 = 20000.2 → 20001
    expect(calculateReserveTokens(100_001, 0.8)).toBe(20_001)
    // 默认 ratio = 0.8
    expect(calculateReserveTokens(100_000)).toBe(20_000)
  })

  it('resolveContextWindow 缺失/非法走兜底，否则用声明值', () => {
    expect(resolveContextWindow(128_000)).toBe(128_000)
    expect(resolveContextWindow(0)).toBe(TAGENT_PI_COMPACTION_FALLBACK_CONTEXT_WINDOW)
    expect(resolveContextWindow(undefined)).toBe(TAGENT_PI_COMPACTION_FALLBACK_CONTEXT_WINDOW)
    expect(resolveContextWindow(-1)).toBe(TAGENT_PI_COMPACTION_FALLBACK_CONTEXT_WINDOW)
  })

  it('buildTagentCompactionSettings 组装齐字段且 reserve 由窗口换算', () => {
    const s = buildTagentCompactionSettings(128_000)
    expect(s.enabled).toBe(true)
    expect(s.thresholdRatio).toBe(TAGENT_PI_COMPACTION_THRESHOLD_RATIO)
    expect(s.contextWindow).toBe(128_000)
    expect(s.reserveTokens).toBe(calculateReserveTokens(128_000))
    expect(s.keepRecentTokens).toBeGreaterThan(0)
    expect(s.keepRecentTokens).toBe(buildTagentCompactionSettings(128_000).keepRecentTokens) // 稳定默认
  })

  it('buildTagentCompactionSettings 支持自定义 enabled/keepRecent', () => {
    const s = buildTagentCompactionSettings(100_000, { enabled: false, keepRecentTokens: 123 })
    expect(s.enabled).toBe(false)
    expect(s.keepRecentTokens).toBe(123)
  })

  it('toPiCompactionSettings 映射为 Pi CompactionSettings 三字段', () => {
    const s = buildTagentCompactionSettings(100_000, { keepRecentTokens: 999 })
    const pi = toPiCompactionSettings(s)
    expect(pi).toEqual({
      enabled: true,
      reserveTokens: calculateReserveTokens(100_000),
      keepRecentTokens: 999,
    })
  })
})

// ===== shouldCompact 边界（Pi 语义） =====

describe('shouldCompact boundary', () => {
  const settings = { enabled: true, reserveTokens: 20_000, keepRecentTokens: 0 }
  it('窗口 - reserve 是严格大于边界', () => {
    // 100_000 - 20_000 = 80_000
    expect(shouldCompact(79_999, 100_000, settings)).toBe(false)
    expect(shouldCompact(80_000, 100_000, settings)).toBe(false) // 严格 >
    expect(shouldCompact(80_001, 100_000, settings)).toBe(true)
  })
  it('enabled=false 一律不压', () => {
    expect(shouldCompact(1_000_000, 100_000, { ...settings, enabled: false })).toBe(false)
  })
})

// ===== 切点启发式 =====

describe('findCompactionCutIndex', () => {
  it('空消息返回 -1', () => {
    expect(findCompactionCutIndex([], 100)).toBe(-1)
  })

  it('整段都 < keepRecentTokens 返回 -1', () => {
    const msgs = [userMsg('q1'), assistantMsg('a1'), userMsg('q2')]
    expect(findCompactionCutIndex(msgs, 1_000_000)).toBe(-1)
  })

  it('预算达成处往后无 user 边界返回 -1（避免拆散 turn）', () => {
    // [user, assistant, assistant]：预算在第 2 条达成，其后无 user
    const msgs = [userMsg('q'), assistantMsg('aaaa'), assistantMsg('bbbb')]
    expect(findCompactionCutIndex(msgs, 1)).toBe(-1)
  })

  it('在 user turn 边界切，保留从该 user 起的尾', () => {
    // estimateTokens: 'q1'=1, 'a1'=1, 'q2'=1, 'a2'=1, 'recent prompt'=4
    const msgs = [
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantMsg('a2'),
      userMsg('recent prompt'),
    ]
    // keepRecent=6 → 从末尾累到 i=2(msg q2) 时 acc=4+1+1=6 → 找 j>=2 的 user → 2
    expect(findCompactionCutIndex(msgs, 6)).toBe(2)
    // keepRecent=3 → i=4 时 acc=4>=3 → j>=4 的 user → 4
    expect(findCompactionCutIndex(msgs, 3)).toBe(4)
  })

  it('只有单条 user 时切点落在 0（调用方按 <=0 跳过）', () => {
    expect(findCompactionCutIndex([userMsg('q')], 1)).toBe(0)
  })
})

// ===== 消息装配 =====

describe('assembleCompactedMessages', () => {
  it('摘要合并进首条 user（string content），尾原样保留', () => {
    const tail = [userMsg('hello'), assistantMsg('a'), userMsg('prompt')]
    const out = assembleCompactedMessages('SUMM', tail)
    expect(out).toHaveLength(3)
    expect(out[0]!.role).toBe('user')
    // 首条 content 为数组，首块含摘要包装，其后含原文
    const content = (out[0] as { content: Array<{ type: string; text: string }> }).content
    expect(content[0]!.text).toContain('<summary>')
    expect(content[0]!.text).toContain('SUMM')
    expect(content[1]!.text).toBe('hello')
    expect(out[1]).toBe(tail[1])
    expect(out[2]).toBe(tail[2])
  })

  it('摘要合并进首条 user（block content），原块前置摘要块', () => {
    const tail = [userMsgBlocks('hello'), assistantMsg('a')]
    const out = assembleCompactedMessages('SUMM', tail)
    expect(out).toHaveLength(2)
    const content = (out[0] as { content: Array<{ type: string; text: string }> }).content
    expect(content).toHaveLength(2)
    expect(content[0]!.text).toContain('SUMM')
    expect(content[1]!.text).toBe('hello')
  })

  it('空尾兜底：单独塞一条 user 摘要', () => {
    const out = assembleCompactedMessages('SUMM', [])
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('user')
  })
})

// ===== 执行器 maybeCompactMessages =====

describe('maybeCompactMessages force', () => {
  it('force=true 在低于阈值时仍尝试压缩（有安全切点时）', async () => {
    // 构造足够长历史：多条 user/assistant，keepRecent 较小
    const longText = 'x'.repeat(2000)
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: longText }], timestamp: 1 },
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: longText }],
        timestamp: 2,
        api: 'openai-completions',
        provider: 'openai',
        model: 't',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
      },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'recent' }], timestamp: 3 },
    ] as never
    const model = { id: 't', contextWindow: 100_000 } as never
    // mock models that returns a summary
    const models = {
      completeSimple: async () => ({
        role: 'assistant',
        content: [{ type: 'text', text: 'SUMMARY' }],
        stopReason: 'stop',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }),
    } as never
    const settings = { enabled: true, reserveTokens: 80_000, keepRecentTokens: 100 }
    // without force, 2000*2 chars may still be below threshold for 100k window
    const noForce = await maybeCompactMessages({
      messages,
      contextWindow: 100_000,
      settings,
      models,
      model,
      force: false,
    })
    // force should still find cut and compress if mock works
    const forced = await maybeCompactMessages({
      messages,
      contextWindow: 100_000,
      settings,
      models,
      model,
      force: true,
    })
    // force path at least does not return disabled/below threshold as reason for skip
    if (!forced.compacted) {
      expect(forced.reason).not.toBe('below threshold')
      expect(forced.reason).not.toBe('disabled')
    } else {
      expect(forced.messages.length).toBeLessThanOrEqual(messages.length)
      expect(noForce.compacted === false || forced.compacted === true).toBe(true)
    }
  })
})

describe('maybeCompactMessages', () => {
  const baseSettings = { enabled: true, reserveTokens: 20_000, keepRecentTokens: 6 }

  it('disabled 不压缩', async () => {
    const messages = [userMsg('q'), assistantMsg('a', 90_000), userMsg('p')]
    const r = await maybeCompactMessages({
      messages,
      contextWindow: 100_000,
      settings: { ...baseSettings, enabled: false },
      models: createMockModels('S'),
      model: MOCK_MODEL,
    })
    expect(r.compacted).toBe(false)
    expect(r.reason).toBe('disabled')
    expect(r.messages).toBe(messages)
  })

  it('空消息不压缩', async () => {
    const r = await maybeCompactMessages({
      messages: [],
      contextWindow: 100_000,
      settings: baseSettings,
      models: createMockModels('S'),
      model: MOCK_MODEL,
    })
    expect(r.compacted).toBe(false)
    expect(r.reason).toBe('empty')
  })

  it('低于阈值不压缩', async () => {
    // 末条 assistant usage.totalTokens=100 → 远低于 80_000 阈值
    const messages = [userMsg('q'), assistantMsg('a', 100), userMsg('p')]
    const r = await maybeCompactMessages({
      messages,
      contextWindow: 100_000,
      settings: baseSettings,
      models: createMockModels('S'),
      model: MOCK_MODEL,
    })
    expect(r.compacted).toBe(false)
    expect(r.reason).toBe('below threshold')
    expect(r.tokensBefore).toBeLessThan(80_000)
  })

  it('超阈值但无安全切点不压缩', async () => {
    // 超阈值（90_000 > 80_000）但 keepRecent 极大 → 找不到切点
    const messages = [userMsg('q'), assistantMsg('a', 90_000), userMsg('p')]
    const r = await maybeCompactMessages({
      messages,
      contextWindow: 100_000,
      settings: { ...baseSettings, keepRecentTokens: 1_000_000 },
      models: createMockModels('S'),
      model: MOCK_MODEL,
    })
    expect(r.compacted).toBe(false)
    expect(r.reason).toContain('no safe cut point')
  })

  it('超阈值且有切点：调用 Pi generateSummary 并装配压缩后列表', async () => {
    const messages = [
      userMsg('q1'),
      assistantMsg('a1', 1000), // 旧 assistant（usage 不被采用，非末条）
      userMsg('q2'),
      assistantMsg('a2', 90_000), // 末条 assistant → estimate ~90_004，超阈值
      userMsg('recent prompt'),
    ]
    const r = await maybeCompactMessages({
      messages,
      contextWindow: 100_000,
      settings: baseSettings, // keepRecent=6 → 切点 index=2
      models: createMockModels('MOCK SUMMARY'),
      model: MOCK_MODEL,
    })
    expect(r.compacted).toBe(true)
    expect(r.summary).toBe('MOCK SUMMARY')
    expect(r.tokensBefore).toBeGreaterThan(80_000)
    // 装配：[merged(summary+q2), assistant(a2), user(recent prompt)]
    expect(r.messages).toHaveLength(3)
    expect(r.messages[0]!.role).toBe('user')
    const firstContent = (r.messages[0] as { content: Array<{ type: string; text: string }> }).content
    expect(firstContent[0]!.text).toContain('MOCK SUMMARY')
    expect(firstContent[0]!.text).toContain('<summary>')
    // 保留尾的后续消息原样保留
    expect(r.messages[1]).toBe(messages[3])
    expect(r.messages[2]).toBe(messages[4])
    // 旧前缀（q1/a1）已被摘要取代，不在结果里
    expect(r.messages).not.toContain(messages[0])
    expect(r.messages).not.toContain(messages[1])
  })

  it('摘要失败（mock 返回 error）不压缩、回退原消息', async () => {
    const errorAssistant = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      stopReason: 'error',
      errorMessage: 'boom',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      model: 'mock',
    } as unknown as AssistantMessage
    const failingModels = { completeSimple: async () => errorAssistant } as unknown as Models
    const messages = [
      userMsg('q1'),
      assistantMsg('a1', 90_000),
      userMsg('recent prompt'),
    ]
    const r = await maybeCompactMessages({
      messages,
      contextWindow: 100_000,
      settings: { ...baseSettings, keepRecentTokens: 1 }, // 切点 index=2
      models: failingModels,
      model: MOCK_MODEL,
    })
    expect(r.compacted).toBe(false)
    expect(r.reason).toContain('summarization failed')
    expect(r.messages).toBe(messages)
  })
})
