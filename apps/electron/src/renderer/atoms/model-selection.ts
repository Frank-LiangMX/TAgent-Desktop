import {
  isLocalRuntimeProvider,
  resolveChannelDefaultModelId,
  type Channel,
} from '@tagent/shared'

export interface ModelSelection {
  channelId: string
  modelId: string
}

export type ChannelCoreKind = 'internal' | 'external'

export function getChannelCoreKind(
  channel: Pick<Channel, 'provider'>,
): ChannelCoreKind {
  return isLocalRuntimeProvider(channel.provider) ? 'internal' : 'external'
}

export function isModelSelectionAvailable(
  channels: Channel[],
  selection: ModelSelection | null | undefined,
): selection is ModelSelection {
  if (!selection) return false
  const channel = channels.find((item) => item.id === selection.channelId && item.enabled && !isLocalRuntimeProvider(item.provider))
  return Boolean(channel?.models.some((model) => model.id === selection.modelId && model.enabled))
}

/**
 * 解析可用的渠道/模型组合。
 *
 * 语义（ADR-0011 §5，评审修正）：**只做 Pi（外部 API 渠道）默认，不做本机内核回落**。
 * - `preferred` 仍可用 → 原样保留（显式选择 / 已保存会话绑定不得被改写）
 * - 否则取第一个可用的**外部 API 渠道**默认模型（新会话默认跑 Pi）
 * - 没有任何可用外部渠道 → `null`：调用方必须提示「配置 Pi 或显式选择其它内核」，
 *   **不得**自动回落到本机内核 / Codex（那不是用户的选择）
 *
 * 显式选择其它内核走 `agent-runtime.ts` 的 `selectionForRuntime`（Agent 选择器）。
 */
export function resolveModelSelection(
  channels: Channel[],
  preferred?: ModelSelection | null,
): ModelSelection | null {
  if (isModelSelectionAvailable(channels, preferred)) return preferred

  const piChannel = channels.find(
    (channel) =>
      !isLocalRuntimeProvider(channel.provider)
      && channel.enabled
      && channel.models.some((model) => model.enabled),
  )
  if (!piChannel) return null

  const modelId = resolveChannelDefaultModelId(piChannel)
  return modelId ? { channelId: piChannel.id, modelId } : null
}
