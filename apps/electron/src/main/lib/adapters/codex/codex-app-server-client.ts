/**
 * Codex App Server stdio 客户端。
 *
 * 协议依据：本机 codex-cli 0.151.0 `app-server generate-ts --experimental`。
 * App Server 使用一行一个 JSON 消息的双向协议；initialize 成功后客户端必须发送
 * `initialized` 通知。此层只负责连接、请求关联和进程生命周期，不做 TAgent 事件归一化。
 */
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { killCliProcessTree } from '../../agent/cli-workers/kill-cli-process'
import { resolveCliBin } from '../../agent/cli-workers/run-ndjson-cli'

export type CodexAppServerRequestId = number | string

export interface CodexAppServerInitializeResponse {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
}

export interface CodexAppServerNotification {
  method: string
  params?: unknown
  emittedAtMs?: number
}

export interface CodexAppServerIncomingRequest {
  id: CodexAppServerRequestId
  method: string
  params?: unknown
}

export interface CodexAppServerClientInfo {
  name: string
  title: string | null
  version: string
}

interface CodexAppServerProcess {
  pid?: number
  stdin: Writable
  stdout: Readable
  stderr: Readable
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface CodexAppServerClientOptions {
  executablePath: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  clientInfo?: Partial<CodexAppServerClientInfo>
  onStderr?: (text: string) => void
  spawnProcess?: () => CodexAppServerProcess
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type ServerRequestHandler = (
  request: CodexAppServerIncomingRequest,
) => unknown | Promise<unknown>

export class CodexAppServerRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'CodexAppServerRpcError'
    this.code = code
    this.data = data
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const GRACEFUL_CLOSE_TIMEOUT_MS = 500

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions
  private readonly pending = new Map<CodexAppServerRequestId, PendingRequest>()
  private readonly notificationListeners = new Set<
    (notification: CodexAppServerNotification) => void
  >()
  private readonly connectionClosedListeners = new Set<
    (error: Error) => void
  >()
  private process: CodexAppServerProcess | undefined
  private nextRequestId = 1
  private stdoutBuffer = ''
  private initialized = false
  private initializePromise: Promise<CodexAppServerInitializeResponse> | undefined
  private closing = false
  private serverRequestHandler: ServerRequestHandler | undefined

  constructor(options: CodexAppServerClientOptions) {
    if (!options.executablePath?.trim()) {
      throw new Error('Codex executablePath 不能为空')
    }
    this.options = options
  }

  get isRunning(): boolean {
    return Boolean(this.process)
  }

  get isInitialized(): boolean {
    return this.initialized
  }

  /** 启动本机 `codex app-server --stdio`，不触碰账号凭证。 */
  start(): void {
    if (this.process) return
    this.closing = false
    const child = this.options.spawnProcess?.() ?? this.spawnDefaultProcess()
    this.process = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string | Buffer) => {
      this.consumeStdout(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    child.stderr.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.options.onStderr?.(text)
    })
    child.on('error', (error) => {
      this.failConnection(new Error(`Codex App Server 启动失败：${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (this.process !== child) return
      this.process = undefined
      this.initialized = false
      this.initializePromise = undefined
      if (!this.closing) {
        const error = new Error(
          `Codex App Server 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`,
        )
        this.rejectAllPending(error)
        this.emitConnectionClosed(error)
      }
    })
  }

  /**
   * 执行官方握手。重复调用复用同一个结果，不重复发送 initialize/initialized。
   */
  initialize(): Promise<CodexAppServerInitializeResponse> {
    if (this.initialized && this.initializePromise) return this.initializePromise
    if (this.initializePromise) return this.initializePromise
    this.start()
    const clientInfo: CodexAppServerClientInfo = {
      name: this.options.clientInfo?.name ?? 'tagent-desktop',
      title: this.options.clientInfo?.title ?? 'TAgent Desktop',
      version: this.options.clientInfo?.version ?? 'unknown',
    }
    this.initializePromise = this.request<CodexAppServerInitializeResponse>(
      'initialize',
      {
        clientInfo,
        capabilities: {
          // request_user_input 等反向 RPC 目前仍属于 App Server experimental API。
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    )
      .then((response) => {
        this.notify('initialized')
        this.initialized = true
        return response
      })
      .catch((error) => {
        this.initializePromise = undefined
        throw error
      })
    return this.initializePromise
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    this.start()
    const id = this.nextRequestId++
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex App Server 请求超时：${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      try {
        this.writeMessage({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.start()
    this.writeMessage(params === undefined ? { method } : { method, params })
  }

  onNotification(
    listener: (notification: CodexAppServerNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onConnectionClosed(listener: (error: Error) => void): () => void {
    this.connectionClosedListeners.add(listener)
    return () => this.connectionClosedListeners.delete(listener)
  }

  setServerRequestHandler(handler: ServerRequestHandler | undefined): void {
    this.serverRequestHandler = handler
  }

  /** 结束 stdio 并回收整棵 App Server 进程树。 */
  close(): void {
    const child = this.process
    if (!child) return
    this.closing = true
    this.process = undefined
    this.initialized = false
    this.initializePromise = undefined
    this.rejectAllPending(new Error('Codex App Server 客户端已关闭'))
    try {
      child.stdin.end()
    } catch {
      // stdin 可能已随进程退出而关闭。
    }
    // App Server 收到 stdin EOF 通常会自行退出；Windows 上立即 taskkill 容易与正常退出
    // 抢跑并留下“未找到进程”的假告警。给它一个很短的优雅窗口，仍存活再杀整棵树。
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        killCliProcessTree(child as unknown as ChildProcess, 'codex-app-server')
      }
    }, GRACEFUL_CLOSE_TIMEOUT_MS)
    forceKillTimer.unref?.()
  }

  private spawnDefaultProcess(): ChildProcessWithoutNullStreams {
    const invocation = resolveCliBin(this.options.executablePath)
    return spawn(
      invocation.command,
      [
        ...invocation.cmdPrefix,
        'app-server',
        '--stdio',
        '--enable',
        'default_mode_request_user_input',
        '--enable',
        'exec_permission_approvals',
        '--enable',
        'request_permissions_tool',
      ],
      {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
  }

  private writeMessage(message: Record<string, unknown>): void {
    const child = this.process
    if (!child) throw new Error('Codex App Server 尚未启动')
    if (child.stdin.destroyed || !child.stdin.writable) {
      throw new Error('Codex App Server stdin 不可写')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8')
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      message = parsed as Record<string, unknown>
    } catch {
      this.options.onStderr?.(`[codex app-server protocol] 非 JSON stdout: ${line}\n`)
      return
    }

    const id = message.id
    if ((typeof id === 'number' || typeof id === 'string') && !message.method) {
      this.handleResponse(id, message)
      return
    }
    if (
      (typeof id === 'number' || typeof id === 'string') &&
      typeof message.method === 'string'
    ) {
      void this.handleServerRequest({
        id,
        method: message.method,
        params: message.params,
      })
      return
    }
    if (typeof message.method === 'string') {
      const notification: CodexAppServerNotification = {
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
        ...(typeof message.emittedAtMs === 'number'
          ? { emittedAtMs: message.emittedAtMs }
          : {}),
      }
      for (const listener of this.notificationListeners) listener(notification)
    }
  }

  private handleResponse(
    id: CodexAppServerRequestId,
    message: Record<string, unknown>,
  ): void {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    const error = message.error
    if (error && typeof error === 'object') {
      const rpcError = error as { code?: unknown; message?: unknown; data?: unknown }
      pending.reject(
        new CodexAppServerRpcError(
          typeof rpcError.code === 'number' ? rpcError.code : -32000,
          typeof rpcError.message === 'string'
            ? rpcError.message
            : `Codex App Server 请求失败：${pending.method}`,
          rpcError.data,
        ),
      )
      return
    }
    pending.resolve(message.result)
  }

  private async handleServerRequest(
    request: CodexAppServerIncomingRequest,
  ): Promise<void> {
    const handler = this.serverRequestHandler
    if (!handler) {
      this.writeMessage({
        id: request.id,
        error: {
          code: -32601,
          message: `TAgent 尚未处理服务端请求：${request.method}`,
        },
      })
      return
    }
    try {
      const result = await handler(request)
      this.writeMessage({ id: request.id, result })
    } catch (error) {
      this.writeMessage({
        id: request.id,
        error: {
          code: error instanceof CodexAppServerRpcError ? error.code : -32000,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof CodexAppServerRpcError && error.data !== undefined
            ? { data: error.data }
            : {}),
        },
      })
    }
  }

  private failConnection(error: Error): void {
    const child = this.process
    this.process = undefined
    this.initialized = false
    this.initializePromise = undefined
    this.rejectAllPending(error)
    this.emitConnectionClosed(error)
    if (child) {
      killCliProcessTree(child as unknown as ChildProcess, 'codex-app-server')
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private emitConnectionClosed(error: Error): void {
    for (const listener of this.connectionClosedListeners) listener(error)
  }
}
