import { wpsPage } from './wps-client'

export interface WpsMessageQuery {
  kind: 'chats' | 'search' | 'history'
  startDate?: string
  endDate?: string
  chatId?: string
  chatIds?: string[]
  keyword?: string
  pageToken?: string
  pageSize?: number
}

/** Inclusive local dates; separate from the daily collector's seven-day limit. */
function dateSeconds(value: unknown, end: boolean): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('消息查询日期应为 YYYY-MM-DD。')
  const date = new Date(`${value}T00:00:00`)
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== Number(value.slice(0, 4)) ||
    date.getMonth() + 1 !== Number(value.slice(5, 7)) || date.getDate() !== Number(value.slice(8, 10))) throw new Error('消息查询日期无效。')
  if (end) date.setDate(date.getDate() + 1)
  return Math.floor(date.getTime() / 1000) - (end ? 1 : 0)
}

function id(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 256
}

export function buildWpsMessageQuery(query: WpsMessageQuery): { name: string; args: Record<string, unknown> } {
  const pageSize = query.pageSize ?? 20
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error('消息查询每页数量应为 1–50。')
  if (query.pageToken !== undefined && (typeof query.pageToken !== 'string' || query.pageToken.length > 8192)) throw new Error('消息分页游标无效。')
  const args: Record<string, unknown> = { page_size: pageSize, ...(query.pageToken ? { page_token: query.pageToken } : {}) }
  if (query.kind === 'chats') return { name: 'kso_message_get_chat_list', args }
  const start = dateSeconds(query.startDate, false), end = dateSeconds(query.endDate, true)
  if (start > end) throw new Error('消息查询开始日期不能晚于结束日期。')
  if (Date.parse(query.endDate!) - Date.parse(query.startDate!) > 30 * 86400_000) throw new Error('单次消息查询最多跨 31 天，请拆分日期范围。')
  Object.assign(args, { start_time: start, end_time: end, order: 'asc' })
  if (query.kind === 'history') {
    if (!id(query.chatId)) throw new Error('请提供有效的 WPS 会话 ID。')
    return { name: 'kso_message_get_chat_messages', args: { ...args, chat_id: query.chatId } }
  }
  if (query.kind !== 'search') throw new Error('不支持的消息查询类型。')
  if (query.chatIds !== undefined && (!Array.isArray(query.chatIds) || !query.chatIds.length || query.chatIds.length > 50 || !query.chatIds.every(id))) throw new Error('消息搜索需提供 1–50 个有效会话 ID。')
  if (query.keyword !== undefined && (typeof query.keyword !== 'string' || !query.keyword.trim() || query.keyword.length > 1000)) throw new Error('消息搜索关键字无效。')
  return { name: 'kso_message_search_messages', args: { ...args, with_chat: 'true',
    ...(query.chatIds ? { chat_id_list: [...new Set(query.chatIds)] } : {}), ...(query.keyword ? { keyword: query.keyword } : {}) } }
}

export function wpsMessagePage(data: unknown, previousToken?: string): { items: Record<string, unknown>[]; nextPageToken?: string; complete: boolean } {
  const page = wpsPage(data)
  if (page.next && page.next === previousToken) throw new Error('WPS 分页游标重复，请缩小日期范围后重试；结果尚未读取完整。')
  // Return message bodies verbatim; never substitute a document summary for chat evidence.
  return { items: page.items, ...(page.next ? { nextPageToken: page.next } : {}), complete: !page.next }
}
