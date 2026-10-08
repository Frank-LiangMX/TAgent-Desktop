import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelCreateInput, ChannelsConfig } from '@tagent/shared'

const state = vi.hoisted(() => ({ config: { version: 1, channels: [] } as ChannelsConfig, writes: 0 }))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`encrypted:${s}`),
  decryptString: (b: Buffer) => b.toString().replace(/^encrypted:/, ''),
} }))
vi.mock('../atomic-json', () => ({
  readJsonSafe: () => structuredClone(state.config),
  writeJsonAtomic: (_path: string, config: ChannelsConfig) => { state.config = structuredClone(config); state.writes++ },
}))
vi.mock('../config/config-paths', () => ({ getChannelsPath: () => 'isolated-test-channels' }))
vi.mock('./gateway-credential', () => ({
  readGatewayApiKey: () => '',
  GATEWAY_CREDENTIAL_MISSING_MESSAGE: '未检测到 kscc 凭据',
  invalidateGatewayCredentialCache: () => {},
}))
import { createChannel, getDecryptedApiKey, listChannels, seedBuiltinChannels, updateChannel } from './channel-store'

const input: ChannelCreateInput = { provider: 'custom', name: 'Company API', baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', enabled: true,
  models: [{ id: 'model', name: 'Model', enabled: true }] }
beforeEach(() => { state.config = { version: 1, channels: [] }; state.writes = 0 })
describe('API channels after ADR-0012', () => {
  it('seeds the built-in gateway channel once and leaves legacy records alone', () => {
    seedBuiltinChannels()
    const seeded = listChannels()
    expect(seeded).toHaveLength(1)
    expect(seeded[0]?.provider).toBe('kscc-gateway')
    expect(seeded[0]?.apiProtocol).toBe('anthropic-messages')
    expect(state.writes).toBe(1)
    // 幂等：已有网关渠道时不再写盘
    seedBuiltinChannels()
    expect(listChannels()).toHaveLength(1)
    expect(state.writes).toBe(1)
    // 旧 kscc-internal 记录保留（不删除历史），也不阻止网关渠道建立
    state.config.channels.push({ ...input, id: 'old', provider: 'kscc-internal', apiKey: '', createdAt: 1, updatedAt: 1 })
    seedBuiltinChannels()
    expect(listChannels().find((c) => c.id === 'old')).toBeTruthy()
  })
  it('round trips explicit protocol and preserves encrypted credentials when editing', () => {
    const created = createChannel({ ...input, apiProtocol: 'openai-responses' })
    expect(created.apiProtocol).toBe('openai-responses')
    expect(created.apiKey).not.toBe('test-key')
    expect(getDecryptedApiKey(created.id)).toBe('test-key')
    expect(updateChannel(created.id, { name: 'Renamed', apiKey: '' })?.apiProtocol).toBe('openai-responses')
    expect(updateChannel(created.id, { apiProtocol: 'anthropic-messages' })?.apiProtocol).toBe('anthropic-messages')
    expect(updateChannel(created.id, { apiProtocol: null })?.apiProtocol).toBeUndefined()
    expect(getDecryptedApiKey(created.id)).toBe('test-key')
  })
  it('rejects unsupported protocols and changing API channels into legacy runtime channels', () => {
    expect(() => createChannel({ ...input, apiProtocol: 'bad' as never })).toThrow('协议')
    const created = createChannel(input)
    expect(() => updateChannel(created.id, { provider: 'codex-internal' })).toThrow('内置')
    expect(() => updateChannel(created.id, { apiProtocol: 'bad' as never })).toThrow('协议')
    expect(listChannels()[0]?.provider).toBe('custom')
  })
})
