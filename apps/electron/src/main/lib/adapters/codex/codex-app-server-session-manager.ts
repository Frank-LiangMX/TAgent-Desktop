/**
 * TAgent 会话到 Codex App Server thread/turn 的生命周期映射。
 *
 * 一个 App Server 进程可承载多个 Codex thread；本 manager 维护：
 * TAgent sessionId <-> Codex threadId <-> 当前 turnId。
 *
 * 此层不把 Codex 通知翻译成 TAgentMessage，只提供稳定路由和原生生命周期，
 * 后续 CodexAppServerAdapter 在其上完成事件 IR、权限审批和 SessionRuntime 接线。
 */
import type {
  CodexAppServerIncomingRequest,
  CodexAppServerInitializeResponse,
  CodexAppServerNotification,
} from './codex-app-server-client'
import type { CodexDynamicToolSpec } from './codex-dynamic-tools'
import type { CodexThreadConfig } from './codex-mcp-config'

export type CodexApprovalPolicy =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      granular: {
        sandbox_approval: boolean
        rules: boolean
        skill_approval: boolean
        request_permissions: boolean
        mcp_elicitations: boolean
      }
    }

export type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'

export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

export type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean }

export interface CodexAccountStatus {
  account: CodexAccount | null
  requiresOpenaiAuth: boolean
}

export interface CodexThread {
  id: string
  sessionId: string
  ephemeral: boolean
  status: unknown
  cwd: string
  preview?: string
  turns?: CodexTurn[]
  [key: string]: unknown
}

export interface CodexTurn {
  id: string
  status: unknown
  error?: unknown
  startedAt?: number | null
  completedAt?: number | null
  durationMs?: number | null
  [key: string]: unknown
}

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string; detail?: string }
  | { type: 'image'; url: string; detail?: string }

export interface CodexThreadStartOptions {
  cwd: string
  model?: string
  approvalPolicy?: CodexApprovalPolicy
  sandbox?: CodexSandboxMode
  config?: CodexThreadConfig
  baseInstructions?: string
  developerInstructions?: string
  dynamicTools?: CodexDynamicToolSpec[]
  ephemeral?: boolean
}

export interface CodexThreadResumeOptions {
  threadId: string
  cwd?: string
  model?: string
  approvalPolicy?: CodexApprovalPolicy
  sandbox?: CodexSandboxMode
  config?: CodexThreadConfig
  baseInstructions?: string
  developerInstructions?: string
}

export interface CodexTurnStartOptions {
  prompt: string
  clientUserMessageId?: string
  localImagePaths?: string[]
  cwd?: string
  model?: string
  effort?: string
  approvalPolicy?: CodexApprovalPolicy
  sandboxPolicy?: CodexSandboxPolicy
}

export interface CodexTurnSteerOptions {
  prompt: string
  clientUserMessageId?: string
  localImagePaths?: string[]
}

export interface CodexSessionBinding {
  tagentSessionId: string
  threadId: string
  activeTurnId?: string
}

export interface RoutedCodexNotification extends CodexAppServerNotification {
  tagentSessionId: string
  threadId: string
}

export interface CodexAppServerClientLike {
  initialize(): Promise<CodexAppServerInitializeResponse>
  request<T>(method: string, params?: unknown): Promise<T>
  onNotification(
    listener: (notification: CodexAppServerNotification) => void,
  ): () => void
  setServerRequestHandler(
    handler:
      | ((
          request: CodexAppServerIncomingRequest,
        ) => unknown | Promise<unknown>)
      | undefined,
  ): void
}

export interface CodexAppServerSessionManagerOptions {
  client: CodexAppServerClientLike
  onThreadBindingChanged?: (tagentSessionId: string, threadId: string) => void
}

type RoutedNotificationListener = (
  notification: RoutedCodexNotification,
) => void

interface ThreadResponse {
  thread: CodexThread
}

interface TurnResponse {
  turn: CodexTurn
}

export class CodexAppServerSessionManager {
  private readonly client: CodexAppServerClientLike
  private readonly onThreadBindingChanged: (
    tagentSessionId: string,
    threadId: string,
  ) => void
  private readonly bindingsBySession = new Map<string, CodexSessionBinding>()
  private readonly sessionIdByThread = new Map<string, string>()
  private readonly notificationListeners = new Set<RoutedNotificationListener>()
  private readonly unsubscribeNotification: () => void

  constructor(options: CodexAppServerSessionManagerOptions) {
    this.client = options.client
    this.onThreadBindingChanged =
      options.onThreadBindingChanged ?? (() => undefined)
    this.unsubscribeNotification = this.client.onNotification((notification) =>
      this.handleNotification(notification),
    )
  }

  initialize(): Promise<CodexAppServerInitializeResponse> {
    return this.client.initialize()
  }

  async readAccount(refreshToken = false): Promise<CodexAccountStatus> {
    await this.initialize()
    return this.client.request<CodexAccountStatus>('account/read', {
      refreshToken,
    })
  }

  async startThread(
    tagentSessionId: string,
    options: CodexThreadStartOptions,
  ): Promise<CodexThread> {
    this.assertSessionId(tagentSessionId)
    await this.initialize()
    const response = await this.client.request<ThreadResponse>('thread/start', {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.approvalPolicy
        ? { approvalPolicy: options.approvalPolicy }
        : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.baseInstructions
        ? { baseInstructions: options.baseInstructions }
        : {}),
      ...(options.developerInstructions
        ? { developerInstructions: options.developerInstructions }
        : {}),
      ...(options.dynamicTools ? { dynamicTools: options.dynamicTools } : {}),
      ephemeral: options.ephemeral ?? false,
    })
    this.bindThread(tagentSessionId, response.thread.id)
    return response.thread
  }

  async resumeThread(
    tagentSessionId: string,
    options: CodexThreadResumeOptions,
  ): Promise<CodexThread> {
    this.assertSessionId(tagentSessionId)
    const threadId = options.threadId?.trim()
    if (!threadId) throw new Error('Codex threadId 不能为空')
    await this.initialize()

    // resume 期间服务端可能先推 live 通知；先建立临时路由，失败再恢复旧绑定。
    const previous = this.bindingsBySession.get(tagentSessionId)
    this.bindThread(tagentSessionId, threadId, false)
    try {
      const response = await this.client.request<ThreadResponse>(
        'thread/resume',
        {
          threadId,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.approvalPolicy
            ? { approvalPolicy: options.approvalPolicy }
            : {}),
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
          ...(options.config ? { config: options.config } : {}),
          ...(options.baseInstructions
            ? { baseInstructions: options.baseInstructions }
            : {}),
          ...(options.developerInstructions
            ? { developerInstructions: options.developerInstructions }
            : {}),
          excludeTurns: true,
        },
      )
      this.bindThread(tagentSessionId, response.thread.id)
      return response.thread
    } catch (error) {
      this.unbindSession(tagentSessionId)
      if (previous) {
        this.bindThread(
          previous.tagentSessionId,
          previous.threadId,
          false,
          previous.activeTurnId,
        )
      }
      throw error
    }
  }

  async startTurn(
    tagentSessionId: string,
    options: CodexTurnStartOptions,
  ): Promise<CodexTurn> {
    const binding = this.requireBinding(tagentSessionId)
    const prompt = options.prompt?.trim()
    if (!prompt) throw new Error('Codex turn prompt 不能为空')
    await this.initialize()
    const input: CodexUserInput[] = [
      { type: 'text', text: prompt, text_elements: [] },
      ...(options.localImagePaths ?? [])
        .map((path) => path.trim())
        .filter(Boolean)
        .map((path): CodexUserInput => ({ type: 'localImage', path })),
    ]
    const response = await this.client.request<TurnResponse>('turn/start', {
      threadId: binding.threadId,
      input,
      ...(options.clientUserMessageId
        ? { clientUserMessageId: options.clientUserMessageId }
        : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.approvalPolicy
        ? { approvalPolicy: options.approvalPolicy }
        : {}),
      ...(options.sandboxPolicy
        ? { sandboxPolicy: options.sandboxPolicy }
        : {}),
    })
    binding.activeTurnId = response.turn.id
    return response.turn
  }

  async interruptTurn(tagentSessionId: string): Promise<boolean> {
    const binding = this.bindingsBySession.get(tagentSessionId)
    if (!binding?.activeTurnId) return false
    const turnId = binding.activeTurnId
    await this.client.request<Record<string, never>>('turn/interrupt', {
      threadId: binding.threadId,
      turnId,
    })
    if (binding.activeTurnId === turnId) binding.activeTurnId = undefined
    return true
  }

  async steerTurn(
    tagentSessionId: string,
    options: CodexTurnSteerOptions,
  ): Promise<string> {
    const binding = this.requireBinding(tagentSessionId)
    if (!binding.activeTurnId) {
      throw new Error(`[codex] 当前没有可引导的 active turn: ${tagentSessionId}`)
    }
    const prompt = options.prompt?.trim()
    if (!prompt) throw new Error('Codex steer prompt 不能为空')
    const input: CodexUserInput[] = [
      { type: 'text', text: prompt, text_elements: [] },
      ...(options.localImagePaths ?? [])
        .map((path) => path.trim())
        .filter(Boolean)
        .map((path): CodexUserInput => ({ type: 'localImage', path })),
    ]
    const response = await this.client.request<{ turnId: string }>(
      'turn/steer',
      {
        threadId: binding.threadId,
        input,
        ...(options.clientUserMessageId
          ? { clientUserMessageId: options.clientUserMessageId }
          : {}),
      },
    )
    return response.turnId
  }

  restoreBinding(tagentSessionId: string, threadId: string): void {
    this.assertSessionId(tagentSessionId)
    if (!threadId?.trim()) throw new Error('Codex threadId 不能为空')
    this.bindThread(tagentSessionId, threadId.trim(), false)
  }

  removeSession(tagentSessionId: string): void {
    this.unbindSession(tagentSessionId)
  }

  getBinding(tagentSessionId: string): CodexSessionBinding | undefined {
    const binding = this.bindingsBySession.get(tagentSessionId)
    return binding ? { ...binding } : undefined
  }

  onNotification(listener: RoutedNotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  setServerRequestHandler(
    handler:
      | ((
          request: CodexAppServerIncomingRequest,
        ) => unknown | Promise<unknown>)
      | undefined,
  ): void {
    this.client.setServerRequestHandler(handler)
  }

  dispose(): void {
    this.unsubscribeNotification()
    this.notificationListeners.clear()
    this.bindingsBySession.clear()
    this.sessionIdByThread.clear()
    this.client.setServerRequestHandler(undefined)
  }

  private bindThread(
    tagentSessionId: string,
    threadId: string,
    notify = true,
    activeTurnId?: string,
  ): void {
    const previous = this.bindingsBySession.get(tagentSessionId)
    if (previous && previous.threadId !== threadId) {
      this.sessionIdByThread.delete(previous.threadId)
    }
    const existingSession = this.sessionIdByThread.get(threadId)
    if (existingSession && existingSession !== tagentSessionId) {
      this.bindingsBySession.delete(existingSession)
    }
    const binding: CodexSessionBinding = {
      tagentSessionId,
      threadId,
      ...(activeTurnId ? { activeTurnId } : {}),
    }
    this.bindingsBySession.set(tagentSessionId, binding)
    this.sessionIdByThread.set(threadId, tagentSessionId)
    if (notify) this.onThreadBindingChanged(tagentSessionId, threadId)
  }

  private unbindSession(tagentSessionId: string): void {
    const binding = this.bindingsBySession.get(tagentSessionId)
    if (!binding) return
    this.bindingsBySession.delete(tagentSessionId)
    if (this.sessionIdByThread.get(binding.threadId) === tagentSessionId) {
      this.sessionIdByThread.delete(binding.threadId)
    }
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    const params =
      notification.params && typeof notification.params === 'object'
        ? (notification.params as Record<string, unknown>)
        : undefined
    const threadId =
      typeof params?.threadId === 'string'
        ? params.threadId
        : this.threadIdFromThreadPayload(params?.thread)
    if (!threadId) return
    const tagentSessionId = this.sessionIdByThread.get(threadId)
    if (!tagentSessionId) return
    const binding = this.bindingsBySession.get(tagentSessionId)
    if (!binding) return

    if (notification.method === 'turn/started') {
      const turnId = this.turnIdFromPayload(params?.turn)
      if (turnId) binding.activeTurnId = turnId
    } else if (notification.method === 'turn/completed') {
      const turnId = this.turnIdFromPayload(params?.turn)
      if (!turnId || binding.activeTurnId === turnId) {
        binding.activeTurnId = undefined
      }
    }

    const routed: RoutedCodexNotification = {
      ...notification,
      tagentSessionId,
      threadId,
    }
    for (const listener of this.notificationListeners) listener(routed)
  }

  private threadIdFromThreadPayload(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined
    const id = (value as { id?: unknown }).id
    return typeof id === 'string' && id ? id : undefined
  }

  private turnIdFromPayload(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined
    const id = (value as { id?: unknown }).id
    return typeof id === 'string' && id ? id : undefined
  }

  private requireBinding(tagentSessionId: string): CodexSessionBinding {
    const binding = this.bindingsBySession.get(tagentSessionId)
    if (!binding) {
      throw new Error(`[codex] TAgent 会话尚未绑定 Codex thread: ${tagentSessionId}`)
    }
    return binding
  }

  private assertSessionId(tagentSessionId: string): void {
    if (!tagentSessionId?.trim()) throw new Error('TAgent sessionId 不能为空')
  }
}
