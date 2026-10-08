/**
 * 渠道（Channel）相关类型定义
 *
 * 渠道是用户配置的 AI 供应商连接，包含 API Key、模型列表等信息。
 * API Key 使用 Electron safeStorage 加密后存储在本地配置文件中。
 */

/**
 * 支持的 AI 供应商类型
 */
export type ProviderType =
  | 'anthropic'
  | 'anthropic-compatible'
  | 'openai'
  | 'deepseek'
  | 'google'
  | 'kimi-api'
  | 'kimi-coding'
  | 'zhipu'
  | 'zhipu-coding'
  | 'minimax'
  | 'doubao'
  | 'qwen'
  | 'qwen-anthropic'
  | 'xiaomi'
  | 'xiaomi-token-plan'
  | 'kscc-internal'
  | 'codex-internal'
  | 'kscc-gateway'
  | 'custom'

/** Explicit wire format; unset preserves the legacy provider mapping. */
export type ChannelApiProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat'

/**
 * 各供应商的默认 Base URL
 */
export const PROVIDER_DEFAULT_URLS: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com',
  'anthropic-compatible': '',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/anthropic',
  google: 'https://generativelanguage.googleapis.com',
  'kimi-api': 'https://api.moonshot.cn/anthropic',
  'kimi-coding': 'https://api.kimi.com/coding/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  'zhipu-coding': 'https://open.bigmodel.cn/api/anthropic',
  minimax: 'https://api.minimaxi.com/anthropic',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'qwen-anthropic': 'https://dashscope.aliyuncs.com/apps/anthropic',
  xiaomi: 'https://api.xiaomimimo.com/anthropic',
  'xiaomi-token-plan': 'https://token-plan-cn.xiaomimimo.com/anthropic',
  'kscc-internal': '', // 内置默认值，无需配置
  'codex-internal': '', // 本机 App Server，无需 API Key
  // 公司内网 kscc 网关（HTTP）。**不要带 /v1**：Anthropic SDK 的请求路径固定为
  // /v1/messages，baseURL 里再带版本段会被拼成 /v1/v1/messages 而 404。
  'kscc-gateway': 'http://120.92.138.34',
  custom: '',
}

/**
 * 供应商显示名称
 */
export const PROVIDER_LABELS: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  'anthropic-compatible': 'Anthropic 兼容格式',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  google: 'Google',
  'kimi-api': 'Kimi API (Anthropic 协议)',
  'kimi-coding': 'Kimi Coding Plan',
  zhipu: '智谱 AI',
  'zhipu-coding': '智谱 Coding Plan',
  minimax: 'MiniMax (API&编程包)',
  doubao: '豆包',
  qwen: '通义千问',
  'qwen-anthropic': '通义千问 (Anthropic 协议)',
  xiaomi: '小米 MiMo (API)',
  'xiaomi-token-plan': '小米 MiMo Token Plan',
  'kscc-internal': '金山云',
  'codex-internal': 'Codex App Server',
  'kscc-gateway': '金山云网关',
  custom: 'OpenAI 兼容格式',
}

/**
 * 支持 Agent 模式的供应商类型
 *
 * Agent SDK 通过 Anthropic 兼容协议调用 `/v1/messages` 端点，
 * 因此所有 Anthropic 协议兼容的供应商都可以用于 Agent。
 */
export const AGENT_COMPATIBLE_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'anthropic',
  'anthropic-compatible',
  'deepseek',
  'kimi-api',
  'kimi-coding',
  'zhipu-coding',
  'minimax',
  'xiaomi',
  'xiaomi-token-plan',
  'qwen-anthropic',
  'kscc-internal',
  'kscc-gateway',
])

/**
 * 本机原生 Runtime 凭据不自持的 Provider（无 apiKey、无外部 HTTP 协议）。
 *
 * 注意：这个集合**只**表示「不出本机、无 apiKey」这一条语义。
 * 「渠道页是否显示为内置卡片 / 能否新建删除」见 {@link BUILTIN_CHANNEL_PROVIDERS}。
 */
export const LOCAL_RUNTIME_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'kscc-internal',
  'codex-internal',
])

export function isLocalRuntimeProvider(provider: ProviderType): boolean {
  return LOCAL_RUNTIME_PROVIDERS.has(provider)
}

/**
 * 内置渠道：随应用预置、在渠道管理页显示为内置卡片、不可新建/删除/改连接配置。
 *
 * 与 {@link LOCAL_RUNTIME_PROVIDERS} 的区别：内置渠道**可以**自带凭据、**可以**进官方内核
 * （例如 kscc-gateway 的 sk 从本机 kscc 配置读取）。
 */
export const BUILTIN_CHANNEL_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'kscc-internal',
  'codex-internal',
  'kscc-gateway',
])

export function isBuiltinChannelProvider(provider: ProviderType): boolean {
  return BUILTIN_CHANNEL_PROVIDERS.has(provider)
}

/** 已废弃的本机 CLI 通路 Provider；历史记录保留，但不再可运行。 */
export const LEGACY_CLI_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'kscc-internal',
])

export function isLegacyCliProvider(provider: ProviderType): boolean {
  return LEGACY_CLI_PROVIDERS.has(provider)
}

/** 内置 HTTP 网关渠道；需要注入客户端标识头，凭据取自本机 kscc 配置。 */
export const GATEWAY_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'kscc-gateway',
])

export function isGatewayProvider(provider: ProviderType): boolean {
  return GATEWAY_PROVIDERS.has(provider)
}

/**
 * 内置网关渠道必须携带的客户端标识头。
 *
 * 公司 kscc 网关按 `ksyun-code-type` 做客户端准入：不带该头一律 403 ClientForbidden，
 * 但**不校验值**（实测 `code` 与任意值均可通过）。`code` 取自公司内部 Zoo Code 分发的配置。
 */
export const GATEWAY_CLIENT_HEADERS: Readonly<Record<string, string>> = {
  'ksyun-code-type': 'code',
}

/** 取某渠道需要附带的自定义请求头；非网关渠道返回空对象。 */
export function resolveChannelCustomHeaders(provider: ProviderType): Record<string, string> {
  return isGatewayProvider(provider) ? { ...GATEWAY_CLIENT_HEADERS } : {}
}

/**
 * 内置网关渠道的完整请求头。
 *
 * 网关实测只认 `authorization: Bearer`——单独发 `x-api-key`（Anthropic SDK 的默认行为、
 * 官方 Claude Code 的 `ANTHROPIC_API_KEY` 路径）会得到 403 `ApiKeyForbidden`。
 * 因此凡是可能走 Anthropic 协议 SDK 的路径，都要显式带上 Bearer。
 */
export function resolveChannelRequestHeaders(
  provider: ProviderType,
  apiKey: string,
): Record<string, string> {
  if (!isGatewayProvider(provider)) return {}
  return {
    ...GATEWAY_CLIENT_HEADERS,
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
}

/**
 * 判断供应商是否兼容 Agent 模式
 */
export function isAgentCompatibleProvider(provider: ProviderType): boolean {
  return AGENT_COMPATIBLE_PROVIDERS.has(provider)
}

/**
 * 渠道中的模型配置
 */
export interface ChannelModel {
  /** 模型唯一标识（如 claude-sonnet-4-5-20250929） */
  id: string
  /** 模型显示名称 */
  name: string
  /** 是否启用 */
  enabled: boolean
  /**
   * 模型标称上下文窗口（token），如 200_000 / 1_000_000。
   * 用于 8k 四层预算比例 + compaction 阈值分母。缺省走运行时 fallback（200k）。
   */
  contextWindow?: number
  /**
   * 实测安全上限（token）。软重置/压缩按此提前触发，避免撞真实爆点。
   * 优先级：此字段 > 自学习回写值 > contextWindow × 0.7 > fallback。
   * 用户实测过的模型手动填（如 GLM-5.2 标 1M 实测 256k 爆 → 填 180_000）。
   */
  safeContextLimit?: number
}

/**
 * 渠道配置
 *
 * 存储在 ~/.tagent/channels.json 中，apiKey 字段为加密后的 base64 字符串
 */
export interface Channel {
  apiProtocol?: ChannelApiProtocol
  /** 渠道唯一标识 */
  id: string
  /** 渠道名称（用户自定义） */
  name: string
  /** AI 供应商类型 */
  provider: ProviderType
  /** API Base URL */
  baseUrl: string
  /** 加密后的 API Key（base64 编码） */
  apiKey: string
  /** 可用模型列表 */
  models: ChannelModel[]
  /** 该渠道的默认模型（须为已启用模型之一；未设则用第一个已启用模型） */
  defaultModelId?: string
  /** 是否启用 */
  enabled: boolean
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

/**
 * 创建渠道时的输入数据（apiKey 为明文）
 */
export interface ChannelCreateInput {
  apiProtocol?: ChannelApiProtocol
  name: string
  provider: ProviderType
  baseUrl: string
  /** 明文 API Key，主进程会加密后存储 */
  apiKey: string
  models: ChannelModel[]
  /** 该渠道的默认模型（须为已启用模型之一） */
  defaultModelId?: string
  enabled: boolean
}

/**
 * 更新渠道时的输入数据（所有字段可选）
 */
export interface ChannelUpdateInput {
  apiProtocol?: ChannelApiProtocol | null
  name?: string
  provider?: ProviderType
  baseUrl?: string
  /** 明文 API Key，为空字符串表示不更新 */
  apiKey?: string
  models?: ChannelModel[]
  /** 该渠道的默认模型（须为已启用模型之一） */
  defaultModelId?: string
  enabled?: boolean
}

/**
 * 渠道配置文件格式
 */
export interface ChannelsConfig {
  /** 配置版本号 */
  version: number
  /** 渠道列表 */
  channels: Channel[]
}

/**
 * 连接测试结果
 */
export interface ChannelTestResult {
  /** 是否成功 */
  success: boolean
  /** 结果消息 */
  message: string
}

/**
 * P0-2: 验证指定 model 名（防止 9120caac 那类 model 名误配导致 400 (2013)）
 */
export interface ChannelModelValidateInput {
  apiProtocol?: ChannelApiProtocol
  baseUrl: string
  apiKey: string
  model: string
  provider: ProviderType
  proxyUrl?: string
}

/**
 * 拉取模型的输入参数（无需已保存的渠道，直接传入凭证）
 */
export interface FetchModelsInput {
  apiProtocol?: ChannelApiProtocol
  provider: ProviderType
  baseUrl: string
  /** 明文 API Key */
  apiKey: string
}

/**
 * 使用已保存渠道的加密凭据拉取模型。
 * 地址与供应商同样取已保存值，避免把密钥发送到渲染进程指定的任意地址。
 */
export interface FetchModelsForChannelInput {
  channelId: string
}

/**
 * 拉取模型的结果
 */
export interface FetchModelsResult {
  /** 是否成功 */
  success: boolean
  /** 结果消息 */
  message: string
  /** 获取到的模型列表 */
  models: ChannelModel[]
}

/**
 * 渠道相关 IPC 通道常量
 */
export const CHANNEL_IPC_CHANNELS = {
  /** 获取所有渠道列表 */
  LIST: 'channel:list',
  /** 创建渠道 */
  CREATE: 'channel:create',
  /** 更新渠道 */
  UPDATE: 'channel:update',
  /** 删除渠道 */
  DELETE: 'channel:delete',
  /** 测试渠道连接 */
  TEST: 'channel:test',
  /** 从供应商拉取可用模型列表 */
  FETCH_MODELS: 'channel:fetch-models',
  /** 使用已保存渠道的凭据拉取模型（明文密钥不进入渲染进程） */
  FETCH_MODELS_FOR_CHANNEL: 'channel:fetch-models-for-channel',
  /** 直接测试连接（无需已保存渠道，传入明文凭证） */
  TEST_DIRECT: 'channel:test-direct',
  /** 验证指定 model 名是否被供应商接受（P0-2, 防止 9120caac 那类 400 (2013)）*/
  VALIDATE_MODEL: 'channel:validate-model',
  /** 测速（TTFB，首字延迟） */
  SPEED_TEST: 'channel:speed-test',
} as const

/** 单个模型的测速结果 */
export interface ModelSpeedTestResult {
  channelId: string
  modelId: string
  success: boolean
  /** 首字延迟（ms），失败时为 null */
  ttfbMs: number | null
  /** 总耗时（ms），失败时为 null */
  totalTimeMs: number | null
  message: string
}

/** 批量测速输入：用户选择的模型列表 */
export interface SpeedTestInput {
  items: Array<{ channelId: string; modelId: string }>
}

/** 批量测速结果 */
export interface SpeedTestBatchResult {
  /** key 格式 "{channelId}:{modelId}" */
  results: Record<string, ModelSpeedTestResult>
}
