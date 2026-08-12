/**
 * 渠道存储（精简版，从 TAgent channel-manager.ts 按需搬移）
 *
 * 职责：
 * - 渠道 CRUD（~/.tagent[-dev]/channels.json）
 * - API Key 加密/解密（Electron safeStorage，底层 OS 级加密）
 * - 启动时 seed kscc-internal 内置渠道（OAuth，无 apiKey，不可删）
 *
 * kscc-internal 是特殊渠道：
 * - 走 OAuth（kscc native exe 内置 token + 内置网关），不填 apiKey
 * - 内置 baseUrl + 模型列表
 * - 不可删除，仅允许改 name/models/enabled/defaultModelId
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
  ProviderType,
} from '@tagent/shared'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getChannelsPath } from '../config/config-paths'
import { getDefaultModelsForProvider, KSCC_DEFAULT_MODEL_ID, KSCC_DEFAULT_MODELS } from './default-models'
import { inferContextWindow } from '@tagent/shared'
import { resolveKsccPath } from '../adapters/claude/kscc-path'

/** 启用 / 依赖 kscc 内置渠道时的统一错误文案（与 channel-tester / session-service 一致） */
export const KSCC_MISSING_MESSAGE = '未检测到 kscc 命令，请先安装 kscc（内网渠道）后再启用'

/** kscc 内置渠道 seed 时用的固定 ID（仅 fresh 安装时用；识别 kscc 一律按 provider） */
const KSCC_BUILTIN_CHANNEL_ID = 'kscc-internal'

/** 配置版本号 */
const CONFIG_VERSION = 1

/** 取 kscc 内置渠道 ID（按 provider 识别，兼容 TAgent_General 用随机 UUID id 的情况） */
export function getKsccChannelId(): string | undefined {
  return readConfig().channels.find((c) => c.provider === 'kscc-internal')?.id
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

/** 取明文 apiKey（adapter 发送时用；kscc-internal 返回空串） */
export function getDecryptedApiKey(id: string): string {
  const ch = getChannel(id)
  if (!ch) return ''
  if (ch.provider === 'kscc-internal') return ''
  return decryptKey(ch.apiKey)
}

/** 创建渠道 */
export function createChannel(input: ChannelCreateInput): Channel {
  const now = Date.now()
  const models = input.models.length > 0 ? input.models : getDefaultModelsForProvider(input.provider)
  const channel: Channel = {
    id: randomUUID(),
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl,
    // kscc-internal 不加密（无 apiKey）；其余加密
    apiKey: input.provider === 'kscc-internal' ? '' : encryptApiKey(input.apiKey),
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

/** 更新渠道（部分字段）。kscc-internal 仅允许改 name/models/enabled/defaultModelId */
export function updateChannel(id: string, patch: ChannelUpdateInput): Channel | undefined {
  const config = readConfig()
  const idx = config.channels.findIndex((c) => c.id === id)
  const existing = idx === -1 ? undefined : config.channels[idx]
  if (!existing) return undefined

  const kscc = existing.provider === 'kscc-internal'
  // 无本机 kscc 时禁止启用内置渠道（避免用户「打开」后发送才炸）
  if (kscc && patch.enabled === true && !resolveKsccPath()) {
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

  if (!kscc) {
    // 外部渠道：允许改 provider/baseUrl/apiKey
    if (patch.provider !== undefined) updated.provider = patch.provider
    if (patch.baseUrl !== undefined) updated.baseUrl = patch.baseUrl
    // apiKey 空串 = 不更新；非空 = 加密后覆盖
    if (patch.apiKey !== undefined && patch.apiKey !== '') {
      updated.apiKey = encryptApiKey(patch.apiKey)
    }
  }
  // kscc-internal：provider/baseUrl/apiKey 忽略（内置，用户改不了）

  config.channels[idx] = updated
  writeConfig(config)
  return updated
}

/** 删除渠道。kscc-internal 不可删（按 provider 识别） */
export function deleteChannel(id: string): { ok: boolean; error?: string } {
  const ch = getChannel(id)
  if (ch?.provider === 'kscc-internal') {
    return { ok: false, error: 'kscc 内置渠道不可删除' }
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
 * 启动时 seed kscc-internal 内置渠道（幂等）。
 *
 * kscc 走 OAuth，不填 apiKey；baseUrl 留空（kscc native exe 内置网关地址）；
 * 模型列表用 KSCC_DEFAULT_MODELS。已存在任意 kscc-internal 渠道则不覆盖（按 provider 判定，
 * 兼容 TAgent_General 用随机 UUID id 写入的 kscc 渠道，避免共享 ~/.tagent-dev/ 时重复 seed）。
 */
export function seedBuiltinChannels(): void {
  const config = readConfig()
  const exists = config.channels.some((c) => c.provider === 'kscc-internal')
  if (exists) return
  const now = Date.now()
  const ksccReady = Boolean(resolveKsccPath())
  const kscc: Channel = {
    id: KSCC_BUILTIN_CHANNEL_ID,
    name: 'kscc 内网',
    provider: 'kscc-internal' as ProviderType,
    baseUrl: '',
    apiKey: '',
    models: KSCC_DEFAULT_MODELS.map((m) => ({ ...m })),
    defaultModelId: KSCC_DEFAULT_MODEL_ID,
    // 无本机 kscc 时默认不启用，避免新装机「开箱就能选内网核却必炸」
    enabled: ksccReady,
    createdAt: now,
    updatedAt: now,
  }
  config.channels.push(kscc)
  writeConfig(config)
  console.log(
    `[渠道存储] 已 seed kscc-internal 内置渠道（enabled=${ksccReady}${ksccReady ? '' : '，本机无 kscc'}）`,
  )
}

/**
 * 启动时同步 kscc 可用性：本机无 kscc 命令则强制停用所有 kscc-internal 渠道。
 * 不自动重新启用（用户装好 kscc 后需在设置里手动打开，或点「测试」确认后启用）。
 * @returns 被强制停用的渠道数
 */
export function syncKsccChannelAvailability(): number {
  const ready = Boolean(resolveKsccPath())
  if (ready) return 0
  const config = readConfig()
  let changed = 0
  const next = config.channels.map((c) => {
    if (c.provider !== 'kscc-internal' || !c.enabled) return c
    changed++
    return { ...c, enabled: false, updatedAt: Date.now() }
  })
  if (changed > 0) {
    writeConfig({ ...config, channels: next })
    console.warn(
      `[渠道存储] 本机未检测到 kscc，已强制停用 ${changed} 个 kscc-internal 渠道`,
    )
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
      if (model.contextWindow && model.contextWindow > 0) continue

      if (channel.provider === 'kscc-internal') {
        const defaults = KSCC_DEFAULT_MODELS.find((d) => d.id === model.id)
        if (defaults?.contextWindow) {
          model.contextWindow = defaults.contextWindow
          if (defaults.safeContextLimit && !model.safeContextLimit) {
            model.safeContextLimit = defaults.safeContextLimit
          }
          changed = true
        }
      } else {
        const inferred = inferContextWindow(model.id)
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
