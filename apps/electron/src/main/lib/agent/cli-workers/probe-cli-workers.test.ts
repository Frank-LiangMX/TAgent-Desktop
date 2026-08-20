/**
 * probe-cli-workers 单测：mock resolve / version，不真扫 PATH。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveBinOnPath: vi.fn(),
  resolveKsccPath: vi.fn(),
  listCliWorkersConfig: vi.fn(),
  existsSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('./resolve-bin-on-path', () => ({
  resolveBinOnPath: mocks.resolveBinOnPath,
}))

vi.mock('../cli-workers-service', () => ({
  listCliWorkersConfig: mocks.listCliWorkersConfig,
}))

vi.mock('../../adapters/claude/kscc-path', () => ({
  resolveKsccPath: mocks.resolveKsccPath,
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: mocks.existsSync }
})

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execFileSync: mocks.execFileSync }
})

import { probeCliWorkers, resolveWorkerBin } from './probe-cli-workers'
import type { CliWorkersConfig } from '@tagent/shared'

const cfg: CliWorkersConfig = {
  version: 1,
  enabled: true,
  defaultBackend: 'cli',
  defaultCliId: 'kscc',
  workers: [
    { id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' },
    { id: 'grok', enabled: true, bin: 'grok' },
  ],
}

beforeEach(() => {
  mocks.resolveBinOnPath.mockReset()
  mocks.resolveKsccPath.mockReset()
  mocks.listCliWorkersConfig.mockReset()
  mocks.existsSync.mockReset()
  mocks.execFileSync.mockReset()
  mocks.listCliWorkersConfig.mockReturnValue(cfg)
})

describe('resolveWorkerBin', () => {
  it('Windows bare 名走 resolveBinOnPath', () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mocks.resolveBinOnPath.mockReturnValue('C:\\npm\\kscc.cmd')
    expect(resolveWorkerBin('kscc')).toBe('C:\\npm\\kscc.cmd')
    Object.defineProperty(process, 'platform', { value: prev })
  })

  it('macOS kscc 使用 GUI 进程可用的专用路径解析器', () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    mocks.resolveKsccPath.mockReturnValue('/opt/homebrew/bin/kscc')
    expect(resolveWorkerBin('kscc')).toBe('/opt/homebrew/bin/kscc')
    expect(mocks.resolveKsccPath).toHaveBeenCalledTimes(1)
    Object.defineProperty(process, 'platform', { value: prev })
  })
})

describe('probeCliWorkers', () => {
  it('available + version 摘要', () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mocks.resolveBinOnPath.mockImplementation((b: string) =>
      b === 'kscc' ? 'C:\\kscc.exe' : null,
    )
    mocks.execFileSync.mockReturnValue('kscc 1.1.28\n')
    const r = probeCliWorkers(cfg)
    expect(r.workers).toHaveLength(2)
    const k = r.workers.find((w) => w.id === 'kscc')
    const g = r.workers.find((w) => w.id === 'grok')
    expect(k?.available).toBe(true)
    expect(k?.resolvedPath).toBe('C:\\kscc.exe')
    expect(k?.version).toContain('1.1.28')
    expect(g?.available).toBe(false)
    expect(g?.error).toMatch(/未找到/)
    Object.defineProperty(process, 'platform', { value: prev })
  })

  it('无 cfg 时读 listCliWorkersConfig', () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mocks.resolveBinOnPath.mockReturnValue(null)
    const r = probeCliWorkers()
    expect(mocks.listCliWorkersConfig).toHaveBeenCalled()
    expect(r.workers.every((w) => !w.available)).toBe(true)
    Object.defineProperty(process, 'platform', { value: prev })
  })
})
