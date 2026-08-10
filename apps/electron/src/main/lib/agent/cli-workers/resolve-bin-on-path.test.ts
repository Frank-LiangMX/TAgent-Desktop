/**
 * resolveBinOnPath 单测：Windows bare 名 → 绝对路径解析（.cmd 优先 / .exe 次 / 兜底 null）。
 *
 * mock execSync（where.exe 输出）与 existsSync，断言优先级与失败兜底。
 * 不真起 where.exe（跨平台确定性；Linux CI 上 where.exe 不存在）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  existsSync: vi.fn(),
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execSync: mocks.execSync }
})

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: mocks.existsSync }
})

import { resolveBinOnPath } from './resolve-bin-on-path'

beforeEach(() => {
  mocks.execSync.mockReset()
  mocks.existsSync.mockReset()
  // 默认所有路径「存在」，单测按需覆盖
  mocks.existsSync.mockReturnValue(true)
})

describe('resolveBinOnPath · bare 名解析优先级', () => {
  it('where 同时给无扩展 shim 与 .cmd → 优先返回 .cmd', () => {
    mocks.execSync.mockReturnValue('C:\\npm\\kscc\nC:\\npm\\kscc.cmd\n')
    expect(resolveBinOnPath('kscc')).toBe('C:\\npm\\kscc.cmd')
  })

  it('where 仅给 .exe → 返回 .exe（可被 Node 直接 spawn）', () => {
    mocks.execSync.mockReturnValue('C:\\bin\\kscc.exe\n')
    expect(resolveBinOnPath('kscc')).toBe('C:\\bin\\kscc.exe')
  })

  it('where 仅给无扩展 shim 且 WindowsApps 无别名 → 返回 null（Node 无法直接 spawn）', () => {
    mocks.execSync.mockReturnValue('C:\\npm\\kscc\n')
    // 无 .cmd/.exe 命中，且 WindowsApps 别名不存在 → null
    mocks.existsSync.mockReturnValue(false)
    expect(resolveBinOnPath('kscc')).toBeNull()
  })

  it('where.exe 抛错且 WindowsApps 无别名 → 返回 null', () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    mocks.existsSync.mockReturnValue(false)
    expect(resolveBinOnPath('kscc')).toBeNull()
  })
})

describe('resolveBinOnPath · WindowsApps 执行别名兜底', () => {
  it('where 无 .cmd/.exe + WindowsApps 别名存在 → 返回别名 .exe', () => {
    vi.stubEnv('LOCALAPPDATA', '/fake/LOCALAPPDATA')
    mocks.execSync.mockReturnValue('C:\\npm\\kscc\n') // 仅无扩展 shim
    mocks.existsSync.mockReturnValue(true)
    const expected = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'kscc.exe')
    expect(resolveBinOnPath('kscc')).toBe(expected)
  })

  it('where.exe 抛错 + WindowsApps 别名存在 → 返回别名 .exe（Store 安装的 codex 走这里）', () => {
    vi.stubEnv('LOCALAPPDATA', '/fake/LOCALAPPDATA')
    mocks.execSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    mocks.existsSync.mockReturnValue(true)
    const expected = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'codex.exe')
    expect(resolveBinOnPath('codex')).toBe(expected)
  })

  it('LOCALAPPDATA 未设 → 跳过 WindowsApps 兜底，返回 null', () => {
    const saved = process.env.LOCALAPPDATA
    delete process.env.LOCALAPPDATA
    try {
      mocks.execSync.mockImplementation(() => {
        throw new Error('ENOENT')
      })
      // 即使 existsSync true，无 LOCALAPPDATA 也跳过兜底
      mocks.existsSync.mockReturnValue(true)
      expect(resolveBinOnPath('kscc')).toBeNull()
    } finally {
      if (saved === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = saved
    }
  })

  it('where 有 .cmd → 仍优先 .cmd（WindowsApps 不抢占）', () => {
    vi.stubEnv('LOCALAPPDATA', '/fake/LOCALAPPDATA')
    mocks.execSync.mockReturnValue('C:\\npm\\kscc.cmd\n')
    mocks.existsSync.mockReturnValue(true)
    expect(resolveBinOnPath('kscc')).toBe('C:\\npm\\kscc.cmd')
  })
})

describe('resolveBinOnPath · 路径输入与边界', () => {
  it('已是绝对路径且存在 → 直接返回，不调 where', () => {
    mocks.existsSync.mockReturnValue(true)
    expect(resolveBinOnPath('C:\\abs\\kscc.cmd')).toBe('C:\\abs\\kscc.cmd')
    expect(mocks.execSync).not.toHaveBeenCalled()
  })

  it('已是绝对路径但不存在 → 返回 null', () => {
    mocks.existsSync.mockImplementation((p: unknown) => String(p) === 'C:\\abs\\missing.cmd')
    expect(resolveBinOnPath('C:\\abs\\missing.cmd')).toBe('C:\\abs\\missing.cmd')
    mocks.existsSync.mockReturnValue(false)
    expect(resolveBinOnPath('C:\\abs\\missing.cmd')).toBeNull()
  })

  it('空串 → null', () => {
    expect(resolveBinOnPath('')).toBeNull()
    expect(mocks.execSync).not.toHaveBeenCalled()
  })
})
