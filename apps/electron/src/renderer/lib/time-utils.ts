/**
 * 时间格式化工具函数
 */
import { useEffect, useState } from 'react'

/**
 * 格式化消息时间（简略写法）
 * - 今年：02/12 14:30
 * - 跨年：2025/02/12 14:30
 * - undefined / 非有限值：返回空串（不显示）
 */
export function formatMessageTime(timestamp?: number): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  const now = new Date()

  const hh = date.getHours().toString().padStart(2, '0')
  const mm = date.getMinutes().toString().padStart(2, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const time = `${hh}:${mm}`

  if (date.getFullYear() === now.getFullYear()) {
    return `${month}/${day} ${time}`
  }

  return `${date.getFullYear()}/${month}/${day} ${time}`
}

/**
 * 格式化运行时长（毫秒 → 可读）
 * - <1s：0.3s
 * - <60s：12s
 * - ≥60s：1:05 / 12:03
 */
export function formatElapsedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m < 60) return `${m}:${s.toString().padStart(2, '0')}`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}:${rm.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

/**
 * 运行中实时刷新 elapsed（ms）。isLive=false 时返回 0。
 */
export function useLiveElapsedMs(
  startedAt: number | undefined,
  isLive: boolean,
  tickMs = 250,
): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isLive || startedAt == null) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), tickMs)
    return () => window.clearInterval(id)
  }, [isLive, startedAt, tickMs])
  if (!isLive || startedAt == null || !Number.isFinite(startedAt)) return 0
  return Math.max(0, now - startedAt)
}
