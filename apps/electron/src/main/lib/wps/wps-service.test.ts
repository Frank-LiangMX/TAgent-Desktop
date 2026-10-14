import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WpsConnectionInput, WpsDailyBundle } from '@tagent/shared'
import { wpsScopes, type WpsFetch } from './wps-client'

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
  secure.available = true; runCli.mockImplementation(async (args: string[]) => args[1] === 'login' ? '' : JSON.stringify({ access_token: 'synthetic-access' }))
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
