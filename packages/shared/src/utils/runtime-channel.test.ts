import { describe, expect, it } from 'vitest'
import { isChannelCompatibleWithRuntime, resolveChannelApiProtocol } from './runtime-channel'
import type { AgentRuntimeKind } from '../types'

const api = { provider: 'custom', enabled: true } as const
describe('runtime/channel compatibility', () => {
  it.each([
    ['openai-chat', ['pi', 'codex', 'claude-code']],
    ['openai-responses', ['pi', 'codex', 'claude-code']],
    ['anthropic-messages', ['pi', 'codex', 'claude-code']],
  ] as const)('%s is accepted by all built-in runtimes', (apiProtocol, accepted) => {
    for (const runtime of ['pi', 'codex', 'claude-code'] as AgentRuntimeKind[]) {
      expect(isChannelCompatibleWithRuntime({ ...api, apiProtocol }, runtime)).toBe((accepted as readonly string[]).includes(runtime))
      expect(isChannelCompatibleWithRuntime({ ...api, apiProtocol, enabled: false }, runtime)).toBe(false)
    }
  })
  it('keeps old providers and local bindings separate', () => {
    expect(resolveChannelApiProtocol(api)).toBe('openai-chat')
    expect(resolveChannelApiProtocol({ provider: 'deepseek' })).toBe('anthropic-messages')
    expect(resolveChannelApiProtocol({ provider: 'google' })).toBe('google-native')
    // kscc-internal 的 CLI 通路已移除：历史记录保留可读但不可运行
    expect(isChannelCompatibleWithRuntime({ provider: 'kscc-internal', enabled: true }, 'claude-code')).toBe(false)
    expect(isChannelCompatibleWithRuntime({ provider: 'kscc-internal', enabled: true }, 'pi')).toBe(false)
    expect(isChannelCompatibleWithRuntime({ provider: 'kscc-internal', enabled: true }, 'codex')).toBe(false)
  })
  it('serves the built-in gateway channel to the three runtimes via Messages protocol', () => {
    expect(resolveChannelApiProtocol({ provider: 'kscc-gateway' })).toBe('anthropic-messages')
    for (const runtime of ['pi', 'codex', 'claude-code'] as AgentRuntimeKind[]) {
      expect(isChannelCompatibleWithRuntime({ provider: 'kscc-gateway', enabled: true }, runtime)).toBe(true)
      expect(isChannelCompatibleWithRuntime({ provider: 'kscc-gateway', enabled: false }, runtime)).toBe(false)
    }
  })
})
