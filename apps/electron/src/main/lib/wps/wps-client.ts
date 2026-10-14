import { createHmac } from 'node:crypto'
import type { WpsConfig, WpsReportScope } from '@tagent/shared'

export const WPS_ORIGIN = 'https://openapi.wps.cn'
export const DEFAULT_WPS_SCOPE: WpsReportScope = { includeChats: true, includeDocuments: true, chatIds: [] }

export function wpsScopes(scope: WpsReportScope): string[] {
  return [
    'kso.user_base.read',
    // WPS 开放平台权限管理页为用户授权登记的是不带 delegated: 前缀的
    // scope；CLI 会将这些 scope 原样带入 OAuth 请求。
    ...(scope.includeChats ? ['kso.mcp_message.readwrite'] : []),
    ...(scope.includeDocuments ? ['kso.mcp_yundoc.readwrite', 'kso.file.search', 'kso.file_version.readwrite'] : []),
  ]
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function string(value: unknown): string { return typeof value === 'string' ? value : '' }

/**
 * 已由 /users/current 验证的官方用户 token 中，aid/cid 对应聊天 MCP 的原始 ID。
 * REST 的混淆 ID 与 MCP 原始 ID 不可直接比较；解码仅补充身份别名，不代替服务端认证。
 * 不返回其他 claims，也不将 token 或这些别名写入配置/公共授权状态。
 */
export function wpsMessageIdentity(token: string, appId: string, now = Date.now()): { id: string; companyId: string } | undefined {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return undefined
    const claims = record(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')))
    if (claims.cli !== appId || !(Number(claims.exp) * 1000 > now)) return undefined
    const id = String(claims.aid ?? ''), companyId = String(claims.cid ?? '')
    if (!/^[1-9]\d*$/.test(id) || !/^[1-9]\d*$/.test(companyId)) return undefined
    if ((typeof claims.aid === 'number' && !Number.isSafeInteger(claims.aid)) ||
      (typeof claims.cid === 'number' && !Number.isSafeInteger(claims.cid))) return undefined
    return { id, companyId }
  } catch { return undefined }
}

/** 官方 KSO-1：GET 空请求体的 hash 是空串，不是空串的 SHA256。 */
export function wpsGetSignature(appId: string, secret: string, uri: string, date: string): string {
  const signature = createHmac('sha256', secret).update(`KSO-1GET${uri}application/json${date}`).digest('hex')
  return `KSO-1 ${appId}:${signature}`
}

export type WpsFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
export interface WpsClientDependencies {
  read: () => WpsConfig
  write: (config: WpsConfig) => void
  encrypt: (value: string) => string
  decrypt: (value: string) => string
  fetch?: WpsFetch
  now?: () => number
  /** WPS CLI 登录模式由 CLI 管理 refresh token，过期时回调获取新 access token。 */
  refreshUserToken?: () => Promise<string>
}

export class WpsApiError extends Error {
  constructor(public readonly status: number, public readonly code?: unknown) {
    // 不透传响应 msg/body；平台错误可能回显请求参数和凭证。
    super(`WPS 接口失败（HTTP ${status}${typeof code === 'number' ? `，代码 ${code}` : ''}）。请检查开放平台权限、授权状态和接口配置。`)
  }
}

/** 只携带应用定义的诊断文案，不透传平台响应或消息正文。 */
export class WpsPaginationError extends Error {}

export function wpsReadFailure(error: unknown): { detail: string; retryable: boolean } {
  if (error instanceof WpsApiError) {
    const code = typeof error.code === 'number' ? `，代码 ${error.code}` : ''
    const retryable = error.status === 429 || error.status >= 500
    const reason = error.status === 403 ? '当前授权无权读取此接口或资源'
      : error.status === 401 ? '账号授权已失效，请重新连接 WPS'
      : error.status === 404 ? '接口或资源不存在'
      : '接口请求失败'
    return { detail: `${reason}（HTTP ${error.status}${code}）`, retryable }
  }
  if (error instanceof WpsPaginationError) return { detail: error.message, retryable: true }
  return { detail: '读取失败或分页未完成，请检查权限与连接', retryable: true }
}

export class WpsClient {
  private refreshPending?: Promise<string>
  private generation = 0
  private readonly request: WpsFetch
  private readonly now: () => number
  constructor(private readonly deps: WpsClientDependencies) {
    this.request = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  /** 取消旧授权的在途写回，防止退出/换应用后刷新恢复旧账号。 */
  invalidate(): void { this.generation += 1; this.refreshPending = undefined }

  private async tokens(parameters: Record<string, string>, config: WpsConfig): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.request(`${WPS_ORIGIN}/oauth2/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...parameters, client_id: config.appId, client_secret: this.deps.decrypt(config.secretKey) }),
      })
    } catch { throw new Error('WPS 授权接口暂时不可用，请稍后重试。') }
    const body = record(await response.json())
    if (!response.ok || !string(body.access_token) || !string(body.refresh_token) || !(Number(body.expires_in) > 0) || !(Number(body.refresh_expires_in) > 0)) {
      throw new WpsApiError(response.status, body.code)
    }
    return body
  }

  private saveTokens(body: Record<string, unknown>, generation: number, config: WpsConfig): string {
    if (generation !== this.generation) throw new Error('WPS 授权已取消或账号已变更。')
    const access = string(body.access_token)
    // 读最新配置，保留刷新期间界面更新的采集范围。
    this.deps.write({ ...this.deps.read(), appId: config.appId,
      userAccessToken: this.deps.encrypt(access), userRefreshToken: this.deps.encrypt(string(body.refresh_token)),
      userTokenExpiresAt: this.now() + Number(body.expires_in) * 1000,
      userRefreshExpiresAt: this.now() + Number(body.refresh_expires_in) * 1000,
    })
    return access
  }

  async exchangeCode(code: string, redirectUri: string, scopes: string[]): Promise<void> {
    const generation = this.generation
    const config = this.deps.read()
    const tokens = await this.tokens({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, config)
    const access = string(tokens.access_token)
    const identity = record(await this.getWithToken('/v7/users/current', access, config))
    if (!string(identity.id)) throw new Error('WPS 未返回本人身份，无法开启工作日报。')
    this.saveTokens(tokens, generation, config)
    this.deps.write({ ...this.deps.read(), userId: string(identity.id), companyId: string(identity.company_id),
      userName: string(identity.user_name), authorizedScopes: scopes })
  }

  async accessToken(): Promise<string> {
    const config = this.deps.read()
    if (!config.enabled) throw new Error('请先启用 WPS 账号连接。')
    if (config.userAccessToken && (config.userTokenExpiresAt ?? 0) > this.now() + 60_000) return this.deps.decrypt(config.userAccessToken)
    if (!config.userRefreshToken && this.deps.refreshUserToken) return this.deps.refreshUserToken()
    if (!config.userRefreshToken || (config.userRefreshExpiresAt !== undefined && config.userRefreshExpiresAt <= this.now())) {
      throw new Error('WPS 授权已过期，请重新授权本人账号。')
    }
    if (!this.refreshPending) {
      const generation = this.generation
      const pending = this.tokens({ grant_type: 'refresh_token', refresh_token: this.deps.decrypt(config.userRefreshToken) }, config)
        .then(body => this.saveTokens(body, generation, config))
      this.refreshPending = pending
      void pending.finally(() => { if (this.refreshPending === pending) this.refreshPending = undefined }).catch(() => {})
    }
    return this.refreshPending
  }

  private async getWithToken(uri: string, access: string, config: WpsConfig, signal?: AbortSignal): Promise<unknown> {
    const date = new Date(this.now()).toUTCString()
    let response: Response
    try {
      response = await this.request(`${WPS_ORIGIN}${uri}`, {
        method: 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}`,
          'X-Kso-Date': date, 'X-Kso-Authorization': wpsGetSignature(config.appId, this.deps.decrypt(config.secretKey), uri, date) },
      })
    } catch { signal?.throwIfAborted(); throw new Error('WPS 读取接口暂时不可用，请稍后重试。') }
    const body = record(await response.json())
    if (!response.ok || (body.code !== undefined && Number(body.code) !== 0)) throw new WpsApiError(response.status, body.code)
    if (body.data === undefined) throw new Error('WPS 读取接口返回的数据结构不完整。')
    return body.data
  }

  async get(uri: string, signal?: AbortSignal): Promise<unknown> {
    // 只允许内部构造的官方 GET URI，不能通过工具传入任意服务器地址。
    if (!uri.startsWith('/v7/') || uri.includes('#')) throw new Error('WPS 请求路径无效。')
    return this.getWithToken(uri, await this.accessToken(), this.deps.read(), signal)
  }
}

/** 同时兼容 MCP structuredContent 与文本 JSON；未知结构直接报错，不伪装成空数据。 */
export function unpackWpsMcp(result: unknown): unknown {
  const r = record(result)
  if (r.isError) throw new Error('WPS 读取工具执行失败，请检查账号权限。')
  let data: unknown = r.structuredContent
  if (data === undefined && Array.isArray(r.content)) {
    const texts = r.content.map(block => string(record(block).text)).filter(Boolean)
    if (texts.length === 1) {
      try { data = JSON.parse(texts[0]!) } catch { data = texts[0] }
    } else if (texts.length) data = texts.join('\n')
  }
  if (data === undefined) throw new Error('WPS 工具未返回可读取的数据。')
  const envelope = record(data)
  if (envelope.code !== undefined && Number(envelope.code) !== 0) throw new WpsApiError(200, envelope.code)
  return envelope.data ?? data
}

export function wpsPage(data: unknown): { items: Record<string, unknown>[]; next: string } {
  const r = record(data)
  const items = r.items ?? r.messages ?? r.chats
  if (!Array.isArray(items)) throw new WpsPaginationError('WPS 分页响应缺少记录列表，未将该结果视为完整采集。')
  const next = string(r.next_page_token ?? r.nextPageToken)
  if ((r.has_more === true || r.hasMore === true) && !next) throw new WpsPaginationError('WPS 分页响应缺少下一页游标。')
  return { items: items.map(record), next }
}

export async function collectWpsPages(
  load: (cursor?: string) => Promise<unknown>, maxPages = 200, signal?: AbortSignal,
  onPage?: (items: Record<string, unknown>[]) => void,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted()
    const result = wpsPage(await load(cursor))
    onPage?.(result.items)
    items.push(...result.items)
    if (!result.next) return items
    if (cursors.has(result.next)) throw new WpsPaginationError('WPS 分页游标重复，采集未完成。')
    cursors.add(result.next)
    cursor = result.next
  }
  throw new WpsPaginationError(`WPS 数据超过 ${maxPages} 页，采集未完成，请缩小范围。`)
}
