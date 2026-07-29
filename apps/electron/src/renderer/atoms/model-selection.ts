import { resolveChannelDefaultModelId, type Channel } from '@tagent/shared'

export interface ModelSelection {
  channelId: string
  modelId: string
}

export type ChannelCoreKind = 'kscc' | 'external'

export function getChannelCoreKind(
  channel: Pick<Channel, 'provider'>,
): ChannelCoreKind {
  return channel.provider === 'kscc-internal' ? 'kscc' : 'external'
}

export function isModelSelectionAvailable(
  channels: Channel[],
  selection: ModelSelection | null | undefined,
): selection is ModelSelection {
  if (!selection) return false
  const channel = channels.find((item) => item.id === selection.channelId && item.enabled)
  return Boolean(channel?.models.some((model) => model.id === selection.modelId && model.enabled))
}

export function resolveModelSelection(
  channels: Channel[],
  preferred?: ModelSelection | null,
): ModelSelection | null {
  if (isModelSelectionAvailable(channels, preferred)) return preferred

  const usableChannels = channels.filter(
    (channel) => channel.enabled && channel.models.some((model) => model.enabled),
  )
  const fallback = usableChannels.find((channel) => channel.provider === 'kscc-internal')
    ?? usableChannels[0]
  if (!fallback) return null

  const modelId = resolveChannelDefaultModelId(fallback)
  return modelId ? { channelId: fallback.id, modelId } : null
}
