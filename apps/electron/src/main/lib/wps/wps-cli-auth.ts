import { app } from 'electron'
import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getWpsAppCredentials } from './wps-app-credentials'

const execFile = promisify(nodeExecFile)
const CLI_VERSION = 'v0.2.0'

function cliDir(): string { return join(app.getPath('userData'), 'wps-cli') }
export function wpsCliPath(): string {
  return join(cliDir(), process.platform === 'win32' ? 'wps365-cli.exe' : 'wps365-cli')
}

function existingCliPaths(): string[] {
  const executable = process.platform === 'win32' ? 'wps365-cli.exe' : 'wps365-cli'
  const paths = [wpsCliPath()]
  // 旧版 TAgent 使用的是 electron-dev 的 userData 目录。复用已经安装的
  // CLI，避免新应用首次登录时无谓地请求 GitHub 下载。
  try { paths.push(join(app.getPath('appData'), '@tagent', 'electron-dev', 'wps-cli', executable)) } catch { /* app 尚未初始化时忽略旧目录。 */ }
  paths.push(join(homedir(), '.tagent', 'wps-cli', executable))
  return [...new Set(paths)]
}

function archive(): { name: string; url: string } {
  const key = `${process.platform}-${process.arch}`
  const entries: Record<string, { name: string; url: string }> = {
    'win32-x64': { name: 'wps365-cli-x86_64-pc-windows-gnu.zip', url: `https://github.com/wps365-open/cli/releases/download/${CLI_VERSION}/wps365-cli-x86_64-pc-windows-gnu.zip` },
    'win32-arm64': { name: 'wps365-cli-aarch64-pc-windows-gnu.zip', url: `https://github.com/wps365-open/cli/releases/download/${CLI_VERSION}/wps365-cli-aarch64-pc-windows-gnu.zip` },
    'darwin-x64': { name: 'wps365-cli-x86_64-apple-darwin.tar.gz', url: `https://github.com/wps365-open/cli/releases/download/${CLI_VERSION}/wps365-cli-x86_64-apple-darwin.tar.gz` },
    'darwin-arm64': { name: 'wps365-cli-aarch64-apple-darwin.tar.gz', url: `https://github.com/wps365-open/cli/releases/download/${CLI_VERSION}/wps365-cli-aarch64-apple-darwin.tar.gz` },
    'linux-x64': { name: 'wps365-cli-x86_64-unknown-linux-gnu.tar.gz', url: `https://github.com/wps365-open/cli/releases/download/${CLI_VERSION}/wps365-cli-x86_64-unknown-linux-gnu.tar.gz` },
    'linux-arm64': { name: 'wps365-cli-aarch64-unknown-linux-gnu.tar.gz', url: `https://github.com/wps365-open/cli/releases/download/${CLI_VERSION}/wps365-cli-aarch64-unknown-linux-gnu.tar.gz` },
  }
  const value = entries[key]
  if (!value) throw new Error(`当前平台没有对应的 WPS CLI：${key}`)
  return value
}

export async function ensureWpsCli(): Promise<string> {
  const existing = existingCliPaths().find(path => existsSync(path))
  if (existing) return existing
  const path = wpsCliPath()
  await mkdir(cliDir(), { recursive: true })
  const item = archive()
  let response: Response
  try {
    response = await fetch(item.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
  } catch {
    throw new Error('本机未找到 WPS 登录组件，且下载失败。请检查网络后重试。')
  }
  if (!response.ok) throw new Error(`WPS 登录组件下载失败（HTTP ${response.status}）。`)
  const archivePath = join(cliDir(), item.name)
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
  try {
    if (process.platform === 'win32') {
      const escaped = archivePath.replace(/'/g, "''").replace(/\\/g, '/')
      const destination = cliDir().replace(/'/g, "''").replace(/\\/g, '/')
      await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${escaped}' -DestinationPath '${destination}' -Force`], { timeout: 120_000 })
    } else {
      await execFile('tar', ['-xzf', archivePath, '-C', cliDir()], { timeout: 120_000 })
    }
  } finally { await rm(archivePath, { force: true }).catch(() => {}) }
  if (!existsSync(path)) throw new Error('WPS 登录组件安装后未找到可执行文件。')
  return path
}

export async function runWpsCli(args: string[]): Promise<string> {
  const path = await ensureWpsCli()
  const credentials = getWpsAppCredentials()
  if (!credentials.appId || !credentials.secretKey) throw new Error('应用内 WPS 凭据不可用，请联系应用管理员。')
  const env = { ...process.env, WPS365_CLIENT_ID: credentials.appId, WPS365_CLIENT_SECRET: credentials.secretKey, WPS365_OUTPUT: 'json', WPS365_QUIET: '1' }
  const result = await execFile(path, args, { env, timeout: args[0] === 'auth' ? 5 * 60_000 : 30_000, windowsHide: true })
  return result.stdout.trim()
}

export function parseWpsAccessToken(output: string): string {
  try {
    const value: unknown = JSON.parse(output)
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
      const token = (value as { access_token?: unknown; token?: unknown }).access_token ?? (value as { token?: unknown }).token
      if (typeof token === 'string') return token
    }
  } catch { /* CLI 可能直接输出 token。 */ }
  return output.trim()
}
