import { describe, expect, it } from 'vitest'
import {
  createMoARoundtablePanel,
  deriveMoAPhase,
  setMoASeatStatus,
  markMoAPanelCancelled,
  setMoAPanelPhase,
} from './moa-roundtable'
import type { MoARoundtablePanel, MoASeatPanel } from './tagent-message'

const SEED = {
  roundtableId: 'moa-rt-s1-0',
  presetId: 'default',
  presetName: '默认会诊',
  topic: '如何拆分模块？',
  references: [
    { seatId: 'ref-0', name: '架构师', modelId: 'glm-5.2' },
    { seatId: 'ref-1', name: '实战派', modelId: 'kimi-k2.5' },
  ],
  aggregator: { seatId: 'agg', name: '汇总·glm-5.2', modelId: 'glm-5.2' },
}

function refSeats(panel: MoARoundtablePanel): MoASeatPanel[] {
  return panel.seats.filter((s) => s.role === 'reference')
}
function aggSeat(panel: MoARoundtablePanel): MoASeatPanel | undefined {
  return panel.seats.find((s) => s.role === 'aggregator')
}

describe('createMoARoundtablePanel', () => {
  it('builds initial panel with all seats pending and phase=references', () => {
    const panel = createMoARoundtablePanel(SEED)
    expect(panel.kind).toBe('moa_roundtable')
    expect(panel.roundtableId).toBe(SEED.roundtableId)
    expect(panel.phase).toBe('references')
    expect(panel.seats).toHaveLength(3)
    expect(refSeats(panel)).toHaveLength(2)
    expect(aggSeat(panel)?.role).toBe('aggregator')
    for (const s of panel.seats) {
      expect(s.status).toBe('pending')
    }
  })
})

describe('deriveMoAPhase', () => {
  it('references while any reference seat is pending/running', () => {
    const panel = createMoARoundtablePanel(SEED)
    expect(deriveMoAPhase(panel.seats)).toBe('references')
    const p1 = setMoASeatStatus(panel, 'ref-0', 'running')
    expect(deriveMoAPhase(p1.seats)).toBe('references')
  })

  it('aggregating once all references done with at least one ok (fail-open)', () => {
    const panel = createMoARoundtablePanel(SEED)
    const p1 = setMoASeatStatus(panel, 'ref-0', 'ok', { text: 'A' })
    const p2 = setMoASeatStatus(p1, 'ref-1', 'failed', { error: 'boom' })
    expect(deriveMoAPhase(p2.seats)).toBe('aggregating')
  })

  it('error when all references failed', () => {
    const panel = createMoARoundtablePanel(SEED)
    const p1 = setMoASeatStatus(panel, 'ref-0', 'failed', { error: 'x' })
    const p2 = setMoASeatStatus(p1, 'ref-1', 'failed', { error: 'y' })
    expect(deriveMoAPhase(p2.seats)).toBe('error')
  })

  it('done when aggregator ok; error when aggregator failed', () => {
    const panel = createMoARoundtablePanel(SEED)
    const refsDone = setMoASeatStatus(setMoASeatStatus(panel, 'ref-0', 'ok'), 'ref-1', 'ok')
    const aggOk = setMoASeatStatus(refsDone, 'agg', 'ok', { text: '结论' })
    expect(deriveMoAPhase(aggOk.seats)).toBe('done')
    const aggFail = setMoASeatStatus(refsDone, 'agg', 'failed', { error: '汇总炸了' })
    expect(deriveMoAPhase(aggFail.seats)).toBe('error')
  })

  it('aggregating while aggregator running after references done', () => {
    const panel = createMoARoundtablePanel(SEED)
    const refsDone = setMoASeatStatus(setMoASeatStatus(panel, 'ref-0', 'ok'), 'ref-1', 'ok')
    const aggRunning = setMoASeatStatus(refsDone, 'agg', 'running')
    expect(deriveMoAPhase(aggRunning.seats)).toBe('aggregating')
  })
})

describe('setMoASeatStatus', () => {
  it('updates the named seat and rederives phase; carries patch fields', () => {
    const panel = createMoARoundtablePanel(SEED)
    const p1 = setMoASeatStatus(panel, 'ref-0', 'ok', { text: 'hello', latencyMs: 1234 })
    const seat = p1.seats.find((s) => s.seatId === 'ref-0')
    expect(seat?.status).toBe('ok')
    expect(seat?.text).toBe('hello')
    expect(seat?.latencyMs).toBe(1234)
    expect(p1.phase).toBe('references') // ref-1 仍 pending
  })

  it('returns panel unchanged for unknown seatId', () => {
    const panel = createMoARoundtablePanel(SEED)
    const p1 = setMoASeatStatus(panel, 'nope', 'ok')
    expect(p1).toBe(panel)
  })
})

describe('markMoAPanelCancelled', () => {
  it('cancels pending/running seats, keeps terminal seats, sets phase=cancelled', () => {
    const panel = createMoARoundtablePanel(SEED)
    // 一个参考席已完成，一个还在跑，汇总席 pending
    const mid = setMoASeatStatus(setMoASeatStatus(panel, 'ref-0', 'ok', { text: 'A' }), 'ref-1', 'running')
    const cancelled = markMoAPanelCancelled(mid)
    expect(cancelled.phase).toBe('cancelled')
    expect(cancelled.seats.find((s) => s.seatId === 'ref-0')?.status).toBe('ok') // 保留
    expect(cancelled.seats.find((s) => s.seatId === 'ref-1')?.status).toBe('cancelled') // running → cancelled
    expect(cancelled.seats.find((s) => s.seatId === 'agg')?.status).toBe('cancelled') // pending → cancelled
  })
})

describe('setMoAPanelPhase', () => {
  it('overwrites phase without touching seats', () => {
    const panel = createMoARoundtablePanel(SEED)
    const err = setMoAPanelPhase(panel, 'error')
    expect(err.phase).toBe('error')
    expect(err.seats).toBe(panel.seats)
  })
})
