/**
 * 三内核（Pi / Codex / Claude Code）在渲染层的**纯判定**。
 *
 * 与主进程 `main/lib/agent/runtime/runtime-switch.ts` 的判定保持同构，但只做
 * 展示与选择所需的最小集合：渠道 provider ↔ 内核映射、可用渠道过滤、
 * 内核默认选择。不碰 IPC / 磁盘 / 适配器。
 *
 * 关键约定（ADR-0012）：
 * - 官方运行时使用外部 API 渠道；协议差异由主进程适配层处理
 * - `codex-internal` 只作为历史会话的兼容绑定，不出现在新选择
 * - 目标内核没有可用渠道时**不静默换核**，由调用方给出明确提示
 */
import {
  isMoaModelId,
  isChannelCompatibleWithRuntime,
  resolveChannelDefaultModelId,
  type AgentRuntimeKind,
  type AgentSessionMeta,
  type Channel,
} from '@tagent/shared'
import type { ChannelCoreKind, ModelSelection } from './model-selection'
import { resolveModelSelection } from './model-selection'

/** Agent 选择器的展示顺序：Pi 在前（新会话默认优先级最高）。 */
export const AGENT_RUNTIME_ORDER: readonly AgentRuntimeKind[] = ['pi', 'codex', 'claude-code']

export const AGENT_RUNTIME_LABELS: Record<AgentRuntimeKind, string> = {
  pi: 'Pi',
  codex: 'Codex',
  'claude-code': 'Claude Code',
}

export const AGENT_RUNTIME_DESCRIPTIONS: Record<AgentRuntimeKind, string> = {
  pi: '外部 API 渠道直连，无需本机 Runtime',
  codex: '官方 Codex 执行循环，自动适配外部 API 渠道',
  'claude-code': '官方 Claude Code 执行循环，自动适配外部 API 渠道',
}

/**
 * 仅用于旧记录没有显式 `agentRuntime` 时的历史兜底。
 * 新绑定不能从 API provider 推断运行时；调用方应优先读取显式 agentRuntime。
 *
 * 历史 kscc CLI 记录已不可运行 → 无可识别内核时返回 null。
 */
export function runtimeForChannelProvider(
  provider: string,
  internalBackend?: AgentSessionMeta['internalBackend'],
): AgentRuntimeKind | null {
  if (provider === 'codex-internal') return 'codex'
  if (provider === 'kscc-internal') {
    // 历史 kscc 渠道：仅 codex 后端记录仍可识别，其余（旧 kscc CLI 会话）不可运行。
    return internalBackend === 'codex-app-server' ? 'codex' : null
  }
  return 'pi'
}

/**
 * 内核 → 会话 meta 的 `internalBackend`（与主进程同口径）：
 * Pi 没有本机后端概念 → undefined。
 */
export function internalBackendForRuntime(
  runtime: AgentRuntimeKind,
): AgentSessionMeta['internalBackend'] {
  if (runtime === 'codex') return 'codex-app-server'
  if (runtime === 'claude-code') return 'claude-code'
  return undefined
}

/** 该渠道能否作为目标内核的承载渠道（与主进程 channelAcceptsRuntime 同构）。 */
export function channelAcceptsRuntime(
  channel: Pick<Channel, 'provider' | 'apiProtocol' | 'enabled'>,
  runtime: AgentRuntimeKind,
): boolean {
  // Legacy local providers remain compatibility-only. Official runtimes use
  // the host protocol bridge for external API channels.
  if (channel.provider === 'kscc-internal' || channel.provider === 'codex-internal') return false
  return isChannelCompatibleWithRuntime(channel, runtime)
}

/** Compatibility-only binding check for sessions created before ADR-0012. */
export function isLegacyChannelForRuntime(
  channel: Pick<Channel, 'provider' | 'enabled'>,
  runtime: AgentRuntimeKind,
): boolean {
  if (!channel.enabled) return false
  if (runtime === 'codex') return channel.provider === 'codex-internal'
  return false
}

function hasEnabledModel(channel: Channel): boolean {
  return channel.models.some((model) => model.enabled)
}

/** 目标内核在本机**可用**的渠道（enabled + 至少一个启用模型）。 */
export function runtimeChannels(channels: Channel[], runtime: AgentRuntimeKind): Channel[] {
  return channels.filter(
    (channel) => channelAcceptsRuntime(channel, runtime) && hasEnabledModel(channel),
  )
}

/** 目标内核是否有可用渠道（协议差异由官方 runtime bridge 适配）。 */
export function isRuntimeAvailable(channels: Channel[], runtime: AgentRuntimeKind): boolean {
  return runtimeChannels(channels, runtime).length > 0
}

/**
 * 目标内核的默认选择：首个可用渠道 + 该渠道默认模型（无 → null）。
 *
 * 只会落在**已启用渠道的已启用真实模型**上：渠道过滤见 `runtimeChannels`，
 * 模型解析由 `resolveChannelDefaultModelId` 保证只返回 enabled 模型；
 * 这里再显式挡掉 MoA 虚拟模型 `moa:*`（它不是可切换的运行目标）。
 */
export function selectionForRuntime(
  channels: Channel[],
  runtime: AgentRuntimeKind,
): ModelSelection | null {
  for (const channel of runtimeChannels(channels, runtime)) {
    const modelId = resolveChannelDefaultModelId(channel)
    if (modelId && !isMoaModelId(modelId)) return { channelId: channel.id, modelId }
  }
  return null
}

/**
 * 会话 meta 反推「这个会话原本跑在哪个内核」——只用于**没有渠道绑定**的
 * 历史会话兜底，避免它们被新会话的 Pi 默认值悄悄换核。
 * 没有任何原生线索 → null（调用方自行决定是否要求显式选择）。
 */
export function runtimeBoundBySessionMeta(
  meta: Pick<AgentSessionMeta, 'agentRuntime' | 'internalBackend'> | null | undefined,
): AgentRuntimeKind | null {
  if (meta?.agentRuntime) return meta.agentRuntime
  if (meta?.internalBackend === 'codex-app-server') return 'codex'
  if (meta?.internalBackend === 'claude-code') return 'claude-code'
  return null
}

/**
 * 旧会话兼容兜底：从已保存渠道反推历史 runtime。
 * 新会话/显式绑定不得调用它来决定 engine；Chat 先读取 agentRuntime。
 */
export function runtimeForSelection(
  channels: Channel[],
  selection: ModelSelection | null | undefined,
  internalBackend?: AgentSessionMeta['internalBackend'],
): AgentRuntimeKind | null {
  if (!selection) return null
  const channel = channels.find((item) => item.id === selection.channelId)
  if (!channel) return null
  return runtimeForChannelProvider(channel.provider, internalBackend)
}

/**
 * 内核 → 旧版 UI 的区域分组（官方运行时都使用外部 API 渠道）。
 */
export function coreKindForRuntime(runtime: AgentRuntimeKind): ChannelCoreKind {
  return runtime === 'codex' ? 'internal' : 'external'
}

/**
 * 新会话（草稿）默认会跑哪个内核：**只在有可用 Pi（外部 API）渠道时给出默认**，
 * 否则 `null`（调用方必须提示「配置 Pi，或用 Agent 选择器显式选择 Codex / Claude Code」）。
 *
 * 这里**不会**自动回落到本机内核——显式选择走 `selectionForRuntime`。
 */
export function resolveDefaultAgentSelection(
  channels: Channel[],
): { runtime: AgentRuntimeKind; selection: ModelSelection } | null {
  const selection = resolveModelSelection(channels)
  if (!selection) return null
  const runtime = runtimeForSelection(channels, selection)
  return runtime ? { runtime, selection } : null
}
