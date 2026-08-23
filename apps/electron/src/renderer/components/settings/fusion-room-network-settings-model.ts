/**
 * 融合会话 · 协作与网络「危险区」设置 model（P0-3b）。
 *
 * 纯展示 / 禁用逻辑：把主进程回传的偏好、证书、闸门状态投影成渲染层只读展示所需的
 * 标签、禁用判定与语气。**不依赖真实 Electron**（不读 window.electronAPI、不读 Date.now），
 * 便于组件模型单测。日期用 UTC 固定格式以保证确定性。
 *
 * 渲染层本地类型与 preload electronAPI + 主进程 IPC 形状保持一致：
 *   - `FusionRoomNetworkPrefsView` ↔ `getFusionRoomNetworkPrefs()` 返回
 *   - `FusionRoomGateStatusView` ↔ `getFusionRoomGateStatus()` 返回
 *   - `FusionRoomCertRecordView` ↔ `listFusionRoomCerts()` 返回（已剥离私钥）
 */
export interface FusionRoomNetworkPrefsView {
  enableCollaboration: boolean
  enableNetworkListen: boolean
}

export interface FusionRoomGateDecisionView {
  registerIpc: boolean
  allowNonLoopbackListen: boolean
  reasons: string[]
}

export interface FusionRoomGateStatusView {
  /** 当前偏好 + 证书下的决策（重启后或将生效）。 */
  decision: FusionRoomGateDecisionView
  /** 本次启动时实际应用的决策。 */
  applied: FusionRoomGateDecisionView
  /** 当前决策与启动应用决策是否不同（不同 → 需重启生效）。 */
  needsRestart: boolean
  /** 当前是否打包版。 */
  isPackaged: boolean
}

export type FusionRoomCertStatusView = 'active' | 'revoked' | 'expired'

export interface FusionRoomCertRecordView {
  certId: string
  cert: string
  fingerprint: string
  createdAt: number
  expiresAt: number
  revokedAt?: number
  status: FusionRoomCertStatusView
  commonName: string
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

/**
 * 证书指纹短显：colon-hex 指纹取前 3 段 + … + 后 3 段，全大写。
 * 段数 ≤ 6 时原样大写返回；空串返回空串。例：32 段 sha256 → `01:02:03…1E:1F:20`。
 */
export function shortFingerprint(fingerprint: string): string {
  const parts = fingerprint.split(':').filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length <= 6) return fingerprint.toUpperCase()
  const head = parts.slice(0, 3).join(':')
  const tail = parts.slice(-3).join(':')
  return `${head}…${tail}`.toUpperCase()
}

/** 证书过期时间固定 UTC 格式 `YYYY-MM-DD HH:mm UTC`（确定性，不依赖本地时区 / locale）。 */
export function formatCertExpiry(expiresAt: number): string {
  const d = new Date(expiresAt)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())} UTC`
}

/** 证书状态中文标签。 */
export function certStatusLabel(status: FusionRoomCertStatusView): string {
  if (status === 'active') return '有效'
  if (status === 'revoked') return '已撤销'
  return '已过期'
}

/**
 * `enableNetworkListen` 开关是否可交互。brief UX：在 `!enableCollaboration` 或
 * `!hasActiveCert` 时 Switch disabled。`hasActiveCert` 由调用方从证书列表派生
 *（`certs.some(c => c.status === 'active')`）。
 */
export function canEnableNetworkListen(
  prefs: FusionRoomNetworkPrefsView,
  hasActiveCert: boolean,
): boolean {
  return prefs.enableCollaboration && hasActiveCert
}

/** `enableNetworkListen` 被禁用的原因（可交互时返回 null），用于开关下方提示。 */
export function networkListenDisabledReason(
  prefs: FusionRoomNetworkPrefsView,
  hasActiveCert: boolean,
): string | null {
  if (canEnableNetworkListen(prefs, hasActiveCert)) return null
  if (!prefs.enableCollaboration) return '需先开启「启用协作室 IPC」'
  return '需先生成并保留一张有效证书'
}

export type GateTone = 'off' | 'warn' | 'ok'

export interface GateStatusSummary {
  /** 协作室 IPC 放行 / 关闭。 */
  ipc: string
  /** 非 loopback 监听放行 / 关闭。 */
  listen: string
  /** 整体语气：off=全关（默认）、warn=需重启或部分开、ok=双开且无需重启。 */
  tone: GateTone
}

/**
 * 把闸门状态投影成只读展示标签 + 语气。
 * - `needsRestart` → 语气 warn（当前决策尚未实际生效）。
 * - 双开且无需重启 → ok；其余 → off。
 */
export function summarizeGateStatus(status: FusionRoomGateStatusView): GateStatusSummary {
  const { decision, needsRestart } = status
  const ipc = decision.registerIpc ? '协作室 IPC 放行' : '协作室 IPC 关闭'
  const listen = decision.allowNonLoopbackListen
    ? '非 loopback 监听放行'
    : '非 loopback 监听关闭'
  let tone: GateTone
  if (needsRestart) tone = 'warn'
  else if (decision.registerIpc && decision.allowNonLoopbackListen) tone = 'ok'
  else tone = 'off'
  return { ipc, listen, tone }
}
