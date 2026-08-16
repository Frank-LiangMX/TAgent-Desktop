import { describe, expect, it } from 'vitest'
import {
  isMoaModelId,
  parseMoaPresetId,
  moaModelId,
  isValidMoAPreset,
  pickDefaultMoAPreset,
  resolveConsultPresetsForChannel,
  migrateMoAPresetsV1toV2,
  buildChannelBasedDraftPreset,
  buildExternalScopeDraftPreset,
  MOA_DEFAULT_PRESETS,
  MOA_MODEL_ID_PREFIX,
  MOA_EXTERNAL_SCOPE_ID,
  type MoAPreset,
} from './moa-preset'
import type { Channel, ChannelModel } from './channel'

describe('isMoaModelId', () => {
  it('accepts moa:<presetId> shape', () => {
    expect(isMoaModelId('moa:default')).toBe(true)
    expect(isMoaModelId('moa:cheap')).toBe(true)
    expect(isMoaModelId('moa:multi_word-1')).toBe(true)
  })

  it('rejects empty / wrong prefix / malformed ids', () => {
    expect(isMoaModelId('')).toBe(false)
    expect(isMoaModelId(null)).toBe(false)
    expect(isMoaModelId(undefined)).toBe(false)
    expect(isMoaModelId('moa:')).toBe(false)
    expect(isMoaModelId('moa')).toBe(false)
    expect(isMoaModelId('glm-5.2')).toBe(false)
    expect(isMoaModelId('moa:Invalid-Caps')).toBe(false)
    expect(isMoaModelId('moa:has space')).toBe(false)
  })
})

describe('parseMoaPresetId', () => {
  it('extracts the preset id from moa:<id>', () => {
    expect(parseMoaPresetId('moa:default')).toBe('default')
    expect(parseMoaPresetId('moa:cheap')).toBe('cheap')
  })

  it('returns null for non-moa ids', () => {
    expect(parseMoaPresetId('glm-5.2')).toBeNull()
    expect(parseMoaPresetId('moa:')).toBeNull()
    expect(parseMoaPresetId('')).toBeNull()
  })
})

describe('moaModelId', () => {
  it('round-trips with parseMoaPresetId', () => {
    expect(parseMoaPresetId(moaModelId('default'))).toBe('default')
    expect(isMoaModelId(moaModelId('cheap'))).toBe(true)
  })

  it('throws on illegal preset ids', () => {
    expect(() => moaModelId('')).toThrow()
    expect(() => moaModelId('Has-Caps')).toThrow()
    expect(() => moaModelId('has space')).toThrow()
    expect(() => moaModelId('a'.repeat(33))).toThrow()
  })
})

describe('MOA_DEFAULT_PRESETS', () => {
  it('ships default + cheap and uses kscc-internal modelIds', () => {
    expect(MOA_DEFAULT_PRESETS.length).toBeGreaterThanOrEqual(2)
    const ids = MOA_DEFAULT_PRESETS.map((p) => p.id)
    expect(ids).toContain('default')
    expect(ids).toContain('cheap')
    for (const p of MOA_DEFAULT_PRESETS) {
      expect(p.references.length).toBeGreaterThanOrEqual(2)
      expect(p.aggregatorModelId).toBeTruthy()
      expect(p.aggregatorModelId.startsWith(MOA_MODEL_ID_PREFIX)).toBe(false)
      for (const ref of p.references) {
        expect(ref.modelId.startsWith(MOA_MODEL_ID_PREFIX)).toBe(false)
      }
    }
  })

  it('all seed presets pass isValidMoAPreset (with channelId injected)', () => {
    // MOA_DEFAULT_PRESETS 是模板常量，无静态 channelId（kscc 渠 id 运行时定）；
    // 服务侧 buildSeed 注入 channelId 后才落盘。此处注入后须通过结构校验。
    for (const p of MOA_DEFAULT_PRESETS) {
      expect(isValidMoAPreset({ ...p, channelId: 'kscc-internal' })).toBe(true)
    }
  })

  it('seed preset constant omits channelId (template; service injects at seed)', () => {
    for (const p of MOA_DEFAULT_PRESETS) {
      expect(p.channelId).toBeUndefined()
    }
  })
})

describe('isValidMoAPreset', () => {
  const valid = MOA_DEFAULT_PRESETS[0]!

  it('rejects malformed shapes', () => {
    expect(isValidMoAPreset(null)).toBe(false)
    expect(isValidMoAPreset(undefined)).toBe(false)
    expect(isValidMoAPreset({})).toBe(false)
    expect(isValidMoAPreset({ ...valid, id: 'Bad-Caps' })).toBe(false)
    expect(isValidMoAPreset({ ...valid, references: valid.references.slice(0, 1) })).toBe(false)
    expect(isValidMoAPreset({ ...valid, enabled: 'yes' as unknown as boolean })).toBe(false)
    expect(isValidMoAPreset({ ...valid, timeoutMsPerSeat: 0 })).toBe(false)
  })

  it('rejects nested moa:<id> as reference / aggregator', () => {
    expect(
      isValidMoAPreset({
        ...valid,
        aggregatorModelId: 'moa:default',
      }),
    ).toBe(false)
    expect(
      isValidMoAPreset({
        ...valid,
        references: [
          { name: 'X', modelId: 'glm-5.2' },
          { name: 'Y', modelId: 'moa:other' },
        ],
      }),
    ).toBe(false)
  })

  it('requires non-empty channelId for non-synthetic presets (v2)', () => {
    expect(isValidMoAPreset({ ...valid, channelId: 'kscc-internal' })).toBe(true)
    expect(isValidMoAPreset({ ...valid, channelId: '' })).toBe(false)
    expect(isValidMoAPreset({ ...valid, channelId: undefined })).toBe(false)
    // 非字符串 channelId 也拒
    expect(isValidMoAPreset({ ...valid, channelId: 123 as unknown as string })).toBe(false)
  })

  it('exempts channelId for synthetic presets', () => {
    expect(isValidMoAPreset({ ...valid, synthetic: 'channel-default' })).toBe(true)
    expect(
      isValidMoAPreset({ ...valid, synthetic: 'channel-same-model', channelId: 'ext-1' }),
    ).toBe(true)
    // synthetic 但 channelId 类型非法仍拒
    expect(
      isValidMoAPreset({
        ...valid,
        synthetic: 'channel-default',
        channelId: 9 as unknown as string,
      }),
    ).toBe(false)
  })
})

describe('pickDefaultMoAPreset', () => {
  it('returns first enabled preset', () => {
    const a = { ...MOA_DEFAULT_PRESETS[0]!, enabled: false }
    const b = MOA_DEFAULT_PRESETS[1]!
    expect(pickDefaultMoAPreset([a, b])?.id).toBe(b.id)
  })

  it('falls back to first preset when none enabled', () => {
    const list = MOA_DEFAULT_PRESETS.map((p) => ({ ...p, enabled: false }))
    expect(pickDefaultMoAPreset(list)?.id).toBe(list[0]!.id)
  })

  it('returns null for empty list', () => {
    expect(pickDefaultMoAPreset([])).toBeNull()
  })
})

describe('migrateMoAPresetsV1toV2', () => {
  it('binds missing channelId to the given kscc channel id', () => {
    const v1: MoAPreset[] = [
      { ...MOA_DEFAULT_PRESETS[0]! },
      { ...MOA_DEFAULT_PRESETS[1]! },
    ] // 无 channelId（v1 旧文件）
    const out = migrateMoAPresetsV1toV2(v1, 'kscc-internal')
    expect(out.every((p) => p.channelId === 'kscc-internal')).toBe(true)
    expect(out).toHaveLength(v1.length)
  })

  it('rewrites legacy non-kscc channelId to external scope (外部渠合并)', () => {
    // 旧「一供应商一会诊」落盘的真实非 kscc 渠 id → 改写为 external 哨兵
    const ext: MoAPreset = {
      ...MOA_DEFAULT_PRESETS[0]!,
      id: 'ext-1',
      channelId: 'ext-channel-1',
      references: [
        { name: '甲', modelId: 'gpt-4o' },
        { name: '乙', modelId: 'gpt-4o-mini' },
      ],
      aggregatorModelId: 'gpt-4o',
    }
    const out = migrateMoAPresetsV1toV2([ext], 'kscc-internal')
    expect(out[0]!.channelId).toBe(MOA_EXTERNAL_SCOPE_ID)
    expect(out[0]!.channelId).toBe('external')
  })

  it('keeps kscc channelId and already-external channelId unchanged (双档归一)', () => {
    const ksccPreset: MoAPreset = { ...MOA_DEFAULT_PRESETS[0]!, channelId: 'kscc-1' }
    const extPreset: MoAPreset = {
      ...MOA_DEFAULT_PRESETS[1]!,
      id: 'ext-keep',
      channelId: MOA_EXTERNAL_SCOPE_ID,
      references: [
        { name: '甲', modelId: 'gpt-4o' },
        { name: '乙', modelId: 'gpt-4o-mini' },
      ],
      aggregatorModelId: 'gpt-4o',
    }
    const out = migrateMoAPresetsV1toV2([ksccPreset, extPreset], 'kscc-1')
    expect(out[0]!.channelId).toBe('kscc-1')
    expect(out[1]!.channelId).toBe(MOA_EXTERNAL_SCOPE_ID)
  })

  it('rewrites multiple distinct legacy provider channelIds all to the same external scope', () => {
    // DeepSeek 真实 id + Mimo 真实 id → 都合并为 'external'（不再一供应商一会诊）
    const ds: MoAPreset = {
      ...MOA_DEFAULT_PRESETS[0]!,
      id: 'ds-preset',
      channelId: 'deepseek-real-id',
      references: [
        { name: '甲', modelId: 'deepseek-chat' },
        { name: '乙', modelId: 'deepseek-reasoner' },
      ],
      aggregatorModelId: 'deepseek-chat',
    }
    const mimo: MoAPreset = {
      ...MOA_DEFAULT_PRESETS[1]!,
      id: 'mimo-preset',
      channelId: 'mimo-real-id',
      references: [
        { name: '甲', modelId: 'mimo-v2.5' },
        { name: '乙', modelId: 'mimo-v3' },
      ],
      aggregatorModelId: 'mimo-v2.5',
    }
    const out = migrateMoAPresetsV1toV2([ds, mimo], 'kscc-internal')
    expect(out.every((p) => p.channelId === MOA_EXTERNAL_SCOPE_ID)).toBe(true)
  })

  it('binds empty-string channelId to kscc (treats as missing)', () => {
    const src = { ...MOA_DEFAULT_PRESETS[0]!, channelId: '' }
    const out = migrateMoAPresetsV1toV2([src], 'kscc-internal')[0]!
    expect(out.channelId).toBe('kscc-internal')
  })

  it('preserves other fields untouched', () => {
    const src = { ...MOA_DEFAULT_PRESETS[0]! }
    const out = migrateMoAPresetsV1toV2([src], 'kscc-internal')[0]!
    expect(out.id).toBe(src.id)
    expect(out.name).toBe(src.name)
    expect(out.enabled).toBe(src.enabled)
    expect(out.aggregatorModelId).toBe(src.aggregatorModelId)
    expect(out.references.map((r) => r.modelId)).toEqual(src.references.map((r) => r.modelId))
  })

  it('returns empty array unchanged', () => {
    expect(migrateMoAPresetsV1toV2([], 'kscc-internal')).toEqual([])
  })
})

describe('isValidMoAPreset · synthetic 字段', () => {
  const base = { ...MOA_DEFAULT_PRESETS[0]!, channelId: 'kscc-internal' }

  it('accepts optional reference systemPrompt', () => {
    expect(
      isValidMoAPreset({
        ...base,
        references: [
          { name: '怀疑者', modelId: 'glm-5.2', systemPrompt: 'be skeptical' },
          { name: '实操者', modelId: 'kimi-k2.5', systemPrompt: 'be practical' },
        ],
      }),
    ).toBe(true)
  })

  it('accepts optional preset synthetic marker', () => {
    expect(isValidMoAPreset({ ...base, synthetic: 'channel-default' })).toBe(true)
    expect(isValidMoAPreset({ ...base, synthetic: 'channel-same-model' })).toBe(true)
  })

  it('rejects non-string reference systemPrompt', () => {
    expect(
      isValidMoAPreset({
        ...base,
        references: [
          { name: 'A', modelId: 'glm-5.2', systemPrompt: 123 as unknown as string },
          { name: 'B', modelId: 'kimi-k2.5' },
        ],
      }),
    ).toBe(false)
  })
})

describe('isValidMoAPreset · roundLimit 字段', () => {
  const base = { ...MOA_DEFAULT_PRESETS[0]!, channelId: 'kscc-internal' }

  it('accepts undefined (缺省由运行时兜底默认 3)', () => {
    expect(isValidMoAPreset({ ...base })).toBe(true)
    expect(isValidMoAPreset({ ...base, roundLimit: undefined })).toBe(true)
  })

  it('accepts integers 1..6 (含默认 3)', () => {
    expect(isValidMoAPreset({ ...base, roundLimit: 3 })).toBe(true)
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(isValidMoAPreset({ ...base, roundLimit: n })).toBe(true)
    }
  })

  it('rejects 0 / 7 / 1.5 / 非整数 / 非数字', () => {
    expect(isValidMoAPreset({ ...base, roundLimit: 0 })).toBe(false)
    expect(isValidMoAPreset({ ...base, roundLimit: 7 })).toBe(false)
    expect(isValidMoAPreset({ ...base, roundLimit: 1.5 })).toBe(false)
    expect(isValidMoAPreset({ ...base, roundLimit: '3' as unknown as number })).toBe(false)
  })
})

/** 渠道构造助手（与 moa-dispatch.test 同形态，精简版） */
function makeChannel(opts: {
  id?: string
  provider?: string
  models: Array<{ id: string; name?: string; enabled?: boolean }>
  defaultModelId?: string
  enabled?: boolean
}): Channel {
  return {
    id: opts.id ?? 'ch-1',
    name: '渠道',
    provider: (opts.provider ?? 'kscc-internal') as Channel['provider'],
    baseUrl: 'http://x',
    apiKey: '',
    enabled: opts.enabled ?? true,
    createdAt: 0,
    updatedAt: 0,
    defaultModelId: opts.defaultModelId,
    models: opts.models.map((m) => ({ id: m.id, name: m.name ?? m.id, enabled: m.enabled ?? true })),
  } as unknown as Channel
}

describe('resolveConsultPresetsForChannel (SPEC 03-PI-EXTERNAL §3)', () => {
  const stored: MoAPreset[] = MOA_DEFAULT_PRESETS.map((p) => ({
    ...p,
    references: p.references.map((r) => ({ ...r })),
  }))

  it('kscc: returns stored presets whose seats are all enabled in the channel', () => {
    const ch = makeChannel({
      models: [
        { id: 'glm-5.2' }, { id: 'kimi-k2.6' }, { id: 'mimo-v2.5-pro' },
        { id: 'deepseek-v4-flash' }, { id: 'glm-5.1' }, { id: 'kimi-k2.5' }, { id: 'mimo-v2.5' },
      ],
      defaultModelId: 'glm-5.2',
    })
    const out = resolveConsultPresetsForChannel(ch, stored)
    expect(out.map((p) => p.id).sort()).toEqual(['cheap', 'default'])
  })

  it('kscc: filters out a preset whose reference model is not enabled', () => {
    // 缺 kimi-k2.6 / mimo-v2.5-pro → default 不可用；cheap 仍可用
    const ch = makeChannel({
      models: [{ id: 'glm-5.2' }, { id: 'deepseek-v4-flash' }, { id: 'kimi-k2.5' }],
      defaultModelId: 'glm-5.2',
    })
    const out = resolveConsultPresetsForChannel(ch, stored)
    expect(out.map((p) => p.id)).toEqual(['cheap'])
  })

  it('external ≥2 enabled, no matching stored: synthesizes channel-default', () => {
    const ch = makeChannel({
      provider: 'openai',
      models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
      defaultModelId: 'gpt-4o',
    })
    const out = resolveConsultPresetsForChannel(ch, stored)
    expect(out).toHaveLength(1)
    const p = out[0]!
    expect(p.id).toBe('channel-default')
    expect(p.synthetic).toBe('channel-default')
    expect(p.references.map((r) => r.modelId)).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(p.aggregatorModelId).toBe('gpt-4o')
  })

  it('external ≥2 enabled: aggregator falls back to first enabled when defaultModelId absent', () => {
    const ch = makeChannel({
      provider: 'openai',
      models: [{ id: 'a' }, { id: 'b' }],
      defaultModelId: 'zzz-not-in-channel',
    })
    const out = resolveConsultPresetsForChannel(ch, [])
    expect(out[0]!.aggregatorModelId).toBe('a')
  })

  it('external =1 enabled: synthesizes channel-same-model (same modelId, different system)', () => {
    const ch = makeChannel({
      provider: 'deepseek',
      models: [{ id: 'deepseek-chat' }],
      defaultModelId: 'deepseek-chat',
    })
    const out = resolveConsultPresetsForChannel(ch, stored)
    expect(out).toHaveLength(1)
    const p = out[0]!
    expect(p.id).toBe('channel-same-model')
    expect(p.synthetic).toBe('channel-same-model')
    expect(p.references).toHaveLength(2)
    expect(p.references.every((r) => r.modelId === 'deepseek-chat')).toBe(true)
    expect(p.references[0]!.systemPrompt).toBeTruthy()
    expect(p.references[1]!.systemPrompt).toBeTruthy()
    expect(p.references[0]!.systemPrompt).not.toBe(p.references[1]!.systemPrompt)
    expect(p.aggregatorModelId).toBe('deepseek-chat')
  })

  it('external ≥2 with matching stored preset: returns the stored preset (no synthesis)', () => {
    const custom: MoAPreset = {
      id: 'ext-custom',
      name: '外置',
      enabled: true,
      channelId: MOA_EXTERNAL_SCOPE_ID,
      references: [
        { name: '甲', modelId: 'gpt-4o' },
        { name: '乙', modelId: 'gpt-4o-mini' },
      ],
      aggregatorModelId: 'gpt-4o',
    }
    const ch = makeChannel({
      id: 'ext-1',
      provider: 'openai',
      models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
      defaultModelId: 'gpt-4o',
    })
    const out = resolveConsultPresetsForChannel(ch, [custom, ...stored])
    // 命中 external 档的 custom（channelId=external），席位均属本渠 → 可用；seed（无 channelId/属 kscc）不命中；不合成
    expect(out.map((p) => p.id)).toEqual(['ext-custom'])
    expect(out[0]!.synthetic).toBeUndefined()
  })

  it('external: filters out external-scope preset whose seats are NOT in current channel (跨渠禁席)', () => {
    // external 档班底席位来自别的外部渠（Mimo），当前会话是 DeepSeek → 席位不在本渠 → 过滤 → 合成兜底
    const mimoPreset: MoAPreset = {
      id: 'ext-mimo',
      name: 'Mimo 班底',
      enabled: true,
      channelId: MOA_EXTERNAL_SCOPE_ID,
      references: [
        { name: '甲', modelId: 'mimo-v2.5' },
        { name: '乙', modelId: 'mimo-v3' },
      ],
      aggregatorModelId: 'mimo-v2.5',
    }
    const deepseek = makeChannel({
      id: 'ext-ds',
      provider: 'deepseek',
      models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
      defaultModelId: 'deepseek-chat',
    })
    const out = resolveConsultPresetsForChannel(deepseek, [mimoPreset])
    // mimo 班底命中 external 档但席位不在 DeepSeek → 过滤掉 → 合成 channel-default
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('channel-default')
    expect(out[0]!.synthetic).toBe('channel-default')
  })

  it('external: external-scope preset with seats in current channel wins over synthesis (DeepSeek 会话 ▾)', () => {
    // 验收：DeepSeek 会话 ▾ 能吃 channelId=external 且模型在本渠启用的班底
    const dsPreset: MoAPreset = {
      id: 'ext-ds-custom',
      name: 'DeepSeek 班底',
      enabled: true,
      channelId: MOA_EXTERNAL_SCOPE_ID,
      references: [
        { name: '甲', modelId: 'deepseek-chat' },
        { name: '乙', modelId: 'deepseek-reasoner' },
      ],
      aggregatorModelId: 'deepseek-chat',
    }
    const deepseek = makeChannel({
      id: 'ext-ds',
      provider: 'deepseek',
      models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
      defaultModelId: 'deepseek-chat',
    })
    const out = resolveConsultPresetsForChannel(deepseek, [dsPreset])
    expect(out.map((p) => p.id)).toEqual(['ext-ds-custom'])
    expect(out[0]!.synthetic).toBeUndefined()
  })

  it('external 0 enabled: returns [] (menu falls back to single send)', () => {
    const ch = makeChannel({
      provider: 'openai',
      models: [{ id: 'a', enabled: false }, { id: 'b', enabled: false }],
    })
    expect(resolveConsultPresetsForChannel(ch, stored)).toEqual([])
  })

  it('channel missing or disabled: returns []', () => {
    expect(resolveConsultPresetsForChannel(null, stored)).toEqual([])
    expect(resolveConsultPresetsForChannel(undefined, stored)).toEqual([])
    const disabled = makeChannel({ models: [{ id: 'a' }], enabled: false })
    expect(resolveConsultPresetsForChannel(disabled, stored)).toEqual([])
  })

  // ── SPEC 05 §3：按 channelId 过滤（双核班底，同场不混席）──
  it('kscc: includes stored presets whose channelId matches the kscc channel', () => {
    const kscc = makeChannel({
      id: 'kscc-1',
      models: [
        { id: 'glm-5.2' }, { id: 'kimi-k2.6' }, { id: 'mimo-v2.5-pro' },
        { id: 'deepseek-v4-flash' }, { id: 'glm-5.1' }, { id: 'kimi-k2.5' }, { id: 'mimo-v2.5' },
      ],
      defaultModelId: 'glm-5.2',
    })
    const tagged: MoAPreset[] = MOA_DEFAULT_PRESETS.map((p) => ({ ...p, channelId: 'kscc-1' }))
    const out = resolveConsultPresetsForChannel(kscc, tagged)
    expect(out.map((p) => p.id).sort()).toEqual(['cheap', 'default'])
  })

  it('kscc: excludes stored presets bound to the external scope (no cross-scope)', () => {
    const kscc = makeChannel({
      id: 'kscc-1',
      models: [
        { id: 'glm-5.2' }, { id: 'kimi-k2.6' }, { id: 'mimo-v2.5-pro' },
        { id: 'deepseek-v4-flash' }, { id: 'glm-5.1' }, { id: 'kimi-k2.5' }, { id: 'mimo-v2.5' },
      ],
      defaultModelId: 'glm-5.2',
    })
    // 预置全部属外部档（即便模型名撞上 kscc，也按 channelId 排除，不混档）
    const foreign: MoAPreset[] = MOA_DEFAULT_PRESETS.map((p) => ({
      ...p,
      channelId: MOA_EXTERNAL_SCOPE_ID,
    }))
    expect(resolveConsultPresetsForChannel(kscc, foreign)).toEqual([])
  })

  it('kscc: treats presets with no channelId as kscc (v1 compat)', () => {
    const kscc = makeChannel({
      id: 'kscc-1',
      models: [
        { id: 'glm-5.2' }, { id: 'kimi-k2.6' }, { id: 'mimo-v2.5-pro' },
        { id: 'deepseek-v4-flash' }, { id: 'glm-5.1' }, { id: 'kimi-k2.5' }, { id: 'mimo-v2.5' },
      ],
      defaultModelId: 'glm-5.2',
    })
    const noChannel: MoAPreset[] = MOA_DEFAULT_PRESETS.map((p) => ({ ...p }))
    const out = resolveConsultPresetsForChannel(kscc, noChannel)
    expect(out.map((p) => p.id).sort()).toEqual(['cheap', 'default'])
  })

  it('external: excludes no-channelId presets (v1 compat is kscc-only; no cross-channel)', () => {
    const ext = makeChannel({
      id: 'ext-1',
      provider: 'openai',
      models: [{ id: 'glm-5.2' }, { id: 'kimi-k2.5' }],
      defaultModelId: 'glm-5.2',
    })
    // 模型名撞上 kscc seed，但无 channelId → 视为 kscc，不计外部席 → 合成兜底
    const noChannel: MoAPreset[] = MOA_DEFAULT_PRESETS.map((p) => ({ ...p }))
    const out = resolveConsultPresetsForChannel(ext, noChannel)
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('channel-default')
    expect(out[0]!.synthetic).toBe('channel-default')
  })

  it('external =1 model: returns stored same-model preset that belongs to this channel', () => {
    const ext = makeChannel({
      id: 'ext-1',
      provider: 'deepseek',
      models: [{ id: 'deepseek-chat' }],
      defaultModelId: 'deepseek-chat',
    })
    const custom: MoAPreset = {
      id: 'ext-same',
      name: '自定义同模',
      enabled: true,
      channelId: MOA_EXTERNAL_SCOPE_ID,
      references: [
        { name: '审阅', modelId: 'deepseek-chat', systemPrompt: 'review' },
        { name: '起草', modelId: 'deepseek-chat', systemPrompt: 'draft' },
      ],
      aggregatorModelId: 'deepseek-chat',
    }
    const out = resolveConsultPresetsForChannel(ext, [custom])
    expect(out.map((p) => p.id)).toEqual(['ext-same'])
    expect(out[0]!.synthetic).toBeUndefined()
  })
})

describe('buildChannelBasedDraftPreset (SPEC 05 §2 空态 CTA)', () => {
  it('≥2 enabled models: builds channel-default form draft with channelId + no synthetic', () => {
    const ch = makeChannel({
      id: 'ext-1',
      provider: 'openai',
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'gpt-4o-mini', name: 'GPT-4o mini' }],
      defaultModelId: 'gpt-4o',
    })
    const draft = buildChannelBasedDraftPreset(ch, 'custom-abc')
    expect(draft).not.toBeNull()
    expect(draft!.id).toBe('custom-abc')
    expect(draft!.channelId).toBe('ext-1')
    expect(draft!.synthetic).toBeUndefined()
    expect(draft!.references.map((r) => r.modelId)).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(draft!.aggregatorModelId).toBe('gpt-4o')
    expect(draft!.roundLimit).toBe(3)
  })

  it('≥2 enabled: aggregator falls back to first enabled when defaultModelId absent', () => {
    const ch = makeChannel({
      id: 'ext-1',
      provider: 'openai',
      models: [{ id: 'a' }, { id: 'b' }],
      defaultModelId: 'zzz-not-in-channel',
    })
    const draft = buildChannelBasedDraftPreset(ch, 'custom-x')
    expect(draft!.aggregatorModelId).toBe('a')
  })

  it('=1 enabled model: builds channel-same-model form (same modelId + different system)', () => {
    const ch = makeChannel({
      id: 'ext-1',
      provider: 'deepseek',
      models: [{ id: 'deepseek-chat' }],
      defaultModelId: 'deepseek-chat',
    })
    const draft = buildChannelBasedDraftPreset(ch, 'custom-1m')
    expect(draft).not.toBeNull()
    expect(draft!.channelId).toBe('ext-1')
    expect(draft!.synthetic).toBeUndefined()
    expect(draft!.references).toHaveLength(2)
    expect(draft!.references.every((r) => r.modelId === 'deepseek-chat')).toBe(true)
    expect(draft!.references[0]!.systemPrompt).toBeTruthy()
    expect(draft!.references[1]!.systemPrompt).toBeTruthy()
    expect(draft!.references[0]!.systemPrompt).not.toBe(draft!.references[1]!.systemPrompt)
    expect(draft!.aggregatorModelId).toBe('deepseek-chat')
  })

  it('0 enabled models: returns null (UI disables CTA)', () => {
    const ch = makeChannel({
      id: 'ext-1',
      provider: 'openai',
      models: [{ id: 'a', enabled: false }],
    })
    expect(buildChannelBasedDraftPreset(ch, 'custom-z')).toBeNull()
  })
})

describe('buildExternalScopeDraftPreset (SPEC 05 V3 · 外部档合并模型 CTA)', () => {
  /** 构造已启用 ChannelModel（外部档合并列表元素） */
  function mkModel(id: string, name?: string): ChannelModel {
    return { id, name: name ?? id, enabled: true }
  }

  it('≥2 merged models: builds channel-default form draft with channelId=external + no synthetic', () => {
    // 合并列表：DeepSeek 两模 + Mimo 一模（按 id 去重）
    const merged: ChannelModel[] = [
      mkModel('deepseek-chat', 'DeepSeek Chat'),
      mkModel('deepseek-reasoner', 'DeepSeek Reasoner'),
      mkModel('mimo-v2.5', 'Mimo v2.5'),
    ]
    const draft = buildExternalScopeDraftPreset(merged, 'custom-ext')
    expect(draft).not.toBeNull()
    expect(draft!.id).toBe('custom-ext')
    expect(draft!.channelId).toBe(MOA_EXTERNAL_SCOPE_ID)
    expect(draft!.channelId).toBe('external')
    expect(draft!.synthetic).toBeUndefined()
    expect(draft!.references.map((r) => r.modelId)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    // 无单渠 defaultModelId → 汇总取合并列表首个 enabled
    expect(draft!.aggregatorModelId).toBe('deepseek-chat')
    expect(draft!.roundLimit).toBe(3)
  })

  it('=1 merged model: builds channel-same-model form (same modelId + different system)', () => {
    const merged: ChannelModel[] = [mkModel('deepseek-chat', 'DeepSeek Chat')]
    const draft = buildExternalScopeDraftPreset(merged, 'custom-1m')
    expect(draft).not.toBeNull()
    expect(draft!.channelId).toBe(MOA_EXTERNAL_SCOPE_ID)
    expect(draft!.synthetic).toBeUndefined()
    expect(draft!.references).toHaveLength(2)
    expect(draft!.references.every((r) => r.modelId === 'deepseek-chat')).toBe(true)
    expect(draft!.references[0]!.systemPrompt).toBeTruthy()
    expect(draft!.references[1]!.systemPrompt).toBeTruthy()
    expect(draft!.references[0]!.systemPrompt).not.toBe(draft!.references[1]!.systemPrompt)
    expect(draft!.aggregatorModelId).toBe('deepseek-chat')
  })

  it('0 merged models: returns null (UI disables CTA)', () => {
    expect(buildExternalScopeDraftPreset([], 'custom-z')).toBeNull()
  })

  it('dedups by id is the caller’s job — passes the list through as-is', () => {
    // 去重由 UI 侧完成；此处只验证前 2 个被取作参考
    const merged: ChannelModel[] = [mkModel('a'), mkModel('b')]
    const draft = buildExternalScopeDraftPreset(merged, 'custom-d')
    expect(draft!.references.map((r) => r.modelId)).toEqual(['a', 'b'])
  })
})
