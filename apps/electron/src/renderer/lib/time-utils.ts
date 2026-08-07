/**
 * 时间格式化工具函数
 */
import { useEffect, useRef, useState } from 'react'

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
 * 格式化运行时长（毫秒 → 可读，对齐 Cursor「8m 6s」）
 * - <1s：0.3s
 * - <60s：12s
 * - ≥60s：1m 5s / 8m 6s
 * - ≥1h：1h 2m 3s
 */
export function formatElapsedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) {
    if (m === 0 && s === 0) return `${h}h`
    if (s === 0) return `${h}h ${m}m`
    return `${h}h ${m}m ${s}s`
  }
  if (s === 0) return `${m}m`
  return `${m}m ${s}s`
}

/**
 * 运行中实时刷新 elapsed（ms）。isLive=false 时返回 0。
 *
 * 调用方不得每帧传入新的 `Date.now()` 作为 startedAt——会令 effect 依赖每帧变化，
 * 同步 `setNow` 触发「Maximum update depth exceeded」。本 hook 在 live 期内锁定首个
 * 有效起点；仍建议调用方用 ref 稳住 startedAt（见 SubagentDetailView）。
 */
export function useLiveElapsedMs(
  startedAt: number | undefined,
  isLive: boolean,
  tickMs = 250,
): number {
  const [now, setNow] = useState(() => Date.now())
  const anchorRef = useRef<number | null>(null)

  if (isLive && startedAt != null && Number.isFinite(startedAt)) {
    if (anchorRef.current == null) anchorRef.current = startedAt
    // 随后落到更早的真实 createdAt 时采纳（比「首次 Date.now() 兜底」更准）
    else if (startedAt < anchorRef.current) anchorRef.current = startedAt
  } else if (!isLive) {
    anchorRef.current = null
  }

  const anchor = anchorRef.current

  useEffect(() => {
    if (!isLive || anchor == null) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), tickMs)
    return () => window.clearInterval(id)
  }, [isLive, anchor, tickMs])

  if (!isLive || anchor == null) return 0
  return Math.max(0, now - anchor)
}
