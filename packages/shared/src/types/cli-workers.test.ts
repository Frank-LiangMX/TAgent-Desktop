import { describe, expect, it } from 'vitest'
import {
  CLI_WORKER_DISCOVERY_CATALOG,
  CLI_WORKERS_DEFAULT_SEED,
  SUPPORTED_CLI_WORKER_IDS,
  ensureSeedWorkers,
  isDeniedCliName,
  isValidCliWorkersConfig,
  listEnabledWorkersByPriority,
  moveWorkerPriority,
  resolveDefaultWorker,
  resolveWorkerByPreference,
  resolveWorkerCapability,
  shouldUseCliWorker,
  syncDefaultCliId,
  validateCliWorkersConfig,
  workerPreferScore,
  workerSupportsRequire,
  type CliCapabilityPrefer,
  type CliCapabilityRequire,
  type CliWorkerCapability,
  type CliWorkerEntry,
  type CliWorkersConfig,
} from './cli-workers'

/** 造一份 seed 的深拷贝，避免测试间共享 workers 数组引用。 */
function seed(): CliWorkersConfig {
  return {
    ...CLI_WORKERS_DEFAULT_SEED,
    version: 1,
    workers: CLI_WORKERS_DEFAULT_SEED.workers.map((w) => ({ ...w })),
  }
}

describe('CLI_WORKERS_DEFAULT_SEED', () => {
  it('ships disabled with 4 workers and defaultCliId=kscc (zero behavior change)', () => {
    expect(CLI_WORKERS_DEFAULT_SEED.version).toBe(1)
    expect(CLI_WORKERS_DEFAULT_SEED.enabled).toBe(false)
    expect(CLI_WORKERS_DEFAULT_SEED.defaultBackend).toBe('in-process')
    expect(CLI_WORKERS_DEFAULT_SEED.defaultCliId).toBe('kscc')
    expect(CLI_WORKERS_DEFAULT_SEED.workers).toHaveLength(4)
    expect(CLI_WORKERS_DEFAULT_SEED.workers.map((w) => w.id)).toEqual([
      'kscc',
      'grok',
      'codex',
      'mimo',
    ])
    const kscc = CLI_WORKERS_DEFAULT_SEED.workers[0]!
    expect(kscc.id).toBe('kscc')
    expect(kscc.enabled).toBe(true)
    expect(kscc.bin).toBe('kscc')
    expect(kscc.defaultModel).toBe('glm-5.2')
    // 其余三个工人 enabled、bin 与 id 同名、无默认模型（用各自 CLI 默认）
    for (const w of CLI_WORKERS_DEFAULT_SEED.workers.slice(1)) {
      expect(w.enabled).toBe(true)
      expect(w.bin).toBe(w.id)
      expect(w.defaultModel).toBeUndefined()
    }
  })

  it('is itself valid', () => {
    expect(isValidCliWorkersConfig(CLI_WORKERS_DEFAULT_SEED)).toBe(true)
    expect(validateCliWorkersConfig(CLI_WORKERS_DEFAULT_SEED)).toBeNull()
  })
})

describe('isDeniedCliName', () => {
  it('matches hermes / openclaw basename, case-insensitive', () => {
    expect(isDeniedCliName('hermes')).toBe(true)
    expect(isDeniedCliName('openclaw')).toBe(true)
    expect(isDeniedCliName('HERMES')).toBe(true)
    expect(isDeniedCliName('OpenClaw')).toBe(true)
    expect(isDeniedCliName('/usr/local/bin/hermes')).toBe(true)
    expect(isDeniedCliName('C:\\bin\\OpenClaw.exe')).toBe(false) // .exe 后缀，非精确 basename
  })

  it('does not match allowed names', () => {
    expect(isDeniedCliName('kscc')).toBe(false)
    expect(isDeniedCliName('/usr/local/bin/kscc')).toBe(false)
    expect(isDeniedCliName('hermes-cli')).toBe(false) // 非精确 basename
    expect(isDeniedCliName('')).toBe(false)
  })
})

describe('isValidCliWorkersConfig', () => {
  it('accepts the flat v1 seed shape', () => {
    expect(isValidCliWorkersConfig(seed())).toBe(true)
  })

  it('rejects non-object / wrong version', () => {
    expect(isValidCliWorkersConfig(null)).toBe(false)
    expect(isValidCliWorkersConfig(undefined)).toBe(false)
    expect(isValidCliWorkersConfig('x')).toBe(false)
    expect(isValidCliWorkersConfig({ ...seed(), version: 2 })).toBe(false)
  })

  it('rejects bad enabled / defaultBackend / defaultCliId', () => {
    expect(isValidCliWorkersConfig({ ...seed(), enabled: 'true' })).toBe(false)
    expect(isValidCliWorkersConfig({ ...seed(), defaultBackend: 'ssh' })).toBe(false)
    expect(isValidCliWorkersConfig({ ...seed(), defaultCliId: '' })).toBe(false)
    expect(isValidCliWorkersConfig({ ...seed(), defaultCliId: 5 })).toBe(false)
  })

  it('rejects workers not array / bad entry fields', () => {
    expect(isValidCliWorkersConfig({ ...seed(), workers: 'x' })).toBe(false)
    expect(isValidCliWorkersConfig({ ...seed(), workers: [{ id: '', enabled: true, bin: 'kscc' }] })).toBe(false)
    expect(isValidCliWorkersConfig({ ...seed(), workers: [{ id: 'kscc', enabled: 'yes', bin: 'kscc' }] })).toBe(false)
    expect(isValidCliWorkersConfig({ ...seed(), workers: [{ id: 'kscc', enabled: true, bin: '' }] })).toBe(false)
    expect(
      isValidCliWorkersConfig({
        ...seed(),
        workers: [{ id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 5 }],
      }),
    ).toBe(false)
  })

  it('rejects deny-list id / bin basename (hermes / openclaw, case-insensitive)', () => {
    expect(
      isValidCliWorkersConfig({ ...seed(), workers: [{ id: 'hermes', enabled: true, bin: 'kscc' }] }),
    ).toBe(false)
    expect(
      isValidCliWorkersConfig({ ...seed(), workers: [{ id: 'kscc', enabled: true, bin: 'openclaw' }] }),
    ).toBe(false)
    expect(
      isValidCliWorkersConfig({
        ...seed(),
        workers: [{ id: 'kscc', enabled: true, bin: '/usr/local/bin/HERMES' }],
      }),
    ).toBe(false)
  })

  it('accepts absolute bin path with non-denied basename', () => {
    expect(
      isValidCliWorkersConfig({
        ...seed(),
        workers: [{ id: 'kscc', enabled: true, bin: '/usr/local/bin/kscc', defaultModel: 'glm-5.2' }],
      }),
    ).toBe(true)
  })

  it('accepts multiple workers', () => {
    expect(
      isValidCliWorkersConfig({
        ...seed(),
        workers: [
          { id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' },
          { id: 'kscc2', enabled: false, bin: '/opt/kscc' },
        ],
      }),
    ).toBe(true)
  })
})

describe('validateCliWorkersConfig', () => {
  it('returns null for valid seed', () => {
    expect(validateCliWorkersConfig(seed())).toBeNull()
  })

  it('returns Chinese error for non-object', () => {
    expect(validateCliWorkersConfig(null)).toContain('结构不合法')
    expect(validateCliWorkersConfig('x')).toContain('结构不合法')
  })

  it('returns Chinese error for wrong version', () => {
    expect(validateCliWorkersConfig({ ...seed(), version: 2 })).toContain('version')
  })

  it('returns Chinese error for bad enabled / defaultBackend', () => {
    expect(validateCliWorkersConfig({ ...seed(), enabled: 'true' })).toContain('enabled')
    expect(validateCliWorkersConfig({ ...seed(), defaultBackend: 'ssh' })).toContain('defaultBackend')
  })

  it('returns Chinese error for empty defaultCliId', () => {
    expect(validateCliWorkersConfig({ ...seed(), defaultCliId: '' })).toContain('defaultCliId')
  })

  it('returns Chinese error for workers not array / bad entry', () => {
    expect(validateCliWorkersConfig({ ...seed(), workers: 'x' })).toContain('workers')
    expect(
      validateCliWorkersConfig({ ...seed(), workers: [{ id: '', enabled: true, bin: 'kscc' }] }),
    ).toContain('id')
    expect(
      validateCliWorkersConfig({ ...seed(), workers: [{ id: 'kscc', enabled: true, bin: '' }] }),
    ).toContain('bin')
    expect(
      validateCliWorkersConfig({ ...seed(), workers: [{ id: 'kscc', enabled: 'yes', bin: 'kscc' }] }),
    ).toContain('enabled')
  })

  it('returns Chinese deny-list error naming hermes / openclaw', () => {
    const byId = validateCliWorkersConfig({
      ...seed(),
      workers: [{ id: 'hermes', enabled: true, bin: 'hermes' }],
    })
    expect(byId).toContain('黑名单')
    expect(byId).toContain('hermes')

    const byBin = validateCliWorkersConfig({
      ...seed(),
      workers: [{ id: 'kscc', enabled: true, bin: '/usr/local/bin/openclaw' }],
    })
    expect(byBin).toContain('黑名单')
    expect(byBin).toContain('kscc') // label = 工人 id
  })
})

describe('listEnabledWorkersByPriority / resolveWorkerByPreference', () => {
  it('lists enabled workers in array order', () => {
    const cfg = seed()
    cfg.workers = [
      { id: 'grok', enabled: true, bin: 'grok' },
      { id: 'kscc', enabled: false, bin: 'kscc' },
      { id: 'codex', enabled: true, bin: 'codex' },
    ]
    expect(listEnabledWorkersByPriority(cfg).map((w) => w.id)).toEqual(['grok', 'codex'])
  })

  it('prefers preferredId when enabled', () => {
    const cfg = { ...seed(), enabled: true, defaultBackend: 'cli' as const }
    expect(resolveWorkerByPreference(cfg, 'codex')?.id).toBe('codex')
  })

  it('falls back to first enabled when preferred disabled/missing', () => {
    const cfg = seed()
    cfg.workers = [
      { id: 'kscc', enabled: true, bin: 'kscc' },
      { id: 'codex', enabled: false, bin: 'codex' },
    ]
    expect(resolveWorkerByPreference(cfg, 'codex')?.id).toBe('kscc')
    expect(resolveWorkerByPreference(cfg, 'nope')?.id).toBe('kscc')
  })

  it('resolveDefaultWorker is first enabled by priority (ignores stale defaultCliId)', () => {
    const cfg: CliWorkersConfig = {
      ...seed(),
      defaultCliId: 'missing',
      workers: [
        { id: 'grok', enabled: true, bin: 'grok' },
        { id: 'kscc', enabled: true, bin: 'kscc' },
      ],
    }
    expect(resolveDefaultWorker(cfg)?.id).toBe('grok')
  })

  it('returns null when pool empty', () => {
    const cfg: CliWorkersConfig = {
      ...seed(),
      workers: [{ id: 'kscc', enabled: false, bin: 'kscc' }],
    }
    expect(resolveDefaultWorker(cfg)).toBeNull()
    expect(resolveWorkerByPreference(cfg, 'kscc')).toBeNull()
  })
})

describe('syncDefaultCliId / moveWorkerPriority', () => {
  it('syncs defaultCliId to first enabled', () => {
    const cfg: CliWorkersConfig = {
      ...seed(),
      defaultCliId: 'kscc',
      workers: [
        { id: 'codex', enabled: true, bin: 'codex' },
        { id: 'kscc', enabled: true, bin: 'kscc' },
      ],
    }
    expect(syncDefaultCliId(cfg).defaultCliId).toBe('codex')
  })

  it('moves worker up/down and syncs defaultCliId', () => {
    const cfg = seed()
    const up = moveWorkerPriority(cfg, 'grok', 'up')
    expect(up.workers.map((w) => w.id)[0]).toBe('grok')
    expect(up.defaultCliId).toBe('grok')
    const down = moveWorkerPriority(up, 'grok', 'down')
    expect(down.workers.map((w) => w.id)[0]).toBe('kscc')
  })
})

describe('shouldUseCliWorker', () => {
  it('returns false for the default seed (master switch off)', () => {
    expect(shouldUseCliWorker(CLI_WORKERS_DEFAULT_SEED)).toBe(false)
  })

  it('returns false when enabled but backend is in-process', () => {
    const cfg: CliWorkersConfig = { ...seed(), enabled: true, defaultBackend: 'in-process' }
    expect(shouldUseCliWorker(cfg)).toBe(false)
  })

  it('returns false when enabled but master switch off', () => {
    const cfg: CliWorkersConfig = { ...seed(), enabled: false, defaultBackend: 'cli' }
    expect(shouldUseCliWorker(cfg)).toBe(false)
  })

  it('returns true when enabled + backend=cli + any worker enabled', () => {
    const cfg: CliWorkersConfig = { ...seed(), enabled: true, defaultBackend: 'cli' }
    expect(shouldUseCliWorker(cfg)).toBe(true)
  })

  it('returns true when defaultCliId worker disabled but another enabled', () => {
    const cfg: CliWorkersConfig = {
      ...seed(),
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [
        { id: 'kscc', enabled: false, bin: 'kscc' },
        { id: 'grok', enabled: true, bin: 'grok' },
      ],
    }
    expect(shouldUseCliWorker(cfg)).toBe(true)
    expect(resolveDefaultWorker(cfg)?.id).toBe('grok')
  })

  it('returns false when enabled + backend=cli but no worker enabled', () => {
    const cfg: CliWorkersConfig = {
      ...seed(),
      enabled: true,
      defaultBackend: 'cli',
      workers: [{ id: 'kscc', enabled: false, bin: 'kscc', defaultModel: 'glm-5.2' }],
    }
    expect(shouldUseCliWorker(cfg)).toBe(false)
  })
})

describe('ensureSeedWorkers', () => {
  it('returns cfg unchanged when all seed ids already present', () => {
    const cfg = seed() // seed() 已含 4 个工人
    expect(ensureSeedWorkers(cfg)).toBe(cfg)
  })

  it('appends missing seed workers (grok/codex/mimo) without overwriting existing entries', () => {
    // 旧配置：仅有 1 条 kscc，且用户已自定义 bin
    const old: CliWorkersConfig = {
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [{ id: 'kscc', enabled: true, bin: '/my/kscc', defaultModel: 'glm-5.2' }],
    }
    const merged = ensureSeedWorkers(old)
    expect(merged.workers.map((w) => w.id)).toEqual(['kscc', 'grok', 'codex', 'mimo'])
    // 用户已有 kscc 字段不被覆盖
    expect(merged.workers[0]!.bin).toBe('/my/kscc')
    expect(merged.workers[0]!.defaultModel).toBe('glm-5.2')
    // 补的三条用 seed 默认（含 SLICE-5 能力画像 + tags）
    expect(merged.workers[1]).toEqual({
      id: 'grok',
      enabled: true,
      bin: 'grok',
      defaultModel: undefined,
      capability: { cost: 2, reasoning: 'medium', tags: ['frontend', 'research'], goodFor: '探索 / 对照 / 草稿实现' },
    })
    expect(merged.workers[2]).toEqual({
      id: 'codex',
      enabled: true,
      bin: 'codex',
      defaultModel: undefined,
      capability: { cost: 4, reasoning: 'high', tags: ['reasoning', 'refactor', 'backend'], goodFor: '长任务 / 深改造' },
    })
    expect(merged.workers[3]).toEqual({
      id: 'mimo',
      enabled: true,
      bin: 'mimo',
      defaultModel: undefined,
      capability: { cost: 1, reasoning: 'low', tags: ['test', 'scaffold', 'command'], goodFor: '单测 / 机械改动 / 小包' },
    })
    // 其余顶层字段不变
    expect(merged.enabled).toBe(true)
    expect(merged.defaultCliId).toBe('kscc')
  })

  it('does not duplicate a user-customized worker whose id matches a seed id', () => {
    const old: CliWorkersConfig = {
      version: 1,
      enabled: false,
      defaultBackend: 'in-process',
      defaultCliId: 'kscc',
      workers: [
        { id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' },
        { id: 'grok', enabled: false, bin: '/usr/local/bin/grok' },
      ],
    }
    const merged = ensureSeedWorkers(old)
    expect(merged.workers.map((w) => w.id)).toEqual(['kscc', 'grok', 'codex', 'mimo'])
    // 用户自定义的 grok（enabled=false / 自定义 bin）保留，不被 seed 覆盖
    expect(merged.workers[1]).toEqual({ id: 'grok', enabled: false, bin: '/usr/local/bin/grok' })
  })

  it('handles a non-seed worker id alongside missing seed ids', () => {
    const old: CliWorkersConfig = {
      version: 1,
      enabled: false,
      defaultBackend: 'in-process',
      defaultCliId: 'kscc',
      workers: [{ id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' }],
    }
    const merged = ensureSeedWorkers(old)
    // 仍补齐缺的三条 seed 工人
    expect(merged.workers.map((w) => w.id)).toEqual(['kscc', 'grok', 'codex', 'mimo'])
  })
})

/** 造一条带能力画像的工人条目（默认 enabled + bin=id） */
function capWorker(id: string, cap: CliWorkerCapability): CliWorkerEntry {
  return { id, enabled: true, bin: id, capability: cap }
}

/** 造一份 seed 形态、唯一工人 kscc 携给定 capability（capability 未知形状交给校验器判断） */
function cfgWithCapability(cap: unknown): unknown {
  return {
    ...seed(),
    workers: [{ id: 'kscc', enabled: true, bin: 'kscc', capability: cap }],
  }
}

describe('CLI_WORKERS_DEFAULT_SEED · 能力画像默认', () => {
  it('四工人各带 cost / reasoning / goodFor（modalities 缺省 = text-only）', () => {
    const byId = (id: string) => CLI_WORKERS_DEFAULT_SEED.workers.find((w) => w.id === id)
    expect(byId('kscc')?.capability).toEqual({ cost: 3, reasoning: 'high', tags: ['backend', 'reasoning', 'refactor'], goodFor: '跨层接线 / 编排 / 复杂实现' })
    expect(byId('grok')?.capability).toEqual({ cost: 2, reasoning: 'medium', tags: ['frontend', 'research'], goodFor: '探索 / 对照 / 草稿实现' })
    expect(byId('codex')?.capability).toEqual({ cost: 4, reasoning: 'high', tags: ['reasoning', 'refactor', 'backend'], goodFor: '长任务 / 深改造' })
    expect(byId('mimo')?.capability).toEqual({ cost: 1, reasoning: 'low', tags: ['test', 'scaffold', 'command'], goodFor: '单测 / 机械改动 / 小包' })
    // modalities 均缺省（text-only，由 resolveWorkerCapability 折算）
    for (const w of CLI_WORKERS_DEFAULT_SEED.workers) {
      expect(w.capability?.modalities).toBeUndefined()
    }
  })
})

describe('capability 校验', () => {
  it('接受合法 capability（含 vision 模态）', () => {
    const ok = cfgWithCapability({ cost: 3, reasoning: 'high', modalities: ['text', 'vision'], goodFor: '编排' })
    expect(isValidCliWorkersConfig(ok)).toBe(true)
    expect(validateCliWorkersConfig(ok)).toBeNull()
  })

  it('接受缺省 capability（旧配置不回归）', () => {
    expect(
      isValidCliWorkersConfig({
        ...seed(),
        workers: [{ id: 'kscc', enabled: true, bin: 'kscc' }],
      }),
    ).toBe(true)
  })

  it('拒绝 cost 越界（0 / 6 / 非整数）', () => {
    expect(isValidCliWorkersConfig(cfgWithCapability({ cost: 0, reasoning: 'high' }))).toBe(false)
    expect(isValidCliWorkersConfig(cfgWithCapability({ cost: 6, reasoning: 'high' }))).toBe(false)
    expect(isValidCliWorkersConfig(cfgWithCapability({ cost: 3.5, reasoning: 'high' }))).toBe(false)
  })

  it('拒绝 reasoning 非法', () => {
    expect(isValidCliWorkersConfig(cfgWithCapability({ cost: 3, reasoning: 'ultra' }))).toBe(false)
  })

  it('拒绝 modalities 非法元素 / 非数组', () => {
    expect(isValidCliWorkersConfig(cfgWithCapability({ cost: 3, reasoning: 'high', modalities: ['audio'] }))).toBe(false)
    expect(isValidCliWorkersConfig(cfgWithCapability({ cost: 3, reasoning: 'high', modalities: 'text' }))).toBe(false)
  })

  it('拒绝 goodFor 非字符串', () => {
    expect(isValidCliWorkersConfig(cfgWithCapability({ cost: 3, reasoning: 'high', goodFor: 5 }))).toBe(false)
  })

  it('validateCliWorkersConfig 对坏 capability 返回中文错（带 label）', () => {
    expect(validateCliWorkersConfig(cfgWithCapability({ cost: 9, reasoning: 'high' }))).toContain('capability.cost')
    expect(validateCliWorkersConfig(cfgWithCapability({ cost: 3, reasoning: 'ultra' }))).toContain('reasoning')
    expect(validateCliWorkersConfig(cfgWithCapability({ cost: 3, reasoning: 'high', modalities: ['audio'] }))).toContain('modalities')
  })
})

describe('resolveWorkerCapability', () => {
  it('有 capability 直接返回', () => {
    const w = capWorker('kscc', { cost: 2, reasoning: 'low', modalities: ['text', 'vision'] })
    expect(resolveWorkerCapability(w)).toEqual({ cost: 2, reasoning: 'low', modalities: ['text', 'vision'] })
  })

  it('无 capability 按中性折算（cost 3 / medium / text）', () => {
    const w: CliWorkerEntry = { id: 'old', enabled: true, bin: 'old' }
    expect(resolveWorkerCapability(w)).toEqual({ cost: 3, reasoning: 'medium', modalities: ['text'] })
  })

  it('有 capability 但无 modalities → modalities 保持 undefined（不强行补 text）', () => {
    const w = capWorker('kscc', { cost: 3, reasoning: 'high', goodFor: '编排' })
    expect(resolveWorkerCapability(w).modalities).toBeUndefined()
  })
})

describe('workerSupportsRequire', () => {
  it('无 require 恒 true（含 text-only 与无 capability 工人）', () => {
    expect(workerSupportsRequire(capWorker('a', { cost: 1, reasoning: 'low' }), null)).toBe(true)
    expect(workerSupportsRequire(capWorker('a', { cost: 1, reasoning: 'low' }), undefined)).toBe(true)
    const old: CliWorkerEntry = { id: 'old', enabled: true, bin: 'old' }
    expect(workerSupportsRequire(old, null)).toBe(true)
  })

  it('require.vision=true：含 vision 模态 → true，text-only → false', () => {
    const vision = capWorker('a', { cost: 3, reasoning: 'high', modalities: ['text', 'vision'] })
    const text = capWorker('b', { cost: 3, reasoning: 'high' })
    const req: CliCapabilityRequire = { vision: true }
    expect(workerSupportsRequire(vision, req)).toBe(true)
    expect(workerSupportsRequire(text, req)).toBe(false)
  })

  it('require.vision=true：无 capability 旧工人（默认 text）→ false', () => {
    const old: CliWorkerEntry = { id: 'old', enabled: true, bin: 'old' }
    expect(workerSupportsRequire(old, { vision: true })).toBe(false)
  })

  it('reasoningMin 链 low→high：工人档 < 要求 → false，≥ 要求 → true', () => {
    const low = capWorker('a', { cost: 1, reasoning: 'low' })
    const med = capWorker('b', { cost: 2, reasoning: 'medium' })
    const high = capWorker('c', { cost: 3, reasoning: 'high' })
    expect(workerSupportsRequire(low, { reasoningMin: 'medium' })).toBe(false)
    expect(workerSupportsRequire(low, { reasoningMin: 'high' })).toBe(false)
    expect(workerSupportsRequire(med, { reasoningMin: 'medium' })).toBe(true)
    expect(workerSupportsRequire(med, { reasoningMin: 'high' })).toBe(false)
    expect(workerSupportsRequire(high, { reasoningMin: 'high' })).toBe(true)
    expect(workerSupportsRequire(high, { reasoningMin: 'low' })).toBe(true)
  })

  it('require.vision + reasoningMin 组合：两者都须满足', () => {
    const ok = capWorker('a', { cost: 3, reasoning: 'high', modalities: ['text', 'vision'] })
    const lowVision = capWorker('b', { cost: 3, reasoning: 'low', modalities: ['text', 'vision'] })
    const highText = capWorker('c', { cost: 3, reasoning: 'high' })
    expect(workerSupportsRequire(ok, { vision: true, reasoningMin: 'high' })).toBe(true)
    expect(workerSupportsRequire(lowVision, { vision: true, reasoningMin: 'high' })).toBe(false) // vision ok 但推理不足
    expect(workerSupportsRequire(highText, { vision: true, reasoningMin: 'high' })).toBe(false) // 推理够但无 vision
  })
})

describe('workerPreferScore', () => {
  it('无 prefer → 0（不参与重排，保持数组顺序）', () => {
    expect(workerPreferScore(capWorker('a', { cost: 1, reasoning: 'low' }), null)).toBe(0)
    expect(workerPreferScore(capWorker('a', { cost: 1, reasoning: 'low' }), undefined)).toBe(0)
  })

  it('cost 越低分越高（6 - cost）', () => {
    const prefer: CliCapabilityPrefer = {}
    expect(workerPreferScore(capWorker('a', { cost: 1, reasoning: 'low' }), prefer)).toBe(5)
    expect(workerPreferScore(capWorker('a', { cost: 3, reasoning: 'medium' }), prefer)).toBe(3)
    expect(workerPreferScore(capWorker('a', { cost: 5, reasoning: 'high' }), prefer)).toBe(1)
  })

  it('goodFor 关键词命中 worker.goodFor 加 3 分；未命中仅 cost 分', () => {
    const prefer: CliCapabilityPrefer = { goodFor: '单测' }
    const hit = capWorker('a', { cost: 1, reasoning: 'low', goodFor: '单测 / 机械改动 / 小包' })
    const miss = capWorker('b', { cost: 1, reasoning: 'low', goodFor: '探索 / 对照 / 草稿实现' })
    expect(workerPreferScore(hit, prefer)).toBe(8) // 5 + 3
    expect(workerPreferScore(miss, prefer)).toBe(5) // 仅 cost
  })

  it('goodFor 子串匹配（"编排" 命中 "跨层接线 / 编排 / 复杂实现"）', () => {
    const prefer: CliCapabilityPrefer = { goodFor: '编排' }
    expect(workerPreferScore(capWorker('a', { cost: 3, reasoning: 'high', goodFor: '跨层接线 / 编排 / 复杂实现' }), prefer)).toBe(6) // 3 + 3
  })

  it('无 capability 旧工人中性兜底（默认 cost 3 → 3 分；无 goodFor 不命中）', () => {
    const old: CliWorkerEntry = { id: 'old', enabled: true, bin: 'old' }
    expect(workerPreferScore(old, { goodFor: '单测' })).toBe(3) // 6-3=3，无 goodFor 命中
    expect(workerPreferScore(old, {})).toBe(3)
  })

  it('costMax 不参与打分（仅上限约束，打分仍按 6-cost）', () => {
    const prefer: CliCapabilityPrefer = { costMax: 2 }
    expect(workerPreferScore(capWorker('a', { cost: 1, reasoning: 'low' }), prefer)).toBe(5)
    expect(workerPreferScore(capWorker('a', { cost: 2, reasoning: 'low' }), prefer)).toBe(4)
  })

  it('prefer.tag 命中 worker.tags 加 3 分；未命中仅 cost 分', () => {
    const prefer: CliCapabilityPrefer = { tag: 'frontend' }
    const hit = capWorker('grok', { cost: 2, reasoning: 'medium', tags: ['frontend', 'research'] })
    const miss = capWorker('codex', { cost: 4, reasoning: 'high', tags: ['reasoning', 'refactor'] })
    expect(workerPreferScore(hit, prefer)).toBe(7) // (6-2) + 3
    expect(workerPreferScore(miss, prefer)).toBe(2) // 6-4
  })

  it('prefer.tag 与 goodFor 命中可叠加（+3 +3）', () => {
    const prefer: CliCapabilityPrefer = { tag: 'test', goodFor: '单测' }
    const w = capWorker('mimo', { cost: 1, reasoning: 'low', tags: ['test', 'scaffold'], goodFor: '单测 / 机械改动' })
    expect(workerPreferScore(w, prefer)).toBe(11) // (6-1) +3(tag) +3(goodFor)
  })

  it('prefer.tag 命中空 tags 旧工人不加分', () => {
    const old = capWorker('old', { cost: 3, reasoning: 'medium' })
    expect(workerPreferScore(old, { tag: 'frontend' })).toBe(3) // 仅 6-3
  })
})

describe('workerSupportsRequire · tag 硬筛', () => {
  it('require.tag 命中通过；未命中剔除；无 tags 视为不满足', () => {
    const grok = capWorker('grok', { cost: 2, reasoning: 'medium', tags: ['frontend', 'research'] })
    const codex = capWorker('codex', { cost: 4, reasoning: 'high', tags: ['reasoning', 'refactor'] })
    const old = capWorker('old', { cost: 3, reasoning: 'medium' })
    expect(workerSupportsRequire(grok, { tag: 'frontend' })).toBe(true)
    expect(workerSupportsRequire(grok, { tag: 'backend' })).toBe(false)
    expect(workerSupportsRequire(codex, { tag: 'reasoning' })).toBe(true)
    expect(workerSupportsRequire(old, { tag: 'frontend' })).toBe(false) // 无 tags
  })

  it('require.tag 与 vision / reasoningMin 可叠加（全部满足才通过）', () => {
    const w = capWorker('a', { cost: 3, reasoning: 'high', modalities: ['text', 'vision'], tags: ['backend', 'reasoning'] })
    expect(workerSupportsRequire(w, { tag: 'backend', vision: true, reasoningMin: 'high' })).toBe(true)
    expect(workerSupportsRequire(w, { tag: 'frontend', vision: true })).toBe(false) // tag 不中
  })
})

describe('capability.tags 校验', () => {
  it('接受合法 tags', () => {
    const ok = cfgWithCapability({ cost: 3, reasoning: 'high', tags: ['frontend', 'backend'] })
    expect(isValidCliWorkersConfig(ok)).toBe(true)
    expect(validateCliWorkersConfig(ok)).toBeNull()
  })

  it('接受缺省 tags（旧配置不回归）', () => {
    expect(isValidCliWorkersConfig(cfgWithCapability({ cost: 3, reasoning: 'high' }))).toBe(true)
  })

  it('拒绝未知 tag id', () => {
    expect(isValidCliWorkersConfig(cfgWithCapability({ cost: 3, reasoning: 'high', tags: ['frontend', 'typo'] }))).toBe(false)
  })

  it('拒绝 tags 非数组', () => {
    expect(isValidCliWorkersConfig(cfgWithCapability({ cost: 3, reasoning: 'high', tags: 'frontend' }))).toBe(false)
  })

  it('validateCliWorkersConfig 对未知 tag 给中文错误', () => {
    const cfg = cfgWithCapability({ cost: 3, reasoning: 'high', tags: ['typo'] })
    const err = validateCliWorkersConfig(cfg)
    expect(err).toContain('capability.tags 元素须为已知标签')
  })
})

describe('CLI_WORKER_DISCOVERY_CATALOG', () => {
  it('目录非空且每项 id 唯一', () => {
    expect(CLI_WORKER_DISCOVERY_CATALOG.length).toBeGreaterThan(0)
    const ids = CLI_WORKER_DISCOVERY_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每项 bins 非空（按序探测）、supported 为布尔', () => {
    for (const e of CLI_WORKER_DISCOVERY_CATALOG) {
      expect(e.bins.length).toBeGreaterThan(0)
      for (const b of e.bins) expect(typeof b).toBe('string')
      expect(typeof e.supported).toBe('boolean')
    }
  })

  it('按目录顺序含 kscc / grok / codex / mimo / opencode / claude', () => {
    expect(CLI_WORKER_DISCOVERY_CATALOG.map((e) => e.id)).toEqual([
      'kscc',
      'grok',
      'codex',
      'mimo',
      'opencode',
      'claude',
    ])
  })

  it('opencode supported=true（SLICE-9 转正）；claude supported=true（SLICE-10 转正）；六项均 supported=true', () => {
    const byId = (id: string) => CLI_WORKER_DISCOVERY_CATALOG.find((e) => e.id === id)
    expect(byId('kscc')?.supported).toBe(true)
    expect(byId('grok')?.supported).toBe(true)
    expect(byId('codex')?.supported).toBe(true)
    expect(byId('mimo')?.supported).toBe(true)
    expect(byId('opencode')?.supported).toBe(true)
    expect(byId('claude')?.supported).toBe(true)
  })

  it('每项目录项可构造为合法 worker（capability 结构合法、id 不命中黑名单）', () => {
    for (const e of CLI_WORKER_DISCOVERY_CATALOG) {
      const cfg: CliWorkersConfig = {
        version: 1,
        enabled: false,
        defaultBackend: 'in-process',
        defaultCliId: 'kscc',
        workers: [
          {
            id: e.id,
            enabled: true,
            bin: e.bins[0]!,
            ...(e.defaultModel !== undefined ? { defaultModel: e.defaultModel } : {}),
            ...(e.capability !== undefined ? { capability: e.capability } : {}),
          },
        ],
      }
      expect(validateCliWorkersConfig(cfg)).toBeNull()
    }
  })
})

describe('SUPPORTED_CLI_WORKER_IDS', () => {
  it('=== [kscc, grok, codex, mimo, opencode, claude]（SLICE-10 含 claude）', () => {
    expect([...SUPPORTED_CLI_WORKER_IDS]).toEqual(['kscc', 'grok', 'codex', 'mimo', 'opencode', 'claude'])
  })

  it('是 readonly 数组（不可 push）', () => {
    // readonly 语义：类型层面禁写；运行时仍是数组，仅做存在性断言
    expect(Array.isArray(SUPPORTED_CLI_WORKER_IDS)).toBe(true)
    expect(SUPPORTED_CLI_WORKER_IDS.length).toBe(6)
  })
})
