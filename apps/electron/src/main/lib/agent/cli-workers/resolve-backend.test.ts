/**
 * resolveTaskSubagentBackend 单测：配置 → in-process/cli 判定链。
 *
 * 覆盖：默认 disabled→in-process；enabled+cli+kscc(bare bin)→cli；默认工人 codex(非 kscc)→cli（SLICE-4 去 kscc 硬限制）；
 * 绝对 bin 不存在→in-process；绝对 bin 存在→cli；默认工人被禁用→in-process。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// electron mock：config-paths.ts isAppPackaged 用
vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

let configDir: string

async function load() {
  vi.resetModules()
  return import('./resolve-backend')
}

function writeCfg(cfg: unknown): void {
  writeFileSync(join(configDir, 'cli-workers.json'), JSON.stringify(cfg), 'utf8')
}

/**
 * listCliWorkersConfig 会 ensureSeedWorkers 补齐缺失 id。
 * 测「池空 / 唯一工人」时必须把 seed 四兄弟都写上并关掉无关项，避免 PATH 上碰巧有 grok 导致误判 cli。
 */
function allDisabledExcept(
  only: Array<{ id: string; enabled: boolean; bin: string; defaultModel?: string }>,
): Array<{ id: string; enabled: boolean; bin: string; defaultModel?: string }> {
  const ids = ['kscc', 'grok', 'codex', 'mimo'] as const
  const map = new Map(only.map((w) => [w.id, w]))
  return ids.map((id) => map.get(id) ?? { id, enabled: false, bin: id })
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'tagent-resolve-backend-'))
  process.env.TAGENT_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(configDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('resolveTaskSubagentBackend', () => {
  it('disabled → in-process', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg({
      version: 1,
      enabled: false,
      defaultBackend: 'in-process',
      defaultCliId: 'kscc',
      workers: [{ id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' }],
    })
    expect(resolveTaskSubagentBackend()).toEqual({ kind: 'in-process' })
  })

  it('enabled + cli + kscc(bare bin) → cli', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [{ id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' }],
    })
    const r = resolveTaskSubagentBackend()
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') {
      expect(r.worker.id).toBe('kscc')
      expect(r.worker.bin).toBe('kscc')
      expect(r.worker.defaultModel).toBe('glm-5.2')
    }
  })

  it('默认工人 codex(非 kscc) → cli（SLICE-4 去掉 kscc 硬限制）', async () => {
    const { resolveTaskSubagentBackend } = await load()
    const fakeBin = join(configDir, 'codex.cmd')
    writeFileSync(fakeBin, '@echo off', 'utf8')
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'codex',
      workers: [{ id: 'codex', enabled: true, bin: fakeBin }],
    })
    const r = resolveTaskSubagentBackend()
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') {
      expect(r.worker.id).toBe('codex')
      expect(r.worker.bin).toBe(fakeBin)
    }
  })

  it('默认工人 grok(非 kscc) → cli', async () => {
    const { resolveTaskSubagentBackend } = await load()
    const fakeBin = join(configDir, 'grok.exe')
    writeFileSync(fakeBin, '', 'utf8')
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'grok',
      workers: [{ id: 'grok', enabled: true, bin: fakeBin }],
    })
    const r = resolveTaskSubagentBackend()
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('grok')
  })

  it('默认工人 mimo(非 kscc) → cli', async () => {
    const { resolveTaskSubagentBackend } = await load()
    const fakeBin = join(configDir, 'mimo.exe')
    writeFileSync(fakeBin, '', 'utf8')
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'mimo',
      workers: [{ id: 'mimo', enabled: true, bin: fakeBin }],
    })
    const r = resolveTaskSubagentBackend()
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('mimo')
  })

  it('非 kscc 默认工人 bin 本机未找到 → in-process（probe 兜底，不误 spawn）', async () => {
    const { resolveTaskSubagentBackend } = await load()
    const bogus = join(configDir, 'no-such-codex.cmd')
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'codex',
      workers: allDisabledExcept([{ id: 'codex', enabled: true, bin: bogus }]),
    })
    expect(existsSync(bogus)).toBe(false)
    expect(resolveTaskSubagentBackend()).toEqual({ kind: 'in-process' })
  })

  it('绝对 bin 路径不存在 → in-process', async () => {
    const { resolveTaskSubagentBackend } = await load()
    const bogus = join(configDir, 'no-such-kscc.cmd')
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: allDisabledExcept([{ id: 'kscc', enabled: true, bin: bogus }]),
    })
    expect(existsSync(bogus)).toBe(false)
    expect(resolveTaskSubagentBackend()).toEqual({ kind: 'in-process' })
  })

  it('绝对 bin 路径存在 → cli', async () => {
    const { resolveTaskSubagentBackend } = await load()
    const fakeBin = join(configDir, 'kscc.cmd')
    writeFileSync(fakeBin, '@echo off', 'utf8')
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: allDisabledExcept([{ id: 'kscc', enabled: true, bin: fakeBin }]),
    })
    const r = resolveTaskSubagentBackend()
    expect(r.kind).toBe('cli')
  })

  it('启用池全禁用 → in-process', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: allDisabledExcept([{ id: 'kscc', enabled: false, bin: 'kscc' }]),
    })
    expect(resolveTaskSubagentBackend()).toEqual({ kind: 'in-process' })
  })

  it('defaultBackend=in-process → in-process（即使 enabled）', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'in-process',
      defaultCliId: 'kscc',
      workers: [{ id: 'kscc', enabled: true, bin: 'kscc' }],
    })
    expect(resolveTaskSubagentBackend()).toEqual({ kind: 'in-process' })
  })

  it('优先级：数组靠前且可用者胜出（不绑 defaultCliId）', async () => {
    const { resolveTaskSubagentBackend } = await load()
    const grokBin = join(configDir, 'grok.exe')
    const codexBin = join(configDir, 'codex.cmd')
    writeFileSync(grokBin, '', 'utf8')
    writeFileSync(codexBin, '@echo off', 'utf8')
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'codex', // 旧字段：不该压过数组优先级
      workers: [
        { id: 'grok', enabled: true, bin: grokBin },
        { id: 'codex', enabled: true, bin: codexBin },
      ],
    })
    const r = resolveTaskSubagentBackend()
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('grok')
  })

  it('preferredCliId 优先于数组顺序', async () => {
    const { resolveTaskSubagentBackend } = await load()
    const grokBin = join(configDir, 'grok2.exe')
    const codexBin = join(configDir, 'codex2.cmd')
    writeFileSync(grokBin, '', 'utf8')
    writeFileSync(codexBin, '@echo off', 'utf8')
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'grok',
      workers: [
        { id: 'grok', enabled: true, bin: grokBin },
        { id: 'codex', enabled: true, bin: codexBin },
      ],
    })
    const r = resolveTaskSubagentBackend({ preferredCliId: 'codex' })
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('codex')
  })

  it('preferred 不可用 → 回落到下一优先级可用工人', async () => {
    const { resolveTaskSubagentBackend } = await load()
    const grokBin = join(configDir, 'grok3.exe')
    writeFileSync(grokBin, '', 'utf8')
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'codex',
      workers: [
        { id: 'codex', enabled: true, bin: join(configDir, 'no-codex.cmd') },
        { id: 'grok', enabled: true, bin: grokBin },
      ],
    })
    const r = resolveTaskSubagentBackend({ preferredCliId: 'codex' })
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('grok')
  })
})
