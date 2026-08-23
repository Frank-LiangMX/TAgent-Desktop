/**
 * 打包版协作 / 网络显式闸门（P0-3 B）。
 *
 * 当前 `main/index.ts` 历史：`if (!app.isPackaged) registerCollaborationRoomIpc(...)` ——
 * 打包版完全关闭协作室 IPC。本切片改为**可配置但默认关闭**的决策函数 +
 * 持久化偏好：默认 prefs 全关时打包行为与今天一致；只有用户显式打开
 * `enableCollaboration` 才注册协作室 IPC；`enableNetworkListen` 还需存在 active 且未过期
 * 的 TLS 证书材料才放行非 loopback 监听。
 *
 * 规则（与 brief 一一对应）：
 *   1. 开发环境（`!isPackaged`）：`registerIpc=true`；非 loopback 仍要求 TLS（由 runtime 现有逻辑保证）。
 *   2. 打包版默认：`registerIpc=false`，`allowNonLoopbackListen=false`。
 *   3. 仅 `enableCollaboration` → IPC 开，但非 loopback 仍关。
 *   4. `enableNetworkListen` 额外要求：显式打开 + 存在 active 且未过期 TLS 证书；否则 false。
 *   5. 禁止新增 `allowInsecureNetwork` / 明文公网监听开关（`validateFusionRoomNetworkPrefs` 显式拒绝）。
 *
 * `decidePackagedCollaborationGate` 是纯函数（无 I/O、不 require electron），可直接单测。
 * 偏好读写走 `atomic-json`；路径由调用方传入（生产用 `getFusionRoomNetworkPrefsPath()`，
 * 单测用临时目录），不写用户真实 config。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'

/** 打包版协作 / 网络偏好；默认全关。 */
export interface FusionRoomNetworkPrefs {
  /** 打包版是否注册协作室 IPC / 本地房间 UI 入口；默认 false。 */
  enableCollaboration: boolean
  /**
   * 打包版是否允许启动非 loopback FusionRoom transport；默认 false。
   * 仅当 `enableCollaboration` 且存在未撤销 TLS 证书时才可能为 true。
   */
  enableNetworkListen: boolean
}

export const DEFAULT_FUSION_ROOM_NETWORK_PREFS: FusionRoomNetworkPrefs = {
  enableCollaboration: false,
  enableNetworkListen: false,
}

/**
 * 明文公网 / 不安全监听开关的禁用名单。brief 明确禁止新增此类绕过开关；
 * `validateFusionRoomNetworkPrefs` 命中即抛错，避免偏好文件被手工写入后绕过闸门。
 */
const FORBIDDEN_PREF_KEYS = [
  'allowInsecureNetwork',
  'allowInsecure',
  'allowPlaintext',
  'allowPlaintextNetwork',
  'insecure',
  'insecureNetwork',
] as const

export interface PackagedCollaborationGateInput {
  isPackaged: boolean
  prefs: FusionRoomNetworkPrefs
  /**
   * 是否存在 active 且未过期的 TLS 证书材料（由 `FusionRoomCertStore.hasActiveCert()` 判定）。
   * 决策函数保持纯函数，证书可用性由调用方传入。
   */
  hasActiveCert: boolean
}

export interface PackagedCollaborationGateDecision {
  /** 是否注册协作室 IPC（local room UI 入口 + 运行链路）。 */
  registerIpc: boolean
  /** 是否允许非 loopback FusionRoom transport 监听。 */
  allowNonLoopbackListen: boolean
  /** 决策原因（人类可读），用于日志；放行时为空数组。 */
  reasons: string[]
}

/**
 * 打包版协作 / 网络显式闸门决策函数（纯函数）。
 *
 * 开发环境恒开 IPC；非 loopback 仍由 runtime 现有 TLS 逻辑保证（不在此放宽）。
 * 打包版默认全关；`enableCollaboration` 控制 IPC；`enableNetworkListen` 还需 active 证书。
 */
export function decidePackagedCollaborationGate(
  input: PackagedCollaborationGateInput,
): PackagedCollaborationGateDecision {
  const { isPackaged, prefs, hasActiveCert } = input

  // 规则 1：开发环境恒开 IPC；非 loopback 仍要求 TLS（runtime 保证）。
  // allowNonLoopbackListen 在 dev 下只反映是否有可用证书（信息性；实际由 runtime 校验 tls）。
  if (!isPackaged) {
    return {
      registerIpc: true,
      allowNonLoopbackListen: hasActiveCert,
      reasons: [],
    }
  }

  // 规则 2：打包版默认全关。
  if (!prefs.enableCollaboration) {
    return {
      registerIpc: false,
      allowNonLoopbackListen: false,
      reasons: ['enableCollaboration 偏好未开启（打包版默认关闭协作室 IPC）'],
    }
  }

  // 规则 3：enableCollaboration 已开 → 注册 IPC。
  const reasons: string[] = []

  // 规则 4：enableNetworkListen 额外要求显式打开 + active 且未过期证书。
  if (!prefs.enableNetworkListen) {
    reasons.push('enableNetworkListen 偏好未开启（非 loopback 监听保持关闭）')
    return { registerIpc: true, allowNonLoopbackListen: false, reasons }
  }

  if (!hasActiveCert) {
    reasons.push('enableNetworkListen 已开启但无 active 且未过期的 TLS 证书（非 loopback 监听保持关闭）')
    return { registerIpc: true, allowNonLoopbackListen: false, reasons }
  }

  return { registerIpc: true, allowNonLoopbackListen: true, reasons }
}

/** 把任意输入归一化为合法 `FusionRoomNetworkPrefs`（缺失字段取默认，类型强制 boolean）。 */
export function normalizeFusionRoomNetworkPrefs(
  raw: unknown,
): FusionRoomNetworkPrefs {
  const obj = (raw ?? {}) as Partial<Record<string, unknown>>
  return {
    enableCollaboration: obj.enableCollaboration === true,
    enableNetworkListen: obj.enableNetworkListen === true,
  }
}

/**
 * 校验偏好整单合法性（`prefs:set` 时调用）。
 *
 * - 拒绝禁用名单中的明文公网 / 不安全开关（brief 禁止新增此类绕过）。
 *   必须在 `normalize` 之前对**原始输入**检查，否则 normalize 会静默洗掉未知字段。
 * - 拒绝 `enableNetworkListen=true` 但 `enableCollaboration=false`（网络监听以开启协作为前提）。
 * - 不拒绝 `enableNetworkListen=true` + 无证书：证书可后续 `certs:generate` 生成，
 *   闸门在无证书时仍返回 `allowNonLoopbackListen=false`（规则 4 的「否则 false」由决策函数兜底）。
 */
export function validateFusionRoomNetworkPrefs(
  prefs: unknown,
  input: { hasActiveCert?: boolean } = {},
): void {
  const raw = (prefs ?? {}) as Record<string, unknown>
  for (const key of FORBIDDEN_PREF_KEYS) {
    if (key in raw) {
      throw new Error(
        '禁止设置明文公网 / 不安全监听开关 ' +
          JSON.stringify(key) +
          '：明文 HTTP 绑定 0.0.0.0/公网不被支持',
      )
    }
  }
  const normalized = normalizeFusionRoomNetworkPrefs(prefs)
  if (normalized.enableNetworkListen && !normalized.enableCollaboration) {
    throw new Error('enableNetworkListen 需要 enableCollaboration 同时开启')
  }
  // hasActiveCert 当前不用于硬拒（证书可后生成），仅保留参数便于后续扩展。
  void input
}

/** 读取偏好（缺失/损坏 → 默认全关）。 */
export function loadFusionRoomNetworkPrefs(path: string): FusionRoomNetworkPrefs {
  return normalizeFusionRoomNetworkPrefs(readJsonSafe<unknown>(path, null))
}

/** 校验（含禁用开关拦截）+ 原子写入偏好，返回落盘后的值。 */
export function saveFusionRoomNetworkPrefs(
  path: string,
  prefs: FusionRoomNetworkPrefs,
): FusionRoomNetworkPrefs {
  // 先在原始输入上拒绝禁用开关，避免 normalize 静默洗掉。
  validateFusionRoomNetworkPrefs(prefs)
  const next = normalizeFusionRoomNetworkPrefs(prefs)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeJsonAtomic(path, next)
  return next
}
