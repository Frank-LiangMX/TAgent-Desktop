import type { AddressInfo } from 'node:net'
import type { MemberBackendAdapter } from '@tagent/shared'
import type { Server } from 'node:http'
import type {
  FusionRoomGatewayOptions,
  FusionRoomPrincipal,
  FusionRoomAuthoritySnapshot,
  FusionRoomHost,
  FusionRoomGateway,
  FusionRoomWorkspaceStore,
} from '@tagent/core'
import {
  FusionRoomGateway as FusionRoomGatewayImpl,
  FusionRoomHost as FusionRoomHostImpl,
} from '@tagent/core'
import { FileFusionRoomSnapshotStore } from './fusion-room-snapshot-store'
import { FileFusionRoomWorkspaceStore } from './fusion-room-workspace-store'
import {
  createFusionRoomInviteAuthenticator,
  FileFusionRoomInviteTokenStore,
  type FusionRoomIssuedInvite,
  type FusionRoomInviteTokenIssueInput,
} from './fusion-room-invite-token-store'
import {
  createFusionRoomHttpServer,
  createFusionRoomHttpsServer,
  type FusionRoomHttpServerOptions,
  type FusionRoomTlsOptions,
} from './fusion-room-http-server'
import { FusionRoomExecutionBridge, type FusionRoomExecutionBridgeOptions } from './fusion-room-execution-bridge'
import { createFusionRoomHostToolHandlerFactory } from './fusion-room-host-tools'
import { createDefaultChannelMemberStack } from './member-backend-factory'

export interface FusionRoomTransportRuntimeOptions
  extends Pick<
    FusionRoomHttpServerOptions,
    'authenticate' | 'maxBodyBytes' | 'heartbeatMs' | 'maxEventStreamsPerPrincipal'
  > {
  snapshotPath?: string
  inviteTokenPath?: string
  workspaceStore?: FusionRoomWorkspaceStore
  authorize?: FusionRoomGatewayOptions['authorize']
  /** Optional real member runner; omitted means authority-only transport. */
  memberAdapter?: MemberBackendAdapter
  /**
   * 显式开关：为 true 且未传 {@link memberAdapter} 时，自动装配默认成员执行栈
   *（`createDefaultChannelMemberStack`：带 lifecycle 的 ChannelBackendAdapter）+ ExecutionBridge，
   * 使该 runtime 具备本地成员 turn 执行能力（且 adapter 已 bindTurnAbort 到 lifecycle，
   * 满足「启用执行时必须带 lifecycle」）。
   *
   * **默认 false**：保持「不自动开执行 / 不自动开网络」——runtime 默认只做 authority-only
   * transport，不静默拉起模型调用。可信环境（如本地协作室入口）显式置 true 打开；远程 /
   * 打包入口在未完成账户认证与 ACL 前不应打开。提供 {@link memberAdapter} 时本字段被忽略
   * （以显式注入为准）。
   */
  enableDefaultMemberExecution?: boolean
  /** Optional host-authorized room/workspace tool bridge. */
  memberToolHandlerFactory?: FusionRoomExecutionBridgeOptions['hostToolHandlerFactory']
  /**
   * 可选 TLS 选项。提供时 transport 构造 HTTPS 服务器（TLS 加密通道），并允许
   * {@link FusionRoomTransportListenOptions.host} 绑定非 loopback 地址以支持跨主机
   * 访问；省略时构造明文 HTTP 服务器，仅允许 loopback 监听。本字段不充当
   * `allowInsecureNetwork` 之类的绕过开关：明文 HTTP + 非 loopback 一律拒绝。
   */
  tls?: FusionRoomTlsOptions
}

export interface FusionRoomTransportListenOptions {
  /**
   * 监听主机名。明文 HTTP transport（未在
   * {@link FusionRoomTransportRuntimeOptions.tls} 提供 TLS 选项时）仅允许
   * loopback 地址：`127.0.0.1`、`localhost`、`::1` 以及 `127.0.0.0/8` 段内的
   * 任意 IPv4。其余目标（`0.0.0.0`、`::`、局域网 IP、公网 IP、任意 hostname）
   * 在明文 HTTP transport 下会被 {@link start} 直接 `Promise.reject`，避免在
   * 未加密通道上暴露邀请令牌（Bearer token）。
   *
   * 当在 {@link FusionRoomTransportRuntimeOptions.tls} 提供 TLS 选项时，
   * transport 切换为 HTTPS（TLS 加密通道），此时允许绑定非 loopback 地址以
   * 支持跨主机访问；跨主机访问仍需配合真实账户认证。
   *
   * 本接口不存在 `allowInsecureNetwork` 之类的绕过开关；明文监听的任何放宽
   * 都属于新增安全 transport 实现的范畴，而不是在这里放行明文监听。
   *
   * 省略时默认 `127.0.0.1`。判定逻辑见 {@link isFusionRoomLoopbackHost}。
   */
  host?: string
  /**
   * 监听端口；省略或传 `0` 时由操作系统分配临时端口。
   * 测试一律使用 `0`，避免绑定真实公网端口。
   */
  port?: number
}

/**
 * 判定 `host` 是否为安全的 loopback 监听目标（明文 HTTP transport 闸门）。
 *
 * 纯函数、无副作用，可直接单元测试。`trim` 后只接受：
 *   - `localhost`（大小写不敏感）
 *   - `::1`（IPv6 loopback，仅接受 canonical 压缩形式）
 *   - `127.x.x.x`（IPv4 loopback，`127.0.0.0/8`，仅接受 canonical
 *     dotted-decimal 形式）
 *
 * 拒绝空值、空格串，以及一切会被 `inet_aton` 重新解释为非 loopback 地址
 * 的 IPv4 伪造写法：八进制前导零（`0127.0.0.1` / `127.0.0.01`）、
 * 十六进制（`0x7f.0.0.1`）、短格式（`127.1`）、单整数（`2130706433`）、
 * 带尾域名（`127.0.0.1.example.com`）等。`0.0.0.0`、`::`、局域网/公网 IP、
 * 任意 hostname 一律拒绝。
 */
export function isFusionRoomLoopbackHost(host: string): boolean {
  if (typeof host !== 'string') return false
  const trimmed = host.trim()
  if (trimmed === '') return false
  const lower = trimmed.toLowerCase()
  if (lower === 'localhost') return true
  if (lower === '::1') return true
  // IPv4 loopback `127.0.0.0/8`：仅接受 canonical dotted-decimal `a.b.c.d`，
  // 逐段校验，拒绝前导零（防止被某些 C 库按八进制解释成别的地址）。
  const octets = trimmed.split('.')
  if (octets.length !== 4) return false
  for (const octet of octets) {
    if (!/^[0-9]{1,3}$/.test(octet)) return false
    if (octet.length > 1 && octet[0] === '0') return false
    if (Number(octet) > 255) return false
  }
  return octets[0] === '127'
}

export interface FusionRoomTransportRuntime {
  readonly host: FusionRoomHost
  readonly gateway: FusionRoomGateway
  readonly inviteTokenStore: FileFusionRoomInviteTokenStore
  readonly workspaceStore: FusionRoomWorkspaceStore
  readonly executionBridge?: FusionRoomExecutionBridge
  readonly server: Server
  issueInvite(
    principal: FusionRoomPrincipal,
    roomId: string,
    input: Omit<FusionRoomInviteTokenIssueInput, 'roomId' | 'now'> & { now?: number },
  ): FusionRoomIssuedInvite
  start(options?: FusionRoomTransportListenOptions): Promise<AddressInfo>
  close(): Promise<void>
}

/**
 * Assemble the durable fusion-room transport without starting a network listener.
 *
 * The caller must explicitly invoke start() and must provide the real account
 * authentication adapter at construction time. This is intentionally not
 * bootstrapped from Electron app startup while the packaged collaboration gate
 * remains closed.
 */
export function createFusionRoomTransportRuntime(
  options: FusionRoomTransportRuntimeOptions,
): FusionRoomTransportRuntime {
  const snapshotStore = new FileFusionRoomSnapshotStore(options.snapshotPath)
  const inviteTokenStore = new FileFusionRoomInviteTokenStore(options.inviteTokenPath)
  const workspaceStore = options.workspaceStore ?? new FileFusionRoomWorkspaceStore()
  const host = new FusionRoomHostImpl({ snapshotStore, workspaceStore })
  const gateway = new FusionRoomGatewayImpl(host, {
    ...(options.authorize ? { authorize: options.authorize } : {}),
  })
  host.recoverInterruptedRuns()
  const hostToolHandlerFactory = options.memberToolHandlerFactory ??
    createFusionRoomHostToolHandlerFactory({ host, workspaceStore })
  // P1-2c：未显式注入 memberAdapter 但打开 enableDefaultMemberExecution 时，自动装配默认
  // 成员执行栈（带 lifecycle 的 ChannelBackendAdapter）。默认 false → memberAdapter 为
  // undefined → 无 executionBridge（authority-only transport，不静默开执行/网络）。
  const defaultMemberStack =
    options.enableDefaultMemberExecution && !options.memberAdapter
      ? createDefaultChannelMemberStack()
      : undefined
  const memberAdapter = options.memberAdapter ?? defaultMemberStack?.adapter
  const executionBridge = memberAdapter
    ? new FusionRoomExecutionBridge({
        host,
        adapter: memberAdapter,
        hostToolHandlerFactory,
      })
    : undefined
  const authenticate = createFusionRoomInviteAuthenticator({
    store: inviteTokenStore,
    fallback: options.authenticate,
  })
  const issueInvite = (
    principal: FusionRoomPrincipal,
    roomId: string,
    input: Omit<FusionRoomInviteTokenIssueInput, 'roomId' | 'now'> & { now?: number },
  ): FusionRoomIssuedInvite => {
    const issued = inviteTokenStore.issue({ ...input, roomId })
    const connectionId = gateway.connect(principal)
    try {
      gateway.dispatch(connectionId, roomId, {
        type: 'invite-human',
        userId: issued.userId,
        displayName: issued.displayName,
      })
      return issued
    } catch (error) {
      inviteTokenStore.revoke(issued.tokenId)
      throw error
    } finally {
      gateway.disconnect(connectionId)
    }
  }
  const httpServerOptions: FusionRoomHttpServerOptions = {
    gateway,
    authenticate,
    inviteIssuer: { issueInvite },
    ...(executionBridge ? {
      onAction: ({ roomId, action, result }: { roomId: string; action: import('@tagent/core').FusionRoomGatewayAction; result: unknown }) =>
        executionBridge.handleAction(roomId, action, result),
    } : {}),
    ...(workspaceStore.readFile ? { publishedFileReader: { readFile: workspaceStore.readFile.bind(workspaceStore) } } : {}),
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.maxEventStreamsPerPrincipal !== undefined
      ? { maxEventStreamsPerPrincipal: options.maxEventStreamsPerPrincipal }
      : {}),
  }
  const tlsOptions = options.tls
  const server = tlsOptions
    ? createFusionRoomHttpsServer(httpServerOptions, tlsOptions)
    : createFusionRoomHttpServer(httpServerOptions)

  let started = false
  let starting = false
  let startPromise: Promise<AddressInfo> | undefined
  let closePromise: Promise<void> | undefined

  const start = (listenOptions: FusionRoomTransportListenOptions = {}): Promise<AddressInfo> => {
    if (started || starting || closePromise) {
      return Promise.reject(new Error('Fusion Room transport 已经启动或正在关闭'))
    }
    const hostName = listenOptions.host ?? '127.0.0.1'
    // 安全闸门：明文 HTTP transport 只允许 loopback 绑定。
    // 提供了 tls（TLS 加密通道）时才允许非 loopback 监听；未提供 tls 仍拒绝非
    // loopback；loopback 无 tls 仍可用。这里没有任何 allowInsecureNetwork 绕过开关。
    if (!isFusionRoomLoopbackHost(hostName) && !tlsOptions) {
      return Promise.reject(
        new Error(
          'Fusion Room transport 拒绝非 loopback 监听地址 ' +
            JSON.stringify(hostName) +
            '：当前为明文 HTTP transport，绑定到 0.0.0.0/::/局域网/公网主机名会暴露邀请令牌；' +
            '跨主机访问请先启用 TLS 与真实账户认证。',
        ),
      )
    }
    starting = true
    startPromise = new Promise<AddressInfo>((resolve, reject) => {
      const port = listenOptions.port ?? 0
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Fusion Room transport 未返回有效监听地址'))
          return
        }
        resolve(address)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, hostName)
    }).then((address) => {
      started = true
      return address
    }).finally(() => {
      starting = false
      startPromise = undefined
    })
    return startPromise
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      if (executionBridge) await executionBridge.disposeAndWait()
      if (startPromise) {
        try {
          await startPromise
        } catch {
          return
        }
      }
      if (!started) return
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          started = false
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error)
            return
          }
          resolve()
        })
      })
    })().finally(() => {
      closePromise = undefined
    })
    return closePromise
  }

  return {
    host,
    gateway,
    inviteTokenStore,
    workspaceStore,
    executionBridge,
    server,
    issueInvite,
    start,
    close,
  }
}

export type FusionRoomRuntimeSnapshot = FusionRoomAuthoritySnapshot
