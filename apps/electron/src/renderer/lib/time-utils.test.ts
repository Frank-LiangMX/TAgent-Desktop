import { describe, expect, test } from 'vitest'
import { resolveLiveElapsedAnchor } from './time-utils'

describe('live elapsed anchor', () => {
  test('same timer switches to a new anchor for the next queued task', () => {
    const next = resolveLiveElapsedAnchor(1_000, 1_000, 5_000, true)
    expect(next).toEqual({ anchor: 5_000, startedAt: 5_000 })
  })

  test('a real earlier timestamp can replace a temporary fallback', () => {
    const next = resolveLiveElapsedAnchor(5_000, 5_000, 4_000, true)
    expect(next).toEqual({ anchor: 4_000, startedAt: 4_000 })
  })

  test('leaving live clears the anchor for the next run', () => {
    const next = resolveLiveElapsedAnchor(1_000, 1_000, undefined, false)
    expect(next).toEqual({ anchor: null, startedAt: null })
  })
})
