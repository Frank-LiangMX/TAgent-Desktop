/** HTTP 渠道存储；旧本机渠道只用于读取历史绑定，不参与运行或选择。 */
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type {
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelsConfig,
  ChannelModel,
  ChannelApiProtocol,
} from '@tagent/shared'
import {
  DEFAULT_CONTEXT_WINDOW,
  inferContextWindow,
  isBuiltinChannelProvider,
  isGatewayProvider,
  isLocalRuntimeProvider,
} from '@tagent/shared'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getChannelsPath } from '../config/config-paths'
import {
  CODEX_DEFAULT_MODELS,
  getDefaultModelsForProvider,
  KSCC_DEFAULT_MODELS,
} from './default-models'
import { GATEWAY_CREDENTIAL_MISSING_MESSAGE, readGatewayApiKey } from './gateway-credential'
import {
  isKsccProvider,
  isTokenHubProvider,
  readCodexModelProviders,
  resolveCodexConfigApiKey,
  resolveCodexConfigProtocol,
  type CodexModelProviderConfig,
} from './codex-config'
/** 配置版本号 */
const CONFIG_VERSION = 1

/** 取内置网关渠道 ID（按 provider 识别，兼容随机 UUID id 的情况） */
export function getGatewayChannelId(): string | undefined {
  return readConfig().channels.find((c) => c.provider === 'kscc-gateway')?.id
}

/** 取 Codex 本机渠道 ID。 */
export function getCodexChannelId(): string | undefined {
  return readConfig().channels.find((c) => c.provider === 'codex-internal')?.id
}

/**
 * 取新会话默认外部渠道。
 *
 * 只选择已启用 HTTP 渠道，不回落到旧本机 Runtime。
 */
export function getDefaultExternalChannelId(): string | undefined {
  const external = readConfig().channels.filter(
    (channel) =>
      channel.enabled &&
      channel.provider !== 'kscc-internal' &&
      channel.provider !== 'codex-internal' &&
      channel.models.some((model) => model.enabled),
  )
  const withValidDefault = external.filter((channel) =>
    channel.defaultModelId
      ? channel.models.some(
          (model) => model.id === channel.defaultModelId && model.enabled,
        )
      : true,
  )
  // 公司自有 OpenAI-compatible 网关通常以 custom provider 注册，优先它，
  // 让新会话默认走当前内部 API Key，而不是历史上排在最前的公共渠道。
  return withValidDefault.find((channel) => channel.provider === 'custom')?.id
    ?? withValidDefault[0]?.id
}

/** 读渠道配置文件（损坏时从 .bak 自愈恢复） */
function readConfig(): ChannelsConfig {
  const parsed = readJsonSafe<ChannelsConfig | null>(getChannelsPath(), null)
  if (!parsed || !Array.isArray(parsed.channels)) {
    return { version: CONFIG_VERSION, channels: [] }
  }
  return parsed
}

/** 写渠道配置文件（原子写：tmp + 备份 + rename） */
function writeConfig(config: ChannelsConfig): void {
  try {
    writeJsonAtomic(getChannelsPath(), config)
  } catch (err) {
    console.error('[渠道存储] 写入配置失败:', err)
    throw new Error('写入渠道配置失败')
  }
}

/** 加密 API Key（base64 编码的 safeStorage 密文） */
function encryptApiKey(plainKey: string): string {
  if (!plainKey) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[渠道存储] safeStorage 不可用，apiKey 明文存储')
    return plainKey
  }
  return safeStorage.encryptString(plainKey).toString('base64')
}

/** 解密 API Key（解密失败返回空串，让用户重输） */
function decryptKey(encryptedKey: string): string {
  if (!encryptedKey) return ''
  if (!safeStorage.isEncryptionAvailable()) return encryptedKey
  try {
    return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
  } catch (err) {
    // Windows DPAPI 绑定可执行文件路径，不同 Electron 实例间 safeStorage 密钥不互通
    // 解密失败说明是另一个实例加密的，返回空串让用户重新输入
    console.warn('[渠道存储] 解密 apiKey 失败（可能由另一个 Electron 实例加密）:', err)
    return ''
  }
}

/** 规范化 defaultModelId：须为已启用模型之一，否则取第一个已启用模型 */
function normalizeDefaultModelId(models: ChannelModel[], defaultModelId?: string): string | undefined {
  const enabled = models.filter((m) => m.enabled)
  if (enabled.length === 0) return undefined
  if (defaultModelId && enabled.some((m) => m.id === defaultModelId)) {
    return defaultModelId
  }
  return enabled[0]?.id
}

/** 列出全部渠道（apiKey 保持加密，返回给渲染层不泄露明文） */
export function listChannels(): Channel[] {
  return readConfig().channels
    .filter((channel) => !isLocalRuntimeProvider(channel.provider))
    .filter((channel) => isManagedCodexChannelAvailable(channel))
    .map(withCredentialStatus)
}

function isManagedCodexChannelAvailable(channel: Channel): boolean {
  if (channel.id !== 'codex-kscc' && channel.id !== 'codex-tokenhub') return true
  return Boolean(getCodexConfigProvider(channel.id))
}

function withCredentialStatus(channel: Channel): Channel {
  const codexProvider = getCodexConfigProvider(channel.id)
  if (codexProvider) {
    return {
      ...channel,
      scope: 'internal',
      baseUrl: codexProvider.baseUrl,
      apiProtocol: resolveCodexConfigProtocol(codexProvider),
      credentialStatus: resolveCodexConfigApiKey(codexProvider) ? 'ready' : 'missing',
    }
  }
  if (!isGatewayProvider(channel.provider)) return channel
  return { ...channel, credentialStatus: readGatewayApiKey() || decryptKey(channel.apiKey) ? 'ready' : 'missing' }
}

/** 取单个渠道 */
export function getChannel(id: string): Channel | undefined {
  const channel = readConfig().channels.find((c) => c.id === id)
  return channel ? withCredentialStatus(channel) : undefined
}

/**
 * 取明文 apiKey（adapter 发送时用）。
 *
 * KSCC HTTP 网关自动读取本机环境；其他 HTTP 渠道解密用户保存的凭据。
 */
export function getDecryptedApiKey(id: string): string {
  const ch = getChannel(id)
  if (!ch) return ''
  const codexProvider = getCodexConfigProvider(id)
  if (codexProvider) return resolveCodexConfigApiKey(codexProvider)
  if (isLocalRuntimeProvider(ch.provider)) return ''
  if (isGatewayProvider(ch.provider)) return readGatewayApiKey() || decryptKey(ch.apiKey)
  return decryptKey(ch.apiKey)
}

function getCodexConfigProvider(id: string): CodexModelProviderConfig | undefined {
  const prefix = id === 'codex-kscc' ? isKsccProvider : id === 'codex-tokenhub' ? isTokenHubProvider : undefined
  return prefix ? readCodexModelProviders().find(prefix) : undefined
}

/** 创建渠道 */
function validateHttpUrl(value: string): void {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return
  } catch { /* 使用统一错误 */ }
  throw new Error('渠道地址必须是有效的 HTTP(S) 地址')
}

function validateApiProtocol(value: unknown): ChannelApiProtocol | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'anthropic-messages' || value === 'openai-responses' || value === 'openai-chat') return value
  throw new Error('不支持的 API 协议')
}

export function createChannel(input: ChannelCreateInput): Channel {
  const apiProtocol = validateApiProtocol(input.apiProtocol)
  if (isBuiltinChannelProvider(input.provider)) {
    throw new Error('内置渠道不可手动创建')
  }
  validateHttpUrl(input.baseUrl)
  const now = Date.now()
  const models = input.models.length > 0 ? input.models : getDefaultModelsForProvider(input.provider)
  const channel: Channel = {
    id: randomUUID(),
    name: input.name,
    provider: input.provider,
    scope: 'external',
    ...(apiProtocol ? { apiProtocol } : {}),
    baseUrl: input.baseUrl,
    // 自动读取的 KSCC 凭据不会复制到配置。
    apiKey: encryptApiKey(input.apiKey),
    models,
    defaultModelId: normalizeDefaultModelId(models, input.defaultModelId),
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now,
  }
  const config = readConfig()
  config.channels.push(channel)
  writeConfig(config)
  return withCredentialStatus(channel)
}

/** 更新渠道（部分字段）。本机 Runtime 仅允许改 name/models/enabled/defaultModelId */
export function updateChannel(id: string, patch: ChannelUpdateInput): Channel | undefined {
  const config = readConfig()
  const idx = config.channels.findIndex((c) => c.id === id)
  const existing = idx === -1 ? undefined : config.channels[idx]
  if (!existing) return undefined

  const builtin = isBuiltinChannelProvider(existing.provider)
  const models = patch.models ?? existing.models
  const updated: Channel = {
    ...existing,
    name: patch.name ?? existing.name,
    models,
    enabled: patch.enabled ?? existing.enabled,
    defaultModelId: normalizeDefaultModelId(models, patch.defaultModelId ?? existing.defaultModelId),
    updatedAt: Date.now(),
  }

  const internal = existing.scope === 'internal' || builtin

  if (!internal) {
    if (patch.provider && isBuiltinChannelProvider(patch.provider)) {
      throw new Error('API 渠道不能改为内置渠道')
    }
    if (patch.baseUrl !== undefined) validateHttpUrl(patch.baseUrl)
    if (patch.apiProtocol !== undefined) {
      const protocol = validateApiProtocol(patch.apiProtocol)
      if (protocol) updated.apiProtocol = protocol
      else delete updated.apiProtocol
    }
    // 外部渠道：允许改 provider/baseUrl/apiKey
    if (patch.provider !== undefined) updated.provider = patch.provider
    if (patch.baseUrl !== undefined) updated.baseUrl = patch.baseUrl
    // apiKey 空串 = 不更新；非空 = 加密后覆盖
    if (patch.apiKey !== undefined && patch.apiKey !== '') {
      updated.apiKey = encryptApiKey(patch.apiKey)
    }
  }
  // 本机 Runtime：provider/baseUrl/apiKey 忽略（内置，用户改不了）

  if (isGatewayProvider(updated.provider) && updated.enabled && !readGatewayApiKey() && !decryptKey(updated.apiKey)) {
    throw new Error(GATEWAY_CREDENTIAL_MISSING_MESSAGE)
  }
  config.channels[idx] = updated
  writeConfig(config)
  return withCredentialStatus(updated)
}

/** 删除渠道。本机 Runtime 渠道不可删（按 provider 识别） */
export function deleteChannel(id: string): { ok: boolean; error?: string } {
  const ch = getChannel(id)
  if (ch && (ch.scope === 'internal' || isBuiltinChannelProvider(ch.provider))) {
    return { ok: false, error: '内部渠道不可删除' }
  }
  const config = readConfig()
  const next = config.channels.filter((c) => c.id !== id)
  if (next.length === config.channels.length) {
    return { ok: false, error: '渠道不存在' }
  }
  writeConfig({ ...config, channels: next })
  return { ok: true }
}

/** 兼容入口：迁移已有渠道，并按本机 KSCC 环境补齐内置 HTTP 渠道。 */
export function seedBuiltinChannels(): void { migrateHttpChannels() }

/**
 * 保留 Pi/HTTP 连接和历史 ID；恢复被通用迁移改名的 KSCC 自动认证网关。
 *
 * 打包版不会携带开发机的 channels.json，因此不能依赖配置文件里预先存在
 * `kscc-gateway`。只要本机能读到 KSCC 凭据，就自动创建一次内置网关卡片。
 * 已存在的渠道不覆盖用户的名称、地址、模型和启用状态。
 */
export function migrateHttpChannels(): void {
  const config = readConfig()
  let changed = false
  for (const channel of config.channels) {
    if (isLocalRuntimeProvider(channel.provider)) {
      if (channel.enabled) { channel.enabled = false; changed = true }
    } else if (isGatewayProvider(channel.provider)) {
      if (!channel.apiProtocol) { channel.apiProtocol = 'anthropic-messages'; changed = true }
      const ready = Boolean(readGatewayApiKey() || decryptKey(channel.apiKey))
      const wasRenamed = channel.name === 'HTTP 网关' || channel.name === 'HTTP 网关（兼容旧配置）'
      if (wasRenamed && ready && !channel.enabled) { channel.enabled = true; changed = true }
      if (!ready && channel.enabled) { channel.enabled = false; changed = true }
      if (wasRenamed || ['金山云网关', 'KSCC 内网', 'KSCC 内网网关'].includes(channel.name)) {
        channel.name = 'KSCC 网关'; changed = true
      }
    }
  }

  const codexProviders = readCodexModelProviders()
  const managedProviders = [
    { id: 'codex-kscc', name: 'KSCC 网关（内部）', provider: 'kscc-gateway' as const, match: isKsccProvider },
    { id: 'codex-tokenhub', name: 'TokenHub（内部）', provider: 'custom' as const, match: isTokenHubProvider },
  ]
  for (const managed of managedProviders) {
    const source = codexProviders.find(managed.match)
    if (!source) continue
    const existing = config.channels.find((channel) => channel.id === managed.id)
    const now = Date.now()
    const models = existing?.models?.length ? existing.models : getDefaultModelsForProvider(managed.provider)
    const next = {
      id: managed.id,
      name: managed.name,
      provider: managed.provider,
      scope: 'internal' as const,
      apiProtocol: resolveCodexConfigProtocol(source),
      baseUrl: source.baseUrl,
      apiKey: '',
      models,
      defaultModelId: existing?.defaultModelId ?? models.find((model) => model.enabled)?.id,
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (!existing) {
      config.channels.push(next)
      changed = true
    } else if (
      existing.name !== next.name ||
      existing.provider !== next.provider ||
      existing.scope !== next.scope ||
      existing.apiProtocol !== next.apiProtocol ||
      existing.baseUrl !== next.baseUrl ||
      existing.defaultModelId !== next.defaultModelId ||
      existing.enabled !== next.enabled ||
      JSON.stringify(existing.models) !== JSON.stringify(next.models)
    ) {
      Object.assign(existing, next)
      changed = true
    }
  }
  if (changed) writeConfig(config)
}

/**
 * 启动迁移：补全已有渠道模型的 contextWindow / safeContextLimit。
 *
 * 早期创建的渠道模型缺窗口字段（default-models 加字段之前），导致
 * resolveModelSafeContextLimit 全走 fallback 200k，1M 模型也按 140k 触发压缩。
 *
 * - kscc-internal：按 default-models.ts KSCC_DEFAULT_MODELS 补全（权威源）
 * - 外部渠道：缺 contextWindow 时用 inferContextWindow(modelId) 推断
 * - 幂等：已有字段不覆盖，仅补缺失
 */
export function migrateModelWindows(): void {
  const config = readConfig()
  let changed = false

  for (const channel of config.channels) {
    for (const model of channel.models) {
      const inferred = inferContextWindow(model.id)

      // 早期渠道会把所有外部模型写成 200k。对已知更大窗口的模型，
      // 将这个旧默认值升级为推断值；用户显式填过其它窗口则保留。
      if (
        model.contextWindow === DEFAULT_CONTEXT_WINDOW &&
        inferred &&
        inferred > DEFAULT_CONTEXT_WINDOW
      ) {
        model.contextWindow = inferred
        changed = true
        continue
      }

      if (model.contextWindow && model.contextWindow > 0) continue

      if (isGatewayProvider(channel.provider) || channel.provider === 'kscc-internal') {
        const defaults = KSCC_DEFAULT_MODELS.find((d) => d.id === model.id)
        if (defaults?.contextWindow) {
          model.contextWindow = defaults.contextWindow
          if (defaults.safeContextLimit && !model.safeContextLimit) {
            model.safeContextLimit = defaults.safeContextLimit
          }
          changed = true
        }
      } else if (channel.provider === 'codex-internal') {
        const defaults = CODEX_DEFAULT_MODELS.find((d) => d.id === model.id)
        if (defaults?.contextWindow) {
          model.contextWindow = defaults.contextWindow
          changed = true
        }
      } else {
        if (inferred && inferred > 0) {
          model.contextWindow = inferred
          changed = true
        }
      }
    }
  }

  if (changed) {
    writeConfig(config)
    console.log('[渠道存储] 已补全模型 contextWindow 字段')
  }
}
