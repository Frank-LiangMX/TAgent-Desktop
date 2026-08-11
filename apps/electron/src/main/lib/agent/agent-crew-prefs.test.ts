/**
 * agent-crew-prefs 单测：读写校验 + 非法值拒绝 + 坏文件自愈
 *
 * 验收对齐 brief：最小单测「读写校验 / 非法值拒绝」。
 * - 读：无文件 → 默认且不写盘；合法文件原样（剥离未知字段）；损坏 → 默认。
 * - 写：合法 → 落盘 + 回读一致；非法 → 抛中文错且不脏写盘。
 * - 纯函数 validate：边界值 1/8 与 0/9、布尔类型。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AGENT_CREW_PREFS_DEFAULT,
  isValidAgentCrewPrefs,
  validateAgentCrewPrefs,
} from '@tagent/shared'

// electron mock：config-paths.ts isAppPackaged 用
vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

let configDir: string

async function loadService() {
  vi.resetModules()
  return import('./agent-crew-prefs')
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'tagent-crew-prefs-'))
  process.env.TAGENT_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(configDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const PREFS_PATH = () => join(configDir, 'agent-crew-prefs.json')

describe('readAgentCrewPrefs', () => {
  it('无文件 → 返回默认且不写盘', async () => {
    const { readAgentCrewPrefs } = await loadService()
    const prefs = readAgentCrewPrefs()
    expect(prefs).toEqual(AGENT_CREW_PREFS_DEFAULT)
    expect(existsSync(PREFS_PATH())).toBe(false)
  })

  it('合法文件 → 原样返回（剥离未知字段）', async () => {
    writeFileSync(
      PREFS_PATH(),
      JSON.stringify({
        autoOpenPanelOnDispatch: false,
        maxParallelWorkers: 5,
        showFlowAsGraph: true,
        unknownExtra: 'drop-me',
      }),
      'utf8',
    )
    const { readAgentCrewPrefs } = await loadService()
    const prefs = readAgentCrewPrefs()
    expect(prefs).toEqual({
      autoOpenPanelOnDispatch: false,
      maxParallelWorkers: 5,
      showFlowAsGraph: true,
    })
    expect((prefs as unknown as Record<string, unknown>).unknownExtra).toBeUndefined()
  })

  it('损坏文件 → 返回默认（不覆盖坏文件）', async () => {
    const { readAgentCrewPrefs } = await loadService()
    writeFileSync(PREFS_PATH(), 'not-json{}garbage', 'utf8')
    const prefs = readAgentCrewPrefs()
    expect(prefs).toEqual(AGENT_CREW_PREFS_DEFAULT)
  })

  it('结构非法文件（字段越界）→ 返回默认', async () => {
    const { readAgentCrewPrefs } = await loadService()
    writeFileSync(
      PREFS_PATH(),
      JSON.stringify({ autoOpenPanelOnDispatch: true, maxParallelWorkers: 99, showFlowAsGraph: false }),
      'utf8',
    )
    const prefs = readAgentCrewPrefs()
    expect(prefs).toEqual(AGENT_CREW_PREFS_DEFAULT)
  })
})

describe('writeAgentCrewPrefs', () => {
  it('合法 → 落盘 + 回读一致', async () => {
    const { writeAgentCrewPrefs, readAgentCrewPrefs } = await loadService()
    const written = writeAgentCrewPrefs({
      autoOpenPanelOnDispatch: false,
      maxParallelWorkers: 8,
      showFlowAsGraph: true,
    })
    expect(written).toEqual({
      autoOpenPanelOnDispatch: false,
      maxParallelWorkers: 8,
      showFlowAsGraph: true,
    })
    expect(readAgentCrewPrefs()).toEqual(written)
    const raw = JSON.parse(readFileSync(PREFS_PATH(), 'utf8'))
    expect(raw).toEqual(written)
  })

  it('非法并行上限（0 / 9）→ 抛中文错且不写盘', async () => {
    const { writeAgentCrewPrefs } = await loadService()
    expect(() =>
      writeAgentCrewPrefs({ autoOpenPanelOnDispatch: true, maxParallelWorkers: 0, showFlowAsGraph: false }),
    ).toThrow(/并行|worker|上限/)
    expect(() =>
      writeAgentCrewPrefs({ autoOpenPanelOnDispatch: true, maxParallelWorkers: 9, showFlowAsGraph: false }),
    ).toThrow(/并行|worker|上限/)
    expect(existsSync(PREFS_PATH())).toBe(false)
  })

  it('自动开面板开关非布尔 → 抛错且不写盘', async () => {
    const { writeAgentCrewPrefs } = await loadService()
    expect(() =>
      writeAgentCrewPrefs({
        autoOpenPanelOnDispatch: 'yes' as unknown as boolean,
        maxParallelWorkers: 3,
        showFlowAsGraph: false,
      }),
    ).toThrow(/布尔/)
    expect(existsSync(PREFS_PATH())).toBe(false)
  })

  it('依赖用图开关非布尔 → 抛错且不写盘', async () => {
    const { writeAgentCrewPrefs } = await loadService()
    expect(() =>
      writeAgentCrewPrefs({
        autoOpenPanelOnDispatch: true,
        maxParallelWorkers: 3,
        showFlowAsGraph: 1 as unknown as boolean,
      }),
    ).toThrow(/布尔/)
    expect(existsSync(PREFS_PATH())).toBe(false)
  })

  it('非对象入参 → 抛错', async () => {
    const { writeAgentCrewPrefs } = await loadService()
    expect(() => writeAgentCrewPrefs(null)).toThrow(/对象/)
    expect(() => writeAgentCrewPrefs(42)).toThrow(/对象/)
  })
})

describe('validateAgentCrewPrefs / isValidAgentCrewPrefs（纯函数边界）', () => {
  it('边界值合法：并行 1 与 8', () => {
    expect(validateAgentCrewPrefs({ autoOpenPanelOnDispatch: true, maxParallelWorkers: 1, showFlowAsGraph: false })).toBeNull()
    expect(validateAgentCrewPrefs({ autoOpenPanelOnDispatch: false, maxParallelWorkers: 8, showFlowAsGraph: true })).toBeNull()
  })

  it('越界非法：并行 0/9；非整数', () => {
    expect(validateAgentCrewPrefs({ autoOpenPanelOnDispatch: true, maxParallelWorkers: 0, showFlowAsGraph: false })).toMatch(/并行|worker|上限/)
    expect(validateAgentCrewPrefs({ autoOpenPanelOnDispatch: true, maxParallelWorkers: 9, showFlowAsGraph: false })).toMatch(/并行|worker|上限/)
    expect(validateAgentCrewPrefs({ autoOpenPanelOnDispatch: true, maxParallelWorkers: 3.5, showFlowAsGraph: false })).toMatch(/并行|worker|上限/)
  })

  it('布尔字段非法 / 缺字段', () => {
    expect(validateAgentCrewPrefs({ maxParallelWorkers: 3, showFlowAsGraph: false })).toMatch(/布尔|面板/)
    expect(validateAgentCrewPrefs({ autoOpenPanelOnDispatch: true, maxParallelWorkers: 3 })).toMatch(/布尔|图/)
  })

  it('isValid 断言与 validate 一致', () => {
    expect(isValidAgentCrewPrefs(AGENT_CREW_PREFS_DEFAULT)).toBe(true)
    expect(isValidAgentCrewPrefs({ autoOpenPanelOnDispatch: true, maxParallelWorkers: 99, showFlowAsGraph: false })).toBe(false)
    expect(isValidAgentCrewPrefs(undefined)).toBe(false)
  })
})
