/**
 * FusionRoom transport 启动装配（P0-3c）。
 *
 * 把 P0-3 / P0-3b 已产出但**未接通**的 `allowNonLoopbackListen` 接到 Electron 主进程
 * 启动路径：据显式闸门 + cert store 的 active TLS 材料决定是否 `createFusionRoomTransportRuntime`
 * 并 `start`，返回结构化的 bootstrap 结果供 `main/index.ts` 记录 / 暴露只读状态 IPC。
 *
 * 决策表（与 brief §A 一一对应，**绝不**默认打开公网、**绝不**新增 `allowInsecureNetwork`、
 * 远程 / 打包路径 **不**默认 `enableDefaultMemberExecution`）：
 *
 * | 条件 | 行为 |
 * |---|---|
 * | `!gate.allowNonLoopbackListen` 且未显式 `enableDevLoopbackTransport` | `disabled`（reasons 含闸门理由），不 start |
 * | `!gate.allowNonLoopbackListen` 且显式 `enableDevLoopbackTransport` | `loopback_only`：明文 HTTP，仅 127.0.0.1，无 tls |
 * | `gate.allowNonLoopbackListen` 且 `resolveTlsOptions()` 有值 | `listening`：HTTPS + 非 loopback（或调用方 host） |
 * | `gate.allowNonLoopbackListen` 但无 TLS 材料 | `failed`（不得明文非 loopback）；不得绕过 |
 * | `start` reject / listen 失败 | `failed`，打日志，**不**崩主进程 |
 *
 * 本模块不读 `app.isPackaged` / 不 require electron，所有路径由调用方传入（生产用
 * `getCollaborationDir()` 系列路径，测试用临时目录），便于离线单测。生命周期策略对齐
 * P0-3b **B**：闸门变更需重启才重新 bootstrap（不在本切片做热插拔 listen）；调用方
 * 持有返回的 runtime 句柄并在 `before-quit` / `will-quit` 调 `runtime.close()`。
 */
import type { AddressInfo } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { FusionRoomPrincipal } from '@tagent/core'
import type { FusionRoomCertStore } from './fusion-room-cert-store'
import {
  createFusionRoomTransportRuntime,
  type FusionRoomTransportRuntime,
} from './fusion-room-runtime'

/** bootstrap 终态。`disabled`/`failed` 不含 runtime；`loopback_only`/`listening` 含 runtime 句柄。 */
export type FusionRoomTransportBootstrapResult =
  | { status: 'disabled'; reasons: string[] }
  | { status: 'loopback_only'; runtime: FusionRoomTransportRuntime; address: AddressInfo; tls: false }
  | { status: 'listening'; runtime: FusionRoomTransportRuntime; address: AddressInfo; tls: true; host: string }
  | { status: 'failed'; error: string; reasons?: string[] }

export interface FusionRoomTransportBootstrapInput {
  /** 显式闸门决策（`decidePackagedCollaborationGate` 产出；bootstrap 不自行重算闸门）。 */
  gate: { registerIpc: boolean; allowNonLoopbackListen: boolean; reasons: string[] }
  certStore: FusionRoomCertStore
  /** 非 loopback 时绑定主机；默认 `0.0.0.0`；测试传具体地址。 */
  listenHost?: string
  /** 端口；默认 0（OS 分配）；测试用 0。 */
  listenPort?: number
  /**
   * 开发态是否可选启动 **loopback-only** HTTP transport（仅当 `!allowNonLoopbackListen`）。
   * **本切片默认 false**（避免无显式开关就起服务）；为 true 时仅 127.0.0.1、无 tls。
   */
  enableDevLoopbackTransport?: boolean
  /** RoomSession 快照索引路径；生产用 `getFusionRoomSnapshotsPath()`，测试用临时路径。 */
  snapshotPath?: string
  /** 邀请令牌索引路径；生产用 `getFusionRoomInviteTokensPath()`，测试用临时路径。 */
  inviteTokenPath?: string
  /** outbox worker 状态文件路径；省略时 runtime 用默认 `getCollaborationDir()` 路径。 */
  outboxWorkerStatePath?: string
  /**
   * transport fallback 认证（无邀请令牌时如何识别 principal）。省略时默认 `() => undefined`
   *（deny-all：本切片**不**做真实账户 OAuth，仅邀请令牌可访问；房主网络侧认证留待
   * 真实账户系统）。测试可注入 stub。
   */
  authenticate?: (request: IncomingMessage) => FusionRoomPrincipal | undefined
}

/** deny-all fallback：未带有效邀请令牌的请求一律不认证（与「本切片不做真实账户 OAuth」一致）。 */
const denyAllAuthenticate = (): undefined => undefined

/**
 * 据闸门 + cert store 装配 FusionRoom transport 并按需 start。纯决策 + 单次 start，
 * 不重算闸门、不热插拔。失败时 **不**抛（返回 `failed`），避免拖垮主进程启动。
 */
export async function bootstrapFusionRoomTransport(
  input: FusionRoomTransportBootstrapInput,
): Promise<FusionRoomTransportBootstrapResult> {
  const { gate, certStore } = input
  const authenticate = input.authenticate ?? denyAllAuthenticate

  // 规则 1：闸门不允许非 loopback。
  if (!gate.allowNonLoopbackListen) {
    // 可选 dev loopback-only 明文 HTTP（仅 127.0.0.1、无 tls）。
    if (input.enableDevLoopbackTransport) {
      try {
        const runtime = createFusionRoomTransportRuntime({
          ...(input.snapshotPath !== undefined ? { snapshotPath: input.snapshotPath } : {}),
          ...(input.inviteTokenPath !== undefined ? { inviteTokenPath: input.inviteTokenPath } : {}),
          ...(input.outboxWorkerStatePath !== undefined
            ? { outboxWorkerStatePath: input.outboxWorkerStatePath }
            : {}),
          authenticate,
          enableDefaultMemberExecution: false,
        })
        const address = await runtime.start({ host: '127.0.0.1', port: input.listenPort ?? 0 })
        return { status: 'loopback_only', runtime, address, tls: false }
      } catch (error) {
        return {
          status: 'failed',
          error: `loopback-only transport 启动失败：${toMessage(error)}`,
          reasons: gate.reasons,
        }
      }
    }
    return { status: 'disabled', reasons: gate.reasons }
  }

  // 规则 2/3：闸门允许非 loopback → 必须有 active TLS 材料（不得明文非 loopback）。
  // 注意：闸门 `allowNonLoopbackListen` 已据 hasActiveCert 计算，但 bootstrap 仍以
  // `resolveTlsOptions()` 取真实材料，避免闸门判定与 start 之间证书被撤销的竞态。
  const tls = certStore.resolveTlsOptions()
  if (!tls) {
    return {
      status: 'failed',
      error: '闸门允许非 loopback 监听但无 active 且未过期的 TLS 证书材料（不得明文非 loopback）',
      reasons: gate.reasons,
    }
  }

  // 规则 4：HTTPS + 非 loopback（或调用方 host），enableDefaultMemberExecution 始终 false。
  try {
    const runtime = createFusionRoomTransportRuntime({
      ...(input.snapshotPath !== undefined ? { snapshotPath: input.snapshotPath } : {}),
      ...(input.inviteTokenPath !== undefined ? { inviteTokenPath: input.inviteTokenPath } : {}),
      ...(input.outboxWorkerStatePath !== undefined
        ? { outboxWorkerStatePath: input.outboxWorkerStatePath }
        : {}),
      tls,
      authenticate,
      enableDefaultMemberExecution: false,
    })
    const host = input.listenHost ?? '0.0.0.0'
    const address = await runtime.start({ host, port: input.listenPort ?? 0 })
    return { status: 'listening', runtime, address, tls: true, host }
  } catch (error) {
    return {
      status: 'failed',
      error: `非 loopback HTTPS transport 启动失败：${toMessage(error)}`,
      reasons: gate.reasons,
    }
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ===== 只读状态投影（供 fusion-room-transport:status IPC，剥离 runtime 句柄）=====

export type FusionRoomTransportStatusKind =
  | 'disabled'
  | 'listening'
  | 'loopback_only'
  | 'failed'
  | 'not_started'

/** 渲染层可见的 transport 状态（无 runtime 句柄、无私钥、无内部对象）。 */
export interface FusionRoomTransportStatusView {
  status: FusionRoomTransportStatusKind
  host?: string
  port?: number
  tls?: boolean
  error?: string
  reasons?: string[]
}

/**
 * 把 bootstrap 结果投影成可经 IPC 回传渲染层的纯数据。`null`（bootstrap 尚未跑）→ `not_started`。
 * 不暴露 runtime / server / 证书私钥等内部句柄。
 */
export function projectFusionRoomTransportStatus(
  bootstrap: FusionRoomTransportBootstrapResult | null,
): FusionRoomTransportStatusView {
  if (!bootstrap) return { status: 'not_started' }
  switch (bootstrap.status) {
    case 'disabled':
      return { status: 'disabled', reasons: bootstrap.reasons }
    case 'loopback_only':
      return { status: 'loopback_only', host: '127.0.0.1', port: bootstrap.address.port, tls: false }
    case 'listening':
      return { status: 'listening', host: bootstrap.host, port: bootstrap.address.port, tls: true }
    case 'failed':
      return { status: 'failed', error: bootstrap.error, reasons: bootstrap.reasons }
  }
}
