import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getDurableRuntimeHome,
  openDurableRuntimeHome,
  createRuntimeApiKeyRedactor,
  redactRuntimeApiKey,
} from './runtime-api-connection'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('durable official runtime homes', () => {
  it('reuses the host-owned home only for the same session, binding, and credential', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-runtime-home-test-'))
    roots.push(root)
    const connection = {
      channelId: 'channel-a',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'key-a',
      contextWindow: 128_000,
    }
    const first = getDurableRuntimeHome(
      'codex',
      'session-a',
      connection,
      'model-a',
      'openai-responses',
      root,
    )
    const resumed = getDurableRuntimeHome(
      'codex',
      'session-a',
      connection,
      'model-a',
      'openai-responses',
      root,
    )

    expect(resumed).toBe(first)
    expect(() =>
      openDurableRuntimeHome(
        'codex',
        'session-a',
        { ...connection, apiKey: 'key-b' },
        'model-a',
        'openai-responses',
        root,
        true,
      ),
    ).toThrow(/凭据已变更/)
  })

  it('creates a separate credential epoch for an intentional new native session without deleting prior state', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-runtime-home-test-'))
    roots.push(root)
    const base = {
      channelId: 'channel-a',
      baseUrl: 'https://api.example.test/v1',
      contextWindow: 128_000,
    }
    const first = openDurableRuntimeHome(
      'claude', 'session-a', { ...base, apiKey: 'key-a' }, 'model-a', 'anthropic-messages', root,
    )
    const fresh = openDurableRuntimeHome(
      'claude', 'session-a', { ...base, apiKey: 'key-b' }, 'model-a', 'anthropic-messages', root,
    )

    expect(fresh.path).not.toBe(first.path)
    expect(first.existingBinding).toBe(false)
    expect(fresh.existingBinding).toBe(false)
    expect(openDurableRuntimeHome(
      'claude', 'session-a', { ...base, apiKey: 'key-a' }, 'model-a', 'anthropic-messages', root, true,
    ).path).toBe(first.path)
  })

  it('uses bounded hash and credential-epoch path segments for Windows-safe durable homes', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-runtime-home-test-'))
    roots.push(root)
    const home = getDurableRuntimeHome(
      'codex',
      'a-session-id-that-is-deliberately-long-but-never-becomes-a-path-segment',
      { channelId: 'a-channel', baseUrl: 'https://api.example.test/v1', apiKey: 'key-a' },
      'a-model-id-that-is-deliberately-long-but-never-becomes-a-path-segment',
      'openai-responses',
      root,
    )
    const segments = home.slice(root.length + 1).split(/[\\/]/)
    expect(segments).toHaveLength(4)
    expect(segments[1]).toMatch(/^[a-f0-9]{24}$/)
    expect(segments[2]).toMatch(/^[a-f0-9]{24}$/)
    expect(segments[3]).toMatch(/^credential-[a-f0-9]{12}$/)
  })

  it('redacts the selected key before adapter stderr callbacks observe it', () => {
    expect(redactRuntimeApiKey('provider rejected key-a at gateway', 'key-a')).toBe(
      'provider rejected [REDACTED] at gateway',
    )
  })

  it('withholds a key prefix at a chunk boundary until it can redact the full key', () => {
    const observed: string[] = []
    const redact = createRuntimeApiKeyRedactor('selected-key', (text) => observed.push(text))
    redact('provider rejected selec')
    expect(observed.join('')).not.toContain('selec')
    redact('ted-key from gateway')
    expect(observed.join('')).toBe('provider rejected [REDACTED] from gateway')
    expect(observed.join('')).not.toContain('selected-key')
  })

  it('redacts a self-overlapping key that arrives as a whole chunk', () => {
    const observed: string[] = []
    const redact = createRuntimeApiKeyRedactor('aba', (text) => observed.push(text))
    redact('aba')
    expect(observed.join('')).toBe('[REDACTED]')
    expect(observed.join('')).not.toContain('aba')
  })
})
