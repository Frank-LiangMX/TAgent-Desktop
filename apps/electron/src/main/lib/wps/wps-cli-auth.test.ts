import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, rm } from 'node:fs/promises'

const { existsSyncMock, getPathMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>(),
  getPathMock: vi.fn<(name: string) => string>(),
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

import { ensureWpsCli, wpsCliPath } from './wps-cli-auth'

describe('WPS CLI discovery', () => {
  let root: string

  beforeEach(async () => {
    root = join(tmpdir(), `tagent-wps-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(root, { recursive: true })
    getPathMock.mockImplementation(name => name === 'userData' ? root : join(root, 'appData'))
    existsSyncMock.mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  })

  it('reuses the CLI installed by the previous electron-dev app', async () => {
    const legacy = join(root, 'appData', '@tagent', 'electron-dev', 'wps-cli', 'wps365-cli.exe')
    existsSyncMock.mockImplementation(path => path === legacy)

    await expect(ensureWpsCli()).resolves.toBe(legacy)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns a readable error when downloading the missing CLI fails', async () => {
    existsSyncMock.mockReturnValue(false)
    vi.mocked(fetch).mockRejectedValue(new Error('fetch failed'))

    await expect(ensureWpsCli()).rejects.toThrow('本机未找到 WPS 登录组件，且下载失败。请检查网络后重试。')
    expect(wpsCliPath()).toContain(join(root, 'wps-cli'))
  })
})
