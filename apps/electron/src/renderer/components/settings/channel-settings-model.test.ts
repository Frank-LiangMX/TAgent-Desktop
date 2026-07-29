import { describe, expect, it } from 'vitest'
import {
  buildUpdateInput,
  channelToDraft,
  mergeFetchedModels,
  normalizeModels,
  validateChannelDraft,
} from './channel-settings-model'

describe('channel settings model', () => {
  it('deduplicates models and chooses the first enabled model as default', () => {
    expect(normalizeModels([
      { id: ' model-a ', name: '', enabled: false },
      { id: 'model-a', name: 'duplicate', enabled: true },
      { id: 'model-b', name: 'Model B', enabled: true },
    ], 'model-a')).toEqual({
      models: [
        { id: 'model-a', name: 'model-a', enabled: false },
        { id: 'model-b', name: 'Model B', enabled: true },
      ],
      defaultModelId: 'model-b',
    })
  })

  it('merges a remote list without losing local enabled state or manual models', () => {
    expect(mergeFetchedModels(
      [
        { id: 'remote-a', name: 'Old name', enabled: false },
        { id: 'manual', name: 'Manual', enabled: true },
      ],
      [
        { id: 'remote-a', name: 'Remote A', enabled: true },
        { id: 'remote-b', name: 'Remote B', enabled: true },
      ],
      'manual',
    )).toEqual({
      models: [
        { id: 'remote-a', name: 'Old name', enabled: false },
        { id: 'remote-b', name: 'Remote B', enabled: true },
        { id: 'manual', name: 'Manual', enabled: true },
      ],
      defaultModelId: 'manual',
    })
  })

  it('requires usable connection details and an enabled model', () => {
    const result = validateChannelDraft({
      name: '',
      provider: 'openai',
      baseUrl: 'not-a-url',
      apiKey: '',
      models: [],
      defaultModelId: '',
      enabled: true,
    }, 'add')
    expect(result.valid).toBe(false)
    expect(result.errors).toMatchObject({
      name: expect.any(String),
      baseUrl: expect.any(String),
      apiKey: expect.any(String),
      models: expect.any(String),
    })
  })

  it('keeps an existing secret when edit input is blank', () => {
    const draft = channelToDraft({
      id: 'channel-1',
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'encrypted',
      models: [{ id: 'gpt-5', name: 'GPT-5', enabled: true }],
      defaultModelId: 'gpt-5',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(buildUpdateInput(draft).apiKey).toBeUndefined()
  })
})
