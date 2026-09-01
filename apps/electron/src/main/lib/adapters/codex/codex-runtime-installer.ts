/**
 * TAgent 托管 Codex Runtime 安装器。
 *
 * 标准 Windows x64 发行版按需下载 OpenAI 发布的固定 npm 平台包，校验
 * SHA-256 后解压到受管目录。安装完成前不改 active.json；任何失败都保留
 * 现有可用 Runtime，不读取或复制 Codex 认证文件。
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { x as extractTar } from 'tar'
import {
  getManagedCodexRuntimeDir,
  getManagedCodexRuntimeManifestPath,
} from '../../config/config-paths'
import { writeJsonAtomic } from '../../atomic-json'
import {
  probeCodexRuntime,
  type ManagedCodexRuntimeManifest,
} from './codex-runtime-resolver'

export const MANAGED_CODEX_RUNTIME_VERSION = '0.151.0'
export const MANAGED_CODEX_RUNTIME_DOWNLOAD_BYTES = 147_584_554
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

export interface ManagedCodexRuntimeRelease {
  version: string
  platform: NodeJS.Platform
  arch: string
  url: string
  sha256: string
  relativeExecutablePath: string
  downloadBytes: number
}

const MANAGED_CODEX_RELEASES: readonly ManagedCodexRuntimeRelease[] = [
  {
    version: MANAGED_CODEX_RUNTIME_VERSION,
    platform: 'win32',
    arch: 'x64',
    url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.151.0-win32-x64.tgz',
    sha256: '9044e64402bf6a92774fe35a8cb86010d254c0d3390d5a7ee9047024588d7355',
    relativeExecutablePath:
      'vendor/x86_64-pc-windows-msvc/bin/codex.exe',
    downloadBytes: MANAGED_CODEX_RUNTIME_DOWNLOAD_BYTES,
  },
]

export interface ManagedCodexInstallProgress {
  phase: 'downloading' | 'verifying' | 'extracting' | 'probing' | 'activating'
  receivedBytes?: number
  totalBytes?: number
}

export interface InstallManagedCodexRuntimeResult {
  executablePath: string
  manifest: ManagedCodexRuntimeManifest
  reusedExistingInstall: boolean
}

export type CodexRuntimeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

type RenamePath = (oldPath: string, newPath: string) => Promise<void>

export interface InstallManagedCodexRuntimeOptions {
  platform?: NodeJS.Platform
  arch?: string
  runtimeDir?: string
  manifestPath?: string
  release?: ManagedCodexRuntimeRelease
  fetchImpl?: CodexRuntimeFetch
  probe?: typeof probeCodexRuntime
  extractArchive?: (archivePath: string, destination: string) => Promise<void>
  renamePath?: RenamePath
  retryDelay?: (milliseconds: number) => Promise<void>
  onProgress?: (progress: ManagedCodexInstallProgress) => void
  signal?: AbortSignal
}

export function getManagedCodexRuntimeRelease(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ManagedCodexRuntimeRelease | undefined {
  return MANAGED_CODEX_RELEASES.find(
    (release) => release.platform === platform && release.arch === arch,
  )
}

function assertPathInside(root: string, target: string): void {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Codex Runtime 安装路径越出受管目录')
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function renameWithRetry(
  source: string,
  destination: string,
  platform: NodeJS.Platform,
  renamePath: RenamePath,
  retryDelay: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const retryableCodes = new Set(['EBUSY', 'EPERM', 'EACCES'])
  const maxAttempts = platform === 'win32' ? 8 : 1
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await renamePath(source, destination)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException)?.code
      if (
        attempt >= maxAttempts ||
        !code ||
        !retryableCodes.has(code)
      ) {
        throw error
      }
      await retryDelay(Math.min(100 * 2 ** (attempt - 1), 2_000))
    }
  }

  throw lastError
}

async function defaultExtractArchive(
  archivePath: string,
  destination: string,
): Promise<void> {
  await extractTar({
    file: archivePath,
    cwd: destination,
    strip: 1,
    strict: true,
    preservePaths: false,
  })
}

async function downloadRelease(
  release: ManagedCodexRuntimeRelease,
  archivePath: string,
  fetchImpl: CodexRuntimeFetch,
  signal: AbortSignal | undefined,
  onProgress: InstallManagedCodexRuntimeOptions['onProgress'],
): Promise<void> {
  const response = await fetchImpl(release.url, {
    method: 'GET',
    redirect: 'follow',
    signal,
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'TAgent-Desktop Codex Runtime Installer',
    },
  })
  if (!response.ok) {
    throw new Error(`Codex Runtime 下载失败：HTTP ${response.status}`)
  }
  if (!response.body) throw new Error('Codex Runtime 下载响应为空')

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error('Codex Runtime 下载包超过安全大小上限')
  }

  const file = await open(archivePath, 'wx')
  const sha256 = createHash('sha256')
  const reader = response.body.getReader()
  let receivedBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value || chunk.value.byteLength === 0) continue
      receivedBytes += chunk.value.byteLength
      if (receivedBytes > MAX_DOWNLOAD_BYTES) {
        throw new Error('Codex Runtime 下载包超过安全大小上限')
      }
      const buffer = Buffer.from(chunk.value)
      sha256.update(buffer)
      await file.write(buffer)
      onProgress?.({
        phase: 'downloading',
        receivedBytes,
        totalBytes: contentLength || release.downloadBytes,
      })
    }
  } finally {
    await file.close()
    reader.releaseLock()
  }

  onProgress?.({ phase: 'verifying', receivedBytes, totalBytes: receivedBytes })
  const actualSha256 = sha256.digest('hex')
  if (actualSha256 !== release.sha256.toLowerCase()) {
    throw new Error(
      `Codex Runtime 完整性校验失败：期望 ${release.sha256}，实际 ${actualSha256}`,
    )
  }
}

async function writeManifestAtomic(
  manifestPath: string,
  manifest: ManagedCodexRuntimeManifest,
): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true })
  writeJsonAtomic(manifestPath, manifest)
}

/**
 * 下载、验证、探测并激活固定版本 Codex Runtime。
 *
 * 重复调用会先复用已经通过能力探针的目标目录；损坏目录只有在新 staging
 * 完整通过探针后才被替换。
 */
export async function installManagedCodexRuntime(
  options: InstallManagedCodexRuntimeOptions = {},
): Promise<InstallManagedCodexRuntimeResult> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const release =
    options.release ?? getManagedCodexRuntimeRelease(platform, arch)
  if (!release || release.platform !== platform || release.arch !== arch) {
    throw new Error(`当前平台暂不支持托管 Codex Runtime：${platform}-${arch}`)
  }

  const runtimeDir = resolve(
    options.runtimeDir ?? getManagedCodexRuntimeDir(),
  )
  const manifestPath = resolve(
    options.manifestPath ?? getManagedCodexRuntimeManifestPath(),
  )
  const installDir = resolve(
    runtimeDir,
    release.version,
    `${release.platform}-${release.arch}`,
  )
  const executablePath = resolve(
    installDir,
    release.relativeExecutablePath,
  )
  assertPathInside(runtimeDir, installDir)
  assertPathInside(installDir, executablePath)

  const probe = options.probe ?? probeCodexRuntime
  const renamePath = options.renamePath ?? rename
  const retryDelay = options.retryDelay ?? delay
  if (await isFile(executablePath)) {
    options.onProgress?.({ phase: 'probing' })
    const existingProbe = probe(executablePath)
    if (existingProbe.ok) {
      const manifest: ManagedCodexRuntimeManifest = {
        version: release.version,
        platform: release.platform,
        arch: release.arch,
        relativeExecutablePath: relative(runtimeDir, executablePath),
        sha256: release.sha256,
        source: 'official',
      }
      await writeManifestAtomic(manifestPath, manifest)
      return { executablePath, manifest, reusedExistingInstall: true }
    }
  }

  await mkdir(runtimeDir, { recursive: true })
  const operationId = randomUUID()
  const archivePath = resolve(runtimeDir, `.codex-${operationId}.tgz`)
  const stagingDir = resolve(runtimeDir, `.codex-${operationId}.staging`)
  const backupDir = resolve(runtimeDir, `.codex-${operationId}.backup`)
  for (const path of [archivePath, stagingDir, backupDir]) {
    assertPathInside(runtimeDir, path)
  }

  let movedExistingToBackup = false
  try {
    await downloadRelease(
      release,
      archivePath,
      options.fetchImpl ?? fetch,
      options.signal,
      options.onProgress,
    )
    await mkdir(stagingDir, { recursive: true })
    options.onProgress?.({ phase: 'extracting' })
    await (options.extractArchive ?? defaultExtractArchive)(
      archivePath,
      stagingDir,
    )

    const stagedExecutable = resolve(
      stagingDir,
      release.relativeExecutablePath,
    )
    assertPathInside(stagingDir, stagedExecutable)
    if (!(await isFile(stagedExecutable))) {
      throw new Error('Codex Runtime 平台包缺少 codex 可执行文件')
    }
    if (platform !== 'win32') await chmod(stagedExecutable, 0o755)

    options.onProgress?.({ phase: 'probing' })
    const probeResult = probe(stagedExecutable)
    if (!probeResult.ok) {
      throw new Error(
        probeResult.reason ?? '下载的 Codex Runtime 不支持 App Server',
      )
    }

    await mkdir(dirname(installDir), { recursive: true })
    if (await pathExists(installDir)) {
      await renameWithRetry(
        installDir,
        backupDir,
        platform,
        renamePath,
        retryDelay,
      )
      movedExistingToBackup = true
    }
    await renameWithRetry(
      stagingDir,
      installDir,
      platform,
      renamePath,
      retryDelay,
    )

    const manifest: ManagedCodexRuntimeManifest = {
      version: release.version,
      platform: release.platform,
      arch: release.arch,
      relativeExecutablePath: relative(runtimeDir, executablePath),
      sha256: release.sha256,
      source: 'official',
    }
    options.onProgress?.({ phase: 'activating' })
    await writeManifestAtomic(manifestPath, manifest)
    if (movedExistingToBackup) {
      await rm(backupDir, { recursive: true, force: true })
    }
    return { executablePath, manifest, reusedExistingInstall: false }
  } catch (error) {
    if (movedExistingToBackup && !(await isFile(executablePath))) {
      try {
        await renameWithRetry(
          backupDir,
          installDir,
          platform,
          renamePath,
          retryDelay,
        )
        movedExistingToBackup = false
      } catch {
        // 保留原始错误；backup 目录不会在 finally 中删除，供人工恢复。
      }
    }
    throw error
  } finally {
    await rm(archivePath, { force: true }).catch(() => undefined)
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    if (!movedExistingToBackup) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
