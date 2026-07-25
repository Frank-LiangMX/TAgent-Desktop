import { describe, expect, test } from 'vitest'

import { calculateContextUsageRatio, sumContextUsedTokens } from './context-usage'
import {
  inferContextWindow,
  pickResultContextWindow,
  resolveDisplayContextWindow,
} from './context-window'

describe('sumContextUsedTokens', () => {
  test('sums input and cache fields', () => {
    expect(
      sumContextUsedTokens({
        input_tokens: 1000,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 50,
      })
    ).toBe(1350)
  })
})

describe('calculateContextUsageRatio', () => {
  test('returns ratio for valid inputs', () => {
    expect(calculateContextUsageRatio(50_000, 128_000)).toBeCloseTo(50_000 / 128_000)
  })

  test('returns undefined for invalid inputs', () => {
    expect(calculateContextUsageRatio(undefined, 128_000)).toBeUndefined()
    expect(calculateContextUsageRatio(-1, 128_000)).toBeUndefined()
  })
})

describe('pickResultContextWindow', () => {
  test('picks largest context window across modelUsage entries', () => {
    expect(
      pickResultContextWindow({
        subagent: { contextWindow: 200_000 },
        'claude-sonnet-4': { contextWindow: 1_000_000 },
      })
    ).toBe(1_000_000)
  })

  test('infers from model id when contextWindow missing', () => {
    expect(pickResultContextWindow({ 'glm-5.1': {} })).toBe(200_000)
  })

  test('upgrades MiniMax 200K SDK window to 1M display', () => {
    expect(
      pickResultContextWindow({
        'MiniMax-M3': { contextWindow: 200_000 },
      })
    ).toBe(1_000_000)
  })
})

describe('inferContextWindow', () => {
  test('recognizes glm-5.1 as 200k', () => {
    expect(inferContextWindow('glm-5.1')).toBe(200_000)
  })

  test('recognizes minimax-m3 as 1M', () => {
    expect(inferContextWindow('MiniMax-M3')).toBe(1_000_000)
  })
})

describe('resolveDisplayContextWindow', () => {
  test('upgrades compat endpoint 200K to 1M for MiniMax-M3', () => {
    expect(resolveDisplayContextWindow('MiniMax-M3', 200_000)).toBe(1_000_000)
  })

  test('does not upgrade Claude models stuck at 200K', () => {
    expect(resolveDisplayContextWindow('claude-haiku-4', 200_000)).toBe(200_000)
  })

  test('trusts SDK when already above 200K', () => {
    expect(resolveDisplayContextWindow('MiniMax-M3', 512_000)).toBe(512_000)
  })
})
