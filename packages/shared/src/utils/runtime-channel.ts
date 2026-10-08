import type { AgentRuntimeKind } from '../types/agent'
import { AGENT_COMPATIBLE_PROVIDERS, isLegacyCliProvider, isLocalRuntimeProvider, type Channel, type ChannelApiProtocol } from '../types/channel'

export function resolveChannelApiProtocol(channel: Pick<Channel, 'provider' | 'apiProtocol'>): ChannelApiProtocol | 'google-native' | null {
  // 本机原生 Runtime（kscc CLI / Codex App Server）没有 HTTP 协议。
  if (isLocalRuntimeProvider(channel.provider)) return null
  if (channel.apiProtocol) return channel.apiProtocol
  if (channel.provider === 'google') return 'google-native'
  // 内置网关渠道与 Anthropic 系渠道默认走 Messages 协议。
  return AGENT_COMPATIBLE_PROVIDERS.has(channel.provider) ? 'anthropic-messages' : 'openai-chat'
}

/**
 * Protocol eligibility, not proof of installation or authentication.
 *
 * Official runtimes are protocol-adapted at the host boundary: Claude Code
 * speaks Anthropic Messages to its local bridge and Codex speaks Responses to
 * its local bridge. Therefore an external channel is eligible for either
 * official runtime as long as it has one of the supported HTTP protocols.
 */
export function isChannelCompatibleWithRuntime(
  channel: Pick<Channel, 'provider' | 'apiProtocol' | 'enabled'>,
  runtime: AgentRuntimeKind,
): boolean {
  if (!channel.enabled) return false
  // 已废弃的本机 CLI 通路：历史记录保留可读，但不再可运行。
  if (isLegacyCliProvider(channel.provider)) return false
  if (channel.provider === 'codex-internal') return runtime === 'codex'
  const protocol = resolveChannelApiProtocol(channel)
  if (runtime === 'pi') return protocol !== null
  if (runtime === 'codex' || runtime === 'claude-code') {
    return protocol === 'openai-responses' || protocol === 'openai-chat' || protocol === 'anthropic-messages'
  }
  return false
}
