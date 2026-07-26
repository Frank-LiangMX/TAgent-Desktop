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
 * 会话绑核：首条消息绑定 channelId 到 meta，之后不能换渠道（kscc↔external 互斥）。
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
} from '../agent/session-store'
import { getChannel, getDecryptedApiKey, getKsccChannelId } from '../channel/channel-store'
import { KSCC_DEFAULT_MODEL_ID } from '../channel/default-models'
import { resolveWorkspaceForSession } from '../workspace/workspace-manager'

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
  private constructor(private readonly getWindow: () => BrowserWindow | null) {}

  static create(getWindow: () => BrowserWindow | null): SessionService {
    const svc = new SessionService(getWindow)
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

    // 更新会话元数据（重命名 title / 置顶 pinned 等）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_SESSION_META,
      async (_e, args: { id: string; patch: { title?: string; pinned?: boolean } }) => {
        return updateSessionMeta(args.id, args.patch)
      }
    )

    // 置顶切换
    ipcMain.handle(AGENT_IPC_CHANNELS.TOGGLE_PIN, async (_e, id: string) => {
      const meta = getSessionMeta(id)
      return updateSessionMeta(id, { pinned: !meta?.pinned })
    })
  }

  /** 处理发消息：解析渠道→绑核→首次 spawn + 起循环 / 后续 enqueue */
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

    // 绑核：会话已绑定不同渠道则拒绝（kscc↔external 互斥，核内可换模型）
    const meta = getSessionMeta(input.sessionId)
    if (meta?.channelId && meta.channelId !== channelId) {
      throw new Error('该会话已绑定其他渠道，不能切换（kscc↔external 互斥，核内可换模型）')
    }

    // 解析 workspaceId：优先用 input 传入，否则从已有 meta 读
    const workspaceId = input.workspaceId ?? meta?.workspaceId

    const adapterKind: ChannelKind = channel.provider === 'kscc-internal' ? 'kscc' : 'external'
    const adapter = getAdapter(adapterKind)
    let rt = this.runtimes.get(input.sessionId)
    const isFirst = !rt || !rt.hasLiveProcess()

    console.log(`[会话 ${input.sessionId}] ${isFirst ? '首次：spawn + 起循环' : '后续：复用长驻进程 enqueue'}（渠道=${channel.name} 核=${adapterKind} workspaceId=${workspaceId ?? '(无)'}）`)

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
      // 首条：建/绑会话元数据
      const modelId = this.resolveModel(channel, input.model)
      if (!meta) {
        createSession({
          id: input.sessionId,
          title: input.prompt.slice(0, 20) || '新会话',
          channelId,
          modelId,
          workspaceId,
          turnCount: 1,
        })
        console.log(`[会话 ${input.sessionId}] 已创建会话元数据，绑定渠道 ${channel.name}，workspaceId=${workspaceId ?? '(无)'}`)
      } else if (!meta.channelId) {
        updateSessionMeta(input.sessionId, { channelId, workspaceId, turnCount: (meta.turnCount ?? 0) + 1 })
        console.log(`[会话 ${input.sessionId}] 绑定渠道 ${channel.name}，workspaceId=${workspaceId ?? '(无)'}`)
      } else {
        // 已绑定渠道：轮数 +1
        updateSessionMeta(input.sessionId, { turnCount: (meta.turnCount ?? 0) + 1 })
      }
      // 建 SessionRuntime + 起循环
      rt = new SessionRuntime(input.sessionId, adapter)
      this.runtimes.set(input.sessionId, rt)
      rt.setCallbacks({
        onMessage: (msg: SDKMessage) => this.handleStreamMessage(input.sessionId, workspaceId, msg),
        onTurnEnd: () => this.sendPayload(input.sessionId, { kind: 'tagent_event', event: { type: 'turn_end' } }),
        onError: (err: Error) => this.sendPayload(input.sessionId, { kind: 'tagent_event', event: { type: 'session_error', message: err.message } }),
      })

      await rt.sendMessage(this.buildQueryOptions(input, channel, workspaceId))
    } else {
      // 后续：enqueue
      const userMessage: SDKUserMessageInput = {
        type: 'user',
        message: { role: 'user', content: input.prompt },
        parent_tool_use_id: null,
      } as unknown as SDKUserMessageInput
      await rt!.sendMessage(this.buildQueryOptions(input, channel, workspaceId), userMessage)
    }
  }

  /** 解析模型 ID：input > 渠道默认 > 第一个启用模型 > kscc 兜底 */
  private resolveModel(channel: Channel, inputModel?: string): string {
    if (inputModel) return inputModel
    if (channel.defaultModelId) return channel.defaultModelId
    const firstEnabled = channel.models.find((m) => m.enabled)
    if (firstEnabled) return firstEnabled.id
    return channel.provider === 'kscc-internal' ? KSCC_DEFAULT_MODEL_ID : ''
  }

  /** 构建 query 选项（按渠道 provider 选核） */
  private buildQueryOptions(
    input: SendMessageInput,
    channel: Channel,
    workspaceId?: string
  ): Parameters<AgentProviderAdapter['query']>[0] {
    const model = this.resolveModel(channel, input.model)

    // 解析 cwd：有 workspaceId 时优先用项目目录，否则 fallback 到 process.cwd()
    const workspace = workspaceId
      ? resolveWorkspaceForSession(input.sessionId)
      : undefined
    const cwd = workspace?.projectDirectory ?? process.cwd()

    if (channel.provider === 'kscc-internal') {
      const ksccPath = resolveKsccPath()
      if (!ksccPath) {
        throw new Error('未检测到 kscc 命令，请先安装 kscc（内网渠道）')
      }
      const meta = getSessionMeta(input.sessionId)
      // KsccQueryOptions：最小集，后续从 TAgent 搬 MCP/canUseTool/记忆等
      const opts: KsccQueryOptions = {
        sessionId: input.sessionId,
        prompt: input.prompt,
        model,
        cwd,
        sdkCliPath: ksccPath,
        env: { ...process.env } as Record<string, string | undefined>,
        maxTurns: 50,
        sdkPermissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        persistSession: true,
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
    const opts = {
      sessionId: input.sessionId,
      prompt: input.prompt,
      model,
      cwd,
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
    return opts as unknown as Parameters<AgentProviderAdapter['query']>[0]
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

  /** 销毁所有会话（应用退出） */
  disposeAll(): void {
    for (const rt of this.runtimes.values()) rt.destroy()
    this.runtimes.clear()
  }
}
