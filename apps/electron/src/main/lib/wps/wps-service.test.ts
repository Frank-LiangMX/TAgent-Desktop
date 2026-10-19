import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WpsConnectionInput, WpsDailyBundle } from '@tagent/shared'
import { wpsScopes, type WpsFetch } from './wps-client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { WPS_DOCUMENT_CREATE_SCOPE } from './wps-document-create'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const { secure, runCli } = vi.hoisted(() => ({ secure: { available: true }, runCli: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => secure.available,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`), decryptString: (value: Buffer) => value.toString().slice(10) } }))
vi.mock('../channel/channel-store', () => ({ getChannel: vi.fn() }))
vi.mock('./wps-cli-auth', () => ({ ensureWpsCli: vi.fn().mockResolvedValue('wps365-cli.exe'), runWpsCli: runCli,
  parseWpsAccessToken: (value: string) => { try { return JSON.parse(value).access_token ?? value } catch { return value } } }))
import { WpsService } from './wps-service'
import { writeJsonAtomic } from '../atomic-json'

let root: string, service: WpsService
const input: WpsConnectionInput = { reportScope: { includeChats: true, includeDocuments: false, chatIds: [] } }
const load = () => JSON.parse(readFileSync(join(root, 'wps.json'), 'utf8'))
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tagent-wps-test-')); process.env.TAGENT_CONFIG_DIR = root
  secure.available = true; runCli.mockClear(); runCli.mockImplementation(async (args: string[]) => args[1] === 'login' ? '' : JSON.stringify({ access_token: 'synthetic-access' }))
  service = new WpsService()
})
afterEach(() => { service.logout(); vi.unstubAllGlobals(); delete process.env.TAGENT_CONFIG_DIR; rmSync(root, { recursive: true, force: true }) })

function authorize(): void {
  service.save(input)
  writeJsonAtomic(join(root, 'wps.json'), { ...load(), userId: 'me', companyId: 'company', userName: 'Synthetic user',
    userAccessToken: Buffer.from('encrypted:synthetic-access').toString('base64'), userTokenExpiresAt: Date.now() + 3600_000,
    authorizedScopes: wpsScopes(input.reportScope) })
}

describe('WPS account and evidence boundaries', () => {
  it('keeps metadata lookup read-only and allows a new attempt after a definite transport permission denial', async () => {
    authorize()
    writeJsonAtomic(join(root, 'wps.json'), { ...load(), authorizedScopes: [...load().authorizedScopes, WPS_DOCUMENT_CREATE_SCOPE, 'kso.mcp_yundoc.readwrite'] })
    const connect = vi.spyOn(Client.prototype, 'connect').mockRejectedValueOnce(new StreamableHTTPError(403, 'private-error')).mockResolvedValue(undefined)
    const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined)
    const call = vi.spyOn(Client.prototype, 'callTool')
      .mockResolvedValueOnce({ content: [], structuredContent: { file_id: 'file' } })
      .mockResolvedValueOnce({ content: [], structuredContent: { file_url: 'https://365.kdocs.cn/l/report' } })
    try {
      const input = { title: '周报', markdown: '# 本周进展' }
      await expect(service.createDocument(input)).rejects.toThrow('WPS 拒绝')
      expect(await service.createDocument(input)).toMatchObject({ created: true, url: 'https://365.kdocs.cn/l/report' })
      expect(call.mock.calls.map(args => args[0].name)).toEqual(['kso_airpage_import_markdown_data', 'kso_yundoc_get_file_meta'])
      expect(await service.createDocument(input)).toMatchObject({ reused: true, url: 'https://365.kdocs.cn/l/report' })
      expect(call).toHaveBeenCalledTimes(2)
    } finally { connect.mockRestore(); close.mockRestore(); call.mockRestore() }
  })
  it('creates a new cloud document with the exact report body and no existing file ID, then reuses it', async () => {
    authorize()
    await expect(service.createDocument({ title: '周报', markdown: '# 本周进展' })).rejects.toThrow('授权创建云文档')
    writeJsonAtomic(join(root, 'wps.json'), { ...load(), authorizedScopes: [...load().authorizedScopes, WPS_DOCUMENT_CREATE_SCOPE] })
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined)
    const call = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [], structuredContent: {
      code: 0, data: { file_id: 'file', file_url: 'https://365.kdocs.cn/l/report' },
    } })
    try {
      const input = { title: '周报', markdown: '# 本周进展\n\n- 完成接口联调' }
      expect(await service.createDocument(input)).toMatchObject({ created: true, url: 'https://365.kdocs.cn/l/report' })
      expect(await service.createDocument(input)).toMatchObject({ reused: true })
      expect(call).toHaveBeenCalledTimes(1)
      expect(call).toHaveBeenCalledWith({ name: 'kso_airpage_import_markdown_data', arguments: {
        file_name: '周报', markdown_content: input.markdown,
      } }, undefined, expect.any(Object))
      expect(close).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(service.authState())).not.toContain('synthetic-access')
      expect(service.authState().canCreateDocuments).toBe(true)
    } finally { connect.mockRestore(); close.mockRestore(); call.mockRestore() }
  })
  it('requests the extra creation scope only through the dedicated authorization and preserves it on reconnect', async () => {
    vi.stubGlobal('fetch', vi.fn<WpsFetch>().mockResolvedValue(Response.json({ code: 0, data: { id: 'me', company_id: 'company' } })))
    service = new WpsService(); service.save(input)
    await service.loginUser(true)
    await vi.waitFor(() => expect(service.authState().loading).toBe(false))
    expect(runCli).toHaveBeenCalledWith(['auth', 'login', '--scopes', [...wpsScopes(input.reportScope), WPS_DOCUMENT_CREATE_SCOPE].join(',')])
    expect(service.authState().canCreateDocuments).toBe(true)
    runCli.mockClear()
    await service.loginUser()
    await vi.waitFor(() => expect(service.authState().loading).toBe(false))
    expect(runCli).toHaveBeenCalledWith(['auth', 'login', '--scopes', [...wpsScopes(input.reportScope), WPS_DOCUMENT_CREATE_SCOPE].join(',')])
    service.logout()
    expect(service.authState().canCreateDocuments).toBe(false)
  })
  it('reads message history through user MCP and renews an expired CLI token first', async () => {
    authorize()
    writeJsonAtomic(join(root, 'wps.json'), { ...load(), userTokenExpiresAt: Date.now() - 1 })
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined)
    const call = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [], structuredContent: {
      code: 0, data: { items: [{ id: 'message', content: { text: { content: '聊天原文' } } }], next_page_token: 'next' },
    } })
    try {
      const page = await service.queryMessages({ kind: 'history', chatId: 'chat', startDate: '2026-09-01', endDate: '2026-09-02' })
      expect(runCli).toHaveBeenCalledWith(['auth', 'token'])
      expect(connect).toHaveBeenCalledTimes(1)
      expect(call).toHaveBeenCalledWith({ name: 'kso_message_get_chat_messages', arguments: expect.objectContaining({ chat_id: 'chat', page_size: 20 }) }, undefined, expect.any(Object))
      expect(page).toMatchObject({ items: [{ id: 'message' }], nextPageToken: 'next', complete: false })
      expect(load().userTokenExpiresAt).toBeGreaterThan(Date.now())
      expect(close).toHaveBeenCalledTimes(1)
    } finally { connect.mockRestore(); call.mockRestore(); close.mockRestore() }
  })
  it('rejects message reads without a connected account or the user-message scope', async () => {
    await expect(service.queryMessages({ kind: 'chats' })).rejects.toThrow('授权本人账号')
    authorize()
    writeJsonAtomic(join(root, 'wps.json'), { ...load(), authorizedScopes: ['kso.user_base.read'] })
    await expect(service.queryMessages({ kind: 'chats' })).rejects.toThrow('新的权限')
    expect(runCli).not.toHaveBeenCalled()
  })
  it('connects validated REST account identity to raw MCP sender IDs without exposing the token', async () => {
    authorize()
    const config = load()
    const token = `header.${Buffer.from(JSON.stringify({ aid: 1234567890, cid: 987654321, cli: config.appId,
      exp: Math.floor(Date.now() / 1000) + 3600, privateClaim: 'never-return-this' })).toString('base64url')}.signature`
    writeJsonAtomic(join(root, 'wps.json'), { ...config, userAccessToken: Buffer.from(`encrypted:${token}`).toString('base64') })
    const request = vi.fn<WpsFetch>().mockResolvedValue(Response.json({ code: 0, data: { id: 'me', company_id: 'company' } }))
    vi.stubGlobal('fetch', request)
    service = new WpsService()
    const call = vi.spyOn(service, 'call').mockImplementation(async (_s, _n, args) => {
      expect(args.sender_id_list).toEqual(['1234567890'])
      return { items: [{ chat: { id: 'chat', name: 'Synthetic project' }, message: { id: 'message', chat_id: 'chat', ctime: Date.now(),
        sender: { id: '1234567890', company_id: '987654321', type: 'user' }, content: { text: { content: 'Completed synthetic work' } } } }] }
    })
    const summary = await service.collectForSession('manual-report')
    expect(summary.ownMessageCount).toBe(1)
    expect(summary.complete).toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    const evidence = service.evidence('manual-report', 0)
    expect(evidence.evidence[0]?.attribution).toBe('self')
    expect(JSON.stringify(evidence)).not.toContain(token)
    expect(JSON.stringify(evidence)).not.toContain('never-return-this')
    expect(JSON.stringify(service.authState())).not.toContain('1234567890')
  })
  it('returns only public config and auth state without application credentials', () => {
    authorize()
    const visible = JSON.stringify([service.publicConfig(), service.authState()])
    expect(visible).not.toContain('userAccessToken'); expect(visible).not.toContain('synthetic-access')
    expect(service.publicConfig()).toEqual({ available: true, reportScope: input.reportScope })
  })
  it('requires system encryption before opening login', async () => { secure.available = false; await expect(service.loginUser()).rejects.toThrow('加密不可用') })
  it('clears current and backup user tokens but preserves the application binding', () => {
    authorize(); service.logout(); service.logout()
    expect(load().userAccessToken).toBeUndefined(); expect(JSON.parse(readFileSync(join(root, 'wps.json.bak'), 'utf8')).userAccessToken).toBeUndefined()
    expect(load().appId).toBeTruthy(); expect(load().secretKey).toBe('builtin'); expect(service.authState().loggedIn).toBe(false)
  })
  it('isolates evidence by task, fixes scheduled report dates and rejects a changed account', async () => {
    authorize()
    const bundle: WpsDailyBundle = { date: '2026-10-08', accountId: 'me', companyId: 'company', scope: input.reportScope, collectedAt: Date.now(), complete: true, warnings: [], evidence: [] }
    service.bind('report', bundle, true); expect(() => service.evidence('other', 0)).toThrow('没有采集快照')
    await expect(service.collectForSession('report', '2026-10-09')).rejects.toThrow('不能改为'); expect((await service.collectForSession('report')).date).toBe('2026-10-08')
    writeJsonAtomic(join(root, 'wps.json'), { ...load(), userId: 'another' }); expect(() => service.evidence('report', 0)).toThrow('账号已变更')
  })
  it('requires every evidence page to be read before recording a completed daily report', () => {
    authorize(); service.bind('report', { date: '2026-10-09', accountId: 'me', companyId: 'company', scope: input.reportScope,
      collectedAt: Date.now(), complete: true, warnings: [], evidence: Array.from({ length: 21 }, (_, index) => ({ sourceId: `message:chat:${index}`, kind: 'message', title: 'Synthetic chat', attribution: 'self', locator: { messageId: String(index) }, content: 'synthetic evidence' })) }, true)
    expect(() => service.assertEvidenceRead('report')).toThrow('未读取全部'); expect(service.evidence('report', 0).nextOffset).toBe(20); expect(() => service.assertEvidenceRead('report')).toThrow('未读取全部')
    service.evidence('report', 20); expect(() => service.assertEvidenceRead('report')).not.toThrow()
  })
  it('opens the WPS CLI browser login without asking the user for keys or callback settings', async () => {
    const request = vi.fn<WpsFetch>().mockResolvedValue(Response.json({ code: 0, data: { id: 'me', company_id: 'company', user_name: 'Synthetic user' } }))
    vi.stubGlobal('fetch', request); service = new WpsService(); service.save(input); await service.loginUser(); await vi.waitFor(() => expect(service.authState().loggedIn).toBe(true))
    expect(runCli).toHaveBeenCalledWith(['auth', 'login', '--scopes', wpsScopes(input.reportScope).join(',')]); expect(runCli).toHaveBeenCalledWith(['auth', 'token'])
    expect(load().appId).toBeTruthy(); expect(load().secretKey).toBe('builtin'); expect(load().userAccessToken).toBeTruthy(); expect(JSON.stringify(service.publicConfig())).not.toMatch(/token|secret/i)
  })
  it('refreshes an expired CLI token without requiring a public callback service', async () => {
    authorize(); writeJsonAtomic(join(root, 'wps.json'), { ...load(), userTokenExpiresAt: Date.now() - 1 })
    const request = vi.fn<WpsFetch>().mockResolvedValue(Response.json({ code: 0, data: { id: 'me', company_id: 'company' } }))
    vi.stubGlobal('fetch', request); service = new WpsService(); await service.client.get('/v7/users/current'); expect(runCli).toHaveBeenCalledWith(['auth', 'token']); expect(load().userAccessToken).toBeTruthy()
  })
  it('rejects client application-key injection through IPC', () => { expect(() => service.save({ ...input, secretKey: 'injected' } as WpsConnectionInput)).toThrow('仅支持修改') })
})
