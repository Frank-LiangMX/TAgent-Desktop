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
import { type CliWorkerCapability } from '@tagent/shared'

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

/**
 * 造一份 enabled + cli 配置：写全 4 个 seed id（未列出者 disabled），
 * 避免 listCliWorkersConfig 的 ensureSeedWorkers 补入额外启用工人干扰候选集。
 */
function buildCfg(
  workers: Array<{ id: string; enabled: boolean; bin: string; capability?: CliWorkerCapability }>,
): unknown {
  const ids = ['kscc', 'grok', 'codex', 'mimo'] as const
  const map = new Map(workers.map((w) => [w.id, w]))
  return {
    version: 1,
    enabled: true,
    defaultBackend: 'cli',
    defaultCliId: 'kscc',
    workers: ids.map((id) => map.get(id) ?? { id, enabled: false, bin: id }),
  }
}

/** 在 configDir 造一个 fake .cmd bin，返回绝对路径（Windows 走 existsSync 直判）。 */
function mkBin(name: string): string {
  const p = join(configDir, name)
  writeFileSync(p, '@echo off', 'utf8')
  return p
}

describe('resolveTaskSubagentBackend · 能力 require/prefer 路由', () => {
  it('require.vision 剔除 text-only 工人，选 vision 工人', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg(buildCfg([
      { id: 'kscc', enabled: true, bin: mkBin('kscc-v.cmd'), capability: { cost: 3, reasoning: 'high' } },
      { id: 'grok', enabled: true, bin: mkBin('grok-v.cmd'), capability: { cost: 3, reasoning: 'high', modalities: ['text', 'vision'] } },
    ]))
    const r = resolveTaskSubagentBackend({ require: { vision: true } })
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('grok')
  })

  it('require.vision 池内全不支持 → in-process', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg(buildCfg([
      { id: 'kscc', enabled: true, bin: mkBin('kscc-text.cmd'), capability: { cost: 3, reasoning: 'high' } },
    ]))
    expect(resolveTaskSubagentBackend({ require: { vision: true } })).toEqual({ kind: 'in-process' })
  })

  it('require.reasoningMin 剔除推理不足者，选达标者', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg(buildCfg([
      { id: 'kscc', enabled: true, bin: mkBin('kscc-low.cmd'), capability: { cost: 3, reasoning: 'low' } },
      { id: 'grok', enabled: true, bin: mkBin('grok-high.cmd'), capability: { cost: 3, reasoning: 'high' } },
    ]))
    const r = resolveTaskSubagentBackend({ require: { reasoningMin: 'high' } })
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('grok')
  })

  it('require 池内全不满足 → in-process', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg(buildCfg([
      { id: 'kscc', enabled: true, bin: mkBin('kscc-only-low.cmd'), capability: { cost: 3, reasoning: 'low' } },
    ]))
    expect(resolveTaskSubagentBackend({ require: { reasoningMin: 'high' } })).toEqual({ kind: 'in-process' })
  })

  it('prefer.costMax 硬上限剔除贵工人 + cost 打分排序选最便宜', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg(buildCfg([
      { id: 'kscc', enabled: true, bin: mkBin('kscc-c4.cmd'), capability: { cost: 4, reasoning: 'high' } },
      { id: 'grok', enabled: true, bin: mkBin('grok-c2.cmd'), capability: { cost: 2, reasoning: 'medium' } },
      { id: 'mimo', enabled: true, bin: mkBin('mimo-c1.cmd'), capability: { cost: 1, reasoning: 'low' } },
    ]))
    // costMax=2 剔除 kscc(cost4)；grok(cost2)=4 分、mimo(cost1)=5 分 → mimo 胜
    const r = resolveTaskSubagentBackend({ prefer: { costMax: 2 } })
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('mimo')
    // 对照：无 prefer 时按数组顺序选首个可用（kscc），证明 prefer 改变了结果
    const r0 = resolveTaskSubagentBackend()
    expect(r0.kind).toBe('cli')
    if (r0.kind === 'cli') expect(r0.worker.id).toBe('kscc')
  })

  it('prefer.goodFor 命中加分，把命中工人排到数组顺序之前', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg(buildCfg([
      { id: 'kscc', enabled: true, bin: mkBin('kscc-gf.cmd'), capability: { cost: 3, reasoning: 'high', goodFor: '跨层接线 / 编排 / 复杂实现' } },
      { id: 'grok', enabled: true, bin: mkBin('grok-gf.cmd'), capability: { cost: 3, reasoning: 'medium', goodFor: '探索 / 对照 / 草稿实现' } },
    ]))
    // kscc 数组在前、同 cost；grok goodFor 命中 "探索" 加 3 → 超过 kscc
    const r = resolveTaskSubagentBackend({ prefer: { goodFor: '探索' } })
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('grok')
  })

  it('显式 cli 满足 require → 用之（优先于 prefer 打分选更便宜者）', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg(buildCfg([
      { id: 'kscc', enabled: true, bin: mkBin('kscc-exp.cmd'), capability: { cost: 4, reasoning: 'high' } },
      { id: 'grok', enabled: true, bin: mkBin('grok-cheap.cmd'), capability: { cost: 1, reasoning: 'high' } },
    ]))
    const r = resolveTaskSubagentBackend({
      preferredCliId: 'kscc',
      require: { reasoningMin: 'high' },
      prefer: { costMax: 5 },
    })
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('kscc') // 显式 cli 优先于 prefer 选更便宜的 grok
  })

  it('显式 cli 不满足 require → 回落池内满足者', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg(buildCfg([
      { id: 'kscc', enabled: true, bin: mkBin('kscc-low2.cmd'), capability: { cost: 3, reasoning: 'low' } },
      { id: 'grok', enabled: true, bin: mkBin('grok-vis2.cmd'), capability: { cost: 3, reasoning: 'high', modalities: ['text', 'vision'] } },
    ]))
    const r = resolveTaskSubagentBackend({
      preferredCliId: 'kscc',
      require: { vision: true, reasoningMin: 'high' },
    })
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('grok')
  })

  it('无 require/prefer → 按数组顺序选首个可用（不按 cost 重排）', async () => {
    const { resolveTaskSubagentBackend } = await load()
    // mimo 数组首位（cost 1 最便宜）、kscc 次之（cost 3）；无 prefer 不打分 → 选数组首位 mimo
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'mimo',
      workers: [
        { id: 'mimo', enabled: true, bin: mkBin('mimo-first.cmd'), capability: { cost: 1, reasoning: 'low' } },
        { id: 'kscc', enabled: true, bin: mkBin('kscc-second.cmd'), capability: { cost: 3, reasoning: 'high' } },
        { id: 'grok', enabled: false, bin: 'grok' },
        { id: 'codex', enabled: false, bin: 'codex' },
      ],
    })
    const r = resolveTaskSubagentBackend()
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('mimo')
  })
})

describe('listEnabledCliWorkerCards', () => {
  it('关闭 / 未启用 → 空串', async () => {
    const { listEnabledCliWorkerCards } = await load()
    writeCfg({
      version: 1,
      enabled: false,
      defaultBackend: 'in-process',
      defaultCliId: 'kscc',
      workers: [{ id: 'kscc', enabled: true, bin: 'kscc' }],
    })
    expect(listEnabledCliWorkerCards()).toBe('')
  })

  it('启用池 → 含能力卡头 + 每启用工人一行 + 参数说明（禁用者不入卡）', async () => {
    const { listEnabledCliWorkerCards } = await load()
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [
        { id: 'kscc', enabled: true, bin: 'kscc', capability: { cost: 3, reasoning: 'high', goodFor: '编排' } },
        { id: 'grok', enabled: true, bin: 'grok', capability: { cost: 2, reasoning: 'medium', modalities: ['text', 'vision'] } },
        { id: 'codex', enabled: false, bin: 'codex' },
        { id: 'mimo', enabled: false, bin: 'mimo' },
      ],
    })
    const card = listEnabledCliWorkerCards()
    expect(card).toContain('CLI 工人能力卡（按优先级）：')
    expect(card).toContain('kscc — cost 3 · reasoning high · text · 编排')
    expect(card).toContain('grok — cost 2 · reasoning medium · text+vision')
    expect(card).toContain('可用参数：cli 指定其一；require 硬性')
    expect(card).not.toContain('codex') // 禁用者不入卡
    expect(card).not.toContain('mimo')
  })
})

describe('resolveTaskSubagentBackend · 无 runner 工人过滤（用户自定义 id 不在 supported 目录）', () => {
  // opencode 已在 SLICE-9 转正为 supported；此处改用用户自定义 id（custom-cli，不在目录、bin 可用）
  // 继续覆盖「unsupported 工人过滤」语义：不参与路由、不注入能力卡。
  it('池内含 custom-cli（不在 supported 目录）且可用 → 路由跳过它选 supported（kscc）', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [
        { id: 'custom-cli', enabled: true, bin: mkBin('custom-cli.exe'), capability: { cost: 2, reasoning: 'medium' } },
        { id: 'kscc', enabled: true, bin: mkBin('kscc-s8.cmd'), capability: { cost: 3, reasoning: 'high' } },
      ],
    })
    const r = resolveTaskSubagentBackend()
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('kscc') // custom-cli 不在目录 → 被过滤
  })

  it('池内全 unsupported（仅 custom-cli 可用，不在 supported 目录）→ in-process', async () => {
    const { resolveTaskSubagentBackend } = await load()
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [
        { id: 'custom-cli', enabled: true, bin: mkBin('custom-cli-only.exe'), capability: { cost: 2, reasoning: 'medium' } },
      ],
    })
    expect(resolveTaskSubagentBackend()).toEqual({ kind: 'in-process' })
  })

  it('显式 preferredCliId=custom-cli（不在 supported 目录）→ warn 回落池内 supported', async () => {
    const { resolveTaskSubagentBackend } = await load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [
        { id: 'custom-cli', enabled: true, bin: mkBin('custom-cli-pref.exe'), capability: { cost: 2, reasoning: 'medium' } },
        { id: 'kscc', enabled: true, bin: mkBin('kscc-pref.cmd'), capability: { cost: 3, reasoning: 'high' } },
      ],
    })
    const r = resolveTaskSubagentBackend({ preferredCliId: 'custom-cli' })
    expect(r.kind).toBe('cli')
    if (r.kind === 'cli') expect(r.worker.id).toBe('kscc') // custom-cli 显式但无 runner → 回落 kscc
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('暂不支持派工'))
    warn.mockRestore()
  })

  it('listEnabledCliWorkerCards 不注入 unsupported 工人（custom-cli 不入能力卡）', async () => {
    const { listEnabledCliWorkerCards } = await load()
    writeCfg({
      version: 1,
      enabled: true,
      defaultBackend: 'cli',
      defaultCliId: 'kscc',
      workers: [
        { id: 'kscc', enabled: true, bin: mkBin('kscc-card.cmd'), capability: { cost: 3, reasoning: 'high', goodFor: '编排' } },
        { id: 'custom-cli', enabled: true, bin: mkBin('custom-cli-card.exe'), capability: { cost: 2, reasoning: 'medium', goodFor: '通用编码' } },
      ],
    })
    const card = listEnabledCliWorkerCards()
    expect(card).toContain('kscc — cost 3')
    expect(card).not.toContain('custom-cli') // unsupported 不入卡（不向主 Agent 推荐）
  })
})
