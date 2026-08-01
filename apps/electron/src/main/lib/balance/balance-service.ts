/**
 * 渠道余额查询服务（TAgent 自研）
 *
 * 按渠道 ID 查询账户余额，用于会话 token 栏左侧展示。
 * 当前支持：DeepSeek 账户余额（官方 /user/balance 接口）。
 * 新增供应商时在 queryChannelBalance 分发处扩展即可。
 */
import type { ChannelBalanceResult } from '@tagent/shared'
import { getChannel, getDecryptedApiKey } from '../channel/channel-store'

/** 余额请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 10_000

/** 构造不支持/失败结果 */
function unsupported(provider: string, message?: string): ChannelBalanceResult {
  return { supported: false, provider, message, updatedAt: Date.now() }
}

/** 数值 → 带币种的展示文本（CNY→¥、USD→$、其它→"币种 金额"） */
function formatAmount(currency: string, amount: number): string {
  const normalized = currency.trim().toUpperCase()
  const value = Number.isFinite(amount) ? amount : 0
  if (normalized === 'CNY' || normalized === 'RMB') return `¥${value.toFixed(2)}`
  if (normalized === 'USD') return `$${value.toFixed(2)}`
  if (normalized) return `${normalized} ${value.toFixed(2)}`
  return value.toFixed(2)
}

/**
 * DeepSeek 账户余额
 *
 * 官方接口：GET {origin}/user/balance
 * 响应 balance_infos[] 含 currency / total_balance / granted_balance / topped_up_balance。
 * baseUrl 可解析时取其 origin 拼地址（兼容中转站），否则用官方默认域名。
 */
async function queryDeepSeekBalance(apiKey: string, baseUrl: string): Promise<ChannelBalanceResult> {
  let requestUrl = 'https://api.deepseek.com/user/balance'
  try {
    requestUrl = `${new URL(baseUrl).origin}/user/balance`
  } catch {
    // baseUrl 不可解析时保持官方默认地址
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const resp = await fetch(requestUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })
    const text = await resp.text()
    if (!resp.ok) {
      return unsupported('deepseek', `余额查询失败（HTTP ${resp.status}）`)
    }

    let data: {
      is_available?: boolean
      balance_infos?: Array<{
        currency?: string
        total_balance?: string
        granted_balance?: string
        topped_up_balance?: string
      }>
      error?: { message?: string }
    }
    try {
      data = JSON.parse(text)
    } catch {
      return unsupported('deepseek', '余额响应格式错误')
    }
    if (data.error?.message) {
      return unsupported('deepseek', data.error.message)
    }

    const infos = data.balance_infos ?? []
    if (infos.length === 0) {
      return unsupported('deepseek', '未返回余额数据')
    }

    // 优先 CNY，其次余额非 0，最后兜底第一条
    const item =
      infos.find((i) => (i.currency ?? '').toUpperCase() === 'CNY') ??
      infos.find((i) => Number(i.total_balance ?? 0) > 0) ??
      infos[0]!

    const total = Number(item.total_balance ?? 0)
    const currency = item.currency ?? ''

    return {
      supported: true,
      provider: 'deepseek',
      label: '余额',
      balanceLabel: formatAmount(currency, total),
      balance: total,
      currency: currency.trim() || undefined,
      updatedAt: Date.now(),
      message: data.is_available === false ? 'DeepSeek 账户余额不可用' : undefined,
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return unsupported('deepseek', '余额查询超时')
    }
    const msg = err instanceof Error ? err.message : String(err)
    return unsupported('deepseek', `余额查询异常：${msg}`)
  } finally {
    clearTimeout(timer)
  }
}

/** 按渠道查询余额（按 provider 分发） */
export async function queryChannelBalance(channelId: string): Promise<ChannelBalanceResult> {
  const channel = getChannel(channelId)
  if (!channel) return unsupported('unknown', '渠道不存在')

  const apiKey = getDecryptedApiKey(channel.id)
  if (!apiKey) return unsupported(channel.provider, '渠道未配置 API Key')

  switch (channel.provider) {
    case 'deepseek':
      return queryDeepSeekBalance(apiKey, channel.baseUrl)
    default:
      return unsupported(channel.provider, '当前渠道不支持余额查询')
  }
}
