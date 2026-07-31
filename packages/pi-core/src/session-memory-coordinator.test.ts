import { describe, expect, it } from 'vitest'
import { allocateLayerBudgets, SessionMemoryCoordinator } from './session-memory-coordinator'

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
})
