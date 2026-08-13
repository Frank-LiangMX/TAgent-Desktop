/**
 * 各 Provider 内置默认模型列表
 *
 * 用途：
 * - kscc-internal：seed 内置渠道时写入（kscc 网关代理的模型，OAuth 无需 apiKey）
 * - 外部渠道：新建渠道时预填 + FETCH_MODELS IPC 返回（真实拉取未实现前用此兜底）
 *
 * 用户可在渠道管理 UI 里增删改模型，此处仅是初始默认值。
 */
import type { Channel, ChannelModel, ProviderType } from '@tagent/shared'

/** kscc 内网渠道默认模型（与 TAgent kscc-config.ts 保持一致） */
export const KSCC_DEFAULT_MODELS: ChannelModel[] = [
  { id: 'glm-5.1', name: 'GLM-5.1', enabled: true, contextWindow: 200_000 },
  { id: 'glm-5.2', name: 'GLM-5.2 (1M)', enabled: true, contextWindow: 1_000_000 },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', enabled: true, contextWindow: 200_000 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', enabled: true, contextWindow: 200_000 },
  { id: 'kimi-k3', name: 'Kimi K3', enabled: true, contextWindow: 200_000 },
  { id: 'mimo-v2.5', name: 'MiMo V2.5 (1M)', enabled: true, contextWindow: 1_000_000 },
  { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro (1M)', enabled: true, contextWindow: 1_000_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (1M)', enabled: true, contextWindow: 1_000_000 },
]

/** kscc 内置渠道默认模型 ID */
export const KSCC_DEFAULT_MODEL_ID = 'glm-5.2'

/** 各外部 Provider 的默认模型列表（仅常见 Provider 预填，其余空由用户填） */
const EXTERNAL_DEFAULT_MODELS: Partial<Record<ProviderType, ChannelModel[]>> = {
  anthropic: [
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', enabled: true, contextWindow: 200_000 },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', enabled: true, contextWindow: 200_000 },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', enabled: true, contextWindow: 200_000 },
  ],
  'anthropic-compatible': [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', enabled: true, contextWindow: 200_000 }],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', enabled: true, contextWindow: 64_000 },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', enabled: true, contextWindow: 64_000 },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', enabled: true, contextWindow: 128_000 },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', enabled: true, contextWindow: 128_000 },
  ],
  'kimi-api': [{ id: 'kimi-k2', name: 'Kimi K2', enabled: true, contextWindow: 200_000 }],
  'kimi-coding': [{ id: 'kimi-k2', name: 'Kimi K2', enabled: true, contextWindow: 200_000 }],
  zhipu: [{ id: 'glm-4.6', name: 'GLM-4.6', enabled: true, contextWindow: 128_000 }],
  'zhipu-coding': [{ id: 'glm-4.6', name: 'GLM-4.6', enabled: true, contextWindow: 128_000 }],
  minimax: [{ id: 'abab6.5s-chat', name: 'abab6.5s', enabled: true, contextWindow: 245_760 }],
  doubao: [{ id: 'doubao-1-5-pro-32k', name: 'Doubao 1.5 Pro', enabled: true, contextWindow: 32_000 }],
  qwen: [{ id: 'qwen-max', name: 'Qwen Max', enabled: true, contextWindow: 32_000 }],
  'qwen-anthropic': [{ id: 'qwen-max', name: 'Qwen Max', enabled: true, contextWindow: 32_000 }],
  xiaomi: [{ id: 'mimo-v2.5', name: 'MiMo V2.5', enabled: true, contextWindow: 1_000_000 }],
  'xiaomi-token-plan': [{ id: 'mimo-v2.5', name: 'MiMo V2.5', enabled: true, contextWindow: 1_000_000 }],
}

/** 取某 Provider 的默认模型列表（无预填则返回空数组，由用户手动填） */
export function getDefaultModelsForProvider(provider: ProviderType): ChannelModel[] {
  if (provider === 'kscc-internal') return KSCC_DEFAULT_MODELS.map((m) => ({ ...m }))
  const list = EXTERNAL_DEFAULT_MODELS[provider]
  return list ? list.map((m) => ({ ...m })) : []
}

/**
 * 该渠道是否对子代理可钉 Claude `haiku`（决定 buildBuiltinSubagentDefinitions 的 claudeAvailable）。
 *
 * SDK 的 `AgentDefinition.model` 为空时子代理继承父会话模型；非空则用定义里的 model
 * （见 @anthropic-ai/claude-agent-sdk sdk-tools.d.ts「uses the agent definition's model,
 * or inherits from the parent」）。内置角色 modelPool 均空，走 resolveModelForRole：
 * claudeAvailable=true → 钉 'haiku'；false → undefined（继承父）。
 *
 * kscc-internal 网关只代理 glm/kimi/mimo/deepseek-v4（见 KSCC_DEFAULT_MODELS），不认识 'haiku' 别名 →
 * 钉 haiku 会让子代理首轮 LLM 调用即失败。故仅 Anthropic 系渠道（真有 Claude 模型）才钉 haiku，
 * 其余渠道省略 model 让子代理继承父会话模型（与 Pi 核 createSubagentStreamFn 的 modelOverride 兜底对齐）。
 *
 * @see docs/dev/core-loop/SUBAGENT-FAIL-FINDINGS.md 根因 1
 * @see docs/dev/core-loop/SUBAGENT-HAIKU-FIX-brief.md
 */
export function isClaudeAvailableForChannel(channel: Channel): boolean {
  return channel.provider === 'anthropic' || channel.provider === 'anthropic-compatible'
}
