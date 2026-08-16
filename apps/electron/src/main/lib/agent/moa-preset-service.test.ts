/**
 * moa-preset-service 单测：整单校验 + writeMoaPresets 拒写 + synthetic 剥离
 *
 * SPEC 04 §2.2：整单校验失败则 reject 中文错、不写盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MOA_DEFAULT_PRESETS, MOA_EXTERNAL_SCOPE_ID, type MoAPreset } from '@tagent/shared'

// electron mock：config-paths.ts isAppPackaged 用
vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

let configDir: string

async function loadService() {
  vi.resetModules()
  return import('./moa-preset-service')
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'tagent-moa-preset-svc-'))
  process.env.TAGENT_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(configDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('validateMoAPresetList', () => {
  it('returns null for valid seed presets (with channelId injected)', async () => {
    const { validateMoAPresetList } = await loadService()
    expect(
      validateMoAPresetList(MOA_DEFAULT_PRESETS.map((p) => ({ ...p, channelId: 'kscc-internal' }))),
    ).toBeNull()
  })

  it('returns Chinese error for non-array input', async () => {
    const { validateMoAPresetList } = await loadService()
    expect(validateMoAPresetList(null)).toContain('不合法')
    expect(validateMoAPresetList('not-array')).toContain('不合法')
  })

  it('returns Chinese error for preset with <2 references', async () => {
    const { validateMoAPresetList } = await loadService()
    const bad: MoAPreset = {
      id: 'bad-1',
      name: '少参考',
      enabled: true,
      references: [{ name: '仅一个', modelId: 'glm-5.2' }],
      aggregatorModelId: 'glm-5.2',
    }
    const err = validateMoAPresetList([bad])
    expect(err).toContain('结构不合法')
    expect(err).toContain('少参考')
  })

  it('returns Chinese error for empty name', async () => {
    const { validateMoAPresetList } = await loadService()
    const bad: MoAPreset = {
      id: 'no-name',
      name: '',
      enabled: true,
      references: [
        { name: '甲', modelId: 'glm-5.2' },
        { name: '乙', modelId: 'kimi-k2.5' },
      ],
      aggregatorModelId: 'glm-5.2',
    }
    expect(validateMoAPresetList([bad])).toContain('结构不合法')
  })

  it('returns Chinese error for duplicate ids', async () => {
    const { validateMoAPresetList } = await loadService()
    const dup = { ...MOA_DEFAULT_PRESETS[0]!, id: 'dupe', channelId: 'kscc-internal' }
    const dup2 = { ...MOA_DEFAULT_PRESETS[1]!, id: 'dupe', channelId: 'kscc-internal' }
    const err = validateMoAPresetList([dup, dup2])
    expect(err).toContain('重复')
    expect(err).toContain('dupe')
  })

  it('returns Chinese error for preset missing channelId (v2 requirement)', async () => {
    const { validateMoAPresetList } = await loadService()
    // 结构合法但缺 channelId → 须报「结构不合法」（含 channelId 提示）
    const noChannel: MoAPreset = {
      id: 'no-ch',
      name: '缺渠道',
      enabled: true,
      references: [
        { name: '甲', modelId: 'glm-5.2' },
        { name: '乙', modelId: 'kimi-k2.5' },
      ],
      aggregatorModelId: 'glm-5.2',
    }
    const err = validateMoAPresetList([noChannel])
    expect(err).toContain('结构不合法')
    expect(err).toContain('channelId')
  })

  it('returns null for empty array (no presets is valid)', async () => {
    const { validateMoAPresetList } = await loadService()
    expect(validateMoAPresetList([])).toBeNull()
  })
})

describe('writeMoaPresets', () => {
  it('writes valid presets to disk (v2, with channelId)', async () => {
    const { writeMoaPresets, listMoaPresets } = await loadService()
    const presets = MOA_DEFAULT_PRESETS.map((p) => ({
      ...p,
      references: p.references.map((r) => ({ ...r })),
      channelId: 'kscc-internal',
    }))
    writeMoaPresets(presets)
    const loaded = listMoaPresets()
    expect(loaded.map((p) => p.id).sort()).toEqual(['cheap', 'default'])
    expect(loaded.every((p) => p.channelId === 'kscc-internal')).toBe(true)
    // 文件头为 v2
    const raw = JSON.parse(readFileSync(join(configDir, 'moa-presets.json'), 'utf8'))
    expect(raw.version).toBe(2)
  })

  it('throws Chinese error and does NOT write when list contains invalid preset', async () => {
    const { writeMoaPresets } = await loadService()
    const bad: MoAPreset = {
      id: 'bad-ref',
      name: '少参考',
      enabled: true,
      references: [{ name: '仅一个', modelId: 'glm-5.2' }],
      aggregatorModelId: 'glm-5.2',
    }
    // 先写一次合法的（带 channelId）
    const service = await loadService()
    service.writeMoaPresets(
      MOA_DEFAULT_PRESETS.map((p) => ({
        ...p,
        references: p.references.map((r) => ({ ...r })),
        channelId: 'kscc-internal',
      })),
    )

    // 再尝试写非法的（参考<2）
    expect(() => service.writeMoaPresets([bad])).toThrow(/结构不合法/)

    // 文件应保留之前合法的内容
    const reloaded = await loadService()
    const after = reloaded.listMoaPresets()
    expect(after.map((p) => p.id).sort()).toEqual(['cheap', 'default'])
  })

  it('strips synthetic field before writing', async () => {
    const { writeMoaPresets } = await loadService()
    const withSynthetic: MoAPreset = {
      ...MOA_DEFAULT_PRESETS[0]!,
      references: MOA_DEFAULT_PRESETS[0]!.references.map((r) => ({ ...r })),
      channelId: 'kscc-internal',
      synthetic: 'channel-default',
    }
    writeMoaPresets([withSynthetic])
    // 读回文件内容验证 synthetic 被剥离
    const filePath = join(configDir, 'moa-presets.json')
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(raw.presets[0].synthetic).toBeUndefined()
  })

  it('throws for duplicate ids and does not write', async () => {
    const { writeMoaPresets } = await loadService()
    const dup1 = {
      ...MOA_DEFAULT_PRESETS[0]!,
      id: 'same-id',
      channelId: 'kscc-internal',
      references: MOA_DEFAULT_PRESETS[0]!.references.map((r) => ({ ...r })),
    }
    const dup2 = {
      ...MOA_DEFAULT_PRESETS[1]!,
      id: 'same-id',
      channelId: 'kscc-internal',
      references: MOA_DEFAULT_PRESETS[1]!.references.map((r) => ({ ...r })),
    }
    expect(() => writeMoaPresets([dup1, dup2])).toThrow(/重复/)
  })

  it('migrates v1 file to v2 on read (binds missing channelId to kscc, writes back)', async () => {
    const { listMoaPresets } = await loadService()
    const filePath = join(configDir, 'moa-presets.json')
    // 直接落一份 v1 文件（version 1，预置无 channelId）
    const v1File = {
      version: 1,
      presets: MOA_DEFAULT_PRESETS.map((p) => ({
        ...p,
        references: p.references.map((r) => ({ ...r })),
      })),
    }
    writeFileSync(filePath, JSON.stringify(v1File), 'utf8')

    const loaded = listMoaPresets()
    // 返回的预置都绑到 kscc-internal（测试环境无 channels.json → fallback）
    expect(loaded.every((p) => p.channelId === 'kscc-internal')).toBe(true)
    expect(loaded.map((p) => p.id).sort()).toEqual(['cheap', 'default'])

    // 文件已写回 v2，且每条带 channelId
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(raw.version).toBe(2)
    expect(raw.presets.every((p: { channelId: string }) => p.channelId === 'kscc-internal')).toBe(true)
  })

  it('upgrades untouched legacy built-in seats to the expanded kscc roster', async () => {
    const { listMoaPresets } = await loadService()
    const filePath = join(configDir, 'moa-presets.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        presets: [
          {
            id: 'default', name: '默认会诊', enabled: true, channelId: 'kscc-internal',
            references: [
              { name: '架构师', modelId: 'glm-5.2' },
              { name: '实战派', modelId: 'kimi-k2.5' },
            ],
            aggregatorModelId: 'glm-5.2', timeoutMsPerSeat: 120_000,
          },
          {
            id: 'cheap', name: '省并发', enabled: true, channelId: 'kscc-internal',
            references: [
              { name: '省并发·甲', modelId: 'glm-5.1' },
              { name: '省并发·乙', modelId: 'mimo-v2.5' },
            ],
            aggregatorModelId: 'glm-5.2', timeoutMsPerSeat: 120_000,
          },
        ],
      }),
      'utf8',
    )

    const byId = new Map(listMoaPresets().map((preset) => [preset.id, preset]))
    expect(byId.get('default')!.references.map((seat) => seat.modelId)).toEqual([
      'glm-5.2', 'kimi-k2.6', 'mimo-v2.5-pro',
    ])
    expect(byId.get('default')!.aggregatorModelId).toBe('glm-5.2')
    expect(byId.get('cheap')!.references.map((seat) => seat.modelId)).toEqual(['deepseek-v4-flash', 'kimi-k2.5'])
    expect(byId.get('cheap')!.aggregatorModelId).toBe('deepseek-v4-flash')
  })

  it('upgrades the immediately preceding untouched cheap preset to DeepSeek Flash', async () => {
    const { listMoaPresets } = await loadService()
    const filePath = join(configDir, 'moa-presets.json')
    writeFileSync(filePath, JSON.stringify({
      version: 2,
      presets: [{
        id: 'cheap', name: '省并发', enabled: true, channelId: 'kscc-internal',
        references: [
          { name: '省并发·甲', modelId: 'glm-5.1' },
          { name: '省并发·乙', modelId: 'kimi-k2.5' },
        ],
        aggregatorModelId: 'mimo-v2.5', timeoutMsPerSeat: 120_000,
      }],
    }), 'utf8')

    const cheap = listMoaPresets().find((preset) => preset.id === 'cheap')!
    expect(cheap.references.map((seat) => seat.modelId)).toEqual(['deepseek-v4-flash', 'kimi-k2.5'])
    expect(cheap.aggregatorModelId).toBe('deepseek-v4-flash')
  })

  it('does not overwrite a customized built-in preset while migrating defaults', async () => {
    const { listMoaPresets } = await loadService()
    const filePath = join(configDir, 'moa-presets.json')
    const customized: MoAPreset = {
      id: 'default', name: '我的默认会诊', enabled: true, channelId: 'kscc-internal',
      references: [
        { name: '自定义甲', modelId: 'glm-5.2' },
        { name: '自定义乙', modelId: 'kimi-k2.5' },
      ],
      aggregatorModelId: 'glm-5.1', timeoutMsPerSeat: 60_000,
    }
    writeFileSync(filePath, JSON.stringify({ version: 2, presets: [customized] }), 'utf8')

    expect(listMoaPresets()).toEqual([customized])
  })

  it('rewrites legacy non-kscc channelId to external scope on read (外部渠合并)', async () => {
    const { listMoaPresets } = await loadService()
    const filePath = join(configDir, 'moa-presets.json')
    const v1File = {
      version: 1,
      presets: [
        // kscc 旧条目（无 channelId → 迁移绑到 kscc-internal）
        { ...MOA_DEFAULT_PRESETS[0]!, references: MOA_DEFAULT_PRESETS[0]!.references.map((r) => ({ ...r })) },
        // 外部渠遗留真实渠 id 条目（旧「一供应商一会诊」→ 改写为 external 哨兵）
        {
          id: 'ext-keep',
          name: '外置保留',
          enabled: true,
          channelId: 'ext-1',
          references: [
            { name: '甲', modelId: 'gpt-4o' },
            { name: '乙', modelId: 'gpt-4o-mini' },
          ],
          aggregatorModelId: 'gpt-4o',
        },
      ],
    }
    writeFileSync(filePath, JSON.stringify(v1File), 'utf8')

    const loaded = listMoaPresets()
    const byId = new Map(loaded.map((p) => [p.id, p]))
    expect(byId.get('default')!.channelId).toBe('kscc-internal')
    // 遗留非 kscc 真实渠 id → 改写为 external 哨兵（外部渠合并）
    expect(byId.get('ext-keep')!.channelId).toBe(MOA_EXTERNAL_SCOPE_ID)
    expect(byId.get('ext-keep')!.channelId).toBe('external')

    // 文件已写回 v2，且遗留 id 已就地改写
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(raw.version).toBe(2)
    expect(raw.presets.find((p: MoAPreset) => p.id === 'ext-keep').channelId).toBe('external')
  })
})
