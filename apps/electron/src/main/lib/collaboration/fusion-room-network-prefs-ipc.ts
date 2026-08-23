/**
 * 打包版协作 / 网络闸门偏好 + 证书管理 IPC（P0-3 B 最小接线）。
 *
 * 这组 handler **始终注册**（开发与打包都注册），让用户能从设置页 / 未来 UI 显式打开
 * `enableCollaboration`、生成 / 撤销 TLS 证书，从而控制 {@link decidePackagedCollaborationGate}
 * 的输入。它们本身不注册协作室 IPC、不开任何网络监听、不回传私钥，只是管理两个布尔偏好
 * 与证书元数据，因此始终可用不违背「默认关闭」——真正危险的能力（协作室 IPC、非 loopback
 * 监听）仍由 `index.ts` 经 `decidePackagedCollaborationGate` 闸门控制。
 *
 * 通道：
 *   - `fusion-room-network-prefs:get` / `:set`（set 走 `validateFusionRoomNetworkPrefs` 校验）
 *   - `fusion-room-network-prefs:gate-status`（只读：当前决策 + 启动应用决策 + needsRestart）
 *   - `fusion-room-certs:list` / `:generate` / `:revoke`（list/generate 回传剥离私钥的公开记录）
 *
 * 设计参考：apps/electron/src/main/lib/notification-prefs.ts + main/index.ts 内联注册。
 */
import { ipcMain } from 'electron'
import { getCollaborationDir, getFusionRoomNetworkPrefsPath } from '../config/config-paths'
import {
  FusionRoomCertStore,
  type FusionRoomCertGenerateInput,
  type FusionRoomPublicCertRecord,
} from './fusion-room-cert-store'
import {
  decidePackagedCollaborationGate,
  loadFusionRoomNetworkPrefs,
  saveFusionRoomNetworkPrefs,
  validateFusionRoomNetworkPrefs,
  type FusionRoomNetworkPrefs,
  type PackagedCollaborationGateDecision,
} from './fusion-room-network-prefs'

/** 证书生成入参（渲染层只传可选 commonName / validityDays）。 */
export type FusionRoomCertGenerateIpcInput = FusionRoomCertGenerateInput

/** 偏好变更 patch（部分字段）。 */
export type FusionRoomNetworkPrefsPatch = Partial<FusionRoomNetworkPrefs>

/**
 * 闸门状态查询返回（P0-3b）。设置页只读展示「当前 IPC / 非 loopback 是否实际放行」。
 *
 * - `decision`：用**当前**偏好 + 证书重新跑 {@link decidePackagedCollaborationGate} 的结果
 *   （重启后或将生效）。
 * - `applied`：本次启动时实际应用的决策（注册 IPC / 非 loopback 放行的真值）。
 * - `needsRestart`：`decision` 与 `applied` 在 `registerIpc` / `allowNonLoopbackListen` 上是否
 *   不同——不同即表示用户刚改过偏好，**需重启应用后生效**（本切片采用策略 B：所有闸门
 *   变更提示重启，不动态注册 / 卸载 IPC；详见 12-IMPLEMENTATION-LOG §75）。
 * - `isPackaged`：当前是否打包版（渲染层据此决定是否展示打包版专属文案）。
 */
export interface FusionRoomGateStatus {
  decision: PackagedCollaborationGateDecision
  applied: PackagedCollaborationGateDecision
  needsRestart: boolean
  isPackaged: boolean
}

export interface RegisterFusionRoomNetworkPrefsIpcOptions {
  /** 当前是否打包版（`app.isPackaged`），用于 `decidePackagedCollaborationGate`。 */
  isPackaged: boolean
  /**
   * 本次启动时实际应用的闸门决策（`main/index.ts` 在启动时据 `app.isPackaged` + 启动偏好 +
   * 启动证书可用性跑 `decidePackagedCollaborationGate` 得到）。用于 `needsRestart` 比较与
   * 设置页只读展示「实际放行」真值。重启后 `main/index.ts` 会重新计算，故 `applied` 自动追上。
   */
  appliedGate: PackagedCollaborationGateDecision
}

export function registerFusionRoomNetworkPrefsIpc(
  options: RegisterFusionRoomNetworkPrefsIpcOptions,
): void {
  const { isPackaged, appliedGate } = options
  const certsDir = getCollaborationDir()
  const prefsPath = getFusionRoomNetworkPrefsPath()
  const certStore = new FusionRoomCertStore({ dir: certsDir })

  ipcMain.handle('fusion-room-network-prefs:get', (): FusionRoomNetworkPrefs =>
    loadFusionRoomNetworkPrefs(prefsPath),
  )

  ipcMain.handle(
    'fusion-room-network-prefs:set',
    (_e, patch: FusionRoomNetworkPrefsPatch): FusionRoomNetworkPrefs => {
      const current = loadFusionRoomNetworkPrefs(prefsPath)
      const next = { ...current, ...patch }
      // set 时校验：拒绝禁用开关、拒绝 enableNetworkListen 缺 enableCollaboration。
      // 不据证书硬拒（证书可后续 generate）；闸门在无证书时仍返回 allowNonLoopbackListen=false。
      validateFusionRoomNetworkPrefs(next, { hasActiveCert: certStore.hasActiveCert() })
      return saveFusionRoomNetworkPrefs(prefsPath, next)
    },
  )

  ipcMain.handle('fusion-room-network-prefs:gate-status', (): FusionRoomGateStatus => {
    const prefs = loadFusionRoomNetworkPrefs(prefsPath)
    const decision = decidePackagedCollaborationGate({
      isPackaged,
      prefs,
      hasActiveCert: certStore.hasActiveCert(),
    })
    const needsRestart =
      decision.registerIpc !== appliedGate.registerIpc ||
      decision.allowNonLoopbackListen !== appliedGate.allowNonLoopbackListen
    return { decision, applied: appliedGate, needsRestart, isPackaged }
  })

  ipcMain.handle('fusion-room-certs:list', (): FusionRoomPublicCertRecord[] =>
    certStore.listPublic(),
  )

  ipcMain.handle(
    'fusion-room-certs:generate',
    (_e, input?: FusionRoomCertGenerateIpcInput): FusionRoomPublicCertRecord => {
      const record = certStore.generate(input ?? {})
      const { key: _key, ...rest } = record
      return rest
    },
  )

  ipcMain.handle(
    'fusion-room-certs:revoke',
    (_e, input: { certId: string }): FusionRoomPublicCertRecord | undefined =>
      certStore.revoke(input.certId),
  )
}
