import { describe, expect, it } from 'vitest'
import type { Channel } from '@tagent/shared'
import {
  FALLBACK_CONTEXT_WINDOW,
  findChannelModel,
  resolveModelContextWindow,
  resolveModelSafeContextLimit,
} from './model-window'

function makeChannel(models: Channel['models']): Channel {
  return {
    id: 'ch-1',
    name: 'Test',
    provider: 'kscc-internal',
    enabled: true,
    baseUrl: '',
    apiKey: '',
    models,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Channel
}

describe('resolveModelContextWindow', () => {
  it('returns ChannelModel.contextWindow when present', () => {
    const ch = makeChannel([{ id: 'glm-5.2', name: 'GLM', enabled: true, contextWindow: 1_000_000 }])
    expect(resolveModelContextWindow(ch, 'glm-5.2')).toBe(1_000_000)
  })

  it('falls back to FALLBACK_CONTEXT_WINDOW when missing', () => {
    const ch = makeChannel([{ id: 'x', name: 'X', enabled: true }])
    expect(resolveModelContextWindow(ch, 'x')).toBe(FALLBACK_CONTEXT_WINDOW)
    expect(resolveModelContextWindow(undefined, undefined)).toBe(FALLBACK_CONTEXT_WINDOW)
    expect(resolveModelContextWindow(ch, 'nope')).toBe(FALLBACK_CONTEXT_WINDOW)
  })
})

describe('resolveModelSafeContextLimit priority', () => {
  it('1. ChannelModel.safeContextLimit wins', () => {
    const ch = makeChannel([
      {
        id: 'glm-5.2',
        name: 'GLM',
        enabled: true,
        contextWindow: 1_000_000,
        safeContextLimit: 180_000,
      },
    ])
    expect(resolveModelSafeContextLimit(ch, 'glm-5.2', 999_000)).toBe(180_000)
  })

  it('2. learnedSafeContextLimit when no manual safe limit', () => {
    const ch = makeChannel([
      { id: 'm', name: 'M', enabled: true, contextWindow: 1_000_000 },
    ])
    expect(resolveModelSafeContextLimit(ch, 'm', 250_000)).toBe(250_000)
  })

  it('3. contextWindow × 0.7 when no safe/learned', () => {
    const ch = makeChannel([
      { id: 'm', name: 'M', enabled: true, contextWindow: 200_000 },
    ])
    expect(resolveModelSafeContextLimit(ch, 'm')).toBe(Math.ceil(200_000 * 0.7))
  })

  it('4. fallback × 0.7 when everything missing', () => {
    expect(resolveModelSafeContextLimit(undefined, undefined)).toBe(
      Math.ceil(FALLBACK_CONTEXT_WINDOW * 0.7),
    )
  })
})

describe('findChannelModel', () => {
  it('finds model by id', () => {
    const ch = makeChannel([
      { id: 'a', name: 'A', enabled: true },
      { id: 'b', name: 'B', enabled: true },
    ])
    expect(findChannelModel(ch, 'b')?.name).toBe('B')
    expect(findChannelModel(ch, 'z')).toBeUndefined()
  })
})
