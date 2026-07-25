/**
 * WPS 协作集成相关类型定义
 */

/** WPS Bridge 连接状态 */
export type WpsBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** WPS Bridge 状态详情 */
export interface WpsBridgeState {
  status: WpsBridgeStatus
  connectedAt?: number
  errorMessage?: string
  /** 本地监听地址（用于在开放平台配置回调） */
  callbackUrl?: string
}

/** WPS 配置（持久化到 ~/.tagent/wps.json） */
export interface WpsConfig {
  enabled: boolean
  appId: string
  /** safeStorage 加密后的 base64 */
  secretKey: string
  /** safeStorage 加密后的 base64，可选 */
  encryptKey?: string
  apiUrl: string
  callbackPort: number
  callbackPath: string
  defaultWorkspaceId?: string
  /** 用户 OAuth token（safeStorage 加密） */
  userAccessToken?: string
  userRefreshToken?: string
  userTokenExpiresAt?: number
  /** 最后登录的用户信息 */
  userName?: string
  userEmail?: string
}

/** WPS 配置保存输入（明文） */
export interface WpsConfigInput {
  enabled: boolean
  appId: string
  /** 明文 secretKey；空字符串表示不修改 */
  secretKey: string
  /** 明文 encryptKey；空字符串表示清空 */
  encryptKey?: string
  apiUrl: string
  callbackPort: number
  callbackPath: string
  defaultWorkspaceId?: string
}

/** WPS 连接测试结果 */
export interface WpsTestResult {
  success: boolean
  message: string
}

/** WPS 用户登录状态 */
export interface WpsUserAuthState {
  /** 是否已登录 */
  loggedIn: boolean
  /** 登录进行中 */
  loading?: boolean
  /** 用户显示名 */
  userName?: string
  /** 用户邮箱 */
  userEmail?: string
  /** Token 过期时间（时间戳） */
  expiresAt?: number
  /** 登录中的错误信息 */
  errorMessage?: string
}

export const WPS_IPC_CHANNELS = {
  GET_CONFIG: 'wps:get-config',
  GET_DECRYPTED_SECRET: 'wps:get-decrypted-secret',
  SAVE_CONFIG: 'wps:save-config',
  TEST_CONNECTION: 'wps:test-connection',
  START_BRIDGE: 'wps:start-bridge',
  STOP_BRIDGE: 'wps:stop-bridge',
  GET_STATUS: 'wps:get-status',
  STATUS_CHANGED: 'wps:status-changed',
  // 用户登录
  USER_LOGIN: 'wps:user-login',
  USER_LOGOUT: 'wps:user-logout',
  GET_USER_AUTH: 'wps:get-user-auth',
  CHECK_USER_AUTH: 'wps:check-user-auth',
  USER_AUTH_CHANGED: 'wps:user-auth-changed',
  // WPS CLI 工具通道
  CLI_LIST_USERS: 'wps:cli-list-users',
  CLI_SEARCH_USERS: 'wps:cli-search-users',
  CLI_LIST_CALENDARS: 'wps:cli-list-calendars',
  CLI_LIST_EVENTS: 'wps:cli-list-events',
  CLI_CREATE_EVENT: 'wps:cli-create-event',
  CLI_QUERY_FREEBUSY: 'wps:cli-query-freebusy',
  CLI_SEND_MESSAGE: 'wps:cli-send-message',
  CLI_LIST_CHATS: 'wps:cli-list-chats',
  CLI_CREATE_CHAT: 'wps:cli-create-chat',
  CLI_LIST_FILES: 'wps:cli-list-files',
  CLI_SEARCH_FILES: 'wps:cli-search-files',
  CLI_CREATE_SHARE_LINK: 'wps:cli-create-share-link',
  CLI_LIST_SHEETS: 'wps:cli-list-sheets',
  CLI_LIST_RECORDS: 'wps:cli-list-records',
  CLI_CREATE_RECORD: 'wps:cli-create-record',
  CLI_API_GET: 'wps:cli-api-get',
  CLI_API_POST: 'wps:cli-api-post',
  CLI_HTTP_REQUEST: 'wps:cli-http-request',
  // AirPage 智能文档
  AIRPAGE_LOGIN: 'wps:airpage-login',
  AIRPAGE_LOGOUT: 'wps:airpage-logout',
  AIRPAGE_STATUS: 'wps:airpage-status',
  AIRPAGE_CREATE: 'wps:airpage-create',
  AIRPAGE_INSERT: 'wps:airpage-insert',
  AIRPAGE_QUERY: 'wps:airpage-query',
  AIRPAGE_SEARCH: 'wps:airpage-search',
} as const

/** AirPage 登录状态 */
export interface AirpageAuthState {
  loggedIn: boolean
  loading?: boolean
  cookie?: string
  csrf?: string
  updatedAt?: string
}

/** AirPage 创建文档参数 */
export interface AirpageCreateParams {
  name: string
}

/** AirPage 内容插入参数 */
export interface AirpageInsertParams {
  fileId: string
  content: string
  pos?: 'begin' | 'end'
}

/** AirPage 查询参数 */
export interface AirpageQueryParams {
  fileId: string
  blockId?: string
}
