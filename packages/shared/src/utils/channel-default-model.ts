import type { Channel } from '../types/channel'

type ChannelModelSource = Pick<Channel, 'models' | 'defaultModelId'>

/** 渠道内第一个已启用的模型 ID */
export function getFirstEnabledChannelModelId(channel: ChannelModelSource): string | undefined {
  return channel.models.find((m) => m.enabled)?.id
}

/**
 * 解析渠道的默认模型：显式 defaultModelId（且仍 enabled）> 第一个 enabled 模型
 */
export function resolveChannelDefaultModelId(
  channel: ChannelModelSource | undefined
): string | undefined {
  if (!channel) return undefined

  const enabledIds = new Set(channel.models.filter((m) => m.enabled).map((m) => m.id))
  if (enabledIds.size === 0) return undefined

  if (channel.defaultModelId && enabledIds.has(channel.defaultModelId)) {
    return channel.defaultModelId
  }

  return channel.models.find((m) => m.enabled)?.id
}

/**
 * 校验并规范化渠道的 defaultModelId（无效时清除）
 */
export function normalizeChannelDefaultModelId(channel: ChannelModelSource): string | undefined {
  if (!channel.defaultModelId) return undefined
  const enabled = channel.models.filter((m) => m.enabled)
  if (enabled.some((m) => m.id === channel.defaultModelId)) {
    return channel.defaultModelId
  }
  return undefined
}

/**
 * 解析 Agent 会话有效模型：会话 override > 渠道默认 > 旧版 settings.agentModelId
 */
export function resolveAgentSessionModelId(
  channel: ChannelModelSource | undefined,
  sessionModelId: string | null | undefined,
  legacyGlobalModelId?: string | null
): string | undefined {
  if (sessionModelId) return sessionModelId
  const channelDefault = resolveChannelDefaultModelId(channel)
  if (channelDefault) return channelDefault
  return legacyGlobalModelId ?? undefined
}
