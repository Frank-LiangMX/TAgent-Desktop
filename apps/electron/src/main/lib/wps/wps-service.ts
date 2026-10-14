import { isChannelCompatibleWithRuntime } from '@tagent/shared'
import { BrowserWindow, ipcMain, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WPS_IPC_CHANNELS, type WpsConfig, type WpsConnectionInput, type WpsPublicConfig, type WpsUserAuthState,
  type WpsReportScope, type WpsDailyReportSource, type WpsDailyBundle, type WpsCollectionSummary, type WpsChatSummary } from '@tagent/shared'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getConfigDir } from '../config/config-paths'
import { getChannel } from '../channel/channel-store'
import { createAutomation, listAutomations } from '../automation-manager'
import { collectDailyWps, localReportDate, WPS_DAILY_REPORT_PROMPT } from './wps-daily-collector'
import { DEFAULT_WPS_SCOPE, WPS_ORIGIN, WpsClient, WpsApiError, collectWpsPages, record, string, unpackWpsMcp, wpsScopes, wpsMessageIdentity } from './wps-client'
import { getWpsAppCredentials } from './wps-app-credentials'
import { ensureWpsCli, parseWpsAccessToken, runWpsCli } from './wps-cli-auth'

const path = (): string => join(getConfigDir(), 'wps.json')
const defaults: WpsConfig = { enabled: true, appId: getWpsAppCredentials().appId, secretKey: 'builtin', apiUrl: WPS_ORIGIN, callbackPort: 18365, callbackPath: '/oauth/callback', reportScope: DEFAULT_WPS_SCOPE }
const read = (): WpsConfig => {
  const stored = readJsonSafe<Partial<WpsConfig>>(path(), {})
  const config = { ...defaults, ...stored }
  if (!config.appId) config.appId = defaults.appId
  if (!config.secretKey) config.secretKey = defaults.secretKey
  return config
}
const write = (config: WpsConfig): void => writeJsonAtomic(path(), config)
function encrypt(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存 WPS 授权。')
  return safeStorage.encryptString(value).toString('base64')
}
function decrypt(value: string): string {
  if (value === 'builtin') return getWpsAppCredentials().secretKey
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')) }
  catch { throw new Error('WPS 凭据无法解密，请重新连接 WPS。') }
}

function normalizeScope(input: WpsReportScope): WpsReportScope {
  if (!input || typeof input.includeChats !== 'boolean' || typeof input.includeDocuments !== 'boolean' || !Array.isArray(input.chatIds)) throw new Error('WPS 采集范围无效。')
  if (!input.includeChats && !input.includeDocuments) throw new Error('请选择聊天或文档采集。')
  if (input.chatIds.length > 50 || input.chatIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) throw new Error('最多选择 50 个会话。')
  return { includeChats: input.includeChats, includeDocuments: input.includeDocuments, chatIds: [...new Set(input.chatIds)] }
}

export class WpsService {
  readonly client = new WpsClient({ read, write, encrypt, decrypt, refreshUserToken: () => this.refreshCliToken() })
  private login?: Promise<void>
  private epoch = 0
  private authError?: string
  private snapshots = new Map<string, WpsDailyBundle>()
  private frozenSessions = new Set<string>()
  private evidenceReads = new Map<string, Set<number>>()

  publicConfig(): WpsPublicConfig {
    const c = read()
    return { available: !!c.appId && !!getWpsAppCredentials().secretKey,
      reportScope: c.reportScope ?? DEFAULT_WPS_SCOPE }
  }

  authState(): WpsUserAuthState {
    const c = read()
    const valid = !!c.userAccessToken && !!c.userId && (c.userTokenExpiresAt ?? 0) > Date.now()
    return { loggedIn: valid, loading: !!this.login, userId: valid ? c.userId : undefined, companyId: valid ? c.companyId : undefined,
      userName: valid ? c.userName : undefined, expiresAt: c.userTokenExpiresAt, errorMessage: this.authError }
  }

  private broadcast(): void {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(WPS_IPC_CHANNELS.USER_AUTH_CHANGED, this.authState())
  }
  private clearLogin(): void {
    this.login = undefined
  }
  logout(): WpsUserAuthState {
    this.epoch++; this.clearLogin(); this.snapshots.clear(); this.frozenSessions.clear(); this.evidenceReads.clear(); this.authError = undefined
    const c = read()
    delete c.userAccessToken; delete c.userRefreshToken; delete c.userTokenExpiresAt; delete c.userRefreshExpiresAt
    delete c.userName; delete c.userEmail; delete c.userId; delete c.companyId; delete c.authorizedScopes
    // 同时清除原子备份中的旧 token，避免损坏恢复时恢复已退出的登录态。
    write({ ...c, appId: defaults.appId, secretKey: defaults.secretKey }); this.broadcast(); return this.authState()
  }

  save(input: WpsConnectionInput): WpsPublicConfig {
    if (!input || Object.keys(input).some(key => key !== 'reportScope')) throw new Error('用户设置仅支持修改 WPS 采集范围。')
    const scope = normalizeScope(input.reportScope)
    this.epoch++; this.clearLogin(); this.snapshots.clear(); this.frozenSessions.clear(); this.evidenceReads.clear()
    write({ ...read(), reportScope: scope })
    this.broadcast(); return this.publicConfig()
  }

  async loginUser(): Promise<WpsUserAuthState> {
    if (!this.publicConfig().available) throw new Error('应用内 WPS 凭据不可用，请联系应用管理员。')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存 WPS 授权。')
    if (this.login) return this.authState()
    this.logout()
    const epoch = this.epoch
    const scope = this.publicConfig().reportScope
    let task!: Promise<void>
    task = (async () => {
      try {
        await ensureWpsCli()
        await runWpsCli(['auth', 'login', '--scopes', wpsScopes(scope).join(',')])
        if (epoch !== this.epoch) return
        const token = parseWpsAccessToken(await runWpsCli(['auth', 'token']))
        if (!token) throw new Error('WPS 登录未返回用户凭据。')
        write({ ...read(), enabled: true, userAccessToken: encrypt(token), userTokenExpiresAt: Date.now() + 2 * 3600_000,
          userRefreshToken: undefined, userRefreshExpiresAt: undefined, authorizedScopes: wpsScopes(scope) })
        const identity = record(await this.client.get('/v7/users/current'))
        if (!string(identity.id)) throw new Error('WPS 未返回本人身份。')
        write({ ...read(), userId: string(identity.id), companyId: string(identity.company_id), userName: string(identity.user_name), userEmail: string(identity.email) })
        this.authError = undefined
      } catch (error) {
        if (epoch === this.epoch) this.authError = error instanceof Error ? error.message : 'WPS 登录失败，请重试。'
      } finally { if (this.login === task) this.login = undefined; this.broadcast() }
    })()
    this.login = task; this.broadcast(); return this.authState()
  }

  private async refreshCliToken(): Promise<string> {
    const token = parseWpsAccessToken(await runWpsCli(['auth', 'token']))
    if (!token) throw new Error('WPS 登录已过期，请重新连接 WPS。')
    write({ ...read(), userAccessToken: encrypt(token), userTokenExpiresAt: Date.now() + 2 * 3600_000 })
    return token
  }

  private checkAccount(accountId?: string, companyId?: string): WpsConfig {
    const c = read()
    if (!this.authState().loggedIn || !c.userId) throw new Error('请先在设置 → WPS 日报中授权本人账号。')
    if (accountId && (c.userId !== accountId || companyId !== undefined && c.companyId !== companyId)) throw new Error('WPS 日报绑定的账号已变更，请重新配置日报任务。')
    return c
  }
  private checkScopes(scope: WpsReportScope): void {
    const c = this.checkAccount()
    if (wpsScopes(scope).some(value => !c.authorizedScopes?.includes(value))) throw new Error('WPS 采集范围需要新的权限，请重新授权。')
  }

  async call(service: 'message' | 'yundoc', name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const allowed = service === 'message'
      ? ['kso_message_get_chat_list', 'kso_message_search_messages', 'kso_message_get_chat_messages']
      : ['kso_yundoc_extract_yundoc_content']
    if (!allowed.includes(name)) throw new Error('WPS 日报仅支持读取工具。')
    signal?.throwIfAborted()
    const epoch = this.epoch
    this.checkScopes({ includeChats: service === 'message', includeDocuments: service === 'yundoc', chatIds: [] })
    const token = await this.client.accessToken()
    const client = new Client({ name: 'tagent-wps-readonly', version: '1.0.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(`${WPS_ORIGIN}/mcp/v2/kso-${service}/message`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
    })
    let result: unknown
    try {
      await client.connect(transport, { timeout: 30_000, signal })
      result = unpackWpsMcp(await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000, signal }))
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof WpsApiError) throw error
      throw new Error('WPS 读取工具失败，请检查本人权限和 WPS 接入配置。')
    }
    finally { await client.close().catch(() => {}) }
    if (epoch !== this.epoch) throw new Error('WPS 授权或范围已变更。')
    return result
  }

  async listChats(): Promise<WpsChatSummary[]> {
    this.checkScopes({ includeChats: true, includeDocuments: false, chatIds: [] })
    const items = await collectWpsPages(cursor => this.call('message', 'kso_message_get_chat_list', { page_size: 100, ...(cursor ? { page_token: cursor } : {}) }))
    return items.flatMap(item => {
      const id = string(item.id ?? item.chat_id)
      return id ? [{ id, title: string(item.title ?? item.name) || id }] : []
    })
  }

  async collect(date = localReportDate(), scope = this.publicConfig().reportScope, accountId?: string, signal?: AbortSignal, companyId?: string): Promise<WpsDailyBundle> {
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) : AbortSignal.timeout(5 * 60_000)
    scope = normalizeScope(scope)
    this.checkScopes(scope)
    const c = this.checkAccount(accountId, companyId)
    const epoch = this.epoch
    const identity = record(await this.client.get('/v7/users/current', signal))
    if (identity.id !== c.userId || string(identity.company_id) !== string(c.companyId)) throw new Error('WPS 当前用户与日报账号不匹配，请重新授权。')
    const messageIdentity = scope.includeChats ? wpsMessageIdentity(await this.client.accessToken(), c.appId) : undefined
    const bundle = await collectDailyWps({ get: (uri, abort) => this.client.get(uri, abort), call: (service, name, args, abort) => this.call(service, name, args, abort),
      identity: { id: c.userId!, companyId: c.companyId, name: c.userName, messageIdentity } }, date, scope, signal)
    if (epoch !== this.epoch) throw new Error('采集期间 WPS 账号或范围已变更，结果未保存。')
    return bundle
  }

  summary(bundle: WpsDailyBundle): WpsCollectionSummary {
    return { date: bundle.date, accountId: bundle.accountId, complete: bundle.complete, warnings: bundle.warnings,
      evidenceCount: bundle.evidence.length, ownMessageCount: bundle.evidence.filter(item => item.kind === 'message' && item.attribution === 'self').length,
      documentCount: bundle.evidence.filter(item => item.kind === 'document').length }
  }
  bind(sessionId: string, bundle: WpsDailyBundle, freeze = false): void {
    this.checkAccount(bundle.accountId, bundle.companyId)
    this.snapshots.delete(sessionId); this.snapshots.set(sessionId, bundle)
    this.evidenceReads.delete(sessionId)
    if (freeze) this.frozenSessions.add(sessionId)
    // 临时采集缓存只保留在内存；被模型读取的证据可随工具结果落入会话历史。
    while (this.snapshots.size > 30) {
      const oldest = this.snapshots.keys().next().value!
      this.snapshots.delete(oldest); this.frozenSessions.delete(oldest); this.evidenceReads.delete(oldest)
    }
  }
  async collectForSession(sessionId: string, date?: string, signal?: AbortSignal): Promise<WpsCollectionSummary> {
    const snapshot = this.snapshots.get(sessionId)
    if (snapshot && this.frozenSessions.has(sessionId)) {
      this.checkAccount(snapshot.accountId, snapshot.companyId)
      if (date && date !== snapshot.date) throw new Error(`当前日报目标日期是 ${snapshot.date}，不能改为 ${date}。`)
      return this.summary(snapshot)
    }
    const bundle = await this.collect(date ?? localReportDate(), undefined, undefined, signal)
    this.bind(sessionId, bundle)
    return this.summary(bundle)
  }
  evidence(sessionId: string, offset: number): { summary: WpsCollectionSummary; evidence: WpsDailyBundle['evidence']; nextOffset?: number } {
    const bundle = this.snapshots.get(sessionId)
    if (!bundle) throw new Error('当前任务没有采集快照，请先调用 wps_collect_daily。')
    this.checkAccount(bundle.accountId, bundle.companyId)
    if (!Number.isInteger(offset) || offset < 0 || offset > bundle.evidence.length) throw new Error('证据分页位置无效。')
    const items: WpsDailyBundle['evidence'] = []
    let size = 0
    for (const item of bundle.evidence.slice(offset, offset + 20)) {
      const length = JSON.stringify(item).length
      if (size + length > 40_000 && items.length) break
      items.push(item); size += length
    }
    const next = offset + items.length
    const reads = this.evidenceReads.get(sessionId) ?? new Set<number>()
    for (let index = offset; index < next; index++) reads.add(index)
    this.evidenceReads.set(sessionId, reads)
    return { summary: this.summary(bundle), evidence: items, ...(next < bundle.evidence.length ? { nextOffset: next } : {}) }
  }
  assertEvidenceRead(sessionId: string): void {
    const bundle = this.snapshots.get(sessionId)
    if (!bundle) throw new Error('WPS 采集快照已失效，日报未标记完成。')
    this.checkAccount(bundle.accountId, bundle.companyId)
    const reads = this.evidenceReads.get(sessionId)
    if (!reads || reads.size < bundle.evidence.length) throw new Error('Agent 未读取全部 WPS 日报证据，草稿未标记完成。')
  }
  source(): WpsDailyReportSource {
    const scope = this.publicConfig().reportScope
    this.checkScopes(scope)
    const c = this.checkAccount()
    return { ...scope, accountId: c.userId!, companyId: c.companyId }
  }
}

export const wpsService = new WpsService()

export function registerWpsIpc(): void {
  const handlers: Record<string, (...args: any[]) => unknown> = {
    [WPS_IPC_CHANNELS.GET_CONFIG]: () => wpsService.publicConfig(),
    [WPS_IPC_CHANNELS.SAVE_CONFIG]: (input: WpsConnectionInput) => wpsService.save(input),
    [WPS_IPC_CHANNELS.GET_USER_AUTH]: () => wpsService.authState(),
    [WPS_IPC_CHANNELS.USER_LOGIN]: () => wpsService.loginUser(),
    [WPS_IPC_CHANNELS.USER_LOGOUT]: () => wpsService.logout(),
    [WPS_IPC_CHANNELS.CHECK_USER_AUTH]: async () => {
      await wpsService.client.get('/v7/users/current'); return wpsService.authState()
    },
    [WPS_IPC_CHANNELS.LIST_REPORT_CHATS]: () => wpsService.listChats(),
    [WPS_IPC_CHANNELS.COLLECT_DAILY]: async () => wpsService.summary(await wpsService.collect()),
    [WPS_IPC_CHANNELS.CREATE_DAILY_REPORT]: (input: { channelId: string; modelId?: string; timeOfDay: string }) => {
      const source = wpsService.source()
      if (listAutomations().some(item => item.enabled && item.wpsDailyReport?.accountId === source.accountId && item.wpsDailyReport.companyId === source.companyId)) {
        throw new Error('本人账号已有启用的 WPS 日报，请在定时任务中修改或暂停。')
      }
      const channel = getChannel(input.channelId)
      if (!channel || !isChannelCompatibleWithRuntime(channel, 'pi')) throw new Error('请选择已启用的 HTTP AI 渠道（Pi 内核）。')
      if (input.modelId && !channel.models.some(model => model.id === input.modelId && model.enabled)) throw new Error('请选择已启用的模型。')
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.timeOfDay)) throw new Error('日报时间应为 HH:MM。')
      return createAutomation({ name: 'WPS 本人工作日报', prompt: WPS_DAILY_REPORT_PROMPT, scheduleType: 'daily', intervalMinutes: 1440,
        timeOfDay: input.timeOfDay, channelId: input.channelId, modelId: input.modelId, sessionMode: 'daily',
        permissionMode: 'auto', wpsDailyReport: source })
    },
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => handler(...args))
  }
}
