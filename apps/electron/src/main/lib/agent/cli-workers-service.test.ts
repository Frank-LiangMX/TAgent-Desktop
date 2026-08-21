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
import { CLI_WORKER_DISCOVERY_CATALOG, CLI_WORKERS_DEFAULT_SEED, validateCliWorkersConfig, type CliWorkerDiscoveryEntry, type CliWorkersConfig } from '@tagent/shared'

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
  it('returns default in-memory (enabled false, 0 workers) and does NOT write when none exists', async () => {
    const { listCliWorkersConfig } = await loadService()
    const cfg = listCliWorkersConfig()
    expect(cfg.version).toBe(1)
    expect(cfg.enabled).toBe(false)
    expect(cfg.defaultBackend).toBe('in-process')
    expect(cfg.defaultCliId).toBe('kscc')
    expect(cfg.workers).toEqual([])

    // 纯读：首次落盘由 discoverAndReconcileCliWorkers 负责，list 不写盘
    const filePath = join(configDir, 'cli-workers.json')
    expect(existsSync(filePath)).toBe(false)
  })

  it('returns the existing valid config as-is (no seed merge)', async () => {
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
    // 纯读：原样返回，不再 ensureSeedWorkers 占位补齐 grok/codex/mimo
    expect(cfg.workers.map((w) => w.id)).toEqual(['kscc'])
    expect(cfg.workers[0]!.bin).toBe('/usr/local/bin/kscc')
    // 文件仍是旧 1 条（纯读不回写）
    const raw = JSON.parse(readFileSync(join(configDir, 'cli-workers.json'), 'utf8'))
    expect(raw.workers.map((w: { id: string }) => w.id)).toEqual(['kscc'])
  })

  it('returns default in-memory when the file is structurally invalid (does not overwrite)', async () => {
    const { listCliWorkersConfig } = await loadService()
    const filePath = join(configDir, 'cli-workers.json')
    writeFileSync(filePath, JSON.stringify({ version: 99, garbage: true }), 'utf8')

    const cfg = listCliWorkersConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.version).toBe(1)
    expect(cfg.workers).toEqual([])
    // 纯读：不覆盖坏文件（自愈/首次落盘由 discoverAndReconcileCliWorkers 负责）
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(raw.version).toBe(99)
    expect(raw.garbage).toBe(true)
  })

  it('returns default in-memory when the file contains a deny-list worker (does not overwrite)', async () => {
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
    // 命中黑名单 → 当坏文件 → 返回内存默认（不覆盖）
    expect(cfg.enabled).toBe(false)
    expect(cfg.defaultCliId).toBe('kscc')
    expect(cfg.workers).toEqual([])
    // 文件原样保留（纯读）
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(raw.defaultCliId).toBe('hermes')
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
    // list 纯读原样返回（不再 merge 补齐 seed 工人）→ 仍 1 条 kscc
    expect(reloaded.workers.map((w) => w.id)).toEqual(['kscc'])
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

/** 取目录项 by id（测试构造已安装集合用） */
function cat(id: string): CliWorkerDiscoveryEntry | undefined {
  return CLI_WORKER_DISCOVERY_CATALOG.find((e) => e.id === id)
}

describe('discoverAndReconcileCliWorkers', () => {
  it('无配置文件 → 落盘 = 仅本机已安装目录项（codex 未装则无 codex 行）', async () => {
    const { discoverAndReconcileCliWorkers, listCliWorkersConfig } = await loadService()
    // 模拟本机已安装 kscc / grok / mimo（codex 未装）
    const installed: Array<{ entry: CliWorkerDiscoveryEntry; resolvedBin: string }> = [
      { entry: cat('kscc')!, resolvedBin: 'C:\\kscc.cmd' },
      { entry: cat('grok')!, resolvedBin: 'C:\\grok.cmd' },
      { entry: cat('mimo')!, resolvedBin: 'C:\\mimo.cmd' },
    ]
    const cfg = discoverAndReconcileCliWorkers(() => installed)
    // 落盘 = 已安装 3 行（无 codex），总开关关，defaultCliId=首个已安装 supported（kscc）
    expect(cfg.enabled).toBe(false)
    expect(cfg.defaultBackend).toBe('in-process')
    expect(cfg.defaultCliId).toBe('kscc')
    expect(cfg.workers.map((w) => w.id)).toEqual(['kscc', 'grok', 'mimo'])
    // bin 为命中绝对路径
    expect(cfg.workers[0]!.bin).toBe('C:\\kscc.cmd')
    // kscc 带 defaultModel + capability（自目录）
    expect(cfg.workers[0]!.defaultModel).toBe('glm-5.2')
    expect(cfg.workers[0]!.capability).toEqual({
      cost: 3,
      reasoning: 'high',
      goodFor: '跨层接线 / 编排 / 复杂实现',
      tags: ['backend', 'reasoning', 'refactor'],
    })
    // 文件已落盘
    const raw = JSON.parse(readFileSync(join(configDir, 'cli-workers.json'), 'utf8'))
    expect(raw.workers.map((w: { id: string }) => w.id)).toEqual(['kscc', 'grok', 'mimo'])
    // list 回读一致
    expect(listCliWorkersConfig().workers.map((w) => w.id)).toEqual(['kscc', 'grok', 'mimo'])
    // 对账后配置合法
    expect(validateCliWorkersConfig(cfg)).toBeNull()
  })

  it('无配置文件且无已安装 → 落盘空工人（defaultCliId=kscc 兜底）', async () => {
    const { discoverAndReconcileCliWorkers } = await loadService()
    const cfg = discoverAndReconcileCliWorkers(() => [])
    expect(cfg.workers).toEqual([])
    expect(cfg.enabled).toBe(false)
    expect(cfg.defaultCliId).toBe('kscc')
    expect(validateCliWorkersConfig(cfg)).toBeNull()
    const raw = JSON.parse(readFileSync(join(configDir, 'cli-workers.json'), 'utf8'))
    expect(raw.workers).toEqual([])
  })

  it('已有配置 → 追加新发现（opencode）、移除默认 bin+未安装占位（codex）、保留自定义 id / 改过 bin 的行', async () => {
    const { discoverAndReconcileCliWorkers, listCliWorkersConfig, writeCliWorkersConfig } =
      await loadService()
    // 既有配置：kscc(已安装,bare) + codex(未安装,bare=默认→待移除) + grok(未安装但改过 bin→保留) + mycustom(自定义 id→保留)
    writeCliWorkersConfig({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [
        { id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' },
        { id: 'codex', enabled: false, bin: 'codex' },
        { id: 'grok', enabled: true, bin: '/custom/grok' },
        { id: 'mycustom', enabled: true, bin: '/my/custom' },
      ],
    })
    // 模拟本机已安装 kscc + opencode（codex/grok 未装）
    const installed: Array<{ entry: CliWorkerDiscoveryEntry; resolvedBin: string }> = [
      { entry: cat('kscc')!, resolvedBin: 'C:\\kscc.cmd' },
      { entry: cat('opencode')!, resolvedBin: 'C:\\opencode.exe' },
    ]
    const cfg = discoverAndReconcileCliWorkers(() => installed)
    // kscc 保留（已安装）原样不动；codex 移除（默认 bin + 未装）；grok 保留（改过 bin）；mycustom 保留（自定义 id）；opencode 追加
    expect(cfg.workers.map((w) => w.id)).toEqual(['kscc', 'grok', 'mycustom', 'opencode'])
    // kscc 原样（bin 仍 bare，未被改写为绝对路径——保留用户配置不动）
    expect(cfg.workers.find((w) => w.id === 'kscc')!.bin).toBe('kscc')
    // grok 保留改过的 bin
    expect(cfg.workers.find((w) => w.id === 'grok')!.bin).toBe('/custom/grok')
    // opencode 追加：enabled true，bin=命中绝对路径，带 capability，无 defaultModel
    const oc = cfg.workers.find((w) => w.id === 'opencode')!
    expect(oc.enabled).toBe(true)
    expect(oc.bin).toBe('C:\\opencode.exe')
    expect(oc.capability).toEqual({
      cost: 2,
      reasoning: 'medium',
      goodFor: '通用编码 / 多 Agent 协作',
      tags: ['backend', 'scaffold'],
    })
    expect(oc.defaultModel).toBeUndefined()
    // 顶层总开关 / 后端保留（对账不动用户总开关）
    expect(cfg.enabled).toBe(true)
    expect(cfg.defaultBackend).toBe('cli')
    // 文件已落盘 + list 回读一致
    const raw = JSON.parse(readFileSync(join(configDir, 'cli-workers.json'), 'utf8'))
    expect(raw.workers.map((w: { id: string }) => w.id)).toEqual(['kscc', 'grok', 'mycustom', 'opencode'])
    expect(listCliWorkersConfig().workers.map((w) => w.id)).toEqual([
      'kscc',
      'grok',
      'mycustom',
      'opencode',
    ])
    // 对账后配置合法
    expect(validateCliWorkersConfig(cfg)).toBeNull()
  })

  it('已有配置 + 目录项 bin 被用户改过且未安装 → 保留（不因未装移除）', async () => {
    const { discoverAndReconcileCliWorkers, writeCliWorkersConfig } = await loadService()
    writeCliWorkersConfig({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [{ id: 'kscc', enabled: true, bin: '/my/kscc', defaultModel: 'glm-5.2' }],
    })
    // 本机什么都没装
    const cfg = discoverAndReconcileCliWorkers(() => [])
    // kscc bin 被改过（非默认 'kscc'）→ 保留不动（不因未装移除）
    expect(cfg.workers.map((w) => w.id)).toEqual(['kscc'])
    expect(cfg.workers[0]!.bin).toBe('/my/kscc')
  })

  it('已有配置 + 目录项默认 bin 未安装 → 移除占位（不残留未找到行）', async () => {
    const { discoverAndReconcileCliWorkers, writeCliWorkersConfig } = await loadService()
    writeCliWorkersConfig({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [
        { id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' },
        { id: 'codex', enabled: true, bin: 'codex' },
        { id: 'mimo', enabled: false, bin: 'mimo' },
      ],
    })
    // 本机仅装 kscc
    const cfg = discoverAndReconcileCliWorkers(() => [
      { entry: cat('kscc')!, resolvedBin: 'C:\\kscc.cmd' },
    ])
    // codex/mimo 均默认 bin + 未装 → 移除；仅留 kscc
    expect(cfg.workers.map((w) => w.id)).toEqual(['kscc'])
  })
})
