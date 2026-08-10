/**
 * cli-workers-service 单测：无文件 seed + save/list 一致 + 黑名单拒写 + 坏文件自愈
 *
 * 验收对齐：无文件 list 返回默认(enabled false)并落 seed；合法 save→list 一致；
 * hermes/openclaw 条目 save 失败且不脏写。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CLI_WORKERS_DEFAULT_SEED, type CliWorkersConfig } from '@tagent/shared'

// electron mock：config-paths.ts isAppPackaged 用
vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

let configDir: string

async function loadService() {
  vi.resetModules()
  return import('./cli-workers-service')
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'tagent-cli-workers-svc-'))
  process.env.TAGENT_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(configDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** 造一份合法的「已启用 CLI 后端」配置，用于写盘后再校验是否被覆盖。 */
function validEnabledCfg(): CliWorkersConfig {
  return {
    version: 1,
    enabled: true,
    defaultBackend: 'cli',
    defaultCliId: 'kscc',
    workers: [{ id: 'kscc', enabled: true, bin: '/usr/local/bin/kscc', defaultModel: 'glm-5.2' }],
  }
}

describe('listCliWorkersConfig', () => {
  it('seeds default (enabled false) and writes the file when none exists', async () => {
    const { listCliWorkersConfig } = await loadService()
    const cfg = listCliWorkersConfig()
    expect(cfg.version).toBe(1)
    expect(cfg.enabled).toBe(false)
    expect(cfg.defaultBackend).toBe('in-process')
    expect(cfg.defaultCliId).toBe('kscc')
    expect(cfg.workers.map((w) => w.id)).toEqual(['kscc', 'grok', 'codex', 'mimo'])

    // seed 文件已落盘（含 4 个工人）
    const filePath = join(configDir, 'cli-workers.json')
    expect(existsSync(filePath)).toBe(true)
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.enabled).toBe(false)
    expect(raw.workers.map((w: { id: string }) => w.id)).toEqual(['kscc', 'grok', 'codex', 'mimo'])
    expect(raw.workers[0].id).toBe('kscc')
  })

  it('returns the existing valid config with missing seed workers merged in', async () => {
    const { listCliWorkersConfig, writeCliWorkersConfig } = await loadService()
    // 旧配置：仅 1 条 kscc，bin 已自定义
    writeCliWorkersConfig({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [{ id: 'kscc', enabled: true, bin: '/usr/local/bin/kscc', defaultModel: 'glm-5.2' }],
    })
    const cfg = listCliWorkersConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.defaultBackend).toBe('cli')
    // 用户已有 kscc 字段保留，缺的 grok/codex/mimo 补齐
    expect(cfg.workers.map((w) => w.id)).toEqual(['kscc', 'grok', 'codex', 'mimo'])
    expect(cfg.workers[0]!.bin).toBe('/usr/local/bin/kscc')
    // merge 自 seed 的 grok 带 SLICE-5 能力画像（仅内存补齐，不回写盘）
    expect(cfg.workers[1]).toEqual({
      id: 'grok',
      enabled: true,
      bin: 'grok',
      capability: { cost: 2, reasoning: 'medium', goodFor: '探索 / 对照 / 草稿实现' },
    })
    // merge 仅在内存，文件仍是旧 1 条（落盘升级发生在用户下次保存整表）
    const raw = JSON.parse(readFileSync(join(configDir, 'cli-workers.json'), 'utf8'))
    expect(raw.workers.map((w: { id: string }) => w.id)).toEqual(['kscc'])
  })

  it('falls back to seed when the file is structurally invalid', async () => {
    const { listCliWorkersConfig } = await loadService()
    const filePath = join(configDir, 'cli-workers.json')
    writeFileSync(filePath, JSON.stringify({ version: 99, garbage: true }), 'utf8')

    const cfg = listCliWorkersConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.version).toBe(1)
    // 文件被 seed 覆盖（4 工人）
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.enabled).toBe(false)
    expect(raw.workers.map((w: { id: string }) => w.id)).toEqual(['kscc', 'grok', 'codex', 'mimo'])
  })

  it('falls back to seed when the file contains a deny-list worker', async () => {
    const { listCliWorkersConfig } = await loadService()
    const filePath = join(configDir, 'cli-workers.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        enabled: true,
        defaultBackend: 'cli',
        defaultCliId: 'hermes',
        workers: [{ id: 'hermes', enabled: true, bin: 'hermes' }],
      }),
      'utf8',
    )

    const cfg = listCliWorkersConfig()
    // 命中黑名单 → 当坏文件 → seed 覆盖回零行为
    expect(cfg.enabled).toBe(false)
    expect(cfg.defaultCliId).toBe('kscc')
  })
})

describe('writeCliWorkersConfig', () => {
  it('writes a valid config and list reads it back consistently', async () => {
    const { writeCliWorkersConfig, listCliWorkersConfig } = await loadService()
    writeCliWorkersConfig(validEnabledCfg())
    const loaded = listCliWorkersConfig()
    expect(loaded.enabled).toBe(true)
    expect(loaded.defaultBackend).toBe('cli')
    expect(loaded.defaultCliId).toBe('kscc')
    expect(loaded.workers[0]!.bin).toBe('/usr/local/bin/kscc')
    expect(loaded.workers[0]!.defaultModel).toBe('glm-5.2')
    // 文件头为 v1 扁平
    const raw = JSON.parse(readFileSync(join(configDir, 'cli-workers.json'), 'utf8'))
    expect(raw.version).toBe(1)
  })

  it('strips unknown fields when writing', async () => {
    const { writeCliWorkersConfig } = await loadService()
    const cfg = {
      ...validEnabledCfg(),
      unknownJunk: 'drop-me',
    } as CliWorkersConfig
    writeCliWorkersConfig(cfg)
    const raw = JSON.parse(readFileSync(join(configDir, 'cli-workers.json'), 'utf8'))
    expect(raw.unknownJunk).toBeUndefined()
    expect(raw.enabled).toBe(true)
  })

  it('throws Chinese error for deny-list id (hermes) and does NOT write', async () => {
    const svc = await loadService()
    // 先写一份合法的（带可识别标记 defaultCliId=kscc / enabled=true）
    svc.writeCliWorkersConfig(validEnabledCfg())

    const bad: CliWorkersConfig = {
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [
        { id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' },
        { id: 'hermes', enabled: true, bin: 'hermes' },
      ],
    }
    expect(() => svc.writeCliWorkersConfig(bad)).toThrow(/黑名单/)

    // 文件应保留之前合法的内容（不脏写）：raw 仍是 validEnabledCfg 的 1 条 kscc
    const reloaded = (await loadService()).listCliWorkersConfig()
    expect(reloaded.enabled).toBe(true)
    expect(reloaded.defaultCliId).toBe('kscc')
    const raw = JSON.parse(readFileSync(join(configDir, 'cli-workers.json'), 'utf8'))
    expect(raw.workers.map((w: { id: string }) => w.id)).toEqual(['kscc'])
    expect(raw.workers[0].bin).toBe('/usr/local/bin/kscc')
    // list 回读会 merge 补齐缺的 seed 工人 → 4 工人，但 kscc 仍是合法那份
    expect(reloaded.workers.map((w) => w.id)).toEqual(['kscc', 'grok', 'codex', 'mimo'])
  })

  it('throws Chinese error for deny-list bin basename (openclaw) and does NOT write', async () => {
    const svc = await loadService()
    svc.writeCliWorkersConfig(validEnabledCfg())

    const bad: CliWorkersConfig = {
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [{ id: 'kscc', enabled: true, bin: '/usr/local/bin/openclaw', defaultModel: 'glm-5.2' }],
    }
    expect(() => svc.writeCliWorkersConfig(bad)).toThrow(/黑名单/)

    const reloaded = (await loadService()).listCliWorkersConfig()
    expect(reloaded.workers[0]!.bin).toBe('/usr/local/bin/kscc')
  })

  it('throws for structurally invalid config (empty defaultCliId) and does NOT write', async () => {
    const svc = await loadService()
    svc.writeCliWorkersConfig(validEnabledCfg())

    const bad = {
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: '',
      workers: [],
    } as CliWorkersConfig
    expect(() => svc.writeCliWorkersConfig(bad)).toThrow(/defaultCliId/)

    const reloaded = (await loadService()).listCliWorkersConfig()
    expect(reloaded.defaultCliId).toBe('kscc')
  })

  it('does not break the default seed contract (enabled false) on first save of seed', async () => {
    const { writeCliWorkersConfig, listCliWorkersConfig } = await loadService()
    // 直接落默认 seed（零行为）也须能写回
    writeCliWorkersConfig({
      ...CLI_WORKERS_DEFAULT_SEED,
      workers: CLI_WORKERS_DEFAULT_SEED.workers.map((w) => ({ ...w })),
    } as CliWorkersConfig)
    const loaded = listCliWorkersConfig()
    expect(loaded.enabled).toBe(false)
  })
})
