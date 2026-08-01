/**
 * 渠道余额状态 — token 栏余额徽章数据源
 *
 * 轻量缓存：成功 60s、失败 15s；同一渠道的并发请求去重。
 * 查询失败时不展示（徽章隐藏），不打断会话。
 */
import type { ChannelBalanceResult } from '@tagent/shared'

/** 成功结果缓存时长（毫秒） */
const SUCCESS_TTL_MS = 60_000
/** 失败结果缓存时长（毫秒） */
const FAIL_TTL_MS = 15_000

interface CacheEntry {
  at: number
  value: ChannelBalanceResult
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ChannelBalanceResult>>()

function ttlFor(result: ChannelBalanceResult): number {
  return result.supported ? SUCCESS_TTL_MS : FAIL_TTL_MS
}

function fromCache(channelId: string): ChannelBalanceResult | null {
  const entry = cache.get(channelId)
  if (!entry) return null
  if (Date.now() - entry.at >= ttlFor(entry.value)) {
    cache.delete(channelId)
    return null
  }
  return entry.value
}

/** 查询渠道余额（带缓存 + 并发去重）；失败返回 unsupported，不抛异常 */
export async function fetchChannelBalance(channelId: string): Promise<ChannelBalanceResult | null> {
  if (!channelId) return null

  const cached = fromCache(channelId)
  if (cached) return cached

  const running = inflight.get(channelId)
  if (running) return running

  const promise = window.electronAPI
    .getChannelBalance(channelId)
    .then((value) => {
      cache.set(channelId, { at: Date.now(), value })
      return value
    })
    .catch((error: unknown) => {
      const value: ChannelBalanceResult = {
        supported: false,
        provider: 'custom',
        updatedAt: Date.now(),
        message: error instanceof Error ? error.message : '余额查询失败',
      }
      cache.set(channelId, { at: Date.now(), value })
      return value
    })
    .finally(() => {
      inflight.delete(channelId)
    })

  inflight.set(channelId, promise)
  return promise
}
