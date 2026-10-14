/**
 * 内置网关渠道（kscc-gateway）的凭据读取。
 *
 * 自动读取进程/Windows 用户环境变量、settings.json 的 env 与 KCwork 登录态。
 * 只读取配置，不启动或依赖 kscc CLI，也不把密钥写入渠道记录。
 *
 * 所有来源都读不到，即视为「本机 KSCC 凭据未配置」——由调用方用
 * {@link GATEWAY_CREDENTIAL_MISSING_MESSAGE} 给出统一提示，不提供手填入口。
 *
 * 读取是同步的：`channel-store` 的 `getDecryptedApiKey` 是同步契约。
 * 按文件 mtime 缓存，避免每次发送都读盘。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 读不到凭据时的统一文案（会话发起处与渠道页共用）。 */
export const GATEWAY_CREDENTIAL_MISSING_MESSAGE =
  '未检测到 KSCC 凭据：请配置 KSCC_AUTH_TOKEN 环境变量，或 ~/.claude/settings.json 的 env.KSCC_AUTH_TOKEN / env.ANTHROPIC_AUTH_TOKEN'

/** KSCC 专用变量优先，兼容既有 Anthropic 环境配置。 */
export const GATEWAY_KEY_ENV_NAMES = [
  'KSCC_AUTH_TOKEN', 'KSCC_API_KEY', 'KSCC_KEY', 'KSCC_TOKEN',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
] as const

function readEnvironmentKey(env: Record<string, unknown>): string | null {
  for (const name of GATEWAY_KEY_ENV_NAMES) {
    const value = env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

let windowsEnvCache: { readAt: number; env: Record<string, string> } | undefined

/** 桌面启动可能继承旧环境；读注册表补齐用户/系统配置，避免每次发送启动子进程。 */
function readWindowsEnvironment(): Record<string, string> {
  if (process.platform !== 'win32') return {}
  if (windowsEnvCache && Date.now() - windowsEnvCache.readAt < 30_000) return windowsEnvCache.env
  const env: Record<string, string> = {}
  for (const path of [
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    'HKCU\\Environment',
  ]) {
    try {
      const output = execFileSync('reg.exe', ['query', path], {
        encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      for (const name of GATEWAY_KEY_ENV_NAMES) {
        const value = output.match(new RegExp(`^\\s*${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)$`, 'im'))?.[1]?.trim()
        if (value) env[name] = value
      }
    } catch { /* 不记录注册表内容或包含凭据的异常。 */ }
  }
  windowsEnvCache = { readAt: Date.now(), env }
  return env
}

/** 兼容既有 KSCC 环境配置的位置，读取不依赖 CLI。 */
export function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/** KCwork 登录态凭据的位置（按平台给出 appData 目录）。 */
export function kcworkCredentialPath(): string {
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'kcwork', 'kscc-credential.json')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'kcwork', 'kscc-credential.json')
  }
  return join(homedir(), '.config', 'kcwork', 'kscc-credential.json')
}

/**
 * 解码 KCwork 的 sk：`b64:` 前缀是 base64 包装的标准 sk，无前缀则视为明文。
 * 不满足 `sk-` 形态一律返回 null（宁缺勿错）。
 */
export function decodeKcworkSk(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  if (value.startsWith('b64:')) {
    try {
      const decoded = Buffer.from(value.slice(4), 'base64').toString('utf8').trim()
      return decoded.startsWith('sk-') ? decoded : null
    } catch {
      return null
    }
  }
  return value.startsWith('sk-') ? value : null
}

interface CacheEntry {
  mtimeMs: number
  key: string
}

const cache = new Map<string, CacheEntry>()

/** 清空缓存（测试用；文件被外部改写时也可主动调用）。 */
export function invalidateGatewayCredentialCache(): void {
  cache.clear()
  windowsEnvCache = undefined
}

/** 按 mtime 缓存读盘结果；文件不存在或读取失败返回 null，并清掉该路径缓存。 */
function readCached(path: string, parse: () => string | null): string | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    cache.delete(path)
    return null
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) {
    return hit.key || null
  }
  const key = parse()
  cache.set(path, { mtimeMs, key: key ?? '' })
  return key
}

function readFromClaudeSettings(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { env?: Record<string, unknown> }
    return parsed.env ? readEnvironmentKey(parsed.env) : null
  } catch {
    return null
  }
}

function readFromKcworkCredential(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sk?: unknown }
    return decodeKcworkSk(parsed.sk)
  } catch {
    return null
  }
}

export interface ReadGatewayApiKeyOptions {
  env?: NodeJS.ProcessEnv
  windowsEnv?: Record<string, string>
  claudeSettingsPath?: string
  kcworkCredentialPath?: string
}

/**
 * 读取 HTTP 网关密钥：环境变量优先，其次 settings.json，最后 KCwork 登录态。
 * 读不到返回空串。
 */
export function readGatewayApiKey(options: ReadGatewayApiKeyOptions = {}): string {
  const fromEnv = readEnvironmentKey(options.env ?? process.env)
  if (fromEnv) return fromEnv
  const fromWindows = readEnvironmentKey(options.windowsEnv ?? readWindowsEnvironment())
  if (fromWindows) return fromWindows
  const fromClaude = readCached(
    options.claudeSettingsPath ?? claudeSettingsPath(),
    () => readFromClaudeSettings(options.claudeSettingsPath ?? claudeSettingsPath()),
  )
  if (fromClaude) return fromClaude

  const fromKcwork = readCached(
    options.kcworkCredentialPath ?? kcworkCredentialPath(),
    () => readFromKcworkCredential(options.kcworkCredentialPath ?? kcworkCredentialPath()),
  )
  return fromKcwork ?? ''
}
