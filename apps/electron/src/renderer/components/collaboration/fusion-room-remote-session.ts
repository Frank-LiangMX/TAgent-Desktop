import {
  FusionRoomHttpClient,
  FusionRoomSessionAdapter,
  type FusionRoomHttpClientOptions,
} from '@tagent/core'
import {
  FusionRoomViewModelController,
  type FusionRoomSessionAdapterLike,
} from './fusion-room-view-model'

export interface FusionRoomRemoteSessionConfig
  extends Pick<FusionRoomHttpClientOptions, 'token' | 'headers' | 'fetch'> {
  roomId: string
  baseUrl: string
}

export interface FusionRoomRemoteSession {
  client: FusionRoomHttpClient
  adapter: FusionRoomSessionAdapterLike
  controller: FusionRoomViewModelController
  close(): Promise<void>
}

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function createFusionRoomRemoteSession(
  config: FusionRoomRemoteSessionConfig,
  options: { onError?: (error: unknown) => void } = {},
): FusionRoomRemoteSession {
  const roomId = config.roomId.trim()
  const baseUrl = config.baseUrl.trim()
  if (!roomId || !ROOM_ID_PATTERN.test(roomId)) {
    throw new Error('Fusion RoomSession roomId 格式非法')
  }
  if (!baseUrl) throw new Error('Fusion RoomSession baseUrl 不能为空')

  // baseUrl 必须为可解析的绝对 URL，且仅允许 http/https 协议；
  // 拒绝在 URL 中携带用户名/密码（凭证应通过 token/headers 传入，避免被日志或错误信息泄露）。
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new Error('Fusion RoomSession baseUrl 必须为可解析的 URL')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Fusion RoomSession baseUrl 协议必须为 http: 或 https:')
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Fusion RoomSession baseUrl 不能包含用户名或密码')
  }

  const client = new FusionRoomHttpClient({
    baseUrl,
    ...(config.token === undefined ? {} : { token: config.token }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  })
  const adapter = new FusionRoomSessionAdapter({ client, roomId, onError: options.onError })
  const controller = new FusionRoomViewModelController(adapter)
  return { client, adapter, controller, close: () => controller.close() }
}
