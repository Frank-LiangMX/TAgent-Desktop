/**
 * 会话服务：管理 SessionRuntime 集合 + 注册 IPC handler
 *
 * 2.0 长驻改造核心。见 docs/plans/2026-07-25-longlived-event-loop-rewrite-design.md。
 * 职责：
 * - 创建/销毁 SessionRuntime（一个会话一个，绑进程）
 * - 注册 IPC handler（SEND_MESSAGE/STOP_TURN/DELETE_SESSION）
 * - 流式消息推给渲染进程（STREAM_MESSAGE/TURN_END/SESSION_ERROR）
 * - 按 channelId 选核（kscc-internal→kscc 核，其余→Pi 核）+ 会话绑核（互斥）
 *
 * 会话绑定：首条消息锁定运行内核（KSCC / 外部）；同内核内渠道和模型可继续切换。
 */
import { ipcMain, type BrowserWindow } from 'electron'
import type {
  AgentProviderAdapter,
  SDKMessage,
  SDKUserMessageInput,
  TAgentDesktopStreamPayload,
  Channel,
} from '@tagent/shared'
import { AGENT_IPC_CHANNELS } from '@tagent/shared'
import { SessionRuntime } from '../agent/runtime/session-runtime'
import { getAdapter, type ChannelKind } from '../adapters'
import { resolveKsccPath } from '../adapters/claude/kscc-path'
import { sdkMessageToIR } from '@tagent/shared'
import type { KsccQueryOptions } from '../adapters/claude/claude-agent-adapter'
import {
  getSessionMeta,
  updateSessionMeta,
  appendMessages,
  createSession,
  listSessions,
  readMessages,
  deleteSession as deleteSessionMeta,
  deleteSessionsByWorkspace,
} from '../agent/session-store'
import { getChannel, getDecryptedApiKey, getKsccChannelId } from '../channel/channel-store'
import { KSCC_DEFAULT_MODEL_ID } from '../channel/default-models'
import { resolveWorkspaceForSession } from '../workspace/workspace-manager'
import { getEnabledMcpServers } from '../mcp/mcp-store'
import { PermissionService } from '../permission/permission-service'
import { buildBuiltinSubagentDefinitions, buildSubagentDelegationPrompt } from '../agent/subagent-definitions'
import type { TAgentPermissionMode } from '@tagent/shared'
import { TAGENT_DEFAULT_PERMISSION_MODE, migratePermissionMode } from '@tagent/shared'

interface SendMessageInput {
  sessionId: string
  prompt: string
  /** 渠道 ID（决定选哪个 adapter + 绑核）。不传默认 kscc-internal */
  channelId?: string
  /** 模型 ID */
  model?: string
  /** 工作区 ID（= sanitizePath(projectPath)，用于 JSONL 按项目存储） */
  workspaceId?: string
}

export class SessionService {
  private runtimes = new Map<string, SessionRuntime>()
  private constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly permissionService: PermissionService | null,
  ) {}

  static create(
    getWindow: () => BrowserWindow | null,
    permissionService: PermissionService | null = null,
  ): SessionService {
    const svc = new SessionService(getWindow, permissionService)
    svc.registerIpc()
    return svc
  }

  /** 注册 IPC handler */
  private registerIpc(): void {
    ipcMain.handle(AGENT_IPC_CHANNELS.SEND_MESSAGE, async (_e, input: SendMessageInput) => {
      try {
        await this.handleSend(input)
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.sendPayload(input.sessionId, { kind: 'tagent_event', event: { type: 'session_error', message: msg } })
        return { ok: false, error: msg }
      }
    })

    ipcMain.handle(AGENT_IPC_CHANNELS.STOP_AGENT, async (_e, sessionId: string) => {
      const rt = this.runtimes.get(sessionId)
      if (rt) await rt.interrupt()
      return { ok: true }
    })

    // 热切换会话权限模式：持久化 meta → 通知 runtime（kscc 走 SDK setPermissionMode；Pi 靠闭包读 meta）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE,
      async (_e, args: { sessionId: string; mode: TAgentPermissionMode }): Promise<{ ok: boolean; error?: string }> => {
        const normalized = migratePermissionMode(args.mode)
        updateSessionMeta(args.sessionId, { permissionMode: normalized })
        const rt = this.runtimes.get(args.sessionId)
        if (rt) {
          try {
            await rt.setPermissionMode(normalized)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[会话 ${args.sessionId}] setPermissionMode 失败:`, msg)
            return { ok: false, error: msg }
          }
        }
        return { ok: true }
      }
    )

    ipcMain.handle(AGENT_IPC_CHANNELS.LIST_SESSIONS, async () => {
      const sessions = listSessions()
      console.log(`[会话] listSessions 返回 ${sessions.length} 个会话，isArray=${Array.isArray(sessions)}`)
      return sessions
    })

    ipcMain.handle(AGENT_IPC_CHANNELS.GET_SDK_MESSAGES, async (_e, sessionId: string) => {
      // 从 session meta 查 workspaceId，兼容旧数据（无 workspaceId 传 undefined）
      const meta = getSessionMeta(sessionId)
      return readMessages(meta?.workspaceId, sessionId)
    })

    ipcMain.handle(AGENT_IPC_CHANNELS.DELETE_SESSION, async (_e, sessionId: string) => {
      const rt = this.runtimes.get(sessionId)
      if (rt) {
        rt.destroy()
        this.runtimes.delete(sessionId)
      }
      deleteSessionMeta(sessionId)
      return { ok: true }
    })

    // 更新会话元数据（重命名 title / 置顶 pinned / 归档 archived 等；status 仅主进程内部写 error/idle）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_SESSION_META,
      async (
        _e,
        args: { id: string; patch: { title?: string; pinned?: boolean; archived?: boolean } }
      ) => {
        return updateSessionMeta(args.id, args.patch)
      }
    )

    // 置顶切换
    ipcMain.handle(AGENT_IPC_CHANNELS.TOGGLE_PIN, async (_e, id: string) => {
      const meta = getSessionMeta(id)
      return updateSessionMeta(id, { pinned: !meta?.pinned })
    })

    // 归档切换
    ipcMain.handle(AGENT_IPC_CHANNELS.TOGGLE_ARCHIVE, async (_e, id: string) => {
      const meta = getSessionMeta(id)
      return updateSessionMeta(id, { archived: !meta?.archived })
    })

    // 查会话生命状态（runtimes 内存 turnInFlight 优先 → meta.error → idle；archived 一并返回）
    ipcMain.handle(AGENT_IPC_CHANNELS.GET_SESSION_STATUS, async (_e, id: string) => {
      return this.getStatus(id)
    })
  }

  /**
   * 组合会话生命状态（侧栏状态色点用）。
   * - runtimes 内存 turnInFlight → 'running'（不落盘，重启即失）
   * - meta.status === 'error' → 'error'（落盘，重启保留）
   * - 其余 → 'idle'
   * 用 isTurnInFlight() 而非 isRunning()：长驻进程 isRunning 恒 true，不表达"当前轮在跑"。
   */
  private getStatus(id: string): { status: 'idle' | 'running' | 'error'; archived: boolean } {
    const meta = getSessionMeta(id)
    const rt = this.runtimes.get(id)
    if (rt && rt.isTurnInFlight()) return { status: 'running', archived: !!meta?.archived }
    if (meta?.status === 'error') return { status: 'error', archived: !!meta?.archived }
    return { status: 'idle', archived: !!meta?.archived }
  }

  /** 处理发消息：解析渠道→锁定运行内核→首次 spawn / 后续同内核切换模型 */
  private async handleSend(input: SendMessageInput): Promise<void> {
    const channelId = input.channelId ?? getKsccChannelId()
    if (!channelId) {
      throw new Error('未选择渠道，且未找到 kscc 内置渠道（请在渠道管理中添加）')
    }
    const channel = getChannel(channelId)
    if (!channel) {
      throw new Error(`渠道不存在：${channelId}（请在渠道管理中添加）`)
    }
    if (!channel.enabled) {
      throw new Error(`渠道「${channel.name}」已禁用，请先启用`)
    }

    const meta = getSessionMeta(input.sessionId)
    const adapterKind: ChannelKind = channel.provider === 'kscc-internal' ? 'kscc' : 'external'

    // 会话只锁定运行内核：KSCC 内网与外部运行时不可互切；
    // 同一内核里的渠道和模型都允许在后续轮次继续选择。
    if (meta?.channelId) {
      const boundChannel = getChannel(meta.channelId)
      if (!boundChannel) {
        throw new Error('该会话原绑定渠道已不存在，无法确认运行内核')
      }
      const boundKind: ChannelKind = boundChannel.provider === 'kscc-internal' ? 'kscc' : 'external'
      if (boundKind !== adapterKind) {
        throw new Error(
          `该会话已锁定${boundKind === 'kscc' ? 'KSCC 内网' : '外部'}运行时，不能跨运行内核切换`,
        )
      }
    }
    const modelId = this.resolveModel(
      channel,
      input.model ?? (meta?.channelId === channelId ? meta.modelId : undefined),
    )
    const normalizedInput: SendMessageInput = { ...input, channelId, model: modelId }

    // 解析 workspaceId：优先用 input 传入，否则从已有 meta 读
    const workspaceId = input.workspaceId ?? meta?.workspaceId

    const adapter = getAdapter(adapterKind)
    let rt = this.runtimes.get(input.sessionId)
    const isFirst = !rt || !rt.hasLiveProcess()

    console.log(`[会话 ${input.sessionId}] ${isFirst ? '首次：spawn + 起循环' : '后续：复用长驻进程 enqueue'}（渠道=${channel.name} 核=${adapterKind} workspaceId=${workspaceId ?? '(无)'}）`)

    // KSCC 是真正的长驻 Query，同内核切模型时先调用 SDK 热切接口。
    if (!isFirst && adapterKind === 'kscc' && meta?.modelId !== modelId) {
      await rt!.setModel(modelId)
      console.log(`[会话 ${input.sessionId}] KSCC 热切模型：${meta?.modelId ?? '(未记录)'} → ${modelId}`)
    }

    // 持久化用户消息到 JSONL（SDK 不回显 user 消息，不存则切回来看不到用户气泡）
    const userMsg: SDKMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: input.prompt }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    appendMessages(workspaceId, input.sessionId, [userMsg])
    // 也推给渲染层（用户消息即时显示；首次时渲染层乐观加了，但重复不影响）
    const { message: userIR } = sdkMessageToIR(userMsg)
    if (userIR) {
      this.sendPayload(input.sessionId, { kind: 'sdk_message', message: userIR })
    }

    if (isFirst) {
      // 首条或进程重建：记录本轮真实使用的渠道和模型。
      if (!meta) {
        createSession({
          id: input.sessionId,
          title: input.prompt.slice(0, 20) || '新会话',
          channelId,
          modelId,
          workspaceId,
          turnCount: 1,
        })
        console.log(`[会话 ${input.sessionId}] 已创建会话元数据，运行内核=${adapterKind}，workspaceId=${workspaceId ?? '(无)'}`)
      } else {
        updateSessionMeta(input.sessionId, {
          channelId,
          modelId,
          workspaceId,
          turnCount: (meta.turnCount ?? 0) + 1,
        })
      }
      // 建 SessionRuntime + 起循环
      rt = new SessionRuntime(input.sessionId, adapter)
      this.runtimes.set(input.sessionId, rt)
      rt.setCallbacks({
        onMessage: (msg: SDKMessage) => this.handleStreamMessage(input.sessionId, workspaceId, msg),
        onTurnEnd: () => {
          // 轮成功结束 → 清除可能的 error，落盘 idle（重启后仍为干净态）
          updateSessionMeta(input.sessionId, { status: 'idle' })
          this.sendPayload(input.sessionId, { kind: 'tagent_event', event: { type: 'turn_end' } })
        },
        onError: (err: Error) => {
          // 出错 → 落盘 error（重启保留，下轮成功回 idle）
          updateSessionMeta(input.sessionId, { status: 'error' })
          this.sendPayload(input.sessionId, { kind: 'tagent_event', event: { type: 'session_error', message: err.message } })
        },
      })

      await rt.sendMessage(this.buildQueryOptions(normalizedInput, channel, workspaceId))
    } else {
      updateSessionMeta(input.sessionId, {
        channelId,
        modelId,
        turnCount: (meta?.turnCount ?? 0) + 1,
      })
      // 后续：enqueue
      const userMessage: SDKUserMessageInput = {
        type: 'user',
        message: { role: 'user', content: input.prompt },
        parent_tool_use_id: null,
      } as unknown as SDKUserMessageInput
      await rt!.sendMessage(this.buildQueryOptions(normalizedInput, channel, workspaceId), userMessage)
    }
  }

  /** 解析模型 ID：input > 渠道默认 > 第一个启用模型 > kscc 兜底 */
  private resolveModel(channel: Channel, inputModel?: string): string {
    const modelId = inputModel
      ?? channel.defaultModelId
      ?? channel.models.find((model) => model.enabled)?.id
      ?? (channel.provider === 'kscc-internal' ? KSCC_DEFAULT_MODEL_ID : '')
    const configured = channel.models.find((model) => model.id === modelId)
    if (!configured) {
      throw new Error(`模型「${modelId}」不属于渠道「${channel.name}」`)
    }
    if (!configured.enabled) {
      throw new Error(`模型「${configured.name}」已停用，请选择同一运行区域内的可用模型`)
    }
    return modelId
  }

  /** 构建 query 选项（按渠道 provider 选核） */
  private buildQueryOptions(
    input: SendMessageInput,
    channel: Channel,
    workspaceId?: string
  ): Parameters<AgentProviderAdapter['query']>[0] {
    const model = this.resolveModel(channel, input.model)

    // 解析 workspace：cwd + sanitizedPath（mcp 配置文件 slug）
    const workspace = workspaceId ? resolveWorkspaceForSession(input.sessionId) : undefined
    const cwd = workspace?.projectDirectory ?? process.cwd()
    const sanitizedPath = workspace?.slug ?? ''

    // 权限模式：会话 meta 持久化（默认 auto）
    const metaForMode = getSessionMeta(input.sessionId)
    const permissionMode: TAgentPermissionMode = metaForMode?.permissionMode
      ? migratePermissionMode(metaForMode.permissionMode)
      : TAGENT_DEFAULT_PERMISSION_MODE

    // 工作区 MCP 配置（无 workspace → 空，pi-core buildMcpTools 自动跳过）
    const enabledMcpServers = sanitizedPath ? getEnabledMcpServers(sanitizedPath) : {}
    const mcpConfig = { servers: enabledMcpServers }

    if (channel.provider === 'kscc-internal') {
      const ksccPath = resolveKsccPath()
      if (!ksccPath) {
        throw new Error('未检测到 kscc 命令，请先安装 kscc（内网渠道）')
      }
      const meta = getSessionMeta(input.sessionId)
      // KsccQueryOptions：canUseTool/mcpServers/permissionMode/allowDangerouslySkipPermissions
      // canUseTool 透传 PermissionService.createCanUseTool（permissionMode 非硬编码）
      const canUseTool = this.permissionService
        ? this.permissionService.createCanUseTool(input.sessionId, () => this.getPermissionMode(input.sessionId), cwd)
        : undefined
      const opts: KsccQueryOptions = {
        sessionId: input.sessionId,
        prompt: input.prompt,
        model,
        cwd,
        sdkCliPath: ksccPath,
        env: { ...process.env } as Record<string, string | undefined>,
        maxTurns: 50,
        sdkPermissionMode: 'bypassPermissions',
        // 非 hardcoded：有 canUseTool 时跳过内置检查，全交给我们的服务
        allowDangerouslySkipPermissions: !canUseTool,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: buildSubagentDelegationPrompt('conservative'),
        },
        persistSession: true,
        // 工作区 MCP 配置
        mcpServers: Object.keys(enabledMcpServers).length > 0 ? (enabledMcpServers as Record<string, unknown>) : undefined,
        // 子代理定义（主 Agent 可调用 Agent/Task 工具派发子任务）
        // kscc 核始终是 Claude 渠道，子代理用 haiku
        agents: buildBuiltinSubagentDefinitions(true),
        // 权限钩子（bypass 模式不挂）
        ...(canUseTool ? { canUseTool } : {}),
        // 长驻首次 spawn 带 resume 续历史（SDK 读 JSONL 一次），之后靠内存
        resumeSessionId: meta?.sdkSessionId,
        onSessionId: (sdkSessionId: string) => {
          if (sdkSessionId && sdkSessionId !== meta?.sdkSessionId) {
            updateSessionMeta(input.sessionId, { sdkSessionId })
            console.log(`[会话 ${input.sessionId}] 已保存 sdkSessionId: ${sdkSessionId}`)
          }
        },
        onStderr: (data: string) => console.error(`[kscc stderr] ${data}`),
      }
      // 当前会话的权限模式（透传到 caller 决策；不影响 SDK 内部）
      void permissionMode
      return opts as unknown as Parameters<AgentProviderAdapter['query']>[0]
    }

    // 外部渠道：Pi 核，构造 PiQueryOptions
    // PiAgentAdapter.query() 解构 channelConfig（嵌套对象），不是扁平字段。
    // 对应 PiExternalChannelConfig：type/provider/apiKey/baseUrl/modelId/thinking*
    const apiKey = getDecryptedApiKey(channel.id)
    if (!apiKey) {
      // apiKey 解密失败（Windows DPAPI 跨实例不可互通）或未设置 → 早点报错，别让空 key 打到 HTTP
      throw new Error(
        `渠道「${channel.name}」的 apiKey 未设置或解密失败，请在「渠道管理」中重新输入 apiKey`,
      )
    }
    // beforeToolCall：pi-agent-core 签名，包 PermissionService.createBeforeToolCall
    const beforeToolCall = this.permissionService
      ? this.permissionService.createBeforeToolCall(input.sessionId, () => this.getPermissionMode(input.sessionId), cwd)
      : undefined
    const opts = {
      sessionId: input.sessionId,
      prompt: input.prompt,
      model,
      cwd,
      // MCP 配置（无 server 时 pi-core 跳过）
      mcpConfig,
      // 权限钩子（bypass 模式不挂）
      ...(beforeToolCall ? { beforeToolCall } : {}),
      // Pi 核专属：渠道凭证 + provider，pi-ai streamFn 用
      channelConfig: {
        type: 'external' as const,
        provider: channel.provider,
        apiKey,
        baseUrl: channel.baseUrl,
        modelId: model,
        // thinking 控制：默认关闭，后续可加 UI toggle
        thinkingEnabled: false,
        thinkingLevel: 'medium' as const,
      },
    }
    void permissionMode
    return opts as unknown as Parameters<AgentProviderAdapter['query']>[0]
  }

  /** 读会话当前权限模式（permissionMode getter，供 PermissionService 闭包调用，实现运行中切换） */
  private getPermissionMode(sessionId: string): TAgentPermissionMode {
    const meta = getSessionMeta(sessionId)
    return meta?.permissionMode
      ? migratePermissionMode(meta.permissionMode)
      : TAGENT_DEFAULT_PERMISSION_MODE
  }

  /** 转译 SDKMessage → IR，发 TAgentDesktopStreamPayload 给 renderer，并持久化 */
  private handleStreamMessage(sessionId: string, workspaceId: string | undefined, msg: SDKMessage): void {
    const { message, event } = sdkMessageToIR(msg)
    if (message) {
      // 持久化完整消息到 JSONL（流式 delta 不持久化，完整 assistant/user 才存）
      appendMessages(workspaceId, sessionId, [msg])
      this.sendPayload(sessionId, { kind: 'sdk_message', message })
    }
    if (event) {
      this.sendPayload(sessionId, event)
    }
  }

  /** 发流式事件给 renderer */
  private sendPayload(sessionId: string, payload: TAgentDesktopStreamPayload): void {
    const win = this.getWindow()
    win?.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload })
  }

  /** 停止并删除指定工作区的全部会话，供工作区删除流程复用。 */
  deleteWorkspaceSessions(workspaceId: string): number {
    const sessionIds = listSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.id)

    for (const sessionId of sessionIds) {
      const runtime = this.runtimes.get(sessionId)
      if (runtime) {
        runtime.destroy()
        this.runtimes.delete(sessionId)
      }
    }

    return deleteSessionsByWorkspace(workspaceId).length
  }

  /** 销毁所有会话（应用退出） */
  disposeAll(): void {
    for (const rt of this.runtimes.values()) rt.destroy()
    this.runtimes.clear()
  }
}
