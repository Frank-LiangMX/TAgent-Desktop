import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelCreateInput, ChannelsConfig } from '@tagent/shared'

const state = vi.hoisted(() => ({ config: { version: 1, channels: [] } as ChannelsConfig, writes: 0, gatewayKey: '' }))
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
  readGatewayApiKey: () => state.gatewayKey,
  GATEWAY_CREDENTIAL_MISSING_MESSAGE: '未检测到 kscc 凭据',
  invalidateGatewayCredentialCache: () => {},
}))
vi.mock('./codex-config', () => ({
  readCodexModelProviders: () => [],
  isKsccProvider: () => false,
  isTokenHubProvider: () => false,
  resolveCodexConfigApiKey: () => '',
  resolveCodexConfigProtocol: () => 'openai-responses',
}))
import { createChannel, getDecryptedApiKey, listChannels, seedBuiltinChannels, updateChannel } from './channel-store'

const input: ChannelCreateInput = { provider: 'custom', name: 'Company API', baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', enabled: true,
  models: [{ id: 'model', name: 'Model', enabled: true }] }
beforeEach(() => { state.config = { version: 1, channels: [] }; state.writes = 0; state.gatewayKey = '' })
describe('API channels after ADR-0012', () => {
  it('does not seed local runtimes or a gateway without KSCC credentials', () => {
    seedBuiltinChannels(); seedBuiltinChannels()
    expect(listChannels()).toEqual([])
    expect(state.writes).toBe(0)
  })
  it('disables and hides legacy local channels, retaining historical IDs in storage', () => {
    state.config.channels.push({ ...input, id: 'old', provider: 'codex-internal', createdAt: 1, updatedAt: 1 })
    seedBuiltinChannels()
    expect(listChannels()).toEqual([])
    expect(state.config.channels[0]).toMatchObject({ id: 'old', enabled: false })
    seedBuiltinChannels()
    expect(state.writes).toBe(1)
  })
  it('keeps a KSCC HTTP gateway editable and falls back to its saved key', () => {
    state.config.channels.push({ ...input, id: 'gateway', name: '金山云网关', provider: 'kscc-gateway',
      apiKey: Buffer.from('encrypted:explicit-key').toString('base64'), createdAt: 1, updatedAt: 1 })
    seedBuiltinChannels()
    expect(listChannels()[0]).toMatchObject({ id: 'gateway', name: 'KSCC 网关', baseUrl: input.baseUrl, enabled: true, credentialStatus: 'ready' })
    expect(getDecryptedApiKey('gateway')).toBe('explicit-key')
    expect(updateChannel('gateway', { baseUrl: 'https://other.invalid', apiKey: 'replacement' })?.baseUrl).toBe('https://other.invalid')
    expect(getDecryptedApiKey('gateway')).toBe('replacement')
  })
  it('disables gateways only when neither automatic nor saved credentials are available', () => {
    state.config.channels.push({ ...input, id: 'gateway', provider: 'kscc-gateway', apiKey: '', createdAt: 1, updatedAt: 1 })
    seedBuiltinChannels()
    expect(listChannels()[0]?.enabled).toBe(false)
    expect(getDecryptedApiKey('gateway')).toBe('')
    expect(listChannels()[0]?.credentialStatus).toBe('missing')
    expect(() => updateChannel('gateway', { enabled: true })).toThrow('kscc 凭据')
  })
  it('repairs the regression migration and never stores or returns the automatic key', () => {
    state.gatewayKey = 'test-auto-secret'
    state.config.channels.push({ ...input, id: 'gateway', name: 'HTTP 网关', provider: 'kscc-gateway',
      apiKey: '', enabled: false, createdAt: 1, updatedAt: 1 })
    seedBuiltinChannels()
    const listed = listChannels()
    expect(listed[0]).toMatchObject({ id: 'gateway', name: 'KSCC 网关', enabled: true, credentialStatus: 'ready', apiKey: '' })
    expect(getDecryptedApiKey('gateway')).toBe('test-auto-secret')
    expect(JSON.stringify(listed)).not.toContain('test-auto-secret')
    expect(JSON.stringify(state.config)).not.toContain('test-auto-secret')
    expect(state.config.channels[0]?.credentialStatus).toBeUndefined()
    seedBuiltinChannels()
    expect(state.writes).toBe(1)
    updateChannel('gateway', { enabled: false })
    seedBuiltinChannels()
    expect(listChannels()[0]?.enabled).toBe(false)
    expect(updateChannel('gateway', { enabled: true })?.enabled).toBe(true)
  })
  it('prefers the current automatic KSCC key without leaking it into unrelated HTTP channels', () => {
    state.gatewayKey = 'test-auto-secret'
    const gateway = createChannel({ ...input, provider: 'kscc-gateway', apiKey: 'old-key' })
    const other = createChannel(input)
    expect(getDecryptedApiKey(gateway.id)).toBe('test-auto-secret')
    expect(getDecryptedApiKey(other.id)).toBe('test-key')
    state.gatewayKey = 'rotated-key'
    expect(getDecryptedApiKey(gateway.id)).toBe('rotated-key')
  })
  it('rejects non-HTTP connections before writing', () => {
    expect(() => createChannel({ ...input, baseUrl: 'file:///tmp/model' })).toThrow('HTTP')
    expect(state.writes).toBe(0)
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
