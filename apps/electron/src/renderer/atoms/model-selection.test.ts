import { describe, expect, it } from 'vitest'
import type { Channel } from '@tagent/shared'
import {
  getChannelCoreKind,
  isModelSelectionAvailable,
  resolveModelSelection,
} from './model-selection'

function channel(
  id: string,
  provider: Channel['provider'],
  enabled = true,
  modelEnabled = true,
): Channel {
  return {
    id,
    name: id,
    provider,
    baseUrl: '',
    apiKey: '',
    models: [{ id: `${id}-model`, name: `${id} model`, enabled: modelEnabled }],
    defaultModelId: `${id}-model`,
    enabled,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('model selection', () => {
  it('separates the kscc runtime from all external providers', () => {
    expect(getChannelCoreKind(channel('kscc', 'kscc-internal'))).toBe('kscc')
    expect(getChannelCoreKind(channel('openai', 'openai'))).toBe('external')
    expect(getChannelCoreKind(channel('anthropic', 'anthropic'))).toBe('external')
  })

  it('keeps an available channel and model pair', () => {
    const channels = [channel('external', 'openai')]
    const preferred = { channelId: 'external', modelId: 'external-model' }
    expect(resolveModelSelection(channels, preferred)).toEqual(preferred)
  })

  it('falls back to the enabled kscc model before external channels', () => {
    const channels = [
      channel('external', 'openai'),
      channel('kscc', 'kscc-internal'),
    ]
    expect(resolveModelSelection(channels)).toEqual({
      channelId: 'kscc',
      modelId: 'kscc-model',
    })
  })

  it('skips disabled channels and models', () => {
    const channels = [
      channel('disabled-channel', 'openai', false),
      channel('disabled-model', 'openai', true, false),
      channel('usable', 'openai'),
    ]
    expect(resolveModelSelection(channels)?.channelId).toBe('usable')
    expect(isModelSelectionAvailable(channels, {
      channelId: 'disabled-model',
      modelId: 'disabled-model-model',
    })).toBe(false)
  })

  it('returns null when no usable model exists', () => {
    expect(resolveModelSelection([channel('empty', 'openai', true, false)])).toBeNull()
  })
})
