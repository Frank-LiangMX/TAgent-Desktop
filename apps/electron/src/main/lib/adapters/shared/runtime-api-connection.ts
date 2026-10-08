/**
 * Per-session connection material for official runtimes.
 *
 * This deliberately lives below the adapter boundary.  Callers hand us a
 * decrypted key, but we never serialize it into a runtime configuration or
 * include it in a command line.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../../config/config-paths'

export interface RuntimeApiConnection {
  channelId: string
  provider?: string
  baseUrl: string
  apiKey: string
  /** Upstream channel wire protocol. Official runtimes may bridge it. */
  apiProtocol?: 'anthropic-messages' | 'openai-responses' | 'openai-chat'
  contextWindow?: number
  /**
   * 渠道必须携带的自定义请求头（如内网网关的客户端标识）。
   * 非秘密数据，由渠道 provider 决定；不得写入原生配置文件的明文密钥位。
   */
  headers?: Record<string, string>
}

const SAFE_PARENT_ENV = new Set([
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
])
// 96-bit truncated SHA-256 segments keep the durable Windows path short while
// making accidental session/binding collisions operationally negligible.
const DURABLE_HASH_HEX_LENGTH = 24
const CREDENTIAL_EPOCH_HEX_LENGTH = 12

function isSafeParentVariable(name: string): boolean {
  const upperName = name.toUpperCase()
  return (
    SAFE_PARENT_ENV.has(upperName) ||
    upperName.startsWith('LC_') ||
    upperName === 'TERM'
  )
}

/**
 * Create a fresh process environment.  Do not spread process.env here: doing
 * so can silently import a logged-in runtime's credentials into an API
 * channel.  `parentEnv` is accepted solely to retain executable OS variables.
 */
export function buildIsolatedRuntimeEnv(
  parentEnv: Record<string, string | undefined> | undefined,
  overrides: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(parentEnv ?? {})) {
    if (value !== undefined && isSafeParentVariable(name)) env[name] = value
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  return env
}

/** 规范化自定义头并挡住 CRLF 注入；空集合返回 undefined。 */
function normalizeCustomHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name).trim()
    const val = String(value).trim()
    if (!key || !val) continue
    if (/[\r\n]/.test(key) || /[\r\n]/.test(val)) {
      throw new Error('官方 API 渠道自定义头不允许包含换行')
    }
    out[key] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function assertRuntimeApiConnection(
  connection: RuntimeApiConnection,
): RuntimeApiConnection {
  const channelId = connection.channelId?.trim()
  const baseUrl = connection.baseUrl?.trim()
  const apiKey = connection.apiKey?.trim()
  if (!channelId) throw new Error('官方 API 渠道缺少 channelId')
  if (!baseUrl) throw new Error('官方 API 渠道缺少 baseUrl')
  if (!apiKey) throw new Error('官方 API 渠道缺少 apiKey')
  if (
    connection.contextWindow !== undefined &&
    (!Number.isSafeInteger(connection.contextWindow) || connection.contextWindow <= 0)
  ) {
    throw new Error('官方 API 渠道 contextWindow 必须为正整数')
  }
  const headers = normalizeCustomHeaders(connection.headers)
  return {
    channelId,
    ...(connection.provider ? { provider: connection.provider } : {}),
    baseUrl,
    apiKey,
    ...(connection.apiProtocol ? { apiProtocol: connection.apiProtocol } : {}),
    ...(connection.contextWindow !== undefined ? { contextWindow: connection.contextWindow } : {}),
    ...(headers ? { headers } : {}),
  }
}

/** A non-secret equality key; it is never logged or persisted. */
export function runtimeBindingFingerprint(
  connection: RuntimeApiConnection,
  model: string | undefined,
  protocol: 'anthropic-messages' | 'openai-responses',
): string {
  const value = assertRuntimeApiConnection(connection)
  return createHash('sha256')
    .update(`${protocol}\u0000${value.channelId}\u0000${value.provider ?? ''}\u0000${value.baseUrl}\u0000${value.apiProtocol ?? ''}\u0000${model ?? ''}\u0000${value.contextWindow ?? ''}`)
    .digest('hex')
}

/**
 * Host-owned, durable runtime state.  The directory identity contains only a
 * hash of session and non-secret binding fields (channel, endpoint, model,
 * protocol, context window).  It deliberately does not include API material.
 *
 * To refuse an accidental key change on resume, a 0600 metadata file keeps a
 * salted verifier of the API key.  This is neither the key nor an unsalted key
 * fingerprint; a verifier mismatch fails closed and requires host handoff.
 */
export interface DurableRuntimeHome {
  path: string
  /** True only when this exact non-secret binding was previously initialized. */
  existingBinding: boolean
}

export class RuntimeApiBindingError extends Error {
  readonly code: 'binding_missing' | 'credential_changed' | 'metadata_invalid'

  constructor(
    code: RuntimeApiBindingError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'RuntimeApiBindingError'
    this.code = code
  }
}

export function openDurableRuntimeHome(
  runtime: 'claude' | 'codex',
  sessionId: string,
  connection: RuntimeApiConnection,
  model: string | undefined,
  protocol: 'anthropic-messages' | 'openai-responses',
  rootDir = join(getConfigDir(), 'official-runtime-homes'),
  resumeRequested = false,
): DurableRuntimeHome {
  const value = assertRuntimeApiConnection(connection)
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId) throw new Error('官方 runtime 缺少 sessionId')
  const sessionHash = createHash('sha256')
    .update(normalizedSessionId)
    .digest('hex')
    .slice(0, DURABLE_HASH_HEX_LENGTH)
  const bindingHash = runtimeBindingFingerprint(value, model, protocol).slice(
    0,
    DURABLE_HASH_HEX_LENGTH,
  )
  const bindingRoot = join(rootDir, runtime, sessionHash, bindingHash)
  if (!existsSync(bindingRoot)) mkdirSync(bindingRoot, { recursive: true, mode: 0o700 })
  const homes = readdirSync(bindingRoot)
    .map((entry) => join(bindingRoot, entry))
    .filter((candidate) => statSync(candidate).isDirectory())
  let sawBinding = false
  for (const home of homes) {
    const metadataPath = join(home, '.tagent-binding.json')
    if (!existsSync(metadataPath)) continue
    const metadata = readBindingMetadata(metadataPath, bindingHash)
    sawBinding = true
    if (keyVerifier(value.apiKey, metadata.keySalt) === metadata.keyVerifier) {
      return { path: home, existingBinding: true }
    }
  }
  if (resumeRequested) {
    throw new RuntimeApiBindingError(
      sawBinding ? 'credential_changed' : 'binding_missing',
      sawBinding
        ? '官方 API 渠道凭据已变更，拒绝复用原生会话；请显式上下文接力后新建会话'
        : '官方 API 渠道绑定已变更或无可恢复 host state；请显式上下文接力后新建会话',
    )
  }
  // A deliberate new native session after a key change gets a fresh credential
  // epoch.  Existing transcripts remain untouched in their prior epoch.
  const home = join(
    bindingRoot,
    `credential-${randomBytes(6).toString('hex').slice(0, CREDENTIAL_EPOCH_HEX_LENGTH)}`,
  )
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const salt = randomBytes(32).toString('base64url')
  writeFileSync(
    join(home, '.tagent-binding.json'),
    JSON.stringify({
      version: 1,
      binding: bindingHash,
      keySalt: salt,
      keyVerifier: keyVerifier(value.apiKey, salt),
    }),
    { encoding: 'utf8', mode: 0o600 },
  )
  return { path: home, existingBinding: false }
}

export function getDurableRuntimeHome(
  runtime: 'claude' | 'codex',
  sessionId: string,
  connection: RuntimeApiConnection,
  model: string | undefined,
  protocol: 'anthropic-messages' | 'openai-responses',
  rootDir?: string,
): string {
  return openDurableRuntimeHome(
    runtime,
    sessionId,
    connection,
    model,
    protocol,
    rootDir,
  ).path
}

function readBindingMetadata(
  metadataPath: string,
  bindingHash: string,
): { keySalt: string; keyVerifier: string } {
  let metadata: { version?: unknown; binding?: unknown; keySalt?: unknown; keyVerifier?: unknown }
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as typeof metadata
  } catch {
    throw new RuntimeApiBindingError(
      'metadata_invalid',
      '官方 runtime host state 绑定元数据损坏；请显式上下文接力后新建会话',
    )
  }
  if (
    metadata.version !== 1 ||
    metadata.binding !== bindingHash ||
    typeof metadata.keySalt !== 'string' ||
    typeof metadata.keyVerifier !== 'string'
  ) {
    throw new RuntimeApiBindingError(
      'metadata_invalid',
      '官方 runtime host state 绑定不匹配；请显式上下文接力后新建会话',
    )
  }
  return { keySalt: metadata.keySalt, keyVerifier: metadata.keyVerifier }
}

function keyVerifier(apiKey: string, salt: string): string {
  return createHash('sha256').update(`${salt}\u0000${apiKey}`).digest('hex')
}

/** Replace complete occurrences, including self-overlapping key matches. */
export function redactRuntimeApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text
  const ranges = apiKeyMatchRanges(text, apiKey)
  if (ranges.length === 0) return text
  let result = ''
  let offset = 0
  for (const [start, end] of ranges) {
    result += `${text.slice(offset, start)}[REDACTED]`
    offset = end
  }
  return result + text.slice(offset)
}

/**
 * Stateful stderr redactor for one process stream.  It retains only the
 * longest suffix which could be an API-key prefix, joins it to the next
 * chunk, and never emits that candidate fragment by itself.
 */
export function createRuntimeApiKeyRedactor(
  apiKey: string,
  emit: (text: string) => void,
): (chunk: string) => void {
  let pending = ''
  return (chunk: string) => {
    const combined = pending + chunk
    const matches = apiKeyMatchRanges(combined, apiKey)
    let retainedLength = trailingApiKeyPrefixLength(combined, apiKey)
    // A trailing prefix that sits inside a complete (possibly overlapping)
    // match must be emitted through the redactor now, never held raw.
    if (retainedLength > 0 && matches.some(([, end]) => end > combined.length - retainedLength)) {
      retainedLength = 0
    }
    const readyLength = combined.length - retainedLength
    pending = combined.slice(readyLength)
    const ready = combined.slice(0, readyLength)
    if (ready) emit(redactRuntimeApiKey(ready, apiKey))
  }
}

function apiKeyMatchRanges(text: string, apiKey: string): Array<[number, number]> {
  if (!apiKey) return []
  const ranges: Array<[number, number]> = []
  for (let start = text.indexOf(apiKey); start >= 0; start = text.indexOf(apiKey, start + 1)) {
    const end = start + apiKey.length
    const previous = ranges.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else ranges.push([start, end])
  }
  return ranges
}

function trailingApiKeyPrefixLength(text: string, apiKey: string): number {
  if (!apiKey) return 0
  const limit = Math.min(text.length, apiKey.length - 1)
  for (let length = limit; length > 0; length -= 1) {
    if (text.endsWith(apiKey.slice(0, length))) return length
  }
  return 0
}

function tomlString(value: string): string {
  // TOML basic strings use the same escape grammar for the characters that
  // JSON.stringify emits, while avoiding interpolation or shell parsing.
  return JSON.stringify(value)
}

/**
 * Write only non-secret Codex provider configuration to its isolated home.
 * The provider key is referenced by name and supplied exclusively in env.
 */
export function writeCodexResponsesProviderConfig(
  codexHome: string,
  connection: RuntimeApiConnection,
  model: string,
): void {
  const value = assertRuntimeApiConnection(connection)
  const selectedModel = model.trim()
  if (!selectedModel) throw new Error('官方 Codex API 渠道缺少 model')
  const lines = [
    `model = ${tomlString(selectedModel)}`,
    'model_provider = "tagent_api"',
    ...(value.contextWindow !== undefined
      ? [`model_context_window = ${value.contextWindow}`]
      : []),
    '',
    '[model_providers.tagent_api]',
    'name = "TAgent API channel"',
    `base_url = ${tomlString(value.baseUrl)}`,
    'wire_api = "responses"',
    'env_key = "TAGENT_CODEX_API_KEY"',
    '',
  ]
  writeFileSync(join(codexHome, 'config.toml'), lines.join('\n'), {
    encoding: 'utf8',
    mode: 0o600,
  })
}
