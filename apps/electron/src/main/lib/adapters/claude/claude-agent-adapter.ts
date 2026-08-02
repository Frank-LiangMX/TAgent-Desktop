/**
 * kscc 核适配器（Claude Agent SDK + kscc 渠道）
 *
 * 2.0 长驻改造：会话 = 进程，常驻直到退出。
 * 见 docs/plans/2026-07-25-longlived-event-loop-rewrite-design.md。
 *
 * 跟旧 TAgent claude-agent-adapter.ts 的关键区别：
 * - result 后不 channel.close()：进程长驻，等下条 enqueue（旧版 result 后 close 杀进程）
 * - 不继承旧"一圈一结"：query 的 for-await 持续跑，由 orchestrator 决定何时 close
 * - 精简：暂不带 prompt-suggestion/cache 错误映射等，功能搬齐后再加
 *
 * 可拔插：对外版编译时排除本文件（claude/ 目录整体可拔插）。
 */
import { spawn as spawnChild, execFileSync } from 'node:child_process'
import type {
  AgentProviderAdapter,
  AgentQueryInput,
  AgentDefinition,
  SDKUserMessageInput,
  SDKMessage,
} from '@tagent/shared'
import type {
  Options as SdkOptions,
  SDKUserMessage,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'

import { createMessageChannel, type MessageChannel } from '../shared/message-channel'
import { getDiscardedMemoryDir } from '../../memory/discarded-memory'
import { spawnKscc } from './spawn-kscc'

/** kscc 核查询选项（扩展 AgentQueryInput） */
export interface KsccQueryOptions extends AgentQueryInput {
  /** kscc CLI 路径 */
  sdkCliPath: string
  /** 环境变量 */
  env: Record<string, string | undefined>
  /** 最大轮次 */
  maxTurns?: number
  /** SDK 权限模式 */
  sdkPermissionMode: string
  /** 是否跳过权限检查 */
  allowDangerouslySkipPermissions: boolean
  /** 自定义权限处理器 */
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { mcpServers?: unknown }
  ) => Promise<{ behavior: 'allow' | 'deny' | 'ask'; message?: string }>
  /** 系统提示词 */
  systemPrompt: string | { type: 'preset'; preset: 'claude_code'; append?: string }
  /**
   * 执行形态（Chat|Work）。长驻进程在形态切换时须 re-spawn 才能换工具集。
   * 由 SessionRuntime 做指纹比对。
   */
  executionMode?: 'chat' | 'work'
  /** resume 的 SDK session id */
  resumeSessionId?: string
  /** MCP 服务器配置 */
  mcpServers?: Record<string, unknown>
  /** stderr 回调 */
  onStderr?: (data: string) => void
  /** session_id 捕获回调 */
  onSessionId?: (sdkSessionId: string) => void
  /** 流式 partial 事件 */
  includePartialMessages?: boolean
  /** persistSession */
  persistSession?: boolean
  /** 子代理定义（SDK agents 选项，主 Agent 可调用 Agent/Task 工具派发） */
  agents?: Record<string, AgentDefinition>
}

/** 活跃会话状态（长驻：一个会话一个进程） */
interface ActiveSession {
  controller: AbortController
  channel: MessageChannel
  /** SDK Query iterator（持续跑，result 后不 done） */
  query: AsyncIterable<SDKMessage>
  /** 子进程 pid（force-kill 兜底用） */
  pid?: number
}

const activeSessions = new Map<string, ActiveSession>()

export class ClaudeAgentAdapter implements AgentProviderAdapter {
  /** 是否有活跃长驻 channel（orchestrator 判断复用 vs 新建） */
  hasActiveChannel(sessionId: string): boolean {
    return activeSessions.has(sessionId)
  }

  /** 发起查询，返回 SDKMessage 流（长驻：result 后不 close，持续等下条） */
  async *query(input: KsccQueryOptions): AsyncIterable<SDKMessage> {
    const controller = new AbortController()
    const channel = createMessageChannel(controller.signal)

    // 入队首条 user message
    channel.enqueue({
      type: 'user',
      session_id: input.sessionId,
      message: { role: 'user', content: input.prompt },
      parent_tool_use_id: null,
    } as SDKUserMessage)

    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const sdkOptions = this.buildSdkOptions(input, controller, channel)

    const queryIterable = sdk.query({ prompt: channel.generator, options: sdkOptions })
    const queryIterator = queryIterable[Symbol.asyncIterator]()

    activeSessions.set(input.sessionId, {
      controller,
      channel,
      query: queryIterable,
    })

    try {
      while (true) {
        const iterResult = await queryIterator.next()
        if (iterResult.done) break // 进程退出/EOF

        const msg = iterResult.value as SDKMessage

        // 捕获 session_id
        const msgAny = msg as Record<string, unknown>
        if (typeof msgAny.session_id === 'string' && msgAny.session_id) {
          input.onSessionId?.(msgAny.session_id)
        }

        yield msg

        // 长驻核心：result 后不 close，循环继续，等下条 enqueue 触发新轮
        // （旧版在这里 channel.close() + break，杀进程。新版不这么做。）
        if (msg.type === 'result') {
          // result 后继续循环，queryIterator.next() 会等下条消息触发的新轮
          // 进程不退（channel 没 close，stdin 没 EOF）
          continue
        }
      }
    } finally {
      // 只有进程退出（iterResult.done）或 abort 才到这里
      activeSessions.delete(input.sessionId)
    }
  }

  /** 构建 SDK options */
  private buildSdkOptions(
    input: KsccQueryOptions,
    controller: AbortController,
    channel: MessageChannel
  ): SdkOptions {
    const options = input
    return {
      pathToClaudeCodeExecutable: options.sdkCliPath,
      model: options.model || 'claude-sonnet-4-6',
      ...(options.maxTurns != null && { maxTurns: options.maxTurns }),
      permissionMode: options.sdkPermissionMode as SdkOptions['permissionMode'],
      allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions,
      includePartialMessages: options.includePartialMessages ?? true,
      promptSuggestions: false,
      cwd: options.cwd,
      abortController: controller,
      env: options.env,
      systemPrompt: options.systemPrompt,
      ...(options.canUseTool && { canUseTool: options.canUseTool as SdkOptions['canUseTool'] }),
      ...(options.resumeSessionId && { resume: options.resumeSessionId }),
      ...(options.mcpServers &&
        Object.keys(options.mcpServers).length > 0 && {
          mcpServers: options.mcpServers as SdkOptions['mcpServers'],
        }),
      // 子代理：传 agents 定义 + 开启嵌套对话转发 + 进度摘要
      ...(options.agents && Object.keys(options.agents).length > 0 && {
        agents: options.agents as SdkOptions['agents'],
        forwardSubagentText: true,
        agentProgressSummaries: true,
      }),
      ...(options.onStderr && { stderr: options.onStderr }),
      ...(options.persistSession != null && { persistSession: options.persistSession }),
      // Phase 2.4：SDK auto-memory 重定向到废目录（主防线是 MEMORY_MANAGEMENT_RULES）
      autoMemoryDirectory: getDiscardedMemoryDir(),
      toolUseConcurrency: 1,
      spawnClaudeCodeProcess: (spawnOpts: SpawnOptions) => {
        const { child, command, args } = spawnKscc(
          options.sdkCliPath,
          spawnOpts,
          options.onStderr
        )
        const sess = activeSessions.get(options.sessionId)
        if (sess && child.pid) {
          sess.pid = child.pid
          child.once('exit', () => {
            const s = activeSessions.get(options.sessionId)
            if (s && s.pid === child.pid) s.pid = undefined
          })
        }
        console.log(`[kscc adapter] spawn: ${command} ${args.join(' ')}`)
        return child as unknown as import('@anthropic-ai/claude-agent-sdk').SpawnedProcess
      },
    } as SdkOptions
  }

  /** 向活跃长驻会话注入消息（复用进程，不重新 spawn） */
  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    const sess = activeSessions.get(sessionId)
    if (!sess) {
      throw new Error(`[kscc adapter] 无活跃会话可注入: ${sessionId}`)
    }
    sess.channel.enqueue(message as SDKUserMessage)
  }

  /** 软中断当前 turn（保进程，下条消息续） */
  async interruptQuery(sessionId: string): Promise<void> {
    const sess = activeSessions.get(sessionId)
    if (!sess) return
    // SDK Query 的 interrupt 方法（保留进程）
    const query = sess.query as unknown as { interrupt?: () => Promise<void> }
    if (query.interrupt) {
      try {
        await query.interrupt()
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 热切换 SDK 权限模式（运行中会话，下次工具调用生效） */
  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const sess = activeSessions.get(sessionId)
    if (!sess) {
      throw new Error(`[kscc adapter] 无活跃会话可切权限模式: ${sessionId}`)
    }
    const query = sess.query as unknown as { setPermissionMode?: (mode: string) => Promise<void> }
    if (!query.setPermissionMode) {
      throw new Error('[kscc adapter] SDK Query 不支持 setPermissionMode')
    }
    await query.setPermissionMode(mode)
  }

  /** 热切换 kscc 长驻 Query 的模型，下一轮请求生效 */
  async setModel(sessionId: string, model: string): Promise<void> {
    const sess = activeSessions.get(sessionId)
    if (!sess) {
      throw new Error(`[kscc adapter] 无活跃会话可切模型: ${sessionId}`)
    }
    const query = sess.query as unknown as { setModel?: (model?: string) => Promise<void> }
    if (!query.setModel) {
      throw new Error('[kscc adapter] SDK Query 不支持 setModel')
    }
    await query.setModel(model)
  }

  /** 中止会话：杀进程（destroySession / abort 用） */
  abort(sessionId: string): void {
    const sess = activeSessions.get(sessionId)
    if (!sess) return
    sess.channel.close()
    sess.controller.abort()
    activeSessions.delete(sessionId)
    // force-kill 兜底（进程可能残留）
    if (sess.pid) {
      scheduleForceKill(sessionId, sess.pid)
    }
  }

  dispose(): void {
    for (const sess of activeSessions.values()) {
      try {
        sess.channel.close()
        sess.controller.abort()
      } catch {
        /* 忽略 */
      }
    }
    activeSessions.clear()
  }
}

/** force-kill 兜底（进程残留时） */
function scheduleForceKill(sessionId: string, pid: number): void {
  setTimeout(() => {
    try {
      process.kill(pid, 0) // 存活探测
    } catch {
      return
    }
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
      } else {
        process.kill(pid, 'SIGKILL')
      }
      console.warn(`[kscc adapter] force-killed residual pid=${pid}`)
    } catch {
      /* 忽略 */
    }
  }, 10_000).unref?.()
}
