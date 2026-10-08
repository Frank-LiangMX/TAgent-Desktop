import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../channel/channel-store', () => ({
  listChannels: vi.fn(),
  getDecryptedApiKey: vi.fn(),
}))

vi.mock('@tagent/pi-core', () => ({
  createPiHttpSeatRunner: vi.fn(),
}))

vi.mock('@tagent/core', () => ({
  getAdapter: vi.fn(),
  streamSSE: vi.fn(),
  getTAgentUserAgent: vi.fn(() => 'test-agent'),
}))

import {
  buildEmbeddingBaseCandidates,
  completeMemoryLlm,
  embeddingModelsForProvider,
} from './memory-llm-client'
import { getDecryptedApiKey, listChannels } from '../channel/channel-store'
import { createPiHttpSeatRunner } from '@tagent/pi-core'

describe('buildEmbeddingBaseCandidates', () => {
  it('strips /anthropic for Anthropic-protocol bases', () => {
    const c = buildEmbeddingBaseCandidates('https://api.deepseek.com/anthropic', 'deepseek')
    expect(c.some((u) => u.includes('/v1'))).toBe(true)
    expect(c).toContain('https://api.deepseek.com/anthropic')
    expect(c).toContain('https://api.deepseek.com/v1')
  })

  it('keeps openai v1 base', () => {
    const c = buildEmbeddingBaseCandidates('https://api.openai.com/v1', 'openai')
    expect(c).toContain('https://api.openai.com/v1')
  })

  it('handles moonshot anthropic path', () => {
    const c = buildEmbeddingBaseCandidates('https://api.moonshot.cn/anthropic', 'kimi-api')
    expect(c).toContain('https://api.moonshot.cn/v1')
  })
})

describe('embeddingModelsForProvider', () => {
  it('includes openai models for anthropic-compatible', () => {
    const m = embeddingModelsForProvider('anthropic-compatible')
    expect(m[0]).toBe('text-embedding-3-small')
  })

  it('gives deepseek-specific first', () => {
    expect(embeddingModelsForProvider('deepseek')[0]).toMatch(/deepseek|embedding/i)
  })
})

describe('completeMemoryLlm protocol routing', () => {
  beforeEach(() => {
    vi.mocked(listChannels).mockReset()
    vi.mocked(getDecryptedApiKey).mockReset()
    vi.mocked(createPiHttpSeatRunner).mockReset()
  })

  it('uses the explicit protocol through the native text runner', async () => {
    vi.mocked(listChannels).mockReturnValue([
      {
        id: 'memory-channel',
        name: 'Responses memory',
        provider: 'custom',
        apiProtocol: 'openai-responses',
        baseUrl: 'https://provider.example/v1',
        apiKey: 'encrypted',
        models: [{ id: 'memory-model', name: 'Memory', enabled: true }],
        defaultModelId: 'memory-model',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    vi.mocked(getDecryptedApiKey).mockReturnValue('secret-key')
    const runSeat = vi.fn().mockResolvedValue('  compacted memory  ')
    vi.mocked(createPiHttpSeatRunner).mockReturnValue({ runSeat } as never)

    const result = await completeMemoryLlm({
      systemPrompt: 'system',
      userPrompt: 'prompt',
    })

    expect(result).toBe('compacted memory')
    expect(createPiHttpSeatRunner).toHaveBeenCalledWith({
      apiProtocol: 'openai-responses',
      provider: 'custom',
      apiKey: 'secret-key',
      baseUrl: 'https://provider.example/v1',
      headers: {},
    })
    expect(runSeat).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'memory-model',
      systemPrompt: 'system',
      prompt: 'prompt',
      timeoutMs: 120_000,
    }))
  })

  it('keeps the legacy getAdapter path when protocol is unset', async () => {
    vi.mocked(listChannels).mockReturnValue([
      {
        id: 'legacy-channel',
        name: 'Legacy memory',
        provider: 'openai',
        baseUrl: 'https://provider.example/v1',
        apiKey: 'encrypted',
        models: [{ id: 'legacy-model', name: 'Legacy', enabled: true }],
        defaultModelId: 'legacy-model',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    vi.mocked(getDecryptedApiKey).mockReturnValue('secret-key')
    const buildStreamRequest = vi.fn().mockReturnValue({
      url: 'https://provider.example/v1/chat/completions',
      headers: {},
      body: '{}',
    })
    const streamSSE = (await import('@tagent/core')).streamSSE as unknown as ReturnType<typeof vi.fn>
    vi.mocked((await import('@tagent/core')).getAdapter).mockReturnValue({ buildStreamRequest } as never)
    streamSSE.mockResolvedValue({ content: ' legacy result ' })

    const result = await completeMemoryLlm({ systemPrompt: 'system', userPrompt: 'prompt' })

    expect(result).toBe('legacy result')
    expect(createPiHttpSeatRunner).not.toHaveBeenCalled()
    expect(buildStreamRequest).toHaveBeenCalled()
  })
})
