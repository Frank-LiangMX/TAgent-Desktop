/**
 * Codex App Server 主会话适配器。
 *
 * 一个 App Server 进程承载多个 native thread；每个 TAgent session 保持一条
 * 长生命周期事件队列，以适配现有 SessionRuntime 的 query/enqueue 契约。
 */
import type {
  AgentProviderAdapter,
  AgentQueryInput,
  SDKMessage,
  SDKUserMessageInput,
  TAgentDesktopStreamPayload,
} from '@tagent/shared'
import {
  CodexAppServerClient,
  type CodexAppServerIncomingRequest,
} from './codex-app-server-client'
import {
  CodexAppServerSessionManager,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from './codex-app-server-session-manager'
import type { CodexDynamicToolSpec } from './codex-dynamic-tools'
import { CodexEventNormalizer } from './codex-event-normalizer'
import type { CodexThreadConfig } from './codex-mcp-config'
import {
  resolveCodexRuntimeAsync,
  type CodexRuntimeResolution,
} from './codex-runtime-resolver'

export interface CodexQueryOptions extends AgentQueryInput {
  executionMode?: 'chat' | 'work'
  executablePath?: string
  resumeThreadId?: string
  approvalPolicy?: CodexApprovalPolicy
  sandbox?: CodexSandboxMode
  config?: CodexThreadConfig
  baseInstructions?: string
  developerInstructions?: string
  dynamicTools?: CodexDynamicToolSpec[]
  effort?: string
  ephemeral?: boolean
  onThreadId?: (threadId: string) => void
  onServerRequest?: (
    request: CodexAppServerIncomingRequest,
  ) => unknown | Promise<unknown>
  onStderr?: (text: string) => void
}

interface SessionEntry {
  queue: AsyncPayloadQueue
  normalizer: CodexEventNormalizer
  onServerRequest?: CodexQueryOptions['onServerRequest']
}

export interface CodexAppServerAdapterOptions {
  resolveRuntime?: () =>
    | CodexRuntimeResolution
    | Promise<CodexRuntimeResolution | undefined>
    | undefined
  createClient?: (runtime: ResolvedCodexRuntime) => CodexAppServerClient
}

type ResolvedCodexRuntime = CodexRuntimeResolution & {
  available: true
  executablePath: string
}

class AsyncPayloadQueue {
  private readonly values: TAgentDesktopStreamPayload[] = []
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<TAgentDesktopStreamPayload>) => void
  }> = []
  private closed = false

  push(value: TAgentDesktopStreamPayload): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.values.push(value)
  }

  next(): Promise<IteratorResult<TAgentDesktopStreamPayload>> {
    const value = this.values.shift()
    if (value) return Promise.resolve({ value, done: false })
    if (this.closed) {
      return Promise.resolve({
        value: undefined as unknown as TAgentDesktopStreamPayload,
        done: true,
      })
    }
    return new Promise((resolve) => this.waiters.push({ resolve }))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({
        value: undefined as unknown as TAgentDesktopStreamPayload,
        done: true,
      })
    }
    this.values.length = 0
  }
}

export class CodexAppServerAdapter implements AgentProviderAdapter {
  private readonly options: CodexAppServerAdapterOptions
  private readonly sessions = new Map<string, SessionEntry>()
  private runtimePromise: Promise<ResolvedCodexRuntime> | undefined
  private client: CodexAppServerClient | undefined
  private manager: CodexAppServerSessionManager | undefined

  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.options = options
  }

  async *query(input: CodexQueryOptions): AsyncIterable<SDKMessage> {
    const manager = await this.ensureManager(input)
    this.closeSession(input.sessionId)
    const entry: SessionEntry = {
      queue: new AsyncPayloadQueue(),
      normalizer: new CodexEventNormalizer(input.model),
      onServerRequest: input.onServerRequest,
    }
    this.sessions.set(input.sessionId, entry)

    try {
      const cwd = input.cwd ?? process.cwd()
      const thread = input.resumeThreadId
        ? await manager.resumeThread(input.sessionId, {
            threadId: input.resumeThreadId,
            cwd,
            model: input.model,
            approvalPolicy: input.approvalPolicy,
            sandbox: input.sandbox,
            config: input.config,
            baseInstructions: input.baseInstructions,
            developerInstructions: input.developerInstructions,
          })
        : await manager.startThread(input.sessionId, {
            cwd,
            model: input.model,
            approvalPolicy: input.approvalPolicy,
            sandbox: input.sandbox,
            config: input.config,
            baseInstructions: input.baseInstructions,
            developerInstructions: input.developerInstructions,
            dynamicTools: input.dynamicTools,
            ephemeral: input.ephemeral ?? false,
          })
      input.onThreadId?.(thread.id)
      await manager.startTurn(input.sessionId, {
        prompt: input.prompt,
        localImagePaths: this.localImagePaths(input),
        model: input.model,
        effort: input.effort,
        approvalPolicy: input.approvalPolicy,
      })

      while (true) {
        const next = await entry.queue.next()
        if (next.done) return
        yield next.value as unknown as SDKMessage
      }
    } finally {
      if (this.sessions.get(input.sessionId) === entry) {
        this.sessions.delete(input.sessionId)
        manager.removeSession(input.sessionId)
      }
      entry.queue.close()
      entry.normalizer.reset()
    }
  }

  hasActiveChannel(sessionId: string): boolean {
    return (
      this.sessions.has(sessionId) &&
      Boolean(this.manager?.getBinding(sessionId))
    )
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
  ): Promise<void> {
    const manager = this.requireManager()
    await manager.startTurn(sessionId, {
      prompt: this.userMessageText(message),
      clientUserMessageId: message.uuid,
    })
  }

  async steerMessage(
    sessionId: string,
    message: SDKUserMessageInput,
  ): Promise<void> {
    const manager = this.requireManager()
    await manager.steerTurn(sessionId, {
      prompt: this.userMessageText(message),
      clientUserMessageId: message.uuid,
    })
  }

  async interruptQuery(sessionId: string): Promise<void> {
    await this.manager?.interruptTurn(sessionId)
  }

  abort(sessionId: string): void {
    void this.manager?.interruptTurn(sessionId).catch(() => undefined)
    this.closeSession(sessionId)
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.closeSession(sessionId)
    }
    this.manager?.dispose()
    this.client?.close()
    this.manager = undefined
    this.client = undefined
    this.runtimePromise = undefined
  }

  private async ensureManager(
    input: CodexQueryOptions,
  ): Promise<CodexAppServerSessionManager> {
    if (this.manager) return this.manager
    const runtime = await this.resolveRuntime(input.executablePath)
    const client =
      this.options.createClient?.(runtime) ??
      new CodexAppServerClient({
        executablePath: runtime.executablePath,
        cwd: input.cwd,
        onStderr: input.onStderr,
      })
    const manager = new CodexAppServerSessionManager({ client })
    manager.onNotification((notification) => {
      const entry = this.sessions.get(notification.tagentSessionId)
      if (!entry) return
      for (const payload of entry.normalizer.feed(notification)) {
        entry.queue.push(payload)
      }
    })
    manager.setServerRequestHandler((request) =>
      this.handleServerRequest(request),
    )
    client.onConnectionClosed((error) => {
      for (const entry of this.sessions.values()) {
        entry.queue.push({
          kind: 'tagent_event',
          event: {
            type: 'session_error',
            message: error.message,
            provider: 'codex',
            recoverable: true,
          },
        })
        entry.queue.close()
      }
      manager.dispose()
      if (this.manager === manager) this.manager = undefined
      if (this.client === client) this.client = undefined
    })
    await manager.initialize()
    this.client = client
    this.manager = manager
    return manager
  }

  private async resolveRuntime(
    executablePath?: string,
  ): Promise<ResolvedCodexRuntime> {
    if (executablePath) {
      const resolution = await resolveCodexRuntimeAsync({ explicitPath: executablePath })
      if (!resolution.available || !resolution.executablePath) {
        throw new Error(`指定的 Codex Runtime 不可用：${executablePath}`)
      }
      return resolution as ResolvedCodexRuntime
    }
    if (!this.runtimePromise) {
      this.runtimePromise = Promise.resolve(
        this.options.resolveRuntime?.() ?? resolveCodexRuntimeAsync(),
      ).then((runtime) => {
        if (!runtime?.available || !runtime.executablePath) {
          throw new Error(
            '未找到支持 App Server 的 Codex Runtime，请安装 Codex CLI 或配置 TAGENT_CODEX_PATH',
          )
        }
        return runtime as ResolvedCodexRuntime
      })
    }
    return this.runtimePromise
  }

  private handleServerRequest(
    request: CodexAppServerIncomingRequest,
  ): unknown | Promise<unknown> {
    const params =
      request.params &&
      typeof request.params === 'object' &&
      !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : undefined
    const threadId =
      typeof params?.threadId === 'string' ? params.threadId : undefined
    const sessionId = threadId
      ? [...this.sessions.keys()].find(
          (candidate) =>
            this.manager?.getBinding(candidate)?.threadId === threadId,
        )
      : undefined
    const handler = sessionId
      ? this.sessions.get(sessionId)?.onServerRequest
      : undefined
    if (!handler) {
      throw new Error(`TAgent 尚未处理 Codex 服务端请求：${request.method}`)
    }
    return handler(request)
  }

  private closeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.sessions.delete(sessionId)
    entry.queue.close()
    entry.normalizer.reset()
    this.manager?.removeSession(sessionId)
  }

  private requireManager(): CodexAppServerSessionManager {
    if (!this.manager) throw new Error('Codex App Server 尚未初始化')
    return this.manager
  }

  private userMessageText(message: SDKUserMessageInput): string {
    const content = message.message.content
    if (typeof content === 'string') return content
    return content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n')
      .trim()
  }

  private localImagePaths(input: CodexQueryOptions): string[] {
    return (input.attachments ?? [])
      .filter((attachment) => attachment.mediaType.startsWith('image/'))
      .map((attachment) => attachment.localPath)
  }
}
