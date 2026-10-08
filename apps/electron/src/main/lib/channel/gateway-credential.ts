/**
 * 内置网关渠道（kscc-gateway）的凭据读取。
 *
 * kscc 网关的 sk 不在渠道里配置，而是从本机 kscc 环境读取：
 *   1. `~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN`（kscc CLI 正常路径）
 *   2. KCwork 登录态 `kscc-credential.json` 的 `sk`（可能是 `b64:` 前缀的 base64 包装）
 *
 * 两处都读不到，即视为「本机 kscc 环境未配好」——由调用方用
 * {@link GATEWAY_CREDENTIAL_MISSING_MESSAGE} 给出统一提示，不提供手填入口。
 *
 * 读取是同步的：`channel-store` 的 `getDecryptedApiKey` 是同步契约。
 * 按文件 mtime 缓存，避免每次发送都读盘。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 读不到凭据时的统一文案（会话发起处与渠道页共用）。 */
export const GATEWAY_CREDENTIAL_MISSING_MESSAGE =
  '未检测到 kscc 凭据：请先在本机配置 kscc（~/.claude/settings.json 的 ANTHROPIC_AUTH_TOKEN）'

/** kscc CLI 写凭据的位置。 */
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
    const token = parsed.env?.ANTHROPIC_AUTH_TOKEN
    return typeof token === 'string' && token.trim() ? token.trim() : null
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
  claudeSettingsPath?: string
  kcworkCredentialPath?: string
}

/**
 * 读取内置网关渠道使用的 sk。优先 kscc CLI 的 settings.json，其次 KCwork 登录态。
 * 读不到返回空串。
 */
export function readGatewayApiKey(options: ReadGatewayApiKeyOptions = {}): string {
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