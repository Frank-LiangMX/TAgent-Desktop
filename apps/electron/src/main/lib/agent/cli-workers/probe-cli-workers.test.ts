/**
 * probe-cli-workers 单测：mock resolve / version，不真扫 PATH。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveBinOnPath: vi.fn(),
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
  defaultCliId: 'grok',
  workers: [
    { id: 'grok', enabled: true, bin: 'grok' },
    { id: 'claude', enabled: true, bin: 'claude' },
  ],
}

beforeEach(() => {
  mocks.resolveBinOnPath.mockReset()
  mocks.listCliWorkersConfig.mockReset()
  mocks.existsSync.mockReset()
  mocks.execFileSync.mockReset()
  mocks.listCliWorkersConfig.mockReturnValue(cfg)
})

describe('resolveWorkerBin', () => {
  it('Windows bare 名走 resolveBinOnPath', () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mocks.resolveBinOnPath.mockReturnValue('C:\\npm\\grok.cmd')
    expect(resolveWorkerBin('grok')).toBe('C:\\npm\\grok.cmd')
    Object.defineProperty(process, 'platform', { value: prev })
  })

  it('非 Windows 走通用 unix 解析（command -v）', () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    mocks.execFileSync.mockReturnValue('/opt/homebrew/bin/grok\n')
    mocks.existsSync.mockReturnValue(true)
    expect(resolveWorkerBin('grok')).toBe('/opt/homebrew/bin/grok')
    Object.defineProperty(process, 'platform', { value: prev })
  })
})

describe('probeCliWorkers', () => {
  it('available + version 摘要', () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mocks.resolveBinOnPath.mockImplementation((b: string) =>
      b === 'grok' ? 'C:\\grok.exe' : null,
    )
    mocks.execFileSync.mockReturnValue('grok 1.1.28\n')
    const r = probeCliWorkers(cfg)
    expect(r.workers).toHaveLength(2)
    const g = r.workers.find((w) => w.id === 'grok')
    const c = r.workers.find((w) => w.id === 'claude')
    expect(g?.available).toBe(true)
    expect(g?.resolvedPath).toBe('C:\\grok.exe')
    expect(g?.version).toContain('1.1.28')
    expect(c?.available).toBe(false)
    expect(c?.error).toMatch(/未找到/)
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
