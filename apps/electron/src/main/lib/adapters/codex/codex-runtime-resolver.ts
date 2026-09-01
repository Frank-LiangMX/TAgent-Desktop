/**
 * Codex 主核 Runtime 解析与能力探针。
 *
 * 只解析可执行文件和 App Server 能力，不读取 Codex token/auth 文件：
 * 1. 用户显式路径（调用参数 / TAGENT_CODEX_PATH）
 * 2. 系统 PATH 中的 codex
 * 3. TAgent 按需下载的官方托管 Runtime
 *
 * 候选必须同时通过 `--version` 和 `app-server --help`，旧版或同名程序不会被
 * 误当成主会话后端。托管清单只能引用 runtimes/codex 目录内的相对路径。
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { getManagedCodexRuntimeDir, getManagedCodexRuntimeManifestPath } from '../../config/config-paths'
import { resolveWorkerBin } from '../../agent/cli-workers/probe-cli-workers'
import { resolveCliBin } from '../../agent/cli-workers/run-ndjson-cli'

export type CodexRuntimeSource = 'explicit' | 'environment' | 'system' | 'managed'

export interface ManagedCodexRuntimeManifest {
  version: string
  platform: NodeJS.Platform
  arch: string
  relativeExecutablePath: string
  sha256?: string
  source: 'official' | 'mirror'
}

export interface CodexRuntimeDiagnostic {
  source: CodexRuntimeSource
  candidate?: string
  reason: string
}

export interface CodexRuntimeResolution {
  available: boolean
  source?: CodexRuntimeSource
  executablePath?: string
  version?: string
  versionText?: string
  diagnostics: CodexRuntimeDiagnostic[]
}

interface CodexRuntimeCandidate {
  source: CodexRuntimeSource
  executablePath: string
}

interface ProbeResult {
  ok: boolean
  version?: string
  versionText?: string
  reason?: string
}

const REQUIRED_APP_SERVER_FEATURES = [
  'default_mode_request_user_input',
  'exec_permission_approvals',
  'request_permissions_tool',
] as const

export interface ResolveCodexRuntimeOptions {
  explicitPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  managedRuntimeDir?: string
  managedManifestPath?: string
  resolveSystemBin?: (bin: string) => string | null
  fileExists?: (path: string) => boolean
  readTextFile?: (path: string) => string
  probe?: (executablePath: string) => ProbeResult
}

type SpawnResult = SpawnSyncReturns<string>
type SpawnRunner = (
  command: string,
  args: string[],
  options: {
    encoding: 'utf8'
    timeout: number
    windowsHide: boolean
    stdio: ['ignore', 'pipe', 'pipe']
  },
) => SpawnResult

function isUsableFile(path: string, fileExists: (path: string) => boolean): boolean {
  if (!fileExists(path)) return false
  try {
    return statSync(path).isFile()
  } catch {
    // Tests and virtual filesystems may provide existence without stat metadata.
    return true
  }
}

function firstOutputLine(result: SpawnResult): string {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? ''
}

function commandFailureReason(result: SpawnResult, fallback: string): string {
  if (result.error) return result.error.message
  const line = firstOutputLine(result)
  return line || (result.signal ? `${fallback}（signal=${result.signal}）` : fallback)
}

function runCodexCommand(
  executablePath: string,
  args: string[],
  spawnRunner: SpawnRunner,
): SpawnResult {
  const invocation = resolveCliBin(executablePath)
  return spawnRunner(invocation.command, [...invocation.cmdPrefix, ...args], {
    encoding: 'utf8',
    timeout: 8_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 验证候选确实是带 App Server 的 Codex CLI。 */
export function probeCodexRuntime(
  executablePath: string,
  spawnRunner: SpawnRunner = spawnSync,
): ProbeResult {
  const versionResult = runCodexCommand(executablePath, ['--version'], spawnRunner)
  if (versionResult.status !== 0 || versionResult.error) {
    return {
      ok: false,
      reason: `无法读取 Codex 版本：${commandFailureReason(versionResult, 'codex --version 失败')}`,
    }
  }
  const versionText = firstOutputLine(versionResult)
  const version = versionText.match(/\bcodex(?:-cli)?\s+([^\s]+)/i)?.[1]

  const appServerResult = runCodexCommand(
    executablePath,
    ['app-server', '--help'],
    spawnRunner,
  )
  const appServerHelp = `${appServerResult.stdout ?? ''}\n${appServerResult.stderr ?? ''}`
  if (
    appServerResult.status !== 0 ||
    appServerResult.error ||
    !/(app server|app-server|generate-ts|--listen)/i.test(appServerHelp)
  ) {
    return {
      ok: false,
      version,
      versionText,
      reason: `当前 Codex 不支持 App Server：${commandFailureReason(
        appServerResult,
        'codex app-server --help 失败',
      )}`,
    }
  }

  const featuresResult = runCodexCommand(
    executablePath,
    ['features', 'list'],
    spawnRunner,
  )
  const featuresText = `${featuresResult.stdout ?? ''}\n${featuresResult.stderr ?? ''}`
  const missingFeatures = REQUIRED_APP_SERVER_FEATURES.filter(
    (feature) =>
      !new RegExp(`^${feature}\\s+`, 'm').test(featuresText),
  )
  if (
    featuresResult.status !== 0 ||
    featuresResult.error ||
    missingFeatures.length > 0
  ) {
    return {
      ok: false,
      version,
      versionText,
      reason:
        missingFeatures.length > 0
          ? `当前 Codex 缺少 TAgent 主会话必需特性：${missingFeatures.join(', ')}`
          : `无法读取 Codex 特性列表：${commandFailureReason(
              featuresResult,
              'codex features list 失败',
            )}`,
    }
  }

  return { ok: true, version, versionText }
}

function managedCandidate(
  options: Required<
    Pick<
      ResolveCodexRuntimeOptions,
      'platform' | 'arch' | 'managedRuntimeDir' | 'managedManifestPath' | 'fileExists' | 'readTextFile'
    >
  >,
): { candidate?: CodexRuntimeCandidate; diagnostic?: CodexRuntimeDiagnostic } {
  if (!options.fileExists(options.managedManifestPath)) {
    return {
      diagnostic: {
        source: 'managed',
        candidate: options.managedManifestPath,
        reason: '尚未安装 TAgent 托管 Codex Runtime',
      },
    }
  }

  let manifest: ManagedCodexRuntimeManifest
  try {
    manifest = JSON.parse(options.readTextFile(options.managedManifestPath)) as ManagedCodexRuntimeManifest
  } catch {
    return {
      diagnostic: {
        source: 'managed',
        candidate: options.managedManifestPath,
        reason: '托管 Runtime 清单无法解析',
      },
    }
  }

  if (
    !manifest ||
    typeof manifest.version !== 'string' ||
    manifest.platform !== options.platform ||
    manifest.arch !== options.arch ||
    typeof manifest.relativeExecutablePath !== 'string' ||
    isAbsolute(manifest.relativeExecutablePath)
  ) {
    return {
      diagnostic: {
        source: 'managed',
        candidate: options.managedManifestPath,
        reason: '托管 Runtime 清单与当前平台不匹配或字段无效',
      },
    }
  }

  const runtimeRoot = resolve(options.managedRuntimeDir)
  const executablePath = resolve(runtimeRoot, manifest.relativeExecutablePath)
  const rel = relative(runtimeRoot, executablePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return {
      diagnostic: {
        source: 'managed',
        candidate: executablePath,
        reason: '托管 Runtime 可执行路径越出受管目录',
      },
    }
  }
  if (!isUsableFile(executablePath, options.fileExists)) {
    return {
      diagnostic: {
        source: 'managed',
        candidate: executablePath,
        reason: '托管 Runtime 可执行文件不存在',
      },
    }
  }
  return { candidate: { source: 'managed', executablePath } }
}

/**
 * 按优先级解析并探测 Codex Runtime。
 *
 * 某个候选存在但不支持 App Server 时继续尝试下一个候选，并把失败原因留在
 * diagnostics，供设置页解释最终选择和修复方式。
 */
export function resolveCodexRuntime(
  options: ResolveCodexRuntimeOptions = {},
): CodexRuntimeResolution {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const managedRuntimeDir = options.managedRuntimeDir ?? getManagedCodexRuntimeDir()
  const managedManifestPath =
    options.managedManifestPath ?? getManagedCodexRuntimeManifestPath()
  const fileExists = options.fileExists ?? existsSync
  const readTextFile =
    options.readTextFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const resolveSystemBin = options.resolveSystemBin ?? resolveWorkerBin
  const probe = options.probe ?? probeCodexRuntime
  const diagnostics: CodexRuntimeDiagnostic[] = []
  const candidates: CodexRuntimeCandidate[] = []
  const seen = new Set<string>()

  const addPathCandidate = (
    source: 'explicit' | 'environment',
    rawPath: string | undefined,
  ): void => {
    const trimmed = rawPath?.trim()
    if (!trimmed) return
    const path = resolve(trimmed)
    if (!isUsableFile(path, fileExists)) {
      diagnostics.push({ source, candidate: path, reason: '可执行文件不存在' })
      return
    }
    if (!seen.has(path)) {
      candidates.push({ source, executablePath: path })
      seen.add(path)
    }
  }

  addPathCandidate('explicit', options.explicitPath)
  addPathCandidate('environment', env.TAGENT_CODEX_PATH)

  const systemPath = resolveSystemBin('codex')
  if (systemPath) {
    const resolvedSystemPath = resolve(systemPath)
    if (!seen.has(resolvedSystemPath)) {
      candidates.push({ source: 'system', executablePath: resolvedSystemPath })
      seen.add(resolvedSystemPath)
    }
  } else {
    diagnostics.push({ source: 'system', reason: '系统 PATH 中未找到 codex' })
  }

  const managed = managedCandidate({
    platform,
    arch,
    managedRuntimeDir,
    managedManifestPath,
    fileExists,
    readTextFile,
  })
  if (managed.diagnostic) diagnostics.push(managed.diagnostic)
  if (managed.candidate && !seen.has(managed.candidate.executablePath)) {
    candidates.push(managed.candidate)
  }

  for (const candidate of candidates) {
    const result = probe(candidate.executablePath)
    if (result.ok) {
      return {
        available: true,
        source: candidate.source,
        executablePath: candidate.executablePath,
        version: result.version,
        versionText: result.versionText,
        diagnostics,
      }
    }
    diagnostics.push({
      source: candidate.source,
      candidate: candidate.executablePath,
      reason: result.reason ?? 'Codex Runtime 能力探测失败',
    })
  }

  return { available: false, diagnostics }
}
