import { afterEach, describe, expect, test, vi } from 'vitest'

import type { Channel, ProviderType } from '@tagent/shared'

import { fetchModelsFromProvider, testChannelConnection } from './channel-tester'

function channel(provider: ProviderType, overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'channel-1',
    name: 'Test channel',
    provider,
    baseUrl: 'https://provider.example/v1/',
    apiKey: 'encrypted',
    models: [{ id: 'fallback-model', name: 'Fallback', enabled: true }],
    defaultModelId: 'preferred-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('testChannelConnection protocol requests', () => {
  test('uses the Anthropic messages protocol and authentication headers', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)

    const result = await testChannelConnection(
      channel('anthropic', { baseUrl: 'https://provider.example/' }),
      'secret-key',
    )

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://provider.example/v1/messages')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'secret-key',
        'anthropic-version': '2023-06-01',
      },
    })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'preferred-model',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
  })

  test('uses the OpenAI-compatible endpoint and bearer token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)

    const result = await testChannelConnection(channel('openai'), 'secret-key')

    expect(result.success).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://provider.example/v1/chat/completions')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-key',
      },
    })
  })

  test('uses a Google GET request with an encoded query key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ models: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await testChannelConnection(channel('google'), 'key with symbols/+')

    expect(result.success).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(
      'https://provider.example/v1/models?key=key%20with%20symbols%2F%2B',
    )
    expect(init).toMatchObject({
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
  })
})

describe('testChannelConnection responses', () => {
  test.each([400, 404])(
    'treats HTTP %s as a reachable service with a model configuration issue',
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('unknown model', { status }))
      vi.stubGlobal('fetch', fetchMock)

      const result = await testChannelConnection(channel('openai'), 'secret-key')

      expect(result.success).toBe(true)
      expect(result.message).toContain(String(status))
      expect(result.message).toContain('unknown model')
    },
  )

  test('returns a failure and truncates an HTTP error body', async () => {
    const longBody = 'x'.repeat(250)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(longBody, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await testChannelConnection(channel('openai'), 'secret-key')

    expect(result.success).toBe(false)
    expect(result.message).toContain('503')
    expect(result.message).toContain('x'.repeat(200))
    expect(result.message).not.toContain('x'.repeat(201))
  })

  test('reports a network connection failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await testChannelConnection(channel('openai'), 'secret-key')

    expect(result.success).toBe(false)
    expect(result.message).toContain('ECONNREFUSED')
  })

  test('aborts a request after fifteen seconds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const pending = testChannelConnection(channel('openai'), 'secret-key')
    await vi.advanceTimersByTimeAsync(15_000)
    const result = await pending

    expect(result.success).toBe(false)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
})

describe('fetchModelsFromProvider response parsing', () => {
  test('parses OpenAI-compatible model data', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [{ id: 'model-a' }, { id: 'model-b' }, { missing: 'id' }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchModelsFromProvider({
      provider: 'openai',
      baseUrl: 'https://provider.example/v1/',
      apiKey: 'secret-key',
    })

    expect(result.success).toBe(true)
    expect(result.models).toEqual([
      { id: 'model-a', name: 'model-a', enabled: true },
      { id: 'model-b', name: 'model-b', enabled: true },
    ])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/models')
  })

  test('parses Anthropic display names', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [{ id: 'claude-a', display_name: 'Claude A' }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchModelsFromProvider({
      provider: 'anthropic',
      baseUrl: 'https://provider.example/',
      apiKey: 'secret-key',
    })

    expect(result.success).toBe(true)
    expect(result.models).toEqual([
      { id: 'claude-a', name: 'Claude A', enabled: true },
    ])
  })

  test('does not duplicate /v1 for Anthropic-compatible base URLs', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: [{ id: 'coding-model', display_name: 'Coding Model' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await fetchModelsFromProvider({
      provider: 'kimi-coding',
      baseUrl: 'https://api.example/coding/v1/',
      apiKey: 'secret-key',
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example/coding/v1/models')
  })

  test('normalizes Google model ids and display names', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        models: [
          { name: 'models/gemini-a', displayName: 'Gemini A' },
          { name: 'gemini-b' },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchModelsFromProvider({
      provider: 'google',
      baseUrl: 'https://provider.example/',
      apiKey: 'secret key',
    })

    expect(result.success).toBe(true)
    expect(result.models).toEqual([
      { id: 'gemini-a', name: 'Gemini A', enabled: true },
      { id: 'gemini-b', name: 'gemini-b', enabled: true },
    ])
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://provider.example/models?key=secret%20key',
    )
  })

  test('rejects a successful response with no parseable models', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ no: 'id' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchModelsFromProvider({
      provider: 'openai',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret-key',
    })

    expect(result.success).toBe(false)
    expect(result.models).toEqual([])
  })
})
