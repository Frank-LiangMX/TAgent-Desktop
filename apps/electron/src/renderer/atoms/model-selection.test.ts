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
  it('separates the local runtime from all external providers', () => {
    expect(getChannelCoreKind(channel('codex', 'codex-internal'))).toBe('internal')
    expect(getChannelCoreKind(channel('openai', 'openai'))).toBe('external')
    expect(getChannelCoreKind(channel('anthropic', 'anthropic'))).toBe('external')
  })

  it('keeps an available channel and model pair', () => {
    const channels = [channel('external', 'openai')]
    const preferred = { channelId: 'external', modelId: 'external-model' }
    expect(resolveModelSelection(channels, preferred)).toEqual(preferred)
  })

  it('prefers an external API channel (Pi) for a new session', () => {
    const channels = [
      channel('kscc', 'kscc-internal'),
      channel('codex', 'codex-internal'),
      channel('external', 'openai'),
    ]
    expect(resolveModelSelection(channels)).toEqual({
      channelId: 'external',
      modelId: 'external-model',
    })
  })

  it('does NOT auto-fallback to local runtimes when no external channel exists', () => {
    // 评审修正：没有配置 Pi → 返回 null，由 UI 提示「配置 Pi 或显式选择其它内核」
    expect(
      resolveModelSelection([
        channel('codex', 'codex-internal'),
        channel('kscc', 'kscc-internal'),
      ]),
    ).toBeNull()
    expect(resolveModelSelection([channel('kscc', 'kscc-internal')])).toBeNull()
  })

  it('preserves an explicit stored choice even when it is a local runtime', () => {
    // 已保存会话 / 用户显式选择不得被 Pi 默认值改写
    const channels = [channel('kscc', 'kscc-internal'), channel('external', 'openai')]
    const stored = { channelId: 'kscc', modelId: 'kscc-model' }
    expect(resolveModelSelection(channels, stored)).toEqual(stored)
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
