import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions,
} from 'node:https'
import type { FusionRoomPrincipal } from '@tagent/core'
import {
  FusionRoomAuthorityError,
  FusionRoomGateway,
  type FusionRoomGatewayAction,
} from '@tagent/core'

export interface FusionRoomPublishedFileReader {
  readFile(roomId: string, relativePath: string): string | undefined
}

export interface FusionRoomInviteIssuer {
  issueInvite(
    principal: FusionRoomPrincipal,
    roomId: string,
    input: {
      userId: string
      displayName: string
      expiresAt?: number
    },
  ): unknown
}

export interface FusionRoomHttpServerOptions {
  gateway: FusionRoomGateway
  /**
   * Adapter to the real account/session service. The HTTP layer never trusts
   * userId from JSON body or query parameters.
   */
  authenticate: (request: IncomingMessage) => FusionRoomPrincipal | undefined
  maxBodyBytes?: number
  heartbeatMs?: number
  maxEventStreamsPerPrincipal?: number
  inviteIssuer?: FusionRoomInviteIssuer
  /**
   * Reads a room file only after the HTTP layer has verified that the
   * authority marked that exact version as downloadable.
   */
  publishedFileReader?: FusionRoomPublishedFileReader
  /** Trusted host-side hook; called after an authenticated action is committed. */
  onAction?: (input: {
    principal: FusionRoomPrincipal
    roomId: string
    action: FusionRoomGatewayAction
    result: unknown
    snapshot: import('@tagent/core').FusionRoomAuthoritySnapshot
  }) => void
}

/**
 * FusionRoom HTTPS 服务器的 TLS 选项。至少包含 key/cert/ca/requestCert/
 * rejectUnauthorized；类型基于 node:https 的 ServerOptions，因此可直接传入
 * https.createServer，并支持服务器证书与可选的客户端证书校验策略。
 */
export type FusionRoomTlsOptions = Pick<
  ServerOptions,
  'key' | 'cert' | 'ca' | 'requestCert' | 'rejectUnauthorized'
>

function parseEventCursor(
  request: IncomingMessage,
  url: URL,
): number | undefined {
  const headerValue = request.headers['last-event-id']
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue
  const raw = url.searchParams.get('after') ?? header
  if (raw === null || raw === undefined || raw.trim() === '') return undefined
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new FusionRoomAuthorityError('INVALID_STATE', 'RoomEvent cursor 非法')
  }
  const cursor = Number(raw)
  if (!Number.isSafeInteger(cursor)) {
    throw new FusionRoomAuthorityError('INVALID_STATE', 'RoomEvent cursor 非法')
  }
  return cursor
}

/**
 * 构造 FusionRoom HTTP/SSE 服务器的请求监听器。HTTP 与 HTTPS 入口共用同一套
 * 请求处理与错误语义，避免重复实现业务逻辑。
 */
function createFusionRoomRequestListener(
  options: FusionRoomHttpServerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const service = new FusionRoomHttpServer(options)
  return (request, response) => {
    void service.handle(request, response).catch(() => {
      if (!response.destroyed) response.destroy()
    })
  }
}

export function createFusionRoomHttpServer(
  options: FusionRoomHttpServerOptions,
): Server {
  return createServer(createFusionRoomRequestListener(options))
}

/**
 * 基于 node:https 的 FusionRoom HTTP/SSE 服务器。请求处理逻辑与 HTTP 版本完全
 * 一致，仅在传输层启用 TLS；`tls` 用于配置服务器证书及可选的客户端证书校验。
 */
export function createFusionRoomHttpsServer(
  options: FusionRoomHttpServerOptions,
  tls: FusionRoomTlsOptions,
): HttpsServer {
  return createHttpsServer(tls, createFusionRoomRequestListener(options))
}

class FusionRoomHttpServer {
  private readonly maxBodyBytes: number
  private readonly heartbeatMs: number
  private readonly maxEventStreamsPerPrincipal: number
  private readonly eventStreamsByPrincipal = new Map<string, number>()

  constructor(private readonly options: FusionRoomHttpServerOptions) {
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576
    this.heartbeatMs = options.heartbeatMs ?? 15_000
    this.maxEventStreamsPerPrincipal = Math.max(
      1,
      Math.floor(options.maxEventStreamsPerPrincipal ?? 8),
    )
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const principal = this.options.authenticate(request)
      if (!principal) {
        this.writeError(response, 401, 'UNAUTHENTICATED', '需要有效的登录会话')
        return
      }
      const url = new URL(request.url ?? '/', 'http://fusion.local')
      const parts = url.pathname
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part))

      if (parts.length === 1 && parts[0] === 'rooms') {
        if (request.method === 'GET') {
          const connectionId = this.options.gateway.connect(principal)
          try {
            this.writeJson(response, 200, {
              roomIds: this.options.gateway.listAccessibleRoomIds(connectionId),
            })
          } finally {
            this.options.gateway.disconnect(connectionId)
          }
          return
        }
        if (request.method === 'POST') {
          const body = await this.readBody(request)
          const input = this.parseJson(body) as {
            roomId?: string
            workspace?: unknown
            now?: number
          }
          if (!input.roomId || !input.workspace) {
            this.writeError(response, 400, 'INVALID_REQUEST', 'roomId 和 workspace 不能为空')
            return
          }
          const snapshot = this.options.gateway.createRoom(principal, {
            roomId: input.roomId,
            workspace: input.workspace as never,
            ...(input.now !== undefined ? { now: input.now } : {}),
          })
          this.writeJson(response, 201, snapshot)
          return
        }
        this.writeError(response, 405, 'METHOD_NOT_ALLOWED', '不支持的 rooms 方法')
        return
      }

      if (parts.length < 2 || parts[0] !== 'rooms' || !parts[1]) {
        this.writeError(response, 404, 'NOT_FOUND', '路径不存在')
        return
      }

      const roomId = parts[1]
      if (parts.length === 3 && parts[2] === 'invites' && request.method === 'POST') {
        if (!this.options.inviteIssuer) {
          this.writeError(response, 404, 'NOT_FOUND', '当前 RoomSession transport 未启用邀请服务')
          return
        }
        const body = await this.readBody(request)
        const input = this.parseJson(body) as {
          userId?: string
          displayName?: string
          expiresAt?: number
        }
        if (!input.userId || !input.displayName) {
          this.writeError(response, 400, 'INVALID_REQUEST', 'userId 和 displayName 不能为空')
          return
        }
        const issued = this.options.inviteIssuer.issueInvite(principal, roomId, {
          userId: input.userId,
          displayName: input.displayName,
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        })
        this.writeJson(response, 201, issued)
        return
      }
      if (parts.length === 3 && parts[2] === 'events' && request.method === 'GET') {
        this.startEventStream(request, response, principal, roomId, parseEventCursor(request, url))
        return
      }

      const connectionId = this.options.gateway.connect(principal)
      try {
        if (parts.length === 2 && request.method === 'GET') {
          this.writeJson(response, 200, this.options.gateway.getSnapshot(connectionId, roomId))
          return
        }

        if (parts.length === 3 && parts[2] === 'files' && request.method === 'GET') {
          this.sendPublishedFile(
            response,
            connectionId,
            roomId,
            url.searchParams.get('path'),
          )
          return
        }

        if (parts.length === 3 && parts[2] === 'actions' && request.method === 'POST') {
          const body = await this.readBody(request)
          const payload = this.parseJson(body)
          const action = (payload.action ?? payload) as FusionRoomGatewayAction
          const result = this.options.gateway.dispatch(connectionId, roomId, action)
          const snapshot = this.options.gateway.getSnapshot(connectionId, roomId)
          this.options.onAction?.({ principal, roomId, action, result, snapshot })
          this.writeJson(response, 200, {
            result: result === undefined ? null : result,
            snapshot,
          })
          return
        }

        this.writeError(response, 405, 'METHOD_NOT_ALLOWED', '不支持的 RoomSession 方法')
      } finally {
        this.options.gateway.disconnect(connectionId)
      }
    } catch (error) {
      this.writeCaughtError(response, error)
    }
  }

  private sendPublishedFile(
    response: ServerResponse,
    connectionId: string,
    roomId: string,
    relativePath: string | null,
  ): void {
    if (!relativePath?.trim()) {
      this.writeError(response, 400, 'INVALID_REQUEST', '缺少要下载的文件路径')
      return
    }
    const snapshot = this.options.gateway.getSnapshot(connectionId, roomId)
    const file = snapshot.files.find(
      (item) => item.relativePath === relativePath && item.downloadable === true && item.deleted !== true,
    )
    // 对未发布文件统一返回 404，避免向房间成员泄露工作区文件名或状态。
    if (!file || !this.options.publishedFileReader) {
      this.writeError(response, 404, 'NOT_FOUND', '文件不存在或尚未发布')
      return
    }
    const content = this.options.publishedFileReader.readFile(roomId, relativePath)
    if (content === undefined) {
      this.writeError(response, 404, 'NOT_FOUND', '文件不存在或尚未发布')
      return
    }
    const body = Buffer.from(content, 'utf8')
    const filename = relativePath.split('/').at(-1) ?? 'artifact'
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': body.byteLength,
      'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
      etag: '"' + file.sha256 + '"',
      'cache-control': 'private, no-store',
    })
    response.end(body)
  }

  private startEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    principal: FusionRoomPrincipal,
    roomId: string,
    afterSequence?: number,
  ): void {
    const streamCount = this.eventStreamsByPrincipal.get(principal.userId) ?? 0
    if (streamCount >= this.maxEventStreamsPerPrincipal) {
      this.writeError(response, 429, 'RATE_LIMITED', '该用户的 RoomSession 实时连接数已达到上限')
      return
    }
    this.eventStreamsByPrincipal.set(principal.userId, streamCount + 1)

    let gatewayConnectionId: string | undefined
    let stop: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let closed = false
    let cleaned = false

    const releaseStreamSlot = (): void => {
      const remaining = (this.eventStreamsByPrincipal.get(principal.userId) ?? 1) - 1
      if (remaining <= 0) this.eventStreamsByPrincipal.delete(principal.userId)
      else this.eventStreamsByPrincipal.set(principal.userId, remaining)
    }

    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      stop?.()
      if (gatewayConnectionId) this.options.gateway.disconnect(gatewayConnectionId)
      releaseStreamSlot()
    }

    const send = (payload: unknown, cursor?: number): void => {
      if (closed || response.writableEnded || response.destroyed) return
      try {
        const lineBreak = String.fromCharCode(10)
        if (cursor !== undefined) response.write('id: ' + cursor + lineBreak)
        response.write('event: room' + lineBreak)
        response.write('data: ' + JSON.stringify(payload) + lineBreak + lineBreak)
      } catch {
        cleanup()
        if (!response.destroyed) response.destroy()
      }
    }

    try {
      const rawConnectionId = request.headers['x-fusion-connection-id']
      const connectionId =
        typeof rawConnectionId === 'string' && rawConnectionId.trim()
          ? rawConnectionId.trim()
          : undefined
      gatewayConnectionId = this.options.gateway.connect({
        ...principal,
        ...(connectionId ? { connectionId } : {}),
      })
      stop = this.options.gateway.subscribe(gatewayConnectionId, roomId, (notification) => {
        send(notification, notification.snapshot.events.at(-1)?.sequence)
      })
      heartbeat = setInterval(() => {
        const refreshed = this.options.authenticate(request)
        if (
          !refreshed ||
          refreshed.userId !== principal.userId ||
          (refreshed.kind ?? 'user') !== (principal.kind ?? 'user')
        ) {
          cleanup()
          if (!request.destroyed) request.destroy()
          return
        }
        if (!closed && !response.writableEnded && !response.destroyed) {
          try {
            response.write(': ping\n\n')
          } catch {
            cleanup()
            if (!response.destroyed) response.destroy()
          }
        }
      }, this.heartbeatMs)
      request.on('close', cleanup)
      response.on('close', cleanup)
      response.on('error', cleanup)
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-fusion-connection-id': gatewayConnectionId,
      })
      const currentSnapshot = this.options.gateway.getSnapshot(gatewayConnectionId, roomId)
      const cursor = currentSnapshot.events.at(-1)?.sequence
      if (afterSequence === undefined) {
        send({
          type: 'snapshot',
          roomId,
          snapshot: currentSnapshot,
        }, cursor)
      } else {
        send({
          type: 'replay',
          roomId,
          afterSequence,
          events: this.options.gateway.listEvents(gatewayConnectionId, roomId, afterSequence),
          cursor,
        }, cursor)
      }
    } catch (error) {
      cleanup()
      this.writeCaughtError(response, error)
    }
  }

  private writeJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) return
    const body = JSON.stringify(value)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  private writeError(
    response: ServerResponse,
    status: number,
    code: string,
    message: string,
  ): void {
    this.writeJson(response, status, { error: { code, message } })
  }

  private writeCaughtError(response: ServerResponse, error: unknown): void {
    if (error instanceof FusionRoomAuthorityError) {
      const status =
        error.code === 'FORBIDDEN'
          ? 403
          : error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'CONFLICT' || error.code === 'LOCKED'
              ? 409
              : 400
      this.writeError(response, status, error.code, error.message)
      return
    }
    if (error instanceof URIError) {
      this.writeError(response, 400, 'INVALID_REQUEST', '请求路径不是有效的 URI')
      return
    }
    this.writeError(response, 500, 'INTERNAL_ERROR', 'RoomSession 服务内部错误')
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    const declaredLength = Number(request.headers['content-length'] ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBodyBytes) {
      throw new FusionRoomAuthorityError('INVALID_STATE', '请求体过大')
    }
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > this.maxBodyBytes) {
        throw new FusionRoomAuthorityError('INVALID_STATE', '请求体过大')
      }
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private parseJson(body: string): Record<string, unknown> {
    if (!body.trim()) {
      throw new FusionRoomAuthorityError('INVALID_STATE', '请求体不能为空')
    }
    try {
      const value: unknown = JSON.parse(body)
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('请求体必须是 JSON 对象')
      }
      return value as Record<string, unknown>
    } catch (error) {
      throw new FusionRoomAuthorityError(
        'INVALID_STATE',
        '请求体不是有效 JSON：' + (error instanceof Error ? error.message : String(error)),
      )
    }
  }
}
