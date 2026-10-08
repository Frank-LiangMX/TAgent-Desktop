/**
 * 渠道存储（精简版，从 TAgent channel-manager.ts 按需搬移）
 *
 * 职责：
 * - 渠道 CRUD（~/.tagent[-dev]/channels.json）
 * - API Key 加密/解密（Electron safeStorage，底层 OS 级加密）
 * - 内置渠道（见 BUILTIN_CHANNEL_PROVIDERS）：随应用预置，不可新建/删除
 *
 * 内置渠道分两类：
 * - 本机 Runtime（kscc-internal / codex-internal）：走本机进程或 App Server，不填 apiKey
 * - 内置网关（kscc-gateway）：直连公司内网 kscc 网关，凭据从本机 kscc 配置读取
 *
 * 内置渠道不可删除，仅允许改 name/models/enabled/defaultModelId。
 *
 * 见 docs/plans/2026-07-25-2.0-architecture-decision-dual-core.md §1.5。
 */
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
  isLegacyCliProvider,
  isLocalRuntimeProvider,
  PROVIDER_DEFAULT_URLS,
  PROVIDER_LABELS,
} from '@tagent/shared'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getChannelsPath } from '../config/config-paths'
import {
  CODEX_DEFAULT_MODEL_ID,
  CODEX_DEFAULT_MODELS,
  CODEX_LEGACY_MODEL_ID,
  getDefaultModelsForProvider,
  KSCC_DEFAULT_MODELS,
  KSCC_DEFAULT_MODEL_ID,
} from './default-models'
import {
  GATEWAY_CREDENTIAL_MISSING_MESSAGE,
  readGatewayApiKey,
} from './gateway-credential'

/** 启用内置网关渠道但本机无 kscc 凭据时的统一错误文案（与 session-service 一致）。 */
export const KSCC_MISSING_MESSAGE = GATEWAY_CREDENTIAL_MISSING_MESSAGE

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
 * 外部渠道是 Pi 主线；本机网关 / Codex 只在用户明确选择对应内置渠道时参与。
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
}

/** 取单个渠道 */
export function getChannel(id: string): Channel | undefined {
  return readConfig().channels.find((c) => c.id === id)
}

/**
 * 取明文 apiKey（adapter 发送时用）。
 *
 * - 本机 Runtime 渠道：空串（凭据由本机进程自持）
 * - 内置网关渠道：从本机 kscc 配置读取（不落 channels.json）
 * - 外部渠道：解密存储的密文
 */
export function getDecryptedApiKey(id: string): string {
  const ch = getChannel(id)
  if (!ch) return ''
  if (isGatewayProvider(ch.provider)) return readGatewayApiKey()
  if (isLocalRuntimeProvider(ch.provider)) return ''
  return decryptKey(ch.apiKey)
}

/** 创建渠道 */
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
  const now = Date.now()
  const models = input.models.length > 0 ? input.models : getDefaultModelsForProvider(input.provider)
  const channel: Channel = {
    id: randomUUID(),
    name: input.name,
    provider: input.provider,
    ...(apiProtocol ? { apiProtocol } : {}),
    baseUrl: input.baseUrl,
    // createChannel 已拒绝本机 Runtime Provider，这里只处理外部渠道凭据。
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
  return channel
}

/** 更新渠道（部分字段）。本机 Runtime 仅允许改 name/models/enabled/defaultModelId */
export function updateChannel(id: string, patch: ChannelUpdateInput): Channel | undefined {
  const config = readConfig()
  const idx = config.channels.findIndex((c) => c.id === id)
  const existing = idx === -1 ? undefined : config.channels[idx]
  if (!existing) return undefined

  const builtin = isBuiltinChannelProvider(existing.provider)
  // 无本机 kscc 凭据时禁止启用内置网关渠道（避免用户「打开」后发送才炸）
  if (
    isGatewayProvider(existing.provider) &&
    patch.enabled === true &&
    !readGatewayApiKey()
  ) {
    throw new Error(KSCC_MISSING_MESSAGE)
  }

  const models = patch.models ?? existing.models
  const updated: Channel = {
    ...existing,
    name: patch.name ?? existing.name,
    models,
    enabled: patch.enabled ?? existing.enabled,
    defaultModelId: normalizeDefaultModelId(models, patch.defaultModelId ?? existing.defaultModelId),
    updatedAt: Date.now(),
  }

  if (!builtin) {
    if (patch.provider && isBuiltinChannelProvider(patch.provider)) {
      throw new Error('API 渠道不能改为内置渠道')
    }
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

  config.channels[idx] = updated
  writeConfig(config)
  return updated
}

/** 删除渠道。本机 Runtime 渠道不可删（按 provider 识别） */
export function deleteChannel(id: string): { ok: boolean; error?: string } {
  const ch = getChannel(id)
  if (ch && isBuiltinChannelProvider(ch.provider)) {
    return { ok: false, error: '内置渠道不可删除' }
  }
  const config = readConfig()
  const next = config.channels.filter((c) => c.id !== id)
  if (next.length === config.channels.length) {
    return { ok: false, error: '渠道不存在' }
  }
  writeConfig({ ...config, channels: next })
  return { ok: true }
}

/**
 * 启动时确保内置网关渠道存在（幂等：按 provider 查重，不覆盖已有记录）。
 *
 * 渠道页把内置渠道显示为不可新建/删除的卡片；凭据来自本机 kscc 配置，
 * 因此只建记录、不写 apiKey。
 */
export function seedBuiltinChannels(): void {
  const config = readConfig()
  const expectedUrl = PROVIDER_DEFAULT_URLS['kscc-gateway']
  const existing = config.channels.filter((c) => isGatewayProvider(c.provider))

  if (existing.length > 0) {
    // 修正历史 baseUrl：早期写成带 /v1 的地址，会被 Anthropic SDK 重复拼成
    // /v1/v1/messages 而 404。
    let changed = false
    const next = config.channels.map((c) => {
      if (isGatewayProvider(c.provider) && c.baseUrl !== expectedUrl) {
        changed = true
        return { ...c, baseUrl: expectedUrl, updatedAt: Date.now() }
      }
      return c
    })
    if (changed) {
      writeConfig({ ...config, channels: next })
      console.log('[渠道存储] 已修正内置网关渠道 baseUrl')
    }
    return
  }

  const models = KSCC_DEFAULT_MODELS.map((m) => ({ ...m }))
  const now = Date.now()
  config.channels.push({
    id: randomUUID(),
    name: PROVIDER_LABELS['kscc-gateway'],
    provider: 'kscc-gateway',
    apiProtocol: 'anthropic-messages',
    baseUrl: expectedUrl,
    apiKey: '',
    models,
    defaultModelId: normalizeDefaultModelId(models, KSCC_DEFAULT_MODEL_ID),
    enabled: Boolean(readGatewayApiKey()),
    createdAt: now,
    updatedAt: now,
  })
  writeConfig(config)
  console.log('[渠道存储] 已创建内置网关渠道')
}

/**
 * 启动时同步内置网关渠道的可用性：本机无 kscc 凭据则强制停用。
 * 不自动重新启用（用户配好 kscc 后需在渠道页手动打开，或点「测试」确认后启用）。
 * @returns 被强制停用的渠道数
 */
export function syncGatewayChannelAvailability(): number {
  const ready = Boolean(readGatewayApiKey())
  if (ready) return 0
  const config = readConfig()
  let changed = 0
  const next = config.channels.map((c) => {
    if (!isGatewayProvider(c.provider) || !c.enabled) return c
    changed++
    return { ...c, enabled: false, updatedAt: Date.now() }
  })
  if (changed > 0) {
    writeConfig({ ...config, channels: next })
    console.warn(
      `[渠道存储] 本机未检测到 kscc 凭据，已强制停用 ${changed} 个内置网关渠道`,
    )
  }
  return changed
}

/**
 * 启动迁移：清理重复的 legacy `kscc-internal` 渠道记录。
 *
 * CLI 通路移除后这些记录已不可运行（不出现在渠道页、进不了任何内核），
 * 但历史上可能因多次迁移留下同 provider 的多条记录。保留第一条，其余删除。
 *
 * 只删**重复**项：唯一一条 legacy 记录（若有旧会话绑定）原样保留。
 * @returns 被删除的条数
 */
export function dedupeLegacyKsccChannels(): number {
  const config = readConfig()
  let kept = false
  let removed = 0
  const next = config.channels.filter((c) => {
    if (!isLegacyCliProvider(c.provider)) return true
    if (kept) {
      removed++
      return false
    }
    kept = true
    return true
  })
  if (removed === 0) return 0
  writeConfig({ ...config, channels: next })
  console.log(`[渠道存储] 已清理 ${removed} 条重复的 legacy kscc 渠道记录`)
  return removed
}

/** Codex Runtime 安装后启用本机渠道；不可用时只停用，不覆盖用户主动停用。 */
export function syncCodexChannelAvailability(
  enableIfAvailable = false,
  ready?: boolean,
): number {
  // 不在同步渠道 CRUD / 启动路径中探测 Runtime。ready 由异步探针或安装成功回调提供。
  if (ready === undefined) return 0
  const config = readConfig()
  let changed = 0
  const next = config.channels.map((c) => {
    if (c.provider !== 'codex-internal') return c
    if (!ready && c.enabled) {
      changed++
      return { ...c, enabled: false, updatedAt: Date.now() }
    }
    if (ready && enableIfAvailable && !c.enabled) {
      changed++
      return { ...c, enabled: true, updatedAt: Date.now() }
    }
    return c
  })
  if (changed > 0) writeConfig({ ...config, channels: next })
  return changed
}

/**
 * 启动迁移：把 KSCC_DEFAULT_MODELS 中尚未出现的模型追加到已有内置网关渠道。
 * seed 对已存在渠道是幂等跳过的，否则网关新上的模型进不了选项。
 * 不改用户已有项的 enabled / 顺序 / 自定义字段；仅按 id 追加缺项。
 * @returns 追加的模型条数
 */
export function syncKsccDefaultModels(): number {
  const config = readConfig()
  let added = 0
  const next = config.channels.map((c) => {
    if (!isGatewayProvider(c.provider)) return c
    const have = new Set(c.models.map((m) => m.id))
    const missing = KSCC_DEFAULT_MODELS.filter((d) => !have.has(d.id)).map((m) => ({ ...m }))
    if (missing.length === 0) return c
    added += missing.length
    return { ...c, models: [...c.models, ...missing], updatedAt: Date.now() }
  })
  if (added > 0) {
    writeConfig({ ...config, channels: next })
    console.log(`[渠道存储] 已为内置网关渠道追加 ${added} 个默认模型`)
  }
  return added
}

/**
 * 启动迁移：把 Codex 内置渠道从旧的占位模型升级为正式模型列表。
 *
 * 旧版本使用 `codex-default`，它既不是 Codex 的真实模型 ID，也会让
 * 会话元数据无法表达实际使用的模型。将旧占位项迁移为 Sol，再追加
 * Terra / Luna；已有的用户启用状态保留。
 *
 * @returns 发生变化的模型条数
 */
export function syncCodexDefaultModels(): number {
  const config = readConfig()
  let changed = 0
  const next = config.channels.map((channel) => {
    if (channel.provider !== 'codex-internal') return channel

    let models = channel.models
    let modelListChanged = false
    const legacy = models.find((model) => model.id === CODEX_LEGACY_MODEL_ID)
    const hasSol = models.some((model) => model.id === CODEX_DEFAULT_MODEL_ID)

    if (legacy && !hasSol) {
      models = models.map((model) =>
        model.id === CODEX_LEGACY_MODEL_ID
          ? {
              ...model,
              ...CODEX_DEFAULT_MODELS[0],
              enabled: model.enabled,
            }
          : model,
      )
      modelListChanged = true
      changed++
    } else if (legacy) {
      models = models.filter((model) => model.id !== CODEX_LEGACY_MODEL_ID)
      modelListChanged = true
      changed++
    }

    const have = new Set(models.map((model) => model.id))
    const missing = CODEX_DEFAULT_MODELS.filter((model) => !have.has(model.id)).map(
      (model) => ({ ...model }),
    )
    const nextDefaultModelId =
      channel.defaultModelId === CODEX_LEGACY_MODEL_ID ||
      !channel.defaultModelId ||
      !models.some(
        (model) => model.id === channel.defaultModelId && model.enabled,
      )
        ? CODEX_DEFAULT_MODEL_ID
        : channel.defaultModelId
    const defaultChanged = nextDefaultModelId !== channel.defaultModelId
    if (
      missing.length === 0 &&
      !modelListChanged &&
      !defaultChanged
    ) {
      return channel
    }

    changed += missing.length
    if (defaultChanged) changed++
    return {
      ...channel,
      models: [...models, ...missing],
      defaultModelId: nextDefaultModelId,
      updatedAt: Date.now(),
    }
  })

  if (changed > 0) {
    writeConfig({ ...config, channels: next })
    console.log(`[渠道存储] 已为 codex-internal 升级正式模型列表，变更 ${changed} 项`)
  }
  return changed
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
