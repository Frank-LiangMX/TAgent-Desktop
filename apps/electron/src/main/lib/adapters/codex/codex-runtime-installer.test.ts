import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  getManagedCodexRuntimeRelease,
  installManagedCodexRuntime,
  type CodexRuntimeFetch,
  type ManagedCodexRuntimeRelease,
} from './codex-runtime-installer'
import { resolveCodexRuntime } from './codex-runtime-resolver'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeTempRoot(): string {
  const root = join(tmpdir(), `tagent-codex-installer-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  tempRoots.push(root)
  return root
}

function makeRelease(archive: Buffer): ManagedCodexRuntimeRelease {
  return {
    version: 'test-1.0.0',
    platform: 'win32',
    arch: 'x64',
    url: 'https://example.invalid/codex.tgz',
    sha256: createHash('sha256').update(archive).digest('hex'),
    relativeExecutablePath: 'vendor/test/bin/codex.exe',
    downloadBytes: archive.byteLength,
  }
}

describe('managed Codex runtime installer', () => {
  test('固定清单只开放已验收的 Windows x64 官方平台包', () => {
    expect(getManagedCodexRuntimeRelease('win32', 'x64')).toMatchObject({
      version: '0.151.0',
      platform: 'win32',
      arch: 'x64',
      sha256:
        '9044e64402bf6a92774fe35a8cb86010d254c0d3390d5a7ee9047024588d7355',
    })
    expect(getManagedCodexRuntimeRelease('linux', 'x64')).toBeUndefined()
  })

  test('下载校验、解压探针和 active manifest 形成完整安装闭环', async () => {
    const root = makeTempRoot()
    const runtimeDir = join(root, 'runtimes', 'codex')
    const manifestPath = join(runtimeDir, 'active.json')
    const archive = Buffer.from('fake-codex-platform-package')
    const release = makeRelease(archive)
    const fetchImpl = vi.fn(async () => {
      return new Response(archive, {
        status: 200,
        headers: { 'content-length': String(archive.byteLength) },
      })
    })
    const extractArchive = vi.fn(
      async (_archivePath: string, destination: string) => {
        const executablePath = join(
          destination,
          release.relativeExecutablePath,
        )
        mkdirSync(dirname(executablePath), { recursive: true })
        writeFileSync(executablePath, 'fake executable')
      },
    )
    const probe = vi.fn(() => ({
      ok: true,
      version: release.version,
      versionText: `codex-cli ${release.version}`,
    }))
    const phases: string[] = []

    const result = await installManagedCodexRuntime({
      platform: 'win32',
      arch: 'x64',
      runtimeDir,
      manifestPath,
      release,
      fetchImpl: fetchImpl as CodexRuntimeFetch,
      extractArchive,
      probe,
      onProgress: (progress) => phases.push(progress.phase),
    })

    expect(result.reusedExistingInstall).toBe(false)
    expect(existsSync(result.executablePath)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(extractArchive).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(phases).toEqual([
      'downloading',
      'verifying',
      'extracting',
      'probing',
      'activating',
    ])

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version: string
      relativeExecutablePath: string
      sha256: string
      source: string
    }
    expect(manifest).toMatchObject({
      version: release.version,
      sha256: release.sha256,
      source: 'official',
    })

    const resolution = resolveCodexRuntime({
      platform: 'win32',
      arch: 'x64',
      managedRuntimeDir: runtimeDir,
      managedManifestPath: manifestPath,
      resolveSystemBin: () => null,
      probe: () => ({
        ok: true,
        version: release.version,
        versionText: `codex-cli ${release.version}`,
      }),
    })
    expect(resolution).toMatchObject({
      available: true,
      source: 'managed',
      version: release.version,
    })
  })

  test('重复安装复用已通过探针的目录，不再次下载', async () => {
    const root = makeTempRoot()
    const runtimeDir = join(root, 'runtimes', 'codex')
    const manifestPath = join(runtimeDir, 'active.json')
    const archive = Buffer.from('fake-codex-platform-package')
    const release = makeRelease(archive)
    const executablePath = join(
      runtimeDir,
      release.version,
      `${release.platform}-${release.arch}`,
      release.relativeExecutablePath,
    )
    mkdirSync(dirname(executablePath), { recursive: true })
    writeFileSync(executablePath, 'existing runtime')
    const fetchImpl = vi.fn(async () => {
      throw new Error('不应下载')
    })

    const result = await installManagedCodexRuntime({
      platform: 'win32',
      arch: 'x64',
      runtimeDir,
      manifestPath,
      release,
      fetchImpl: fetchImpl as CodexRuntimeFetch,
      probe: () => ({
        ok: true,
        version: release.version,
        versionText: `codex-cli ${release.version}`,
      }),
    })

    expect(result.reusedExistingInstall).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(existsSync(manifestPath)).toBe(true)
  })

  test('Windows 激活目录暂时被占用时退避重试，不丢失已验证的安装', async () => {
    const root = makeTempRoot()
    const runtimeDir = join(root, 'runtimes', 'codex')
    const manifestPath = join(runtimeDir, 'active.json')
    const archive = Buffer.from('fake-codex-platform-package')
    const release = makeRelease(archive)
    let activationAttempts = 0
    const retryDelay = vi.fn(async () => undefined)

    const result = await installManagedCodexRuntime({
      platform: 'win32',
      arch: 'x64',
      runtimeDir,
      manifestPath,
      release,
      fetchImpl: (async () =>
        new Response(archive, { status: 200 })) as CodexRuntimeFetch,
      extractArchive: async (_archivePath, destination) => {
        const executablePath = join(
          destination,
          release.relativeExecutablePath,
        )
        mkdirSync(dirname(executablePath), { recursive: true })
        writeFileSync(executablePath, 'fake executable')
      },
      probe: () => ({
        ok: true,
        version: release.version,
        versionText: `codex-cli ${release.version}`,
      }),
      renamePath: async (source, destination) => {
        if (source.endsWith('.staging')) {
          activationAttempts += 1
          if (activationAttempts < 3) {
            const error = new Error('temporarily locked') as NodeJS.ErrnoException
            error.code = 'EPERM'
            throw error
          }
        }
        renameSync(source, destination)
      },
      retryDelay,
    })

    expect(activationAttempts).toBe(3)
    expect(retryDelay).toHaveBeenCalledTimes(2)
    expect(existsSync(result.executablePath)).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)
  })

  test('哈希不匹配时拒绝安装且不写 active manifest', async () => {
    const root = makeTempRoot()
    const runtimeDir = join(root, 'runtimes', 'codex')
    const manifestPath = join(runtimeDir, 'active.json')
    const release = makeRelease(Buffer.from('expected archive'))
    const extractArchive = vi.fn()

    await expect(
      installManagedCodexRuntime({
        platform: 'win32',
        arch: 'x64',
        runtimeDir,
        manifestPath,
        release,
        fetchImpl: (async () =>
          new Response(Buffer.from('tampered archive'), {
            status: 200,
          })) as CodexRuntimeFetch,
        extractArchive,
        probe: () => ({ ok: true }),
      }),
    ).rejects.toThrow('完整性校验失败')

    expect(extractArchive).not.toHaveBeenCalled()
    expect(existsSync(manifestPath)).toBe(false)
  })
})
