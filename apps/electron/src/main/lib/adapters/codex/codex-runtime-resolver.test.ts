import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveCliBin: vi.fn(),
}))

vi.mock('../../agent/cli-workers/run-ndjson-cli', () => ({
  resolveCliBin: mocks.resolveCliBin,
}))

vi.mock('../../agent/cli-workers/probe-cli-workers', () => ({
  resolveWorkerBin: vi.fn(),
}))

import { probeCodexRuntime, resolveCodexRuntime } from './codex-runtime-resolver'

beforeEach(() => {
  mocks.resolveCliBin.mockReset()
  mocks.resolveCliBin.mockImplementation((path: string) => ({
    command: path,
    cmdPrefix: [],
    directSpawn: true,
    via: 'win-exe',
  }))
})

function successProbe() {
  return { ok: true, version: '0.151.0', versionText: 'codex-cli 0.151.0' }
}

describe('probeCodexRuntime', () => {
  it('同时验证版本和 app-server 能力', () => {
    const spawnRunner = vi
      .fn()
      .mockReturnValueOnce({
        pid: 1,
        output: [],
        stdout: 'codex-cli 0.151.0\n',
        stderr: '',
        status: 0,
        signal: null,
        error: undefined,
      })
      .mockReturnValueOnce({
        pid: 2,
        output: [],
        stdout: 'Run the app server\nUsage: codex app-server --listen <URL>\n',
        stderr: '',
        status: 0,
        signal: null,
        error: undefined,
      })
      .mockReturnValueOnce({
        pid: 3,
        output: [],
        stdout: [
          'default_mode_request_user_input under development false',
          'exec_permission_approvals under development false',
          'request_permissions_tool under development false',
        ].join('\n'),
        stderr: '',
        status: 0,
        signal: null,
        error: undefined,
      })

    expect(probeCodexRuntime('C:\\codex.exe', spawnRunner)).toEqual({
      ok: true,
      version: '0.151.0',
      versionText: 'codex-cli 0.151.0',
    })
    expect(spawnRunner).toHaveBeenNthCalledWith(
      3,
      'C:\\codex.exe',
      ['features', 'list'],
      expect.objectContaining({ timeout: 8_000 }),
    )
  })

  it('同名旧命令没有 app-server 时拒绝', () => {
    const spawnRunner = vi
      .fn()
      .mockReturnValueOnce({
        pid: 1,
        output: [],
        stdout: 'codex-cli 0.20.0\n',
        stderr: '',
        status: 0,
        signal: null,
        error: undefined,
      })
      .mockReturnValueOnce({
        pid: 2,
        output: [],
        stdout: '',
        stderr: 'unknown subcommand app-server',
        status: 2,
        signal: null,
        error: undefined,
      })

    const result = probeCodexRuntime('C:\\old-codex.exe', spawnRunner)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不支持 App Server')
  })

  it('App Server 存在但缺少主会话必需特性时拒绝', () => {
    const spawnRunner = vi
      .fn()
      .mockReturnValueOnce({
        pid: 1,
        output: [],
        stdout: 'codex-cli 0.140.0\n',
        stderr: '',
        status: 0,
        signal: null,
        error: undefined,
      })
      .mockReturnValueOnce({
        pid: 2,
        output: [],
        stdout: 'Run the app server\nUsage: codex app-server --listen <URL>\n',
        stderr: '',
        status: 0,
        signal: null,
        error: undefined,
      })
      .mockReturnValueOnce({
        pid: 3,
        output: [],
        stdout: 'default_mode_request_user_input under development false\n',
        stderr: '',
        status: 0,
        signal: null,
        error: undefined,
      })

    const result = probeCodexRuntime('C:\\partial-codex.exe', spawnRunner)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('exec_permission_approvals')
    expect(result.reason).toContain('request_permissions_tool')
  })
})

describe('resolveCodexRuntime', () => {
  it('用户显式路径优先于系统和托管 Runtime', () => {
    const probe = vi.fn(successProbe)
    const result = resolveCodexRuntime({
      explicitPath: 'C:\\custom\\codex.exe',
      env: {},
      platform: 'win32',
      arch: 'x64',
      managedRuntimeDir: 'C:\\tagent\\runtimes\\codex',
      managedManifestPath: 'C:\\tagent\\runtimes\\codex\\active.json',
      fileExists: (path) => path === 'C:\\custom\\codex.exe',
      readTextFile: () => '',
      resolveSystemBin: () => 'C:\\system\\codex.cmd',
      probe,
    })

    expect(result).toMatchObject({
      available: true,
      source: 'explicit',
      executablePath: 'C:\\custom\\codex.exe',
      version: '0.151.0',
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('系统 Codex 无 App Server 时回退到托管 Runtime', () => {
    const runtimeRoot = 'C:\\tagent\\runtimes\\codex'
    const manifestPath = `${runtimeRoot}\\active.json`
    const managedExe = `${runtimeRoot}\\0.151.0\\win32-x64\\codex.exe`
    const probe = vi.fn((path: string) =>
      path.includes('system')
        ? { ok: false, reason: '当前 Codex 不支持 App Server' }
        : successProbe(),
    )

    const result = resolveCodexRuntime({
      env: {},
      platform: 'win32',
      arch: 'x64',
      managedRuntimeDir: runtimeRoot,
      managedManifestPath: manifestPath,
      fileExists: (path) => path === manifestPath || path === managedExe,
      readTextFile: () =>
        JSON.stringify({
          version: '0.151.0',
          platform: 'win32',
          arch: 'x64',
          relativeExecutablePath: '0.151.0\\win32-x64\\codex.exe',
          source: 'official',
        }),
      resolveSystemBin: () => 'C:\\system\\codex.cmd',
      probe,
    })

    expect(result).toMatchObject({
      available: true,
      source: 'managed',
      executablePath: managedExe,
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'system',
          reason: expect.stringContaining('不支持 App Server'),
        }),
      ]),
    )
  })

  it('拒绝托管清单越出 runtimes/codex', () => {
    const runtimeRoot = 'C:\\tagent\\runtimes\\codex'
    const manifestPath = `${runtimeRoot}\\active.json`
    const result = resolveCodexRuntime({
      env: {},
      platform: 'win32',
      arch: 'x64',
      managedRuntimeDir: runtimeRoot,
      managedManifestPath: manifestPath,
      fileExists: (path) => path === manifestPath || path.endsWith('evil.exe'),
      readTextFile: () =>
        JSON.stringify({
          version: '0.151.0',
          platform: 'win32',
          arch: 'x64',
          relativeExecutablePath: '..\\..\\evil.exe',
          source: 'official',
        }),
      resolveSystemBin: () => null,
      probe: vi.fn(successProbe),
    })

    expect(result.available).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'managed',
          reason: expect.stringContaining('越出受管目录'),
        }),
      ]),
    )
  })

  it('无任何 Runtime 时返回可解释诊断', () => {
    const result = resolveCodexRuntime({
      env: {},
      platform: 'win32',
      arch: 'x64',
      managedRuntimeDir: 'C:\\tagent\\runtimes\\codex',
      managedManifestPath: 'C:\\tagent\\runtimes\\codex\\active.json',
      fileExists: () => false,
      readTextFile: () => '',
      resolveSystemBin: () => null,
      probe: vi.fn(successProbe),
    })

    expect(result.available).toBe(false)
    expect(result.diagnostics.map((item) => item.reason)).toEqual(
      expect.arrayContaining([
        '系统 PATH 中未找到 codex',
        '尚未安装 TAgent 托管 Codex Runtime',
      ]),
    )
  })
})
