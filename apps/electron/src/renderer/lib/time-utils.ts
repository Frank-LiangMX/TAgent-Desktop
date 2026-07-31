/**
 * 时间格式化工具函数
 */

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
