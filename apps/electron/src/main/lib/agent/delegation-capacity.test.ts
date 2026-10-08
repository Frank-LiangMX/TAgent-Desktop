import { describe, expect, it, vi } from 'vitest'
const prefs = vi.hoisted(() => ({ maxParallelWorkers: 2 }))
vi.mock('./agent-crew-prefs', () => ({ readAgentCrewPrefs: () => prefs }))
import { countDelegationSlots, tryReserveDelegationSlot } from './delegation-capacity'

describe('shared parent delegation budget', () => {
  it('foreground, background and crew share one synchronous cap; parents are independent', () => {
    const foreground = tryReserveDelegationSlot('p', 'foreground')!
    const background = tryReserveDelegationSlot('p', 'background')!
    expect(tryReserveDelegationSlot('p', 'crew')).toBeNull()
    expect(tryReserveDelegationSlot('p', 'foreground')).toBeNull()
    const other = tryReserveDelegationSlot('other', 'crew')!
    expect(countDelegationSlots('p')).toBe(2)
    foreground()
    const crew = tryReserveDelegationSlot('p', 'crew')!
    expect(crew).toBeTypeOf('function')
    background(); crew(); other()
    expect(countDelegationSlots('p')).toBe(0)
  })
  it('old release is idempotent and cannot release a newer reservation', () => {
    const old = tryReserveDelegationSlot('p', 't')!
    old()
    const current = tryReserveDelegationSlot('p', 't')!
    old()
    expect(countDelegationSlots('p')).toBe(1)
    current()
  })
  it('lowering the cap does not kill active work or grant new slots', () => {
    const release = tryReserveDelegationSlot('p', 't')!
    prefs.maxParallelWorkers = 1
    expect(tryReserveDelegationSlot('p', 'next')).toBeNull()
    release()
    tryReserveDelegationSlot('p', 'next')!()
    prefs.maxParallelWorkers = 2
  })
})
