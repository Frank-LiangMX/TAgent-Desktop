import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATEWAY_KEY_ENV_NAMES, invalidateGatewayCredentialCache, readGatewayApiKey } from './gateway-credential'

const registry = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: registry.query }))

let dir: string
let options: Parameters<typeof readGatewayApiKey>[0]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tagent-gateway-test-'))
  options = { env: {}, windowsEnv: {}, claudeSettingsPath: join(dir, 'settings.json'), kcworkCredentialPath: join(dir, 'credential.json') }
  invalidateGatewayCredentialCache()
  registry.query.mockReset()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  invalidateGatewayCredentialCache()
  vi.useRealTimers()
})

describe('KSCC HTTP gateway credentials without CLI', () => {
  it.each(GATEWAY_KEY_ENV_NAMES)('reads %s from the process environment', (name) => {
    expect(readGatewayApiKey({ ...options, env: { [name]: ' test-key ' } })).toBe('test-key')
    expect(registry.query).not.toHaveBeenCalled()
  })
  it('prefers KSCC variables to Anthropic aliases and files; follows environment rotation immediately', () => {
    writeFileSync(options!.claudeSettingsPath!, JSON.stringify({ env: { KSCC_AUTH_TOKEN: 'file-key' } }))
    const env = { KSCC_AUTH_TOKEN: 'current-key', ANTHROPIC_AUTH_TOKEN: 'other-key' }
    expect(readGatewayApiKey({ ...options, env })).toBe('current-key')
    env.KSCC_AUTH_TOKEN = 'rotated-key'
    expect(readGatewayApiKey({ ...options, env })).toBe('rotated-key')
    env.KSCC_AUTH_TOKEN = ' '
    expect(readGatewayApiKey({ ...options, env })).toBe('other-key')
  })
  it('reads persistent Windows variables before files', () => {
    writeFileSync(options!.claudeSettingsPath!, JSON.stringify({ env: { KSCC_AUTH_TOKEN: 'file-key' } }))
    expect(readGatewayApiKey({ ...options, windowsEnv: { KSCC_AUTH_TOKEN: 'windows-key' } })).toBe('windows-key')
  })
  it('reads KSCC_AUTH_TOKEN before the compatibility token in settings.json', () => {
    writeFileSync(options!.claudeSettingsPath!, JSON.stringify({ env: { KSCC_AUTH_TOKEN: 'kscc-key', ANTHROPIC_AUTH_TOKEN: 'alias-key' } }))
    expect(readGatewayApiKey(options)).toBe('kscc-key')
  })
  it('falls back from blank settings to KCwork and handles file rotation/deletion', () => {
    writeFileSync(options!.claudeSettingsPath!, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: ' ' } }))
    writeFileSync(options!.kcworkCredentialPath!, JSON.stringify({ sk: `b64:${Buffer.from('sk-kcwork').toString('base64')}` }))
    expect(readGatewayApiKey(options)).toBe('sk-kcwork')
    writeFileSync(options!.claudeSettingsPath!, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'new-key' } }))
    utimesSync(options!.claudeSettingsPath!, new Date(), new Date(Date.now() + 2000))
    expect(readGatewayApiKey(options)).toBe('new-key')
    unlinkSync(options!.claudeSettingsPath!)
    expect(readGatewayApiKey(options)).toBe('sk-kcwork')
    writeFileSync(options!.kcworkCredentialPath!, 'invalid json')
    invalidateGatewayCredentialCache()
    expect(readGatewayApiKey(options)).toBe('')
  })
  it('reads Windows user overrides, caches registry queries, and invalidates that cache', () => {
    if (process.platform !== 'win32') return
    vi.useFakeTimers()
    registry.query.mockImplementation((_file: string, args: string[]) => args[1] === 'HKCU\\Environment'
      ? '\n    KSCC_AUTH_TOKEN    REG_SZ    user-key\n'
      : '\n    KSCC_AUTH_TOKEN    REG_SZ    machine-key\n')
    const registryOptions = { ...options, windowsEnv: undefined }
    expect(readGatewayApiKey(registryOptions)).toBe('user-key')
    expect(readGatewayApiKey(registryOptions)).toBe('user-key')
    expect(registry.query).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(30_001)
    expect(readGatewayApiKey(registryOptions)).toBe('user-key')
    expect(registry.query).toHaveBeenCalledTimes(4)
    invalidateGatewayCredentialCache()
    expect(readGatewayApiKey(registryOptions)).toBe('user-key')
    expect(registry.query).toHaveBeenCalledTimes(6)
  })
  it('returns empty rather than throwing or exposing registry errors when credentials are absent', () => {
    registry.query.mockImplementation(() => { throw new Error('secret registry contents') })
    expect(readGatewayApiKey({ ...options, windowsEnv: undefined })).toBe('')
  })
})
