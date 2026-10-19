import { describe, expect, it } from 'vitest'
import { buildWpsMessageQuery, wpsMessagePage } from './wps-message-query'

describe('WPS user-authorized message queries', () => {
  it('reads older chat history with inclusive local dates and forwards the cursor', () => {
    const result = buildWpsMessageQuery({ kind: 'history', chatId: 'chat', startDate: '2026-09-01', endDate: '2026-09-03', pageToken: 'next' })
    expect(result).toEqual({ name: 'kso_message_get_chat_messages', args: { chat_id: 'chat', page_size: 20, page_token: 'next',
      start_time: new Date('2026-09-01T00:00:00').getTime() / 1000,
      end_time: new Date('2026-09-04T00:00:00').getTime() / 1000 - 1, order: 'asc' } })
  })
  it('searches nested message results and preserves original content and source metadata', () => {
    const message = { chat: { id: 'chat', name: 'project' }, message: { id: 'message', sender: { id: 'someone' }, ctime: 123,
      content: { text: { content: '原始消息\n'.repeat(5000) } } } }
    expect(wpsMessagePage({ items: [message], next_page_token: 'next' })).toEqual({ items: [message], nextPageToken: 'next', complete: false })
    expect(wpsMessagePage({ messages: [], next_page_token: '' }, 'next')).toEqual({ items: [], complete: true })
    expect(buildWpsMessageQuery({ kind: 'search', startDate: '2026-09-01', endDate: '2026-09-30', keyword: '发布', chatIds: ['chat', 'chat'] }))
      .toMatchObject({ name: 'kso_message_search_messages', args: { keyword: '发布', chat_id_list: ['chat'], with_chat: 'true' } })
  })
  it('rejects invalid ranges, IDs and pagination instead of reporting a complete empty result', () => {
    const base = { kind: 'history' as const, chatId: 'chat', startDate: '2026-09-01', endDate: '2026-09-30' }
    for (const fields of [{ startDate: '2026-02-30' }, { endDate: '2026-08-30' }, { endDate: '2026-10-02' }, { chatId: ' ' }, { pageSize: 51 }, { pageSize: 0 }]) {
      expect(() => buildWpsMessageQuery({ ...base, ...fields })).toThrow()
    }
    expect(() => wpsMessagePage({ items: [], next_page_token: 'same' }, 'same')).toThrow('重复')
    expect(() => wpsMessagePage({ unexpected: [] })).toThrow('缺少记录列表')
    expect(() => wpsMessagePage({ items: [], has_more: true })).toThrow('游标')
  })
})
