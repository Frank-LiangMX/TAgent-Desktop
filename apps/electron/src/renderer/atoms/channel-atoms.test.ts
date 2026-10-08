import { describe, expect, it } from 'vitest'
import { getDefaultStore } from 'jotai'
import type { Channel } from '@tagent/shared'
import {
  channelsAtom,
  loadChannelsAtom,
  selectedChannelIdAtom,
  selectedModelSelectionAtom,
} from './channel-atoms'

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

const KSCC = channel('kscc', 'kscc-internal')
const OPENAI = channel('openai', 'openai')

describe('selected channel/model atoms', () => {
  it('显式写入本机渠道时不被 Pi 默认策略清空', () => {
    const store = getDefaultStore()
    store.set(channelsAtom, [KSCC, OPENAI])
    store.set(selectedChannelIdAtom, 'kscc')

    expect(store.get(selectedModelSelectionAtom)).toEqual({
      channelId: 'kscc',
      modelId: 'kscc-model',
    })
    expect(store.get(selectedChannelIdAtom)).toBe('kscc')
  })

  it('渠道不存在 / 无启用模型时写入 null', () => {
    const store = getDefaultStore()
    store.set(channelsAtom, [channel('empty', 'openai', true, false)])
    store.set(selectedChannelIdAtom, 'empty')
    expect(store.get(selectedModelSelectionAtom)).toBeNull()

    store.set(selectedChannelIdAtom, 'gone')
    expect(store.get(selectedModelSelectionAtom)).toBeNull()
  })
})

describe('loadChannelsAtom 新会话默认', () => {
  it('有外部渠道 → 默认 Pi；仅本机渠道 → 不给默认（不静默回落）', async () => {
    const store = getDefaultStore()
    const list = [KSCC, OPENAI]
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: { listChannels: async () => list },
    }

    await store.set(loadChannelsAtom)
    expect(store.get(selectedModelSelectionAtom)).toEqual({
      channelId: 'openai',
      modelId: 'openai-model',
    })

    // 只留本机渠道：显式选择被保留（渠道仍可用），但一旦失效就不再回落
    store.set(selectedModelSelectionAtom, { channelId: 'kscc', modelId: 'kscc-model' })
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: { listChannels: async () => [KSCC] },
    }
    await store.set(loadChannelsAtom)
    expect(store.get(selectedModelSelectionAtom)).toEqual({
      channelId: 'kscc',
      modelId: 'kscc-model',
    })

    store.set(selectedModelSelectionAtom, { channelId: 'gone', modelId: 'gone-model' })
    await store.set(loadChannelsAtom)
    expect(store.get(selectedModelSelectionAtom)).toBeNull()
  })
})
