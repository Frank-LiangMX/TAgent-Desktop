import { describe, expect, it } from 'vitest'
import { allocateLayerBudgets, SessionMemoryCoordinator } from './session-memory-coordinator'

function user(text: string): any {
  return { role: 'user', content: text, timestamp: 1 }
}

function assistantWithContextTokens(totalTokens: number): any {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens },
    model: 'mock',
    timestamp: 2,
  }
}

function summaryModels(summary = 'summary'): any {
  return {
    completeSimple: async () => ({
      role: 'assistant',
      content: [{ type: 'text', text: summary }],
      stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    }),
  }
}

describe('allocateLayerBudgets', () => {
  it('small window prioritizes L-short', () => {
    const b = allocateLayerBudgets(16_000)
    expect(b.lshort).toBeGreaterThan(b.lmid)
    expect(b.lshort).toBeGreaterThan(b.lrag)
  })

  it('large window expands L-mid share vs small', () => {
    const small = allocateLayerBudgets(30_000)
    const large = allocateLayerBudgets(400_000)
    expect(large.lmid / large.total).toBeGreaterThan(small.lmid / small.total)
  })

  it('mid window ~12% L-mid', () => {
    const b = allocateLayerBudgets(100_000)
    const ratio = b.lmid / b.total
    expect(ratio).toBeGreaterThan(0.1)
    expect(ratio).toBeLessThan(0.15)
  })
})

describe('SessionMemoryCoordinator state', () => {
  it('holds lmid chain and rag cache', () => {
    const c = new SessionMemoryCoordinator('s1')
    expect(c.state.lmidChain).toEqual([])
    c.state.lmidChain.push('摘要1')
    c.state.lastRagHits = [{ source: 'L4:x', text: 'hit' }]
    expect(c.state.lmidChain).toHaveLength(1)
    expect(c.state.lastRagHits[0]?.source).toBe('L4:x')
  })

  it('uses 80% of a 500k window as the automatic boundary, not L-short budget', async () => {
    const settings = { enabled: true, reserveTokens: 100_000, keepRecentTokens: 1 }
    const below = new SessionMemoryCoordinator('500k-below')
    const belowResult = await below.reconcile({
      messages: [user('old'), assistantWithContextTokens(300_000), user('current')],
      contextWindow: 500_000,
      settings,
      models: summaryModels(),
      model: {} as never,
    })
    expect(belowResult.compacted).toBe(false)
    expect(belowResult.reason).toBe('below threshold')

    const at = new SessionMemoryCoordinator('500k-at')
    const atResult = await at.reconcile({
      messages: [user('old'), assistantWithContextTokens(400_000), user('current')],
      contextWindow: 500_000,
      settings,
      models: summaryModels(),
      model: {} as never,
    })
    expect(atResult.compacted).toBe(true)
    expect(atResult.tokensBefore).toBeGreaterThanOrEqual(400_000)
  })

  it('marks a threshold hit as required when summarization fails', async () => {
    const c = new SessionMemoryCoordinator('compact-failure')
    const result = await c.reconcile({
      messages: [user('old'), assistantWithContextTokens(400_000), user('current')],
      contextWindow: 500_000,
      settings: { enabled: true, reserveTokens: 100_000, keepRecentTokens: 1 },
      models: {
        completeSimple: async () => ({
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          stopReason: 'error',
          errorMessage: 'summary unavailable',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        }),
      } as any,
      model: {} as never,
    })
    expect(result.compacted).toBe(false)
    expect(result.compactionRequired).toBe(true)
    expect(result.compactionError).toContain('summarization failed')
  })

  it('merges injected RAG context into the request view without synthetic assistant chatter', async () => {
    const c = new SessionMemoryCoordinator('rag-usage')
    const result = await c.reconcile({
      messages: [{ role: 'user', content: 'question', timestamp: 1 }],
      contextWindow: 100_000,
      settings: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 20_000 },
      models: {} as never,
      model: {} as never,
      retrieveRag: async () => [{ source: 'test', text: 'remember this' }],
    })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.role).toBe('user')
    const first = result.messages[0]
    if (first?.role === 'user') {
      expect(first.content).toEqual([
        { type: 'text', text: expect.stringContaining('相关记忆') },
        { type: 'text', text: 'question' },
      ])
    }
    expect(result.stateMessages).toEqual([
      { role: 'user', content: 'question', timestamp: 1 },
    ])

    const next = await c.reconcile({
      messages: result.stateMessages,
      contextWindow: 100_000,
      settings: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 20_000 },
      models: {} as never,
      model: {} as never,
      retrieveRag: async () => [{ source: 'test', text: 'remember this' }],
    })
    expect(next.stateMessages).toEqual(result.stateMessages)
    expect(next.messages).toHaveLength(1)
    if (next.messages[0]?.role === 'user') {
      expect(next.messages[0].content).toEqual([
        { type: 'text', text: expect.stringContaining('相关记忆') },
        { type: 'text', text: 'question' },
      ])
    }
  })
})
