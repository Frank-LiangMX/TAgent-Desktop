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
  SDKResultMessage,
  ReasoningEffort,
  NoProgressGuardMode,
  NoProgressEvent,
  ToolBatchObservation,
  NoProgressDecision,
} from '@tagent/shared'
import { reasoningEffortToSdkEffort, NO_PROGRESS_GUARD_DEFAULT_MODE } from '@tagent/shared'
import type {
  Options as SdkOptions,
  SDKUserMessage,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'

import { createMessageChannel, type MessageChannel } from '../shared/message-channel'
import { getDiscardedMemoryDir } from '../../memory/discarded-memory'
import { spawnKscc } from './spawn-kscc'
import {
  attachImageBlocksToText,
} from '../../agent/build-user-content-with-attachments'

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
  ) => Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown>; message?: string }
    | { behavior: 'deny'; message: string; interrupt?: boolean }
    | { behavior: 'ask'; message?: string }
  >
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
  /**
   * 思考强度（来自会话 meta.reasoningEffort，已归一化）。映射为 Claude Agent SDK
   * `effort` query option（low/medium/high/max），配合 adaptive thinking 引导思考深度。
   * 缺省时不传 effort（由调用方 migrateReasoningEffort 决定，默认 medium）。
   */
  reasoningEffort?: ReasoningEffort
  /**
   * 无进展守卫运行模式（§20.1 / §23.1）。缺省 shadow（首发不强制）。
   * session-service 读 TAGENT_NO_PROGRESS_GUARD_MODE 归一后注入。
   */
  noProgressGuardMode?: NoProgressGuardMode
  /**
   * 无进展阶段事件回调（§20.4）。适配层把守卫 decision 翻成 NoProgressEvent 推这里，
   * 由 session-service sendPayload 转发 renderer。shadow 模式也发（带 shadow=true），UI 忽略。
   */
  onNoProgressEvent?: (event: NoProgressEvent) => void
}

/** 活跃会话状态（长驻：一个会话一个进程） */
interface ActiveSession {
  controller: AbortController
  channel: MessageChannel
  /** SDK Query iterator（持续跑，result 后不 done） */
  query: AsyncIterable<SDKMessage>
  /** 子进程 pid（force-kill 兜底用） */
  pid?: number
  /** 无进展守卫上下文（per-session，per-turn reset） */
  np?: NoProgressCtx
}

/**
 * 无进展守卫接线上下文（§10.2）。
 * hooks 与 sendQueuedMessage 共用：PostToolBatch→observe、PreToolUse→onPreToolUse、
 * 暂停→interrupt + 终态归一化。
 */
interface NoProgressCtx {
  guard: NoProgressGuard
  mode: NoProgressGuardMode
  onNoProgressEvent?: (event: NoProgressEvent) => void
  /** 本轮 turn id（观察回放/日志用，guard 不依赖） */
  turnId: string
  /** 已触发暂停、待终态归一化的标志（单真源终态闸口，§20.5） */
  pendingPauseNoProgress: boolean
  /** 停止当前 turn（保进程）：query.interrupt()，由 query() 创建后回填 */
  interrupt?: () => void
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

    // 入队首条 user message（有图则多模态 content；prompt 侧已含路径附录）
    const firstContent = attachImageBlocksToText(input.prompt, input.attachments)
    channel.enqueue({
      type: 'user',
      session_id: input.sessionId,
      message: { role: 'user', content: firstContent },
      parent_tool_use_id: null,
    } as SDKUserMessage)

    const sdk = await import('@anthropic-ai/claude-agent-sdk')

    // 无进展守卫（per-session；首 turn reset；后续 turn 由 sendQueuedMessage reset）
    const npMode = input.noProgressGuardMode ?? NO_PROGRESS_GUARD_DEFAULT_MODE
    const np: NoProgressCtx = {
      guard: new NoProgressGuard({ mode: npMode }),
      mode: npMode,
      onNoProgressEvent: input.onNoProgressEvent,
      turnId: `${input.sessionId}-t1`,
      pendingPauseNoProgress: false,
    }
    np.guard.resetForNewTurn() // fresh guard = observing，首 turn 无 cleared 事件

    const sdkOptions = this.buildSdkOptions(input, controller, channel, np)

    const queryIterable = sdk.query({ prompt: channel.generator, options: sdkOptions })
    const queryIterator = queryIterable[Symbol.asyncIterator]()
    // 回填停止函数（保进程的软中断，§22 Step 0/4：不用 continue:false 杀长驻）
    np.interrupt = () => {
      const q = queryIterable as unknown as { interrupt?: () => Promise<void> }
      try {
        void q.interrupt?.()
      } catch {
        /* 忽略 */
      }
    }

    activeSessions.set(input.sessionId, {
      controller,
      channel,
      query: queryIterable,
      np,
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

        // 单真源终态归一化（§20.5）：暂停触发后，底层 result（error_max_turns /
        // error_during_execution / 乃至 success）一律归一为 paused_no_progress，且只一次。
        const out =
          msg.type === 'result' && np.pendingPauseNoProgress
            ? normalizeResultToPausedNoProgress(msg)
            : msg
        np.pendingPauseNoProgress = false

        yield out

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
    channel: MessageChannel,
    np: NoProgressCtx
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
      // 思考强度：reasoningEffort → SDK effort（low/medium/high/max）。
      // 配合 adaptive thinking 引导深度；session-service 已 migrateReasoningEffort 归一化（默认 medium）。
      ...(options.reasoningEffort && {
        effort: resolveSdkEffort(options.reasoningEffort),
      }),
      // 无进展守卫 hooks（§10.2）：PostToolBatch→observe 注入复盘 / PreToolUse→final_response_only 拦截。
      // shadow 模式只发诊断事件（带 shadow=true），不改行为；enforce 才注入 / 拦截 / 暂停。
      ...buildNoProgressHooks(options.sessionId, np),
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
    // 新一轮用户消息 → 守卫重置为 observing（§8）；上一轮非 observing 则发 cleared 清 UI 提示
    if (sess.np) {
      const cleared = sess.np.guard.resetForNewTurn()
      emitNoProgressFromDecision(sess.np, cleared)
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

/**
 * 把会话 {@link ReasoningEffort} 解析为 Claude Agent SDK `effort` query option 值。
 * 导出供单测证明「不同 reasoningEffort → 不同 SDK effort」；buildSdkOptions 据此注入 options.effort。
 * 入参应先经 `migrateReasoningEffort` 归一化（session-service 已做）。
 */
export function resolveSdkEffort(reasoningEffort: ReasoningEffort): SdkOptions['effort'] {
  return reasoningEffortToSdkEffort(reasoningEffort) as SdkOptions['effort']
}

// ===== 无进展守卫接线（§10.2 / §20） =====

/**
 * SDK PostToolBatch hook input（sdk.d.ts PostToolBatchHookInput 精简镜像，避免直接依赖私有类型）。
 * 导出供单测构造观察输入。
 */
export interface PostToolBatchHookInputLike {
  tool_calls: Array<{ tool_name: string; tool_input: unknown; tool_use_id: string; tool_response?: unknown }>
}

/** PreToolUse hook input 精简镜像（单测用） */
export interface PreToolUseHookInputLike {
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}

/**
 * 把 SDK PostToolBatch hook 输入翻成统一观察（§20.2）。
 * 纯函数，导出供单测：证明 hook 输入 → ToolBatchObservation 翻译正确。
 */
export function ksccPostToolBatchToObservation(
  hookInput: PostToolBatchHookInputLike,
  sessionId: string,
  turnId: string,
  observedAt: number,
): ToolBatchObservation {
  return {
    sessionId,
    turnId,
    provider: 'kscc',
    observedAt,
    calls: (hookInput.tool_calls ?? []).map((tc) => ({
      toolUseId: tc.tool_use_id,
      toolName: tc.tool_name,
      input: tc.tool_input,
      output: tc.tool_response,
    })),
  }
}

/** 把守卫 decision 翻成 IPC 事件并下发（emitPhase 非空才发；shadow 带 shadow=true） */
function emitNoProgressFromDecision(
  np: NoProgressCtx,
  decision: NoProgressDecision,
): void {
  if (!decision.emitPhase) return
  np.onNoProgressEvent?.(buildNoProgressEventFromDecision(decision, np.mode))
}

/**
 * 把底层终态 result 归一化为唯一的 `paused_no_progress`（§20.5）。
 * 抑制 error_max_turns / error_during_execution 等重复终态；errors 用友好暂停文案。
 */
export function normalizeResultToPausedNoProgress(msg: SDKMessage): SDKMessage {
  if (msg.type !== 'result') return msg
  const r = msg as SDKResultMessage
  return {
    ...r,
    subtype: 'paused_no_progress',
    errors: ['已暂停：连续多次操作未获得新进展。会话与历史保留，可在原会话继续发送消息。'],
    // 清掉可能误导的 terminal_reason / 后台任务终态分类
    terminal_reason: undefined,
  } as SDKResultMessage
}

/**
 * 注册无进展守卫的 PostToolBatch + PreToolUse hooks（§10.2）。
 *
 * - PostToolBatch：整批工具完成后翻成观察喂守卫；enforce 下 warn/require_reflection 注入 additionalContext；
 *   pause 触发时置 pendingPauseNoProgress 并 query.interrupt()（保进程），终态在 query() 归一化。
 * - PreToolUse：final_response_only 阶段拦截工具（permissionDecision:'deny' + 复盘原因）；
 *   2 次违规 → pause（同上 interrupt）。
 * - shadow：只发诊断事件（带 shadow=true），不改行为（不注入 / 不拦截 / 不暂停）。
 */
function buildNoProgressHooks(
  sessionId: string,
  np: NoProgressCtx,
): Pick<SdkOptions, 'hooks'> {
  if (np.mode === 'off') return {} // 紧急回滚：完全不注册
  const postToolBatch = async (hookInput: PostToolBatchHookInputLike) => {
    const observation = ksccPostToolBatchToObservation(hookInput, sessionId, np.turnId, Date.now())
    const decision = np.guard.observe(observation)
    emitNoProgressFromDecision(np, decision)
    if (np.mode === 'enforce') {
      if (decision.kind === 'pause') {
        np.pendingPauseNoProgress = true
        np.interrupt?.()
        return {}
      }
      if (decision.modelContext) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolBatch',
            additionalContext: decision.modelContext,
          },
        }
      }
    }
    return {}
  }
  const preToolUse = async (hookInput: PreToolUseHookInputLike) => {
    if (np.mode !== 'enforce') return {}
    const advice = np.guard.onPreToolUse(hookInput.tool_name, hookInput.tool_input)
    if (advice.allow) return {}
    if (advice.pause) {
      np.pendingPauseNoProgress = true
      if (advice.decision) emitNoProgressFromDecision(np, advice.decision)
      np.interrupt?.()
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny' as const,
        permissionDecisionReason: advice.blockReason ?? '',
      },
    }
  }
  // SDK HookCallback 签名为 (input: HookInput, toolUseID, options) => Promise<HookJSONOutput>；
  // 这里按事件名窄化入参，整体 as 适配，避免 HookInput 大联合的类型摩擦。
  return {
    hooks: {
      PostToolBatch: [{ hooks: [postToolBatch as never] }],
      PreToolUse: [{ hooks: [preToolUse as never] }],
    } as unknown as SdkOptions['hooks'],
  } as Pick<SdkOptions, 'hooks'>
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
