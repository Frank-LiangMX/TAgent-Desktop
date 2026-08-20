import { describe, expect, test } from 'vitest'
import {
  findAlternatingPair,
  isInCooldown,
  setCooldown,
  SPLIT_SUGGESTION_CONFIG,
  type SwitchRecord,
} from './split-suggestion'

describe('findAlternatingPair', () => {
  const now = Date.now()

  test('returns null when history is too short', () => {
    expect(findAlternatingPair([], now)).toBeNull()
    expect(
      findAlternatingPair(
        [{ sessionId: 'a', timestamp: now }],
        now,
      ),
    ).toBeNull()
  })

  test('returns null when there is only one session', () => {
    expect(
      findAlternatingPair(
        [
          { sessionId: 'a', timestamp: now - 4000 },
          { sessionId: 'a', timestamp: now - 3000 },
          { sessionId: 'a', timestamp: now - 2000 },
          { sessionId: 'a', timestamp: now - 1000 },
          { sessionId: 'a', timestamp: now },
        ],
        now,
      ),
    ).toBeNull()
  })

  test('detects alternating pair with 4 switches', () => {
    const history: SwitchRecord[] = [
      { sessionId: 'a', timestamp: now - 50000 },
      { sessionId: 'b', timestamp: now - 40000 },
      { sessionId: 'a', timestamp: now - 30000 },
      { sessionId: 'b', timestamp: now - 20000 },
      { sessionId: 'a', timestamp: now - 10000 },
    ]
    const result = findAlternatingPair(history, now)
    expect(result).not.toBeNull()
    expect(result!.sort()).toEqual(['a', 'b'])
  })

  test('detects alternating pair starting with b', () => {
    const history: SwitchRecord[] = [
      { sessionId: 'b', timestamp: now - 50000 },
      { sessionId: 'a', timestamp: now - 40000 },
      { sessionId: 'b', timestamp: now - 30000 },
      { sessionId: 'a', timestamp: now - 20000 },
      { sessionId: 'b', timestamp: now - 10000 },
    ]
    const result = findAlternatingPair(history, now)
    expect(result).not.toBeNull()
    expect(result!.sort()).toEqual(['a', 'b'])
  })

  test('returns null when a third session interleaves', () => {
    const history: SwitchRecord[] = [
      { sessionId: 'a', timestamp: now - 50000 },
      { sessionId: 'b', timestamp: now - 40000 },
      { sessionId: 'a', timestamp: now - 30000 },
      { sessionId: 'c', timestamp: now - 20000 },
      { sessionId: 'b', timestamp: now - 10000 },
    ]
    expect(findAlternatingPair(history, now)).toBeNull()
  })

  test('returns null when switches are less than minimum', () => {
    const history: SwitchRecord[] = [
      { sessionId: 'a', timestamp: now - 30000 },
      { sessionId: 'b', timestamp: now - 20000 },
      { sessionId: 'a', timestamp: now - 10000 },
    ]
    expect(findAlternatingPair(history, now)).toBeNull()
  })

  test('ignores entries outside the time window', () => {
    const history: SwitchRecord[] = [
      { sessionId: 'a', timestamp: now - 70000 },
      { sessionId: 'b', timestamp: now - 65000 },
      { sessionId: 'a', timestamp: now - 50000 },
      { sessionId: 'b', timestamp: now - 40000 },
      { sessionId: 'a', timestamp: now - 30000 },
      { sessionId: 'b', timestamp: now - 20000 },
      { sessionId: 'a', timestamp: now - 10000 },
    ]
    // Without the old entries, we have a,b,a,b,a = 4 switches, should be detected
    const result = findAlternatingPair(history, now)
    expect(result).not.toBeNull()
    expect(result!.sort()).toEqual(['a', 'b'])
  })

  test('detects alternating pair with more than 4 switches', () => {
    const history: SwitchRecord[] = [
      { sessionId: 'a', timestamp: now - 55000 },
      { sessionId: 'b', timestamp: now - 45000 },
      { sessionId: 'a', timestamp: now - 35000 },
      { sessionId: 'b', timestamp: now - 25000 },
      { sessionId: 'a', timestamp: now - 15000 },
      { sessionId: 'b', timestamp: now - 5000 },
    ]
    const result = findAlternatingPair(history, now)
    expect(result).not.toBeNull()
    expect(result!.sort()).toEqual(['a', 'b'])
  })

  test('custom minSwitches parameter works', () => {
    const history: SwitchRecord[] = [
      { sessionId: 'a', timestamp: now - 30000 },
      { sessionId: 'b', timestamp: now - 20000 },
      { sessionId: 'a', timestamp: now - 10000 },
    ]
    // 2 switches, custom min 2
    expect(findAlternatingPair(history, now, 2)).not.toBeNull()
    // 2 switches, default min 4
    expect(findAlternatingPair(history, now)).toBeNull()
  })

  test('returns null for empty history', () => {
    expect(findAlternatingPair([], now)).toBeNull()
  })
})

describe('cooldown', () => {
  test('isInCooldown returns true for active cooldown', () => {
    const map = new Map<string, number>()
    setCooldown(map, ['a', 'b'], Date.now())
    expect(isInCooldown(map, ['a', 'b'], Date.now())).toBe(true)
  })

  test('isInCooldown returns false for expired cooldown', () => {
    const map = new Map<string, number>()
    const farFuture = Date.now() + 100_000
    setCooldown(map, ['a', 'b'], farFuture)
    // Cooldown was set at farFuture, so now (farFuture) should be within cooldown
    expect(isInCooldown(map, ['a', 'b'], farFuture)).toBe(true)
    // After cooldown period expires
    expect(
      isInCooldown(
        map,
        ['a', 'b'],
        farFuture + SPLIT_SUGGESTION_CONFIG.COOLDOWN_MS + 1,
      ),
    ).toBe(false)
  })

  test('isInCooldown returns false for unknown pair', () => {
    const map = new Map<string, number>()
    expect(isInCooldown(map, ['a', 'b'], Date.now())).toBe(false)
  })

  test('pair key is order-independent', () => {
    const map = new Map<string, number>()
    setCooldown(map, ['a', 'b'], Date.now())
    expect(isInCooldown(map, ['b', 'a'], Date.now())).toBe(true)
  })
})