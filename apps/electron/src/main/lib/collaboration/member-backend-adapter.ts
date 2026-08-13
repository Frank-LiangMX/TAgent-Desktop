/**
 * 成员后端适配器（Stage 2）
 *
 * 实现 02-RUNTIME-A2A-SPEC §12 的 MemberBackendAdapter（简化版：一次 turn 返回正文，
 * 不做 AsyncIterable 事件流）。Stage 2 只接 channel 后端：用成员绑定的 channelId/modelId
 * 真实调用外部渠道模型（@tagent/pi-core 的 seat runner，与会诊 run-moa-turn 同路），
 * 不做 fake 回复。CLI backend 留 S3+（capabilities 全 false 占位）。
 *
 * 渠道凭据在主进程解密，不进 renderer / 不进 run 记录。
 *
 * 设计参考：
 * - apps/electron/src/main/lib/ipc/session-service.ts runMoATurn（seat runner 选路 + 凭据）
 * - apps/electron/src/main/lib/memory/memory-llm-client.ts（resolveMemoryLlmChannel：取第一个 enabled 外部渠道）
 */
import {
  createKsccSeatRunner,
  createPiHttpSeatRunner,
  type MoASeatRunner,
} from '@tagent/pi-core'
import {
  resolveChannelDefaultModelId,
  type Channel,
  type CollaborationMemberCapabilities,
  type MemberBackendAdapter,
  type MemberTurnInput,
  type MemberTurnResult,
} from '@tagent/shared'
import { getChannel, getDecryptedApiKey, listChannels } from '../channel/channel-store'
import { resolveKsccPath } from '../adapters/claude/kscc-path'

/** 单 turn 超时（ms）；外部渠道长回复兜底，取消由 AbortSignal 即时生效 */
const MEMBER_TURN_TIMEOUT_MS = 120_000

/** channel 后端能力（S2 诚实标记：无 resume/工具/实时输入） */
const CHANNEL_BACKEND_CAPABILITIES: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
}

/** 解析出的后端配置（主进程内部，含解密 apiKey / ksccPath，不落盘不外传 renderer） */
interface ResolvedChannelBackend {
  /** 'external' 走 Pi HTTP 直连；'kscc' 走 kscc bare 子进程 */
  kind: 'external' | 'kscc'
  /** 渠道记录（用于错误提示带上渠道名） */
  channelName: string
  /** 供应商类型（createPiHttpSeatRunner 需要；kscc 分支空串占位） */
  provider: string
  /** 实际使用的模型 ID（member.modelId > 渠道默认 > 首个 enabled） */
  modelId: string
  /** 外部渠道解密后的 apiKey（kind==='external' 时） */
  apiKey?: string
  /** 外部渠道 baseUrl（kind==='external' 时） */
  baseUrl?: string
  /** kscc 可执行路径（kind==='kscc' 时） */
  ksccPath?: string
}

/** 后端解析失败（run 据此置 failed 并向用户展示原因） */
export class MemberBackendResolveError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'MemberBackendResolveError'
  }
}

/**
 * 解析成员的后端配置：
 * - 成员显式绑定 channelId：用该渠道（必须 enabled）；kscc-internal 走 kscc runner，
 *   其余走 Pi HTTP 直连。
 * - 成员未绑定 channelId：优先 enabled 且本机可用的 kscc-internal，再回落 enabled 外部渠道；
 *   皆无则抛 MemberBackendResolveError('NO_CHANNEL_BACKEND', …)。
 *
 * modelId 解析：member.modelId > resolveChannelDefaultModelId(channel) > 首个 enabled 模型。
 * 显式 channelId 指向 kscc-internal 时不要求 apiKey（走 ksccPath）；外部渠道要求 apiKey 非空。
 */
export function resolveChannelBackendConfig(input: {
  channelId?: string
  modelId?: string
}): ResolvedChannelBackend {
  // 1) 显式绑定 channelId
  if (input.channelId) {
    return resolveBoundChannel(input.channelId, input.modelId)
  }

  // 2) 未绑定：kscc 优先（本机有 CLI 且渠道 enabled），再外部渠道
  const unbound = pickDefaultChannelBackend(input.modelId)
  if (unbound) return unbound

  throw new MemberBackendResolveError(
    'NO_CHANNEL_BACKEND',
    '没有可用的渠道：请启用 kscc 内网（并安装 kscc 命令），或配置并启用一个外部渠道（含 API Key 与模型）',
  )
}

/**
 * 新建房间 / 默认协调者用：挑一个可跑的 channelId+modelId。
 * 顺序与未绑定解析一致：kscc（可用）→ 外部。
 */
export function pickDefaultMemberChannelBinding(): {
  channelId: string
  modelId: string
} | null {
  // kscc 优先
  for (const channel of listChannels()) {
    if (!channel.enabled || channel.provider !== 'kscc-internal') continue
    if (!resolveKsccPath()) continue
    const modelId = resolveModelId(channel, undefined)
    if (!modelId) continue
    return { channelId: channel.id, modelId }
  }
  // 外部
  for (const channel of listChannels()) {
    if (!channel.enabled || channel.provider === 'kscc-internal') continue
    if (!getDecryptedApiKey(channel.id)) continue
    const modelId = resolveModelId(channel, undefined)
    if (!modelId) continue
    return { channelId: channel.id, modelId }
  }
  return null
}

function resolveBoundChannel(channelId: string, memberModelId?: string): ResolvedChannelBackend {
  const channel = getChannel(channelId)
  if (!channel) {
    throw new MemberBackendResolveError(
      'NO_CHANNEL',
      `成员绑定的渠道已删除（id=${channelId}），请重新配置成员后端`,
    )
  }
  if (!channel.enabled) {
    throw new MemberBackendResolveError(
      'CHANNEL_DISABLED',
      `渠道「${channel.name}」未启用，请在设置 → 渠道中启用后再发消息`,
    )
  }
  const modelId = resolveModelId(channel, memberModelId)
  if (!modelId) {
    throw new MemberBackendResolveError(
      'NO_MODEL',
      `渠道「${channel.name}」没有可用模型，请在渠道管理中添加并启用模型`,
    )
  }
  if (channel.provider === 'kscc-internal') {
    const ksccPath = resolveKsccPath()
    if (!ksccPath) {
      throw new MemberBackendResolveError(
        'NO_KSCC',
        '未检测到 kscc 命令，请先安装 kscc（内网渠道）后再启用该渠道',
      )
    }
    return { kind: 'kscc', channelName: channel.name, provider: channel.provider, modelId, ksccPath }
  }
  const apiKey = getDecryptedApiKey(channel.id)
  if (!apiKey) {
    throw new MemberBackendResolveError(
      'NO_API_KEY',
      `渠道「${channel.name}」未配置 API Key，请在渠道管理中填写`,
    )
  }
  return {
    kind: 'external',
    channelName: channel.name,
    provider: channel.provider,
    modelId,
    apiKey,
    baseUrl: channel.baseUrl,
  }
}

/** 未绑定时的默认解析（kscc → 外部） */
function pickDefaultChannelBackend(memberModelId?: string): ResolvedChannelBackend | null {
  for (const channel of listChannels()) {
    if (!channel.enabled || channel.provider !== 'kscc-internal') continue
    const ksccPath = resolveKsccPath()
    if (!ksccPath) continue
    const modelId = resolveModelId(channel, memberModelId)
    if (!modelId) continue
    return {
      kind: 'kscc',
      channelName: channel.name,
      provider: channel.provider,
      modelId,
      ksccPath,
    }
  }
  for (const channel of listChannels()) {
    if (!channel.enabled || channel.provider === 'kscc-internal') continue
    const apiKey = getDecryptedApiKey(channel.id)
    if (!apiKey) continue
    const modelId = resolveModelId(channel, memberModelId)
    if (!modelId) continue
    return {
      kind: 'external',
      channelName: channel.name,
      provider: channel.provider,
      modelId,
      apiKey,
      baseUrl: channel.baseUrl,
    }
  }
  return null
}

/** 解析最终模型 ID：成员显式 > 渠道默认（且 enabled）> 首个 enabled 模型 */
function resolveModelId(channel: Channel, memberModelId?: string): string | undefined {
  if (memberModelId) return memberModelId
  return resolveChannelDefaultModelId(channel) ?? channel.models.find((m) => m.enabled)?.id
}

/**
 * Channel 后端适配器：一次 turn 真实调用外部渠道 / kscc 模型并返回正文。
 *
 * 取消：input.signal 透传给 seat runner；abort 即抛错，调用方据 signal.aborted 置 cancelled。
 */
export class ChannelBackendAdapter implements MemberBackendAdapter {
  capabilities(): CollaborationMemberCapabilities {
    return CHANNEL_BACKEND_CAPABILITIES
  }

  async runTurn(input: MemberTurnInput): Promise<MemberTurnResult> {
    const cfg = resolveChannelBackendConfig({ channelId: input.channelId, modelId: input.modelId })
    const runner: MoASeatRunner =
      cfg.kind === 'kscc'
        ? createKsccSeatRunner({ ksccPath: cfg.ksccPath })
        : createPiHttpSeatRunner({ provider: cfg.provider, apiKey: cfg.apiKey ?? '', baseUrl: cfg.baseUrl })

    const text = await runner.runSeat({
      modelId: cfg.modelId,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      signal: input.signal,
      timeoutMs: MEMBER_TURN_TIMEOUT_MS,
      onTextDelta: input.onTextDelta,
    })
    return { text }
  }
}

/** 默认工厂（service 在未注入 adapter 时用） */
export function createChannelBackendAdapter(): MemberBackendAdapter {
  return new ChannelBackendAdapter()
}
