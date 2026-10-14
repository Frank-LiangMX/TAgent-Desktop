import { describe, expect, it, vi } from 'vitest'
import { collectDailyWps, reportDayRange, type WpsCollectorDependencies } from './wps-daily-collector'
import { WpsApiError } from './wps-client'

const now = new Date('2026-10-09T20:00:00').getTime()
const stamp = Math.floor(new Date('2026-10-09T10:00:00').getTime() / 1000)
const mine = { id: 'me', type: 'user', company_id: 'company' }
const other = { id: 'other', type: 'user', company_id: 'company' }
function deps(): WpsCollectorDependencies {
  return { get: vi.fn(async () => ({ items: [] })), call: vi.fn(async () => ({ items: [] })),
    identity: { id: 'me', companyId: 'company' }, now: () => now }
}
const message = (id: string, sender = mine) => ({ id, chat_id: 'chat', ctime: stamp, sender, content: { text: { content: id } } })

describe('WPS daily evidence', () => {
  it('collects real MCP search envelopes with millisecond timestamps and raw token-bound sender IDs', async () => {
    const d = deps()
    d.identity.messageIdentity = { id: '1234567890', companyId: '987654321' }
    const sender = { id: '1234567890', company_id: '987654321', type: 'user', name: 'Synthetic user' }
    d.call = vi.fn(async (_s, name, args) => {
      if (name === 'kso_message_search_messages') expect(args.sender_id_list).toEqual(['1234567890'])
      return { items: [{ chat: { id: 'chat', name: 'Project chat' }, message: {
        ...message('nested', sender), ctime: stamp * 1000 + 129,
      }, highlights: {} }] }
    })
    d.get = vi.fn(async () => ({ items: [{ file: { id: 'self-doc', drive_id: 'drive', mtime: stamp, modified_by: mine } }] }))
    const result = await collectDailyWps(d, '2026-10-09', { includeChats: true, includeDocuments: true, chatIds: [] })
    expect(result.evidence.map(e => e.attribution)).toEqual(['self', 'self'])
    expect(result.evidence[0]).toMatchObject({ sourceId: 'message:chat:nested', title: 'Project chat', timestamp: stamp * 1000,
      locator: { senderId: '1234567890', messageId: 'nested', chatId: 'chat' } })
    expect(result.evidence[0]?.content).toContain('nested')
    expect(result.complete).toBe(true)
  })
  it('keeps sender and company checks for raw MCP IDs, regardless of a matching display name', async () => {
    const d = deps()
    d.identity.messageIdentity = { id: '1234567890', companyId: '987654321' }
    d.call = vi.fn(async () => ({ items: [
      { message: message('foreign-company', { id: '1234567890', company_id: 'other-company', type: 'user' }) },
      { message: message('another-user', { id: 'another-user', company_id: '987654321', type: 'user', name: 'Same name' } as typeof mine) },
    ] }))
    const result = await collectDailyWps(d, '2026-10-09', { includeChats: true, includeDocuments: false, chatIds: [] })
    expect(result.evidence).toEqual([])
    expect(result.warnings.join('')).toContain('身份不匹配')
  })
  it('generates usable chat evidence despite unavailable document version capability without endless retry', async () => {
    const d = deps()
    d.call = vi.fn(async () => ({ items: [{ chat: { id: 'chat', name: 'Project' }, message: message('confirmed-work') }] }))
    d.get = vi.fn(async uri => {
      if (uri.startsWith('/v7/files/search')) return { items: ['f1', 'f2'].map(id => ({ file: { id, drive_id: 'drive', mtime: stamp, modified_by: other } })) }
      throw new WpsApiError(403, 400000003)
    })
    const result = await collectDailyWps(d, '2026-10-09', { includeChats: true, includeDocuments: true, chatIds: [] })
    expect(result.evidence.filter(e => e.kind === 'message' && e.attribution === 'self')).toHaveLength(1)
    expect(result.evidence.filter(e => e.kind === 'document').map(e => e.attribution)).toEqual(['unknown', 'unknown'])
    expect(result.complete).toBe(false)
    expect(result.retryable).toBe(false)
    expect(result.warnings.join('')).toContain('kso.file_version.readwrite')
    expect(result.warnings.join('')).toContain('HTTP 403')
    expect(d.get).toHaveBeenCalledTimes(2)
  })
  it('collects own messages across pages, deduplicates selected context and checks attribution', async () => {
    const d = deps()
    d.call = vi.fn(async (_service, name, args) => {
      if (name === 'kso_message_search_messages') {
        expect(args.sender_id_list).toEqual(['me'])
        expect(args.start_time).toBe(reportDayRange('2026-10-09', now).start)
        return args.page_token ? { items: [message('2')] } : { items: [message('1')], next_page_token: 'next' }
      }
      return { items: [message('1'), message('3', other)] }
    })
    const result = await collectDailyWps(d, '2026-10-09', { includeChats: true, includeDocuments: false, chatIds: ['chat'] })
    expect(result.evidence).toHaveLength(3)
    expect(result.evidence.map(item => item.attribution)).toEqual(['self', 'self', 'context'])
    expect(result.complete).toBe(true)
  })
  it('never treats another company or out-of-range message as own work', async () => {
    const d = deps()
    d.call = vi.fn(async () => ({ items: [message('foreign', { ...mine, company_id: 'foreign' }), { ...message('old'), ctime: stamp - 86400 }] }))
    const result = await collectDailyWps(d, '2026-10-09', { includeChats: true, includeDocuments: false, chatIds: [] })
    expect(result.evidence).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.warnings).toHaveLength(2)
  })
  it('records collection gaps when a later page fails, without claiming complete coverage', async () => {
    const d = deps()
    d.call = vi.fn(async (_s, _n, args) => {
      if (args.page_token) throw new Error('failure')
      return { items: [message('1')], next_page_token: 'next' }
    })
    const result = await collectDailyWps(d, '2026-10-09', { includeChats: true, includeDocuments: false, chatIds: [] })
    expect(result.complete).toBe(false)
    expect(result.warnings.join('')).toContain('分页未完成')
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]?.attribution).toBe('self')
    expect(result.retryable).toBe(true)
  })
  it('uses version authors for own contributions, leaves unrelated documents unknown and extracts only own docs', async () => {
    const d = deps()
    d.get = vi.fn(async uri => uri.startsWith('/v7/files/search') ? { items: [
      { file: { id: 'f1', drive_id: 'drive', name: 'Doc 1', mtime: stamp, modified_by: other } },
      { file: { id: 'f2', drive_id: 'drive', name: 'Doc 2', mtime: stamp, modified_by: other } },
    ] } : { items: uri.includes('/f1/') ? [{ mtime: stamp, modified_by: mine }] : [] })
    d.call = vi.fn(async () => '# 当前文档全文')
    const result = await collectDailyWps(d, '2026-10-09', { includeChats: false, includeDocuments: true, chatIds: [] })
    expect(result.evidence.map(item => item.attribution)).toEqual(['self', 'unknown'])
    expect(d.call).toHaveBeenCalledTimes(1)
    expect(result.evidence[0]!.content).toContain('不是当天修改的差异')
    expect(result.evidence[0]!.locator).toEqual({ fileId: 'f1', driveId: 'drive' })
  })
  it('retains document metadata with a warning when content extraction fails', async () => {
    const d = deps()
    d.get = vi.fn(async () => ({ items: [{ file: { id: 'f1', drive_id: 'drive', mtime: stamp, modified_by: mine } }] }))
    d.call = vi.fn(async () => { throw new Error('denied') })
    const result = await collectDailyWps(d, '2026-10-09', { includeChats: false, includeDocuments: true, chatIds: [] })
    expect(result.evidence).toHaveLength(1)
    expect(result.complete).toBe(false)
    expect(result.warnings.join('')).toContain('正文')
  })
  it('finds a historical self edit even when another person modified that file today', async () => {
    const d = deps(), oldTime = stamp - 86400
    d.get = vi.fn(async uri => uri.startsWith('/v7/files/search') ? { items: [{ file: { id: 'f1', drive_id: 'drive', mtime: stamp, modified_by: other } }] }
      : { items: [{ id: 'historical-version', mtime: oldTime, modified_by: mine }] })
    d.call = vi.fn(async () => 'Current content')
    const result = await collectDailyWps(d, '2026-10-08', { includeChats: false, includeDocuments: true, chatIds: [] })
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]!.timestamp).toBe(oldTime * 1000)
    expect(result.evidence[0]!.locator.versionId).toBe('historical-version')
    expect(result.evidence[0]!.content).toContain('本人当日版本活动证据')
    expect(result.warnings.join('')).toContain('未保留版本')
  })
  it('does not collect disabled sources and aborts cancellation', async () => {
    const d = deps()
    await expect(collectDailyWps(d, '2026-10-09', { includeChats: true, includeDocuments: false, chatIds: [] }, AbortSignal.abort())).rejects.toThrow()
    expect(d.get).not.toHaveBeenCalled()
    expect(d.call).not.toHaveBeenCalled()
  })
  it('rejects invalid calendar dates and future or over-old reports', () => {
    expect(() => reportDayRange('2026-02-31', now)).toThrow('无效')
    expect(() => reportDayRange('2026-10-10', now)).toThrow('最近七天')
    expect(() => reportDayRange('2026-09-01', now)).toThrow('最近七天')
  })
})
