import { describe, expect, it } from 'vitest'
import {
  CLI_WORKERS_DEFAULT_SEED,
  ensureSeedWorkers,
  isDeniedCliName,
  isValidCliWorkersConfig,
  listEnabledWorkersByPriority,
  moveWorkerPriority,
  resolveDefaultWorker,
  resolveWorkerByPreference,
  shouldUseCliWorker,
  syncDefaultCliId,
  validateCliWorkersConfig,
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
    // 补的三条用 seed 默认
    expect(merged.workers[1]).toEqual({ id: 'grok', enabled: true, bin: 'grok', defaultModel: undefined })
    expect(merged.workers[2]).toEqual({ id: 'codex', enabled: true, bin: 'codex', defaultModel: undefined })
    expect(merged.workers[3]).toEqual({ id: 'mimo', enabled: true, bin: 'mimo', defaultModel: undefined })
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
