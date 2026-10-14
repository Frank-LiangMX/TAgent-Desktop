import { describe, expect, it, vi } from 'vitest'
import type { WpsConfig } from '@tagent/shared'
import { WpsClient, WpsApiError, collectWpsPages, unpackWpsMcp, wpsGetSignature, wpsScopes, wpsMessageIdentity, wpsReadFailure, type WpsFetch } from './wps-client'

function setup(request: WpsFetch) {
  let config: WpsConfig = { enabled: true, appId: 'AK123456', secretKey: 'encrypted:sk098765', apiUrl: '', callbackPath: '/callback', callbackPort: 18789,
    userAccessToken: 'encrypted:old-access', userRefreshToken: 'encrypted:old-refresh', userTokenExpiresAt: 1000 }
  const write = vi.fn((next: WpsConfig) => { config = next })
  const client = new WpsClient({ read: () => config, write, encrypt: value => `encrypted:${value}`, decrypt: value => value.slice(10), fetch: request, now: () => 10_000 })
  return { client, write, config: () => config }
}
const tokens = () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 7200, refresh_expires_in: 600 })

describe('WPS user OAuth and read client', () => {
  it('extracts only raw message identity from a validated application-bound user token', () => {
    const token = (claims: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
    const claims = { aid: 1234567890, cid: 987654321, cli: 'test-app', exp: 200, secretClaim: 'must-not-be-returned' }
    expect(wpsMessageIdentity(token(claims), 'test-app', 100_000)).toEqual({ id: '1234567890', companyId: '987654321' })
    expect(wpsMessageIdentity(token(claims), 'other-app', 100_000)).toBeUndefined()
    expect(wpsMessageIdentity(token(claims), 'test-app', 200_000)).toBeUndefined()
    expect(wpsMessageIdentity(token({ ...claims, aid: Number.MAX_SAFE_INTEGER + 1 }), 'test-app', 100_000)).toBeUndefined()
    expect(wpsMessageIdentity(token({ ...claims, cid: undefined }), 'test-app', 100_000)).toBeUndefined()
    expect(wpsMessageIdentity('opaque-access-token', 'test-app')).toBeUndefined()
  })
  it('distinguishes permission denial from retryable transport failures without exposing error bodies', () => {
    expect(wpsReadFailure(new WpsApiError(403, 400000003))).toMatchObject({ retryable: false, detail: expect.stringContaining('HTTP 403') })
    expect(wpsReadFailure(new WpsApiError(401))).toMatchObject({ retryable: false, detail: expect.stringContaining('授权已失效') })
    expect(wpsReadFailure(new WpsApiError(429)).retryable).toBe(true)
    expect(wpsReadFailure(new WpsApiError(503)).retryable).toBe(true)
    const failure = wpsReadFailure(new Error('access_token=private-secret'))
    expect(failure.retryable).toBe(true)
    expect(failure.detail).not.toContain('private-secret')
  })
  it('matches the official GET signing vector including the empty-body rule', () => {
    expect(wpsGetSignature('AK123456', 'sk098765', '/v7/test?key=value', 'Mon, 02 Jan 2006 15:04:05 GMT'))
      .toBe('KSO-1 AK123456:ce8df66877175e5198c8ea1362ffddf82e4941c6f25a4ca205a1ad09d0faaf03')
  })
  it('refreshes concurrent reads once and persists both rotated tokens encrypted', async () => {
    const request = vi.fn<WpsFetch>().mockResolvedValue(tokens())
    const { client, config, write } = setup(request)
    expect(await Promise.all([client.accessToken(), client.accessToken(), client.accessToken()])).toEqual(['new-access', 'new-access', 'new-access'])
    expect(request).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(config().userRefreshToken).toBe('encrypted:new-refresh')
    expect(config().userTokenExpiresAt).toBe(7_210_000)
    expect(config().userRefreshExpiresAt).toBe(610_000)
    expect(new URLSearchParams(request.mock.calls[0]![1]!.body as URLSearchParams).get('grant_type')).toBe('refresh_token')
    await client.accessToken()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not restore credentials after logout invalidates an in-flight refresh', async () => {
    let finish!: (response: Response) => void
    const request = vi.fn<WpsFetch>(() => new Promise(resolve => { finish = resolve }))
    const { client, write } = setup(request)
    const pending = client.accessToken()
    client.invalidate(); finish(tokens())
    await expect(pending).rejects.toThrow('取消')
    expect(write).not.toHaveBeenCalled()
  })
  it('does not expose token responses or echoed secrets in errors', async () => {
    const request = vi.fn<WpsFetch>().mockResolvedValue(Response.json({ code: 403, msg: 'client_secret=private-secret' }, { status: 403 }))
    const { client } = setup(request)
    await expect(client.accessToken()).rejects.toThrow('代码 403')
    await expect(client.accessToken()).rejects.not.toThrow('private-secret')
  })
  it('verifies user identity before persisting a code exchange', async () => {
    const request = vi.fn<WpsFetch>().mockResolvedValueOnce(tokens()).mockResolvedValueOnce(Response.json({ code: 0, data: { id: 'me', company_id: 'company', user_name: 'My name' } }))
    const { client, config } = setup(request)
    await client.exchangeCode('code', 'http://127.0.0.1:18789/callback', ['kso.user_base.read'])
    expect(config().userId).toBe('me')
    expect(config().companyId).toBe('company')
    expect(config().authorizedScopes).toEqual(['kso.user_base.read'])
    expect(request.mock.calls[1]![1]!.headers).toMatchObject({ Authorization: 'Bearer new-access' })
  })
  it('does not persist tokens when the identity endpoint fails', async () => {
    const request = vi.fn<WpsFetch>().mockResolvedValueOnce(tokens()).mockResolvedValueOnce(Response.json({ code: 403 }, { status: 403 }))
    const { client, write } = setup(request)
    await expect(client.exchangeCode('code', 'http://127.0.0.1/callback', [])).rejects.toThrow('失败')
    expect(write).not.toHaveBeenCalled()
  })
  it('requests only capabilities selected for collection', () => {
    expect(wpsScopes({ includeChats: true, includeDocuments: false, chatIds: [] })).toEqual(['kso.user_base.read', 'kso.mcp_message.readwrite'])
    expect(wpsScopes({ includeChats: false, includeDocuments: true, chatIds: [] })).toEqual(['kso.user_base.read', 'kso.mcp_yundoc.readwrite', 'kso.file.search', 'kso.file_version.readwrite'])
  })
})

describe('WPS paginated results', () => {
  it('follows every page and preserves all items', async () => {
    const load = vi.fn().mockResolvedValueOnce({ items: [{ id: '1' }], next_page_token: 'next' }).mockResolvedValueOnce({ items: [{ id: '2' }] })
    expect(await collectWpsPages(load)).toEqual([{ id: '1' }, { id: '2' }])
    expect(load).toHaveBeenNthCalledWith(2, 'next')
  })
  it('rejects repeated cursors and unknown structures instead of returning empty data', async () => {
    await expect(collectWpsPages(async () => ({ items: [], next_page_token: 'loop' }))).rejects.toThrow('重复')
    await expect(collectWpsPages(async () => ({ unexpected: [] }))).rejects.toThrow('缺少')
    await expect(collectWpsPages(async () => ({ items: [], has_more: true }))).rejects.toThrow('游标')
  })
  it('detects business errors inside MCP results and supports text JSON envelopes', () => {
    expect(unpackWpsMcp({ content: [{ type: 'text', text: JSON.stringify({ code: 0, data: { items: [] } }) }] })).toEqual({ items: [] })
    expect(() => unpackWpsMcp({ structuredContent: { code: 403 } })).toThrow('代码 403')
    expect(() => unpackWpsMcp({ isError: true, content: [] })).toThrow('失败')
  })
})
