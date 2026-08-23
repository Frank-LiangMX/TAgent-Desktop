import type { FusionRoomAuthoritySnapshot, CreateFusionRoomAuthorityInput } from './fusion-room-authority'
import type {
  FusionRoomGatewayAction,
  FusionRoomGatewayNotification,
} from './fusion-room-gateway'
import type { CollaborationRoomEvent } from '@tagent/shared'

export interface FusionRoomHttpClientOptions {
  baseUrl: string
  token?: string
  fetch?: typeof fetch
  headers?: HeadersInit
}

export class FusionRoomHttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'FusionRoomHttpError'
    this.status = status
    this.code = code
  }
}

export interface FusionRoomActionResponse {
  result: unknown
  snapshot: FusionRoomAuthoritySnapshot
}

export interface FusionRoomInviteResponse {
  token: string
  tokenId: string
  roomId: string
  userId: string
  displayName: string
  createdAt: number
  expiresAt?: number
}

export interface FusionRoomSnapshotStreamEvent {
  kind: 'snapshot'
  roomId: string
  snapshot: FusionRoomAuthoritySnapshot
  cursor?: number
}

export interface FusionRoomReplayStreamEvent {
  kind: 'replay'
  roomId: string
  afterSequence: number
  events: CollaborationRoomEvent[]
  cursor?: number
}

export interface FusionRoomNotificationStreamEvent extends FusionRoomGatewayNotification {
  kind: 'notification'
  cursor?: number
}

export type FusionRoomHttpStreamEvent =
  | FusionRoomSnapshotStreamEvent
  | FusionRoomReplayStreamEvent
  | FusionRoomNotificationStreamEvent

export interface FusionRoomEventSubscription {
  readonly done: Promise<void>
  close(): void
}

export interface SubscribeFusionRoomOptions {
  afterSequence?: number
  onEvent: (event: FusionRoomHttpStreamEvent) => void
  onError?: (error: unknown) => void
}

type ResponseLike = Pick<Response, 'ok' | 'status' | 'json' | 'text' | 'arrayBuffer'> & {
  body?: ReadableStream<Uint8Array> | null
}

const cloneHeaders = (input?: HeadersInit): Headers => {
  const headers = new Headers(input)
  headers.set('accept', 'application/json')
  return headers
}

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/$/, '')

/**
 * Fetch/SSE client for the transport-neutral RoomSession gateway.
 * Authentication is supplied by the caller; this class does not invent a
 * local identity or silently fall back to the local IPC collaboration path.
 */
export class FusionRoomHttpClient {
  private readonly baseUrl: string
  private readonly token?: string
  private readonly fetchImpl: typeof fetch
  private readonly baseHeaders: Headers

  constructor(options: FusionRoomHttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    if (!this.baseUrl) throw new Error('FusionRoomHttpClient baseUrl 不能为空')
    this.token = options.token?.trim() || undefined
    this.fetchImpl = options.fetch ?? fetch
    this.baseHeaders = cloneHeaders(options.headers)
    if (this.token) this.baseHeaders.set('authorization', 'Bearer ' + this.token)
  }

  async listRoomIds(): Promise<string[]> {
    const response = await this.request<{ roomIds?: unknown }>('/rooms')
    return Array.isArray(response.roomIds)
      ? response.roomIds.filter((value): value is string => typeof value === 'string')
      : []
  }

  async createRoom(
    input: Omit<CreateFusionRoomAuthorityInput, 'ownerUserId'>,
  ): Promise<FusionRoomAuthoritySnapshot> {
    return this.request<FusionRoomAuthoritySnapshot>('/rooms', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async getSnapshot(roomId: string): Promise<FusionRoomAuthoritySnapshot> {
    return this.request<FusionRoomAuthoritySnapshot>('/rooms/' + encodeURIComponent(roomId))
  }

  async dispatch(
    roomId: string,
    action: FusionRoomGatewayAction,
  ): Promise<FusionRoomActionResponse> {
    return this.request<FusionRoomActionResponse>('/rooms/' + encodeURIComponent(roomId) + '/actions', {
      method: 'POST',
      body: JSON.stringify({ action }),
    })
  }

  async issueInvite(
    roomId: string,
    input: { userId: string; displayName: string; expiresAt?: number },
  ): Promise<FusionRoomInviteResponse> {
    return this.request<FusionRoomInviteResponse>('/rooms/' + encodeURIComponent(roomId) + '/invites', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async downloadPublishedFile(roomId: string, relativePath: string): Promise<ArrayBuffer> {
    const headers = new Headers(this.baseHeaders)
    headers.set('accept', 'application/octet-stream')
    const url = this.url('/rooms/' + encodeURIComponent(roomId) + '/files?path=' + encodeURIComponent(relativePath))
    const response = await this.fetchImpl(url, { method: 'GET', headers }) as ResponseLike
    await this.assertResponse(response)
    return response.arrayBuffer()
  }

  async subscribe(
    roomId: string,
    options: SubscribeFusionRoomOptions,
  ): Promise<FusionRoomEventSubscription> {
    const controller = new AbortController()
    const headers = new Headers(this.baseHeaders)
    headers.set('accept', 'text/event-stream')
    if (options.afterSequence !== undefined) {
      if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0) {
        throw new Error('RoomSession event cursor 非法')
      }
      headers.set('last-event-id', String(options.afterSequence))
    }
    const response = await this.fetchImpl(
      this.url('/rooms/' + encodeURIComponent(roomId) + '/events'),
      { method: 'GET', headers, signal: controller.signal },
    ) as ResponseLike
    await this.assertResponse(response)
    if (!response.body) throw new Error('RoomSession SSE 响应缺少 body')

    const done = this.consumeStream(response.body, options, controller.signal).catch((error) => {
      if (!controller.signal.aborted) options.onError?.(error)
      if (!controller.signal.aborted && !options.onError) throw error
    })
    return { done, close: () => controller.abort() }
  }

  private url(path: string): string {
    return this.baseUrl + (path.startsWith('/') ? path : '/' + path)
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(this.baseHeaders)
    headers.set('content-type', 'application/json')
    const response = await this.fetchImpl(this.url(path), { ...init, headers }) as ResponseLike
    return this.readResponse<T>(response)
  }

  private async assertResponse(response: ResponseLike): Promise<void> {
    if (response.ok) return
    const body = await this.readErrorBody(response)
    throw new FusionRoomHttpError(response.status, body.code, body.message)
  }

  private async readResponse<T>(response: ResponseLike): Promise<T> {
    if (!response.ok) {
      const body = await this.readErrorBody(response)
      throw new FusionRoomHttpError(response.status, body.code, body.message)
    }
    return await response.json() as T
  }

  private async readErrorBody(response: ResponseLike): Promise<{ code: string; message: string }> {
    try {
      const body = await response.json() as { error?: { code?: unknown; message?: unknown } }
      return {
        code: typeof body.error?.code === 'string' ? body.error.code : 'HTTP_ERROR',
        message: typeof body.error?.message === 'string' ? body.error.message : 'RoomSession 请求失败',
      }
    } catch {
      const text = await response.text().catch(() => '')
      return { code: 'HTTP_ERROR', message: text || 'RoomSession 请求失败' }
    }
  }

  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    options: SubscribeFusionRoomOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let data: string[] = []
    let cursor: number | undefined
    const emit = (): void => {
      if (!data.length) return
      const payload: unknown = JSON.parse(data.join('\n'))
      const event = this.toStreamEvent(payload, cursor)
      options.onEvent(event)
      data = []
    }
    const processLine = (line: string): void => {
      if (!line) { emit(); return }
      if (line.startsWith(':')) return
      if (line.startsWith('id:')) {
        const value = Number(line.slice(3).trim())
        cursor = Number.isSafeInteger(value) ? value : undefined
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).trimStart())
      }
    }
    try {
      while (true) {
        const chunk = await reader.read()
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) processLine(line)
        if (chunk.done) {
          if (buffer) processLine(buffer)
          emit()
          break
        }
      }
    } finally {
      reader.releaseLock()
      if (signal.aborted) return
    }
  }

  private toStreamEvent(payload: unknown, cursor?: number): FusionRoomHttpStreamEvent {
    if (!payload || typeof payload !== 'object') throw new Error('RoomSession SSE payload 非法')
    const value = payload as Record<string, unknown>
    if (value.type === 'snapshot' && value.snapshot && typeof value.roomId === 'string') {
      return { kind: 'snapshot', roomId: value.roomId, snapshot: value.snapshot as FusionRoomAuthoritySnapshot, ...(cursor === undefined ? {} : { cursor }) }
    }
    if (value.type === 'replay' && Array.isArray(value.events) && typeof value.roomId === 'string' && typeof value.afterSequence === 'number') {
      return { kind: 'replay', roomId: value.roomId, afterSequence: value.afterSequence, events: value.events as CollaborationRoomEvent[], ...(cursor === undefined ? {} : { cursor }) }
    }
    if (typeof value.roomId === 'string' && value.snapshot && Array.isArray(value.events)) {
      return { kind: 'notification', roomId: value.roomId, connectionId: String(value.connectionId ?? ''), events: value.events as CollaborationRoomEvent[], snapshot: value.snapshot as FusionRoomAuthoritySnapshot, ...(cursor === undefined ? {} : { cursor }) }
    }
    throw new Error('RoomSession SSE event 类型未知')
  }
}
