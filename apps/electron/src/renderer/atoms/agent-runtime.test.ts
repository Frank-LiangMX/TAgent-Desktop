import { describe, expect, it } from 'vitest'
import type { Channel } from '@tagent/shared'
import {
  channelAcceptsRuntime,
  coreKindForRuntime,
  internalBackendForRuntime,
  isRuntimeAvailable,
  resolveDefaultAgentSelection,
  runtimeBoundBySessionMeta,
  runtimeChannels,
  runtimeForChannelProvider,
  runtimeForSelection,
  selectionForRuntime,
} from './agent-runtime'

function channel(
  id: string,
  provider: Channel['provider'],
  enabled = true,
  modelEnabled = true,
  defaultModelId?: string,
): Channel {
  return {
    id,
    name: id,
    provider,
    baseUrl: '',
    apiKey: '',
    models: [
      { id: `${id}-model`, name: `${id} model`, enabled: modelEnabled },
      { id: `${id}-model-b`, name: `${id} model b`, enabled: modelEnabled },
    ],
    defaultModelId: defaultModelId ?? `${id}-model`,
    enabled,
    createdAt: 1,
    updatedAt: 1,
  }
}

const KSCC = channel('kscc', 'kscc-internal')
const CODEX = channel('codex', 'codex-internal')
const CODEX_API: Channel = {
  ...channel('codex-api', 'openai'),
  apiProtocol: 'openai-responses',
}
const OPENAI = channel('openai', 'openai')
const DEEPSEEK = channel('deepseek', 'deepseek')

describe('agent runtime mapping', () => {
  it('maps channel providers to the runtime that actually serves them', () => {
    expect(runtimeForChannelProvider('codex-internal')).toBe('codex')
    // 历史 kscc CLI 通路已移除：无可识别内核 → null
    expect(runtimeForChannelProvider('kscc-internal')).toBeNull()
    expect(runtimeForChannelProvider('openai')).toBe('pi')
    expect(runtimeForChannelProvider('deepseek')).toBe('pi')
  })

  it('splits kscc-internal by persisted internalBackend (Codex legacy sessions only)', () => {
    expect(runtimeForChannelProvider('kscc-internal', 'codex-app-server')).toBe('codex')
    // 旧 kscc CLI 会话不再可运行
    expect(runtimeForChannelProvider('kscc-internal', 'claude-code')).toBeNull()
  })

  it('accepts only the channels the runtime can actually run on', () => {
    expect(channelAcceptsRuntime(OPENAI, 'pi')).toBe(true)
    expect(channelAcceptsRuntime(KSCC, 'pi')).toBe(false)
    expect(channelAcceptsRuntime(CODEX, 'pi')).toBe(false)
    expect(channelAcceptsRuntime(CODEX, 'codex')).toBe(false)
    expect(channelAcceptsRuntime(CODEX_API, 'codex')).toBe(true)
    expect(channelAcceptsRuntime(KSCC, 'codex')).toBe(false)
    // 历史 kscc 本机渠道对任何内核都不再可运行
    expect(channelAcceptsRuntime(KSCC, 'claude-code')).toBe(false)
    expect(channelAcceptsRuntime(channel('off', 'openai', false), 'pi')).toBe(false)
  })

  it('offers external API channels to official runtimes through the protocol bridge', () => {
    const channels = [OPENAI, DEEPSEEK]
    expect(runtimeChannels(channels, 'codex')).toHaveLength(2)
    expect(runtimeChannels(channels, 'claude-code')).toHaveLength(2)
    // 本机渠道不进任何外部/协议内核
    expect(runtimeChannels([KSCC, CODEX], 'claude-code')).toEqual([])
    expect(isRuntimeAvailable(channels, 'codex')).toBe(true)
    expect(selectionForRuntime(channels, 'codex')).toEqual({
      channelId: 'openai',
      modelId: 'openai-model',
    })
    expect(selectionForRuntime(channels, 'pi')).toEqual({
      channelId: 'openai',
      modelId: 'openai-model',
    })
  })

  it('maps runtime back to the internal/external core region', () => {
    expect(coreKindForRuntime('pi')).toBe('external')
    expect(coreKindForRuntime('codex')).toBe('internal')
    expect(coreKindForRuntime('claude-code')).toBe('external')
    expect(internalBackendForRuntime('codex')).toBe('codex-app-server')
    expect(internalBackendForRuntime('claude-code')).toBe('claude-code')
    expect(internalBackendForRuntime('pi')).toBeUndefined()
  })

  it('resolves the runtime of the current selection', () => {
    const channels = [OPENAI, KSCC, CODEX_API]
    expect(runtimeForSelection(channels, { channelId: 'openai', modelId: 'x' })).toBe('pi')
    // 历史 kscc 渠道 → 无可识别内核
    expect(runtimeForSelection(channels, { channelId: 'kscc', modelId: 'x' })).toBeNull()
    expect(runtimeForSelection(channels, { channelId: 'codex-api', modelId: 'x' })).toBe('pi')
    expect(runtimeForSelection(channels, null)).toBeNull()
    expect(runtimeForSelection(channels, { channelId: 'gone', modelId: 'x' })).toBeNull()
  })

  it('defaults a new session to Pi when an external API channel exists', () => {
    const channels = [KSCC, CODEX, OPENAI]
    expect(resolveDefaultAgentSelection(channels)).toEqual({
      runtime: 'pi',
      selection: { channelId: 'openai', modelId: 'openai-model' },
    })
  })

  it('never auto-falls back to a local runtime when Pi is not configured', () => {
    // 评审修正：没有可用外部渠道 → 不给默认值（UI 提示配置 Pi 或显式选择其它内核）
    expect(resolveDefaultAgentSelection([KSCC, CODEX])).toBeNull()
    expect(resolveDefaultAgentSelection([KSCC])).toBeNull()
    expect(resolveDefaultAgentSelection([])).toBeNull()
  })

  it('does not default to a disabled external channel or disabled model', () => {
    expect(
      resolveDefaultAgentSelection([KSCC, channel('off', 'openai', false)]),
    ).toBeNull()
    expect(
      resolveDefaultAgentSelection([KSCC, channel('no-model', 'openai', true, false)]),
    ).toBeNull()
  })

  it('never offers a disabled model or a MoA pseudo model as the switch target', () => {
    // 停用渠道 / 停用模型：目标解析为 null（选择器同时会禁用该项）
    expect(selectionForRuntime([channel('off', 'openai', false)], 'pi')).toBeNull()
    expect(selectionForRuntime([channel('no-model', 'openai', true, false)], 'pi')).toBeNull()

    // 渠道默认模型是 MoA 虚拟模型 → fail-closed（拒绝作为切换目标，而不是拿它去切核）
    const moaDefault: Channel[] = [
      {
        ...channel('openai', 'openai'),
        models: [
          { id: 'moa:panel', name: 'moa', enabled: true },
          { id: 'openai-model', name: 'openai model', enabled: true },
        ],
        defaultModelId: 'moa:panel',
      },
    ]
    expect(selectionForRuntime(moaDefault, 'pi')).toBeNull()
    // 但下一个可用渠道仍可被正常选中
    expect(selectionForRuntime([...moaDefault, channel('cc', 'openai')], 'claude-code')).toEqual({
      channelId: 'cc',
      modelId: 'cc-model',
    })
  })

  it('recovers the runtime a legacy session was bound to (no silent re-route)', () => {
    expect(runtimeBoundBySessionMeta({ agentRuntime: 'claude-code' })).toBe('claude-code')
    expect(runtimeBoundBySessionMeta({ agentRuntime: 'codex', internalBackend: 'claude-code' })).toBe('codex')
    expect(runtimeBoundBySessionMeta({ internalBackend: 'codex-app-server' })).toBe('codex')
    expect(runtimeBoundBySessionMeta({ internalBackend: 'claude-code' })).toBe('claude-code')
    expect(runtimeBoundBySessionMeta({})).toBeNull()
    expect(runtimeBoundBySessionMeta(null)).toBeNull()
    // 旧会话无渠道绑定 → 按原生线索拿回自己内核的渠道，而不是新会话的 Pi 默认值
    const channels = [OPENAI, KSCC]
    expect(
      selectionForRuntime(channels, runtimeBoundBySessionMeta({ internalBackend: 'claude-code' })!),
    ).toEqual({ channelId: 'openai', modelId: 'openai-model' })
  })

  it('uses the channel default model, not just the first enabled one', () => {
    const channels = [channel('openai', 'openai', true, true, 'openai-model-b')]
    expect(selectionForRuntime(channels, 'pi')).toEqual({
      channelId: 'openai',
      modelId: 'openai-model-b',
    })
  })
})