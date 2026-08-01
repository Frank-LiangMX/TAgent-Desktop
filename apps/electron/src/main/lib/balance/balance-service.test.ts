import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Channel, ProviderType } from '@tagent/shared'

// mock channel-store，避免加载 electron safeStorage
vi.mock('../channel/channel-store', () => ({
  getChannel: vi.fn(),
  getDecryptedApiKey: vi.fn(),
}))

import { getChannel, getDecryptedApiKey } from '../channel/channel-store'
import { queryChannelBalance } from './balance-service'

function channel(provider: ProviderType, overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'channel-1',
    name: 'Test channel',
    provider,
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'encrypted',
    models: [],
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

const mockedGetChannel = vi.mocked(getChannel)
const mockedGetDecryptedApiKey = vi.mocked(getDecryptedApiKey)

beforeEach(() => {
  mockedGetChannel.mockReset()
  mockedGetDecryptedApiKey.mockReset()
  mockedGetChannel.mockReturnValue(channel('deepseek'))
  mockedGetDecryptedApiKey.mockReturnValue('sk-test-key')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('queryChannelBalance', () => {
  test('DeepSeek 成功返回 CNY 余额并格式化 ¥ 金额', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        ],
      }),
    ))

    const result = await queryChannelBalance('channel-1')
    expect(result.supported).toBe(true)
    expect(result.provider).toBe('deepseek')
    expect(result.balanceLabel).toBe('¥110.00')
    expect(result.balance).toBe(110)
    expect(result.currency).toBe('CNY')
  })

  test('多币种时优先选择 CNY', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        balance_infos: [
          { currency: 'USD', total_balance: '5.00' },
          { currency: 'CNY', total_balance: '80.50' },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await queryChannelBalance('channel-1')
    expect(result.balanceLabel).toBe('¥80.50')
    expect(result.currency).toBe('CNY')
  })

  test('USD 币种格式化为 $ 金额', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ balance_infos: [{ currency: 'USD', total_balance: '12.34' }] }),
    ))

    const result = await queryChannelBalance('channel-1')
    expect(result.balanceLabel).toBe('$12.34')
  })

  test('HTTP 非 2xx 返回不支持 + 状态码信息', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: { message: 'invalid key' } }, 401),
    ))

    const result = await queryChannelBalance('channel-1')
    expect(result.supported).toBe(false)
    expect(result.message).toContain('401')
  })

  test('接口返回 error.message 时透传', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: { message: '账户被冻结' } }),
    ))

    const result = await queryChannelBalance('channel-1')
    expect(result.supported).toBe(false)
    expect(result.message).toBe('账户被冻结')
  })

  test('空 balance_infos 返回不支持', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ is_available: true, balance_infos: [] }),
    ))

    const result = await queryChannelBalance('channel-1')
    expect(result.supported).toBe(false)
    expect(result.message).toContain('未返回余额数据')
  })

  test('网络异常返回不支持且不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('ENOTFOUND api.deepseek.com')))

    const result = await queryChannelBalance('channel-1')
    expect(result.supported).toBe(false)
    expect(result.message).toContain('ENOTFOUND')
  })

  test('渠道无 API Key 返回不支持', async () => {
    mockedGetDecryptedApiKey.mockReturnValue('')
    const result = await queryChannelBalance('channel-1')
    expect(result.supported).toBe(false)
    expect(result.message).toContain('API Key')
  })

  test('不支持的 provider 返回不支持', async () => {
    mockedGetChannel.mockReturnValue(channel('openai'))
    const result = await queryChannelBalance('channel-1')
    expect(result.supported).toBe(false)
    expect(result.message).toContain('不支持余额查询')
  })

  test('渠道不存在返回不支持', async () => {
    mockedGetChannel.mockReturnValue(undefined)
    const result = await queryChannelBalance('missing')
    expect(result.supported).toBe(false)
    expect(result.message).toContain('渠道不存在')
  })

  test('自定义 baseUrl 时使用其 origin 查询', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    mockedGetChannel.mockReturnValue(channel('deepseek', { baseUrl: 'https://relay.example.com/v1' }))

    await queryChannelBalance('channel-1')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(String(url)).toBe('https://relay.example.com/user/balance')
  })
})
