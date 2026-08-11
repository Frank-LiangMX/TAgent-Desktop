/**
 * agent-discuss-prefs 单测：读写校验 + 非法值拒绝 + 坏文件自愈
 *
 * 验收对齐 brief：最小单测「读写校验 / 非法值拒绝」。
 * - 读：无文件 → 默认且不写盘；合法文件原样（剥离未知字段）；损坏 → 默认。
 * - 写：合法 → 落盘 + 回读一致；非法 → 抛中文错且不脏写盘。
 * - 纯函数 validate：边界值 1/6 与 0/7、1/10 与 0/11、布尔类型。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AGENT_DISCUSS_PREFS_DEFAULT,
  isValidAgentDiscussPrefs,
  validateAgentDiscussPrefs,
} from '@tagent/shared'

// electron mock：config-paths.ts isAppPackaged 用
vi.mock('electron', () => ({
  app: { isPackaged: false },
}))

let configDir: string

async function loadService() {
  vi.resetModules()
  return import('./agent-discuss-prefs')
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'tagent-discuss-prefs-'))
  process.env.TAGENT_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(configDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const PREFS_PATH = () => join(configDir, 'agent-discuss-prefs.json')

describe('readAgentDiscussPrefs', () => {
  it('无文件 → 返回默认且不写盘', async () => {
    const { readAgentDiscussPrefs } = await loadService()
    const prefs = readAgentDiscussPrefs()
    expect(prefs).toEqual(AGENT_DISCUSS_PREFS_DEFAULT)
    expect(existsSync(PREFS_PATH())).toBe(false)
  })

  it('合法文件 → 原样返回（剥离未知字段）', async () => {
    const { writeAgentDiscussPrefs } = await loadService()
    writeAgentDiscussPrefs({
      defaultRoundLimit: 5,
      maxAgentMentionDepth: 8,
      routeComposerWhileDiscussing: true,
    })
    const { readAgentDiscussPrefs } = await loadService()
    // 写入一个含未知字段的合法文件，读回应剥离未知字段
    writeFileSync(
      PREFS_PATH(),
      JSON.stringify({
        defaultRoundLimit: 2,
        maxAgentMentionDepth: 3,
        routeComposerWhileDiscussing: false,
        unknownExtra: 'drop-me',
      }),
      'utf8',
    )
    const prefs = readAgentDiscussPrefs()
    expect(prefs).toEqual({
      defaultRoundLimit: 2,
      maxAgentMentionDepth: 3,
      routeComposerWhileDiscussing: false,
    })
    expect((prefs as unknown as Record<string, unknown>).unknownExtra).toBeUndefined()
  })

  it('损坏文件 → 返回默认（不覆盖坏文件）', async () => {
    const { readAgentDiscussPrefs } = await loadService()
    writeFileSync(PREFS_PATH(), 'not-json{}garbage', 'utf8')
    const prefs = readAgentDiscussPrefs()
    expect(prefs).toEqual(AGENT_DISCUSS_PREFS_DEFAULT)
  })

  it('结构非法文件（字段越界）→ 返回默认', async () => {
    const { readAgentDiscussPrefs } = await loadService()
    writeFileSync(
      PREFS_PATH(),
      JSON.stringify({ defaultRoundLimit: 99, maxAgentMentionDepth: 4, routeComposerWhileDiscussing: false }),
      'utf8',
    )
    const prefs = readAgentDiscussPrefs()
    expect(prefs).toEqual(AGENT_DISCUSS_PREFS_DEFAULT)
  })
})

describe('writeAgentDiscussPrefs', () => {
  it('合法 → 落盘 + 回读一致', async () => {
    const { writeAgentDiscussPrefs, readAgentDiscussPrefs } = await loadService()
    const written = writeAgentDiscussPrefs({
      defaultRoundLimit: 6,
      maxAgentMentionDepth: 10,
      routeComposerWhileDiscussing: true,
    })
    expect(written).toEqual({
      defaultRoundLimit: 6,
      maxAgentMentionDepth: 10,
      routeComposerWhileDiscussing: true,
    })
    expect(readAgentDiscussPrefs()).toEqual(written)
    const raw = JSON.parse(readFileSync(PREFS_PATH(), 'utf8'))
    expect(raw).toEqual(written)
  })

  it('非法轮数（0）→ 抛中文错且不写盘', async () => {
    const { writeAgentDiscussPrefs } = await loadService()
    expect(() =>
      writeAgentDiscussPrefs({
        defaultRoundLimit: 0,
        maxAgentMentionDepth: 4,
        routeComposerWhileDiscussing: false,
      }),
    ).toThrow(/轮数/)
    expect(existsSync(PREFS_PATH())).toBe(false)
  })

  it('非法轮数（7）→ 抛错且不写盘', async () => {
    const { writeAgentDiscussPrefs } = await loadService()
    expect(() =>
      writeAgentDiscussPrefs({
        defaultRoundLimit: 7,
        maxAgentMentionDepth: 4,
        routeComposerWhileDiscussing: false,
      }),
    ).toThrow(/轮数/)
    expect(existsSync(PREFS_PATH())).toBe(false)
  })

  it('非法 @ 深度（0 / 11）→ 抛错且不写盘', async () => {
    const { writeAgentDiscussPrefs } = await loadService()
    expect(() =>
      writeAgentDiscussPrefs({
        defaultRoundLimit: 3,
        maxAgentMentionDepth: 0,
        routeComposerWhileDiscussing: false,
      }),
    ).toThrow(/深度/)
    expect(() =>
      writeAgentDiscussPrefs({
        defaultRoundLimit: 3,
        maxAgentMentionDepth: 11,
        routeComposerWhileDiscussing: false,
      }),
    ).toThrow(/深度/)
    expect(existsSync(PREFS_PATH())).toBe(false)
  })

  it('路由开关非布尔 → 抛错且不写盘', async () => {
    const { writeAgentDiscussPrefs } = await loadService()
    expect(() =>
      writeAgentDiscussPrefs({
        defaultRoundLimit: 3,
        maxAgentMentionDepth: 4,
        routeComposerWhileDiscussing: 'yes' as unknown as boolean,
      }),
    ).toThrow(/布尔/)
    expect(existsSync(PREFS_PATH())).toBe(false)
  })

  it('非对象入参 → 抛错', async () => {
    const { writeAgentDiscussPrefs } = await loadService()
    expect(() => writeAgentDiscussPrefs(null)).toThrow(/对象/)
    expect(() => writeAgentDiscussPrefs('oops')).toThrow(/对象/)
  })
})

describe('validateAgentDiscussPrefs / isValidAgentDiscussPrefs（纯函数边界）', () => {
  it('边界值合法：轮数 1 与 6、深度 1 与 10', () => {
    expect(validateAgentDiscussPrefs({ defaultRoundLimit: 1, maxAgentMentionDepth: 1, routeComposerWhileDiscussing: false })).toBeNull()
    expect(validateAgentDiscussPrefs({ defaultRoundLimit: 6, maxAgentMentionDepth: 10, routeComposerWhileDiscussing: true })).toBeNull()
  })

  it('越界非法：轮数 0/7、深度 0/11', () => {
    expect(validateAgentDiscussPrefs({ defaultRoundLimit: 0, maxAgentMentionDepth: 4, routeComposerWhileDiscussing: false })).toMatch(/轮数/)
    expect(validateAgentDiscussPrefs({ defaultRoundLimit: 7, maxAgentMentionDepth: 4, routeComposerWhileDiscussing: false })).toMatch(/轮数/)
    expect(validateAgentDiscussPrefs({ defaultRoundLimit: 3, maxAgentMentionDepth: 0, routeComposerWhileDiscussing: false })).toMatch(/深度/)
    expect(validateAgentDiscussPrefs({ defaultRoundLimit: 3, maxAgentMentionDepth: 11, routeComposerWhileDiscussing: false })).toMatch(/深度/)
  })

  it('非整数非法（浮点 / NaN / 缺字段）', () => {
    expect(validateAgentDiscussPrefs({ defaultRoundLimit: 3.5, maxAgentMentionDepth: 4, routeComposerWhileDiscussing: false })).toMatch(/轮数/)
    expect(validateAgentDiscussPrefs({ defaultRoundLimit: 3, maxAgentMentionDepth: 4 })).toMatch(/布尔/)
    expect(validateAgentDiscussPrefs({ maxAgentMentionDepth: 4, routeComposerWhileDiscussing: false })).toMatch(/轮数/)
  })

  it('isValid 断言与 validate 一致', () => {
    expect(isValidAgentDiscussPrefs(AGENT_DISCUSS_PREFS_DEFAULT)).toBe(true)
    expect(isValidAgentDiscussPrefs({ defaultRoundLimit: 99, maxAgentMentionDepth: 4, routeComposerWhileDiscussing: false })).toBe(false)
    expect(isValidAgentDiscussPrefs(null)).toBe(false)
  })
})
