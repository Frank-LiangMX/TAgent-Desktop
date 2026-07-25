import { describe, expect, test } from 'vitest'

import {
  normalizeChannelDefaultModelId,
  resolveAgentSessionModelId,
  resolveChannelDefaultModelId,
} from './channel-default-model'

import type { ChannelModel } from '../types/channel'

const models: ChannelModel[] = [
  { id: 'glm-5.1', name: 'GLM-5.1', enabled: true },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', enabled: true },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', enabled: false },
]

describe('resolveChannelDefaultModelId', () => {
  test('uses explicit default when enabled', () => {
    expect(resolveChannelDefaultModelId({ models, defaultModelId: 'kimi-k2.5' })).toBe('kimi-k2.5')
  })

  test('falls back to first enabled when default disabled', () => {
    expect(
      resolveChannelDefaultModelId({
        models: models.map((m) => (m.id === 'kimi-k2.5' ? { ...m, enabled: false } : m)),
        defaultModelId: 'kimi-k2.5',
      })
    ).toBe('glm-5.1')
  })

  test('falls back to first enabled when no default', () => {
    expect(resolveChannelDefaultModelId({ models })).toBe('glm-5.1')
  })
})

describe('normalizeChannelDefaultModelId', () => {
  test('clears invalid default', () => {
    expect(normalizeChannelDefaultModelId({ models, defaultModelId: 'missing' })).toBeUndefined()
  })

  test('keeps valid default', () => {
    expect(normalizeChannelDefaultModelId({ models, defaultModelId: 'glm-5.1' })).toBe('glm-5.1')
  })
})

describe('resolveAgentSessionModelId', () => {
  const channel = { models, defaultModelId: 'glm-5.1' }

  test('session override wins', () => {
    expect(resolveAgentSessionModelId(channel, 'kimi-k2.5', 'legacy')).toBe('kimi-k2.5')
  })

  test('channel default before legacy global', () => {
    expect(resolveAgentSessionModelId(channel, null, 'kimi-k2.5')).toBe('glm-5.1')
  })

  test('legacy global when channel missing', () => {
    expect(resolveAgentSessionModelId(undefined, null, 'kimi-k2.5')).toBe('kimi-k2.5')
  })
})
