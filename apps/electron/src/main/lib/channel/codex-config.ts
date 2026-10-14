import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CodexModelProviderConfig {
  name: string
  baseUrl: string
  wireApi?: 'responses' | 'chat' | 'messages'
  apiKey?: string
  envKey?: string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    const body = trimmed.slice(1, -1)
    return trimmed.startsWith('"') ? body.replace(/\\(["\\nrt])/g, (_, code: string) => ({ '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' }[code] ?? code)) : body
  }
  return trimmed
}

/** 读取 Codex config.toml 中的 model_providers 配置；仅解析渠道同步所需字段。 */
export function parseCodexModelProviders(contents: string): CodexModelProviderConfig[] {
  const out: CodexModelProviderConfig[] = []
  let current: CodexModelProviderConfig | undefined
  const flush = () => { if (current?.baseUrl) out.push(current); current = undefined }
  for (const line of contents.split(/\r?\n/)) {
    const section = line.match(/^\s*\[model_providers\.([^\]]+)\]\s*$/)
    if (section) { flush(); current = { name: unquote(section[1]!) , baseUrl: '' }; continue }
    if (!current) continue
    const match = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*(.*?)\s*(?:#.*)?$/)
    if (!match) continue
    const key = match[1]!
    const value = unquote(match[2]!)
    if (key === 'base_url') current.baseUrl = value
    else if (key === 'wire_api') current.wireApi = value === 'responses' || value === 'chat' || value === 'messages' ? value : undefined
    else if (key === 'experimental_bearer_token' || key === 'api_key') current.apiKey = value
    else if (key === 'env_key') current.envKey = value
  }
  flush()
  return out
}

export function getCodexConfigPath(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'config.toml')
}

export function readCodexModelProviders(path = getCodexConfigPath()): CodexModelProviderConfig[] {
  if (!existsSync(path)) return []
  try { return parseCodexModelProviders(readFileSync(path, 'utf8')) } catch { return [] }
}

export function resolveCodexConfigApiKey(provider: CodexModelProviderConfig): string {
  if (provider.apiKey?.trim()) return provider.apiKey.trim()
  if (provider.envKey) return process.env[provider.envKey]?.trim() ?? ''
  return ''
}

export function resolveCodexConfigProtocol(provider: CodexModelProviderConfig): 'openai-responses' | 'openai-chat' | 'anthropic-messages' {
  if (provider.wireApi === 'chat') return 'openai-chat'
  if (provider.wireApi === 'messages') return 'anthropic-messages'
  return 'openai-responses'
}

export function isTokenHubProvider(provider: CodexModelProviderConfig): boolean {
  return /token[-_ ]?hub|airoute|aihub/i.test(`${provider.name} ${provider.baseUrl}`)
}

export function isKsccProvider(provider: CodexModelProviderConfig): boolean {
  return /kscc/i.test(`${provider.name} ${provider.baseUrl}`)
}
