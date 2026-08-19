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

  it('normalizeModels 保留 contextWindow / safeContextLimit', () => {
    const result = normalizeModels(
      [
        {
          id: 'glm-5.2',
          name: 'GLM-5.2',
          enabled: true,
          contextWindow: 1_000_000,
        },
        {
          id: 'kimi-k2.5',
          name: 'Kimi',
          enabled: true,
          contextWindow: 200_000,
          safeContextLimit: 180_000,
        },
      ],
      'glm-5.2',
    )
    expect(result.models).toEqual([
      {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        enabled: true,
        contextWindow: 1_000_000,
      },
      {
        id: 'kimi-k2.5',
        name: 'Kimi',
        enabled: true,
        contextWindow: 200_000,
        safeContextLimit: 180_000,
      },
    ])
  })

  it('normalizeModels 无额外字段时不新增键（保持精简）', () => {
    const result = normalizeModels([{ id: 'm', name: 'M', enabled: true }], 'm')
    expect(result.models[0]!).toEqual({ id: 'm', name: 'M', enabled: true })
    expect(Object.keys(result.models[0]!).sort()).toEqual(['enabled', 'id', 'name'])
  })

  it('mergeFetchedModels 保留本地窗口字段（优先本地，回退远端）', () => {
    const result = mergeFetchedModels(
      [
        {
          id: 'kimi-k2.5',
          name: 'Kimi',
          enabled: true,
          contextWindow: 200_000,
        },
        { id: 'glm-5.2', name: 'GLM', enabled: true, contextWindow: 1_000_000 },
      ],
      [
        {
          id: 'kimi-k2.5',
          name: 'Remote Kimi',
          enabled: false,
          contextWindow: 128_000,
        },
        {
          id: 'new-vl',
          name: 'New VL',
          enabled: true,
          contextWindow: 64_000,
        },
      ],
      'kimi-k2.5',
    )
    const kimi = result.models.find((m) => m.id === 'kimi-k2.5')
    expect(kimi).toMatchObject({
      contextWindow: 200_000,
      enabled: true,
      name: 'Kimi',
    })
    const glm = result.models.find((m) => m.id === 'glm-5.2')
    expect(glm).toMatchObject({ contextWindow: 1_000_000, enabled: true })
    const newVl = result.models.find((m) => m.id === 'new-vl')
    expect(newVl).toMatchObject({ contextWindow: 64_000 })
  })
})
