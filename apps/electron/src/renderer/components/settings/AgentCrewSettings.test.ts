import { describe, expect, it } from 'vitest'
import type { Channel } from '@tagent/shared'
import {
  emptyModelProfile,
  getAvailableModelProfiles,
  mergeModelProfiles,
} from './AgentCrewSettings'

function channel(id: string, provider: Channel['provider'], enabled = true): Channel {
  return {
    id,
    name: id,
    provider,
    baseUrl: '',
    apiKey: '',
    enabled,
    createdAt: 1,
    updatedAt: 1,
    models: [
      { id: `${id}-ok`, name: 'ok', enabled: true },
      { id: `${id}-off`, name: 'off', enabled: false },
    ],
  }
}

describe('AgentCrew model profiles', () => {
  it('只为启用外部非 MoA 模型生成 unknown 默认画像，并保留校准值', () => {
    const existing = [{
      ...emptyModelProfile('external', 'external-ok'),
      enabled: false,
      speed: 'fast' as const,
      goodFor: ['审查'],
    }]
    const profiles = getAvailableModelProfiles([
      channel('external', 'openai'),
      channel('disabled', 'anthropic', false),
      channel('local', 'kscc-internal'),
    ], existing)

    expect(profiles).toEqual(existing)
    expect(profiles[0]).toMatchObject({ speed: 'fast', goodFor: ['审查'] })
    expect(profiles.some((profile) => profile.modelId.endsWith('-off'))).toBe(false)
  })

  it('保存时合并可见默认项且不抹除失效渠道的历史画像', () => {
    const old = emptyModelProfile('removed', 'old-model')
    const visible = emptyModelProfile('external', 'external-ok')
    expect(mergeModelProfiles([visible], [old])).toEqual([old, visible])
  })
})
