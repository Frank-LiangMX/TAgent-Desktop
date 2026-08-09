import { describe, expect, it } from 'vitest'
import { type Channel, type MoAPreset, MOA_DEFAULT_PRESETS } from '@tagent/shared'
import {
  decideMoaMetaPatch,
  resolveMoADispatch,
  resolveOneShotMoADispatch,
  validateMoAPresetForChannel,
} from './moa-dispatch'

function makeChannel(opts: Partial<Channel> & { provider?: string; enabledModels?: string[] } = {}): Channel {
  const enabled = opts.enabledModels ?? ['glm-5.2', 'kimi-k2.5', 'glm-5.1', 'mimo-v2.5']
  return {
    id: 'kscc-1',
    name: '内网',
    provider: 'kscc-internal',
    baseUrl: 'http://kscc.internal',
    apiKey: '',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    models: [
      { id: 'glm-5.2', name: 'GLM 5.2', enabled: enabled.includes('glm-5.2'), contextWindow: 128_000 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', enabled: enabled.includes('kimi-k2.5') },
      { id: 'glm-5.1', name: 'GLM 5.1', enabled: enabled.includes('glm-5.1') },
      { id: 'mimo-v2.5', name: 'Mimo v2.5', enabled: enabled.includes('mimo-v2.5') },
    ],
    ...opts,
  } as unknown as Channel
}

const externalChannel: Channel = {
  ...makeChannel(),
  id: 'ext-1',
  name: '外部',
  provider: 'openai',
  baseUrl: 'https://api.openai.com',
} as unknown as Channel

/** DeepSeek 外部渠：模型 id 与 kscc seed 预置完全不重叠 → 跨渠禁席（席位不在本渠） */
const deepseekChannel: Channel = {
  id: 'ext-ds',
  name: 'DeepSeek',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  defaultModelId: 'deepseek-chat',
  models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', enabled: true, contextWindow: 64_000 },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', enabled: true, contextWindow: 64_000 },
  ],
} as unknown as Channel

const presets: MoAPreset[] = MOA_DEFAULT_PRESETS.map((p) => ({ ...p, references: p.references.map((r) => ({ ...r })) }))

describe('resolveMoADispatch', () => {
  it('routes real modelId to normal (safe to setModel; never moa:*)', () => {
    const d = resolveMoADispatch('glm-5.2', makeChannel(), presets)
    expect(d.kind).toBe('normal')
    if (d.kind === 'normal') {
      expect(d.modelId).toBe('glm-5.2')
      expect(d.modelId.startsWith('moa:')).toBe(false)
    }
  })

  it('routes moa:<preset> on kscc channel to moa with the resolved preset', () => {
    const d = resolveMoADispatch('moa:default', makeChannel(), presets)
    expect(d.kind).toBe('moa')
    if (d.kind === 'moa') {
      expect(d.preset.id).toBe('default')
      expect(d.preset.references.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('routes moa on external channel when seats belong to it (不再因 provider 硬拒)', () => {
    // externalChannel 复用 kscc 模型集 → default 预置席位全部命中 → 走 moa
    const d = resolveMoADispatch('moa:default', externalChannel, presets)
    expect(d.kind).toBe('moa')
    if (d.kind === 'moa') expect(d.preset.id).toBe('default')
  })

  it('rejects when preset seats are not in the channel (跨渠禁席)', () => {
    // DeepSeek 渠无 glm/kimi 模型 → kscc seed 预置席位全部不命中 → error（点名缺失模型）
    const d = resolveMoADispatch('moa:default', deepseekChannel, presets)
    expect(d.kind).toBe('error')
    if (d.kind === 'error') expect(d.message).toContain('glm-5.2')
  })

  it('routes a synthetic channel-default preset on external channel', () => {
    const synth: MoAPreset = {
      id: 'channel-default',
      name: '默认会诊',
      enabled: true,
      references: [
        { name: '参考·DeepSeek Chat', modelId: 'deepseek-chat' },
        { name: '参考·DeepSeek Reasoner', modelId: 'deepseek-reasoner' },
      ],
      aggregatorModelId: 'deepseek-chat',
      synthetic: 'channel-default',
    }
    const d = resolveMoADispatch('moa:channel-default', deepseekChannel, [synth])
    expect(d.kind).toBe('moa')
    if (d.kind === 'moa') expect(d.preset.id).toBe('channel-default')
  })

  it('rejects unknown preset id', () => {
    const d = resolveMoADispatch('moa:no-such-preset', makeChannel(), presets)
    expect(d.kind).toBe('error')
    if (d.kind === 'error') expect(d.message).toContain('不存在')
  })

  it('rejects when a reference model is disabled in the channel', () => {
    const d = resolveMoADispatch('moa:default', makeChannel({ enabledModels: ['glm-5.2'] }), presets)
    // default 预置参考含 kimi-k2.5；缺它 → error
    expect(d.kind).toBe('error')
    if (d.kind === 'error') expect(d.message).toContain('kimi-k2.5')
  })

  it('rejects when the aggregator model is disabled', () => {
    const d = resolveMoADispatch('moa:default', makeChannel({ enabledModels: ['kimi-k2.5', 'glm-5.1'] }), presets)
    // 汇总 glm-5.2 缺 → error
    expect(d.kind).toBe('error')
    if (d.kind === 'error') expect(d.message).toContain('glm-5.2')
  })
})

describe('validateMoAPresetForChannel', () => {
  it('returns null for a healthy kscc preset', () => {
    expect(validateMoAPresetForChannel(presets[0]!, makeChannel())).toBeNull()
  })

  it('returns null for external channel when seats belong to it (不再硬拒外部)', () => {
    // externalChannel 复用 kscc 模型集 → default 预置席位全部命中 → 可用
    expect(validateMoAPresetForChannel(presets[0]!, externalChannel)).toBeNull()
  })

  it('returns a message when a seat model is not in the channel (跨渠禁席)', () => {
    const msg = validateMoAPresetForChannel(presets[0]!, deepseekChannel)
    expect(msg).not.toBeNull()
    expect(msg).toContain('glm-5.2')
    expect(msg).toContain('当前渠道')
  })
})

describe('resolveOneShotMoADispatch (SPEC §3 one-shot)', () => {
  it('routes valid presetId on kscc to moa with the resolved preset', () => {
    const d = resolveOneShotMoADispatch('default', makeChannel(), presets)
    expect(d.kind).toBe('moa')
    if (d.kind === 'moa') expect(d.preset.id).toBe('default')
  })

  it('routes one-shot on external channel when seats belong to it (不再硬拒外部)', () => {
    const d = resolveOneShotMoADispatch('default', externalChannel, presets)
    expect(d.kind).toBe('moa')
    if (d.kind === 'moa') expect(d.preset.id).toBe('default')
  })

  it('rejects unknown preset id', () => {
    const d = resolveOneShotMoADispatch('no-such', makeChannel(), presets)
    expect(d.kind).toBe('error')
    if (d.kind === 'error') expect(d.message).toContain('不存在')
  })

  it('returns error (never normal/real modelId) so 调用方不会被诱导 setModel', () => {
    const d = resolveOneShotMoADispatch('default', makeChannel(), presets)
    if (d.kind === 'normal') {
      // 不变式：one-shot 不应走 normal（normal 意味着真实 modelId，可 setModel）
      expect(d.modelId.startsWith('moa:')).toBe(false)
    }
    // 合法预置 → kind=moa（不是 normal）
    expect(d.kind).toBe('moa')
  })
})

describe('decideMoaMetaPatch (one-shot 不写 sticky moa)', () => {
  const base = {
    moaModelId: 'moa:default' as `moa:${string}`,
    channelId: 'kscc-1',
    workspaceId: 'ws-1',
    previousTurnCount: 3,
  } as const

  it('sticky=true writes moa:<id> as modelId (与历史口径一致)', () => {
    const p = decideMoaMetaPatch({ ...base, sticky: true })
    expect(p.modelId).toBe('moa:default')
    expect(p.channelId).toBe('kscc-1')
    expect(p.workspaceId).toBe('ws-1')
    expect(p.turnCount).toBe(4)
  })

  it('sticky=false (one-shot) does NOT include modelId so meta 保留真实 modelId', () => {
    const p = decideMoaMetaPatch({ ...base, sticky: false })
    expect(p.modelId).toBeUndefined()
    expect(p.channelId).toBe('kscc-1')
    expect(p.workspaceId).toBe('ws-1')
    expect(p.turnCount).toBe(4)
  })

  it('one-shot patch key set is a strict subset of sticky patch keys (无新增字段)', () => {
    const stickyPatch = decideMoaMetaPatch({ ...base, sticky: true })
    const oneShotPatch = decideMoaMetaPatch({ ...base, sticky: false })
    const stickyKeys = Object.keys(stickyPatch)
    const oneShotKeys = new Set(Object.keys(oneShotPatch))
    // one-shot 不写 modelId；其余字段都在
    expect(stickyKeys).toEqual(expect.arrayContaining([...oneShotKeys]))
    expect(oneShotKeys.has('modelId')).toBe(false)
  })

  it('handles previousTurnCount undefined (草稿首条)', () => {
    const p = decideMoaMetaPatch({
      ...base,
      sticky: true,
      previousTurnCount: undefined,
    })
    expect(p.turnCount).toBe(1)
  })
})
