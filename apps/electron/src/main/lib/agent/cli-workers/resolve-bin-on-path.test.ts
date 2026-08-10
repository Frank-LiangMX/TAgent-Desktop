/**
 * resolveBinOnPath 单测：Windows bare 名 → 绝对路径解析（.cmd 优先 / .exe 次 / 兜底 null）。
 *
 * mock execSync（where.exe 输出）与 existsSync，断言优先级与失败兜底。
 * 不真起 where.exe（跨平台确定性；Linux CI 上 where.exe 不存在）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('where 仅给无扩展 shim（无 .cmd/.exe）→ 返回 null（Node 无法直接 spawn）', () => {
    mocks.execSync.mockReturnValue('C:\\npm\\kscc\n')
    expect(resolveBinOnPath('kscc')).toBeNull()
  })

  it('where.exe 抛错（未安装 / 超时）→ 返回 null', () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(resolveBinOnPath('kscc')).toBeNull()
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
