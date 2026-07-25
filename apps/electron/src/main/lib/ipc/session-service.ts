/**
 * 会话服务：管理 SessionRuntime 集合 + 注册 IPC handler
 *
 * 2.0 长驻改造核心。见 docs/plans/2026-07-25-longlived-event-loop-rewrite-design.md。
 * 职责：
 * - 创建/销毁 SessionRuntime（一个会话一个，绑进程）
 * - 注册 IPC handler（SEND_MESSAGE/STOP_TURN/DESTROY_SESSION）
 * - 流式消息推给渲染进程（STREAM_MESSAGE/TURN_END/SESSION_ERROR）
 *
 * 当前阶段：最小版，只接通"发消息→收流式→停止/销毁"。
 * 后续：渠道选择、MCP/Skill 注入、记忆、权限回调等从 TAgent 搬。
 */
import { ipcMain, type BrowserWindow } from 'electron'
import type {
  AgentProviderAdapter,
  SDKMessage,
  SDKUserMessageInput,
  TAgentDesktopStreamPayload,
  TAgentMessage,
} from '@tagent/shared'
import { AGENT_IPC_CHANNELS } from '@tagent/shared'
import { SessionRuntime } from '../agent/runtime/session-runtime'
import { getAdapter } from '../adapters'
import { resolveKsccPath } from '../adapters/claude/kscc-path'
import { sdkMessageToIR } from '../adapters/claude/kscc-message-adapter'
import type { KsccQueryOptions } from '../adapters/claude/claude-agent-adapter'
import { getSessionMeta, updateSessionMeta, appendMessages, createSession, listSessions, readMessages, deleteSession as deleteSessionMeta } from '../agent/session-store'

interface SendMessageInput {
  sessionId: string
  prompt: string
  /** 渠道（决定选哪个 adapter）：'kscc' | 'external'，默认 kscc */
  channelKind?: 'kscc' | 'external'
  /** 模型 */
  model?: string
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
      return listSessions()
    })

    ipcMain.handle(AGENT_IPC_CHANNELS.GET_SDK_MESSAGES, async (_e, sessionId: string) => {
      return readMessages(sessionId)
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
  }

  /** 处理发消息：首次 spawn + 起循环，后续 enqueue */
  private async handleSend(input: SendMessageInput): Promise<void> {
    const channelKind = input.channelKind ?? 'kscc'
    const adapter = getAdapter(channelKind)
    let rt = this.runtimes.get(input.sessionId)
    const isFirst = !rt || !rt.hasLiveProcess()

    console.log(`[会话 ${input.sessionId}] ${isFirst ? '首次：spawn kscc + 起循环' : '后续：复用长驻进程 enqueue'}（渠道=${channelKind}）`)

    if (isFirst) {
      // 首次：确保会话元数据存在（前端 sessionId 若无 meta 则建）
      if (!getSessionMeta(input.sessionId)) {
        createSession({
          id: input.sessionId,
          title: input.prompt.slice(0, 20) || '新会话',
          modelId: input.model,
        })
        console.log(`[会话 ${input.sessionId}] 已创建会话元数据`)
      }
      // 首次：建 SessionRuntime + 起循环
      rt = new SessionRuntime(input.sessionId, adapter)
      this.runtimes.set(input.sessionId, rt)
      rt.setCallbacks({
        onMessage: (msg: SDKMessage) => this.handleStreamMessage(input.sessionId, msg),
        onTurnEnd: () => this.sendPayload(input.sessionId, { kind: 'tagent_event', event: { type: 'turn_end' } }),
        onError: (err: Error) => this.sendPayload(input.sessionId, { kind: 'tagent_event', event: { type: 'session_error', message: err.message } }),
      })

      await rt.sendMessage(this.buildQueryOptions(input, channelKind))
    } else {
      // 后续：enqueue
      const userMessage: SDKUserMessageInput = {
        type: 'user',
        message: { role: 'user', content: input.prompt },
        parent_tool_use_id: null,
      } as unknown as SDKUserMessageInput
      await rt!.sendMessage(this.buildQueryOptions(input, channelKind), userMessage)
    }
  }

  /** 构建 query 选项（按渠道） */
  private buildQueryOptions(
    input: SendMessageInput,
    channelKind: 'kscc' | 'external'
  ): Parameters<AgentProviderAdapter['query']>[0] {
    if (channelKind === 'kscc') {
      const ksccPath = resolveKsccPath()
      if (!ksccPath) {
        throw new Error('未检测到 kscc 命令，请先安装 kscc（内网渠道）')
      }
      // 读会话元数据取 sdkSessionId（长驻首次 spawn 时 resume 续历史）
      const meta = getSessionMeta(input.sessionId)
      // KsccQueryOptions：最小集，后续从 TAgent 搬 MCP/canUseTool/记忆等
      const opts: KsccQueryOptions = {
        sessionId: input.sessionId,
        prompt: input.prompt,
        model: input.model || meta?.modelId || 'glm-5.2',
        cwd: process.cwd(),
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
          // SDK 给的 session_id 存起来，下次 spawn（崩溃 fallback / 重开）用它 resume
          if (sdkSessionId && sdkSessionId !== meta?.sdkSessionId) {
            updateSessionMeta(input.sessionId, { sdkSessionId })
            console.log(`[会话 ${input.sessionId}] 已保存 sdkSessionId: ${sdkSessionId}`)
          }
        },
        onStderr: (data: string) => console.error(`[kscc stderr] ${data}`),
      }
      return opts as unknown as Parameters<AgentProviderAdapter['query']>[0]
    }
    // Pi 核：TODO
    throw new Error('外部渠道（Pi 核）尚未实现')
  }

  /** 转译 SDKMessage → IR，发 TAgentDesktopStreamPayload 给 renderer，并持久化 */
  private handleStreamMessage(sessionId: string, msg: SDKMessage): void {
    const { message, event } = sdkMessageToIR(msg)
    if (message) {
      // 持久化完整消息到 JSONL（流式 delta 不持久化，完整 assistant/user 才存）
      appendMessages(sessionId, [msg])
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
