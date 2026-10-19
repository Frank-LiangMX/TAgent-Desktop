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
import { CodexSnapshotPublisher } from './codex-snapshot-publisher'
import type { CodexThreadConfig } from './codex-mcp-config'
import {
  resolveCodexRuntimeAsync,
  type CodexRuntimeResolution,
} from './codex-runtime-resolver'
import {
  assertRuntimeApiConnection,
  buildIsolatedRuntimeEnv,
  createRuntimeApiKeyRedactor,
  openDurableRuntimeHome,
  writeCodexResponsesProviderConfig,
  type RuntimeApiConnection,
} from '../shared/runtime-api-connection'
import { registerRuntimeProtocolBridgeTarget } from '../shared/protocol-bridge/runtime-protocol-bridge'
import { getAttachmentAbsolutePath } from '../../attachment-service'

export interface CodexQueryOptions extends AgentQueryInput {
  /** Official Responses API connection. Presence selects an isolated App Server. */
  apiConnection?: RuntimeApiConnection
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
  publisher: CodexSnapshotPublisher
  onServerRequest?: CodexQueryOptions['onServerRequest']
  manager: CodexAppServerSessionManager
  client: CodexAppServerClient
  official: boolean
}

export interface CodexClientLaunch {
  /** Omitted for legacy account-auth launches. */
  apiConnection?: { channelId: string; baseUrl: string; contextWindow?: number }
  codexHome?: string
  env?: NodeJS.ProcessEnv
  /** Already-redacted process stderr callback; supplied only to the client. */
  onStderr?: (text: string) => void
}

export interface CodexAppServerAdapterOptions {
  resolveRuntime?: () =>
    | CodexRuntimeResolution
    | Promise<CodexRuntimeResolution | undefined>
    | undefined
  createClient?: (
    runtime: ResolvedCodexRuntime,
    launch?: CodexClientLaunch,
  ) => CodexAppServerClient
  /** Test seam; production uses TAgent's durable config directory. */
  officialRuntimeHomeRoot?: string
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
  private readonly clientsByManager = new Map<
    CodexAppServerSessionManager,
    CodexAppServerClient
  >()
  private readonly bridgeReleasesByManager = new Map<CodexAppServerSessionManager, () => void>()

  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.options = options
  }

  async *query(input: CodexQueryOptions): AsyncIterable<SDKMessage> {
    // Do this before choosing a manager.  An API endpoint/key/model update for
    // the same TAgent session must tear down the old isolated process instead
    // of reusing a thread authenticated against the prior configuration.
    await this.closeSession(input.sessionId)
    const manager = await this.ensureManager(input)
    const queue = new AsyncPayloadQueue()
    const entry: SessionEntry = {
      queue,
      publisher: new CodexSnapshotPublisher(payload => queue.push(payload)),
      normalizer: new CodexEventNormalizer(input.model),
      onServerRequest: input.onServerRequest,
      manager,
      client: this.clientForManager(manager),
      official: Boolean(input.apiConnection),
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
        // Official Responses connections own one App Server process per TAgent
        // session.  App Server reports an interrupted turn but leaves its HTTP
        // connection alive; release that isolated process before exposing the
        // terminal result so a later explicit send can resume from the durable
        // home with a fresh connection.  Do not apply this to account-auth
        // Codex: its normal long-lived enqueue contract remains intact.
        if (entry.official && this.isInterruptedResult(next.value)) {
          await this.closeSession(input.sessionId, entry)
          yield next.value as unknown as SDKMessage
          return
        }
        yield next.value as unknown as SDKMessage
      }
    } finally {
      if (this.sessions.get(input.sessionId) === entry) {
        await this.closeSession(input.sessionId)
      }
      entry.queue.close()
      entry.publisher.dispose()
      entry.normalizer.reset()
    }
  }

  hasActiveChannel(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId)
    return Boolean(entry?.manager.getBinding(sessionId))
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
  ): Promise<void> {
    const manager = this.requireManager(sessionId)
    await manager.startTurn(sessionId, {
      prompt: this.userMessageText(message),
      imageUrls: this.userMessageImageUrls(message),
      clientUserMessageId: message.uuid,
    })
  }

  async steerMessage(
    sessionId: string,
    message: SDKUserMessageInput,
  ): Promise<void> {
    const manager = this.requireManager(sessionId)
    await manager.steerTurn(sessionId, {
      prompt: this.userMessageText(message),
      imageUrls: this.userMessageImageUrls(message),
      clientUserMessageId: message.uuid,
    })
  }

  async interruptQuery(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.manager.interruptTurn(sessionId)
  }

  abort(sessionId: string): void {
    void this.closeSession(sessionId).catch(() => undefined)
  }

  dispose(): void {
    for (const [sessionId, entry] of this.sessions) {
      this.sessions.delete(sessionId)
      entry.queue.close()
      entry.publisher.dispose()
      entry.normalizer.reset()
      entry.manager.removeSession(sessionId)
      if (entry.official) {
        // dispose() is synchronous in AgentProviderAdapter.  Close isolated
        // runtimes immediately so their SQLite handles cannot outlive the
        // caller that may remove the private durable-home root.
        entry.manager.dispose()
        this.clientsByManager.delete(entry.manager)
        entry.client.close({ force: true })
      }
    }
    this.manager?.dispose()
    this.client?.close()
    this.manager = undefined
    this.client = undefined
    this.runtimePromise = undefined
    for (const release of this.bridgeReleasesByManager.values()) release()
    this.bridgeReleasesByManager.clear()
  }

  private async ensureManager(
    input: CodexQueryOptions,
  ): Promise<CodexAppServerSessionManager> {
    if (input.apiConnection) return this.createOfficialManager(input)
    if (this.manager) return this.manager
    const runtime = await this.resolveRuntime(input.executablePath)
    const client =
      this.options.createClient?.(runtime) ??
      new CodexAppServerClient({
        executablePath: runtime.executablePath,
        cwd: input.cwd,
        onStderr: input.onStderr,
      })
    const manager = this.attachManager(client)
    await manager.initialize()
    this.client = client
    this.manager = manager
    return manager
  }

  private attachManager(
    client: CodexAppServerClient,
  ): CodexAppServerSessionManager {
    const manager = new CodexAppServerSessionManager({ client })
    this.clientsByManager.set(manager, client)
    manager.onNotification((notification) => {
      const entry = this.sessions.get(notification.tagentSessionId)
      if (!entry || entry.manager !== manager) return
      for (const payload of entry.normalizer.feed(notification)) {
        entry.publisher.publish(payload)
      }
    })
    manager.setServerRequestHandler((request) => this.handleServerRequest(request))
    client.onConnectionClosed((error) => {
      for (const entry of this.sessions.values()) {
        if (entry.manager !== manager) continue
        entry.publisher.flush()
        entry.publisher.dispose()
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
      this.clientsByManager.delete(manager)
      if (this.manager === manager) this.manager = undefined
      if (this.client === client) this.client = undefined
    })
    return manager
  }

  private clientForManager(
    manager: CodexAppServerSessionManager,
  ): CodexAppServerClient {
    const client = this.clientsByManager.get(manager)
    if (!client) throw new Error('Codex App Server client 尚未初始化')
    return client
  }

  /**
   * API channels get one App Server per TAgent session.  Codex's provider
   * configuration is process-global, so sharing a client would leak the first
   * session's key/endpoint into every subsequent session.
   */
  private async createOfficialManager(
    input: CodexQueryOptions,
  ): Promise<CodexAppServerSessionManager> {
    const connection = assertRuntimeApiConnection(input.apiConnection!)
    const model = input.model?.trim()
    if (!model) throw new Error('官方 Codex API 渠道缺少 model')
    const bridge = connection.apiProtocol && connection.apiProtocol !== 'openai-responses'
      ? await registerRuntimeProtocolBridgeTarget({
          runtime: 'codex',
          provider: connection.provider ?? connection.channelId,
          model,
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
          apiProtocol: connection.apiProtocol,
          reasoningEffort: input.effort,
          headers: connection.headers,
        })
      : undefined
    const runtimeConnection = bridge
      ? {
          ...connection,
          baseUrl: bridge.baseUrl,
          apiKey: bridge.apiKey,
          apiProtocol: 'openai-responses' as const,
        }
      : connection
    const runtime = await this.resolveRuntime(input.executablePath)
    const codexHome = openDurableRuntimeHome(
      'codex',
      input.sessionId,
      connection,
      model,
      'openai-responses',
      this.options.officialRuntimeHomeRoot,
      Boolean(input.resumeThreadId),
    ).path
    writeCodexResponsesProviderConfig(codexHome, runtimeConnection, model)
    const env = buildIsolatedRuntimeEnv(process.env, {
      CODEX_HOME: codexHome,
      CODEX_SQLITE_HOME: codexHome,
      TAGENT_CODEX_API_KEY: runtimeConnection.apiKey,
    }) as NodeJS.ProcessEnv
    const officialStderr = input.onStderr
      ? createRuntimeApiKeyRedactor(connection.apiKey, input.onStderr)
      : undefined
    const launch: CodexClientLaunch = {
      apiConnection: {
        channelId: connection.channelId,
        baseUrl: runtimeConnection.baseUrl,
        ...(runtimeConnection.contextWindow !== undefined
          ? { contextWindow: runtimeConnection.contextWindow }
          : {}),
      },
      codexHome,
      env,
      onStderr: officialStderr,
    }
    const client =
      this.options.createClient?.(runtime, launch) ??
      new CodexAppServerClient({
        executablePath: runtime.executablePath,
        cwd: input.cwd,
        env,
        // CodexAppServerClient owns the sole process stderr listener.
        onStderr: launch.onStderr,
      })
    const manager = this.attachManager(client)
    if (bridge) this.bridgeReleasesByManager.set(manager, bridge.release)
    try {
      await manager.initialize()
      return manager
    } catch (error) {
      bridge?.release()
      this.bridgeReleasesByManager.delete(manager)
      manager.dispose()
      this.clientsByManager.delete(manager)
      client.close()
      throw error
    }
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
      ? [...this.sessions.entries()].find(
          ([candidate, entry]) =>
            entry.manager.getBinding(candidate)?.threadId === threadId,
        )?.[0]
      : undefined
    const handler = sessionId
      ? this.sessions.get(sessionId)?.onServerRequest
      : undefined
    if (!handler) {
      throw new Error(`TAgent 尚未处理 Codex 服务端请求：${request.method}`)
    }
    return handler(request)
  }

  private async closeSession(
    sessionId: string,
    expectedEntry?: SessionEntry,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId)
    // A previous query's terminal notification may arrive after a replacement
    // query has installed a fresh entry for the same TAgent session.  Never let
    // that old generator tear down the replacement's isolated connection.
    if (!entry || (expectedEntry && entry !== expectedEntry)) return
    this.sessions.delete(sessionId)
    entry.queue.close()
    entry.publisher.dispose()
    entry.normalizer.reset()
    if (entry.official) {
      // App Server configuration is process-global.  Stop this isolated
      // process before allowing a replacement configuration to start.  A
      // terminal `interrupted` notification already ended its turn, so waiting
      // for another interrupt RPC only delays disconnecting the HTTP client.
      entry.manager.removeSession(sessionId)
      entry.manager.dispose()
      this.clientsByManager.delete(entry.manager)
      entry.client.close({ force: true })
      this.bridgeReleasesByManager.get(entry.manager)?.()
      this.bridgeReleasesByManager.delete(entry.manager)
      return
    }
    entry.manager.removeSession(sessionId)
  }

  private isInterruptedResult(payload: TAgentDesktopStreamPayload): boolean {
    const candidate = payload as { kind?: unknown; subtype?: unknown }
    return candidate.kind === 'result' && candidate.subtype === 'interrupted'
  }

  private requireManager(sessionId: string): CodexAppServerSessionManager {
    const manager = this.sessions.get(sessionId)?.manager
    if (!manager) throw new Error('Codex App Server 尚未初始化')
    return manager
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
      .map((attachment) => getAttachmentAbsolutePath(attachment.localPath))
  }

  private userMessageImageUrls(message: SDKUserMessageInput): string[] {
    const content = message.message.content
    if (typeof content === 'string') return []
    return content.flatMap((block) => block.type === 'image'
      ? [`data:${block.source.media_type};base64,${block.source.data}`]
      : [])
  }
}
