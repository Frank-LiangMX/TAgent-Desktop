/**
 * Pi 核适配器（外部渠道 + kscc bare 双模式）
 *
 * 2.0 双核之一。见 docs/plans/2026-07-25-2.0-architecture-decision-dual-core.md §7.1。
 *
 * 跟 kscc 核的区别：
 * - 不 spawn 子进程（Pi Agent 在主进程内存，自带循环）
 * - 无长驻问题（Agent 对象天然常驻）
 * - 上下文 Pi 自管（state.messages），无 SDK resume cache
 * - Xfast/MoA 全活（Pi 管工具循环，可并行）
 *
 * 架构：
 * - PiAgentAdapter 单例管理 Map<sessionId, SessionEntry>，每个会话一个 Agent 实例
 * - query() 创建/复用 Agent，subscribe 监听 AgentEvent，转译成 SDKMessage 推给调用方
 * - AgentEvent → SDKMessage 转译逻辑在 piEventToSdkMessage()
 * - 外部渠道用 createHttpDirectStreamFn，kscc 渠道用 createKsccBareStreamFn
 *
 * 可拔插：内网版可排除本文件（只用 kscc 核）。
 */

import type {
  AgentProviderAdapter,
  AgentQueryInput,
  SDKUserMessageInput,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
} from '@tagent/shared'

import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  ThinkingLevel,
  Agent as AgentType,
  AgentOptions,
  AgentState,
  AgentToolResult,
} from '@earendil-works/pi-agent-core'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ModelCost,
  ToolCall,
  ThinkingContent,
  TextContent,
  ToolResultMessage,
  Usage,
  Context,
  StreamFunction,
  AssistantMessageEventStream,
} from '@earendil-works/pi-ai'

// ESM-only 包不能 CJS require，用动态 import 延迟加载
// 首次 query() 时才 import，避免启动时阻塞
type PiCoreModule = typeof import('@tagent/pi-core')
let _piCore: PiCoreModule | null = null
async function loadPiCore(): Promise<PiCoreModule> {
  if (!_piCore) _piCore = await import('@tagent/pi-core')
  return _piCore
}

type PiAgentCoreModule = typeof import('@earendil-works/pi-agent-core')
let _piAgentCore: PiAgentCoreModule | null = null
async function loadPiAgentCore(): Promise<PiAgentCoreModule> {
  if (!_piAgentCore) _piAgentCore = await import('@earendil-works/pi-agent-core')
  return _piAgentCore
}

import { createTaskTool } from './subagent-task-tool'

// ===== 配置类型 =====

/** Pi 核适配器配置（外部渠道模式） */
export interface PiExternalChannelConfig {
  type: 'external'
  /** API provider 类型（anthropic/deepseek/openai/google 等） */
  provider: 'anthropic' | 'deepseek' | 'openai' | 'google' | string
  /** API Key（明文） */
  apiKey: string
  /** Base URL（可选，覆盖默认） */
  baseUrl?: string
  /** 模型 ID */
  modelId: string
  /** 是否启用 thinking */
  thinkingEnabled?: boolean
  /** thinking level */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
}

/** Pi 核适配器配置（kscc bare 模式） */
export interface PiKsccChannelConfig {
  type: 'kscc'
  /** kscc 可执行文件路径 */
  ksccPath?: string
  /** 默认模型 ID */
  defaultModelId?: string
}

/** Pi 核适配器总配置 */
export type PiAgentAdapterConfig = PiExternalChannelConfig | PiKsccChannelConfig

/** Pi 核查询选项（扩展 AgentQueryInput） */
export interface PiQueryOptions extends AgentQueryInput {
  /** 渠道配置 */
  channelConfig: PiAgentAdapterConfig
  /** 系统提示词 */
  systemPrompt?: string
  /** 自定义工具列表（默认用 pi-core 的 defaultTools + mcpTools） */
  tools?: AgentTool[]
  /** 工作区 MCP 配置（合并 mcpTools） */
  mcpConfig?: { servers: Record<string, unknown> }
  /** 工作目录（bashTool/相对路径用，不传 process.cwd） */
  cwd?: string
  /** 权限模式回调（beforeToolCall 用） */
  beforeToolCall?: (ctx: { toolCall: { name: string; arguments: Record<string, unknown> } }) => Promise<{ block: true; reason: string } | undefined>
}

// ===== 会话状态 =====

/** 单个会话的运行时状态 */
interface SessionEntry {
  /** Pi Agent 实例 */
  agent: AgentType
  /** 中止控制器 */
  controller: AbortController
  /** 是否正在流式输出 */
  isStreaming: boolean
}

// ===== 主类 =====

export class PiAgentAdapter implements AgentProviderAdapter {
  /** 会话 → Agent 实例映射（一个会话一个 Agent，天然常驻） */
  private sessions = new Map<string, SessionEntry>()

  // ===== AgentProviderAdapter 接口实现 =====

  /**
   * 发起查询，返回 SDKMessage 异步迭代流
   *
   * 核心流程：
   * 1. 按 sessionId 查找/创建 Agent 实例
   * 2. Agent.subscribe 注册事件监听
   * 3. agent.prompt(用户消息) 启动对话
   * 4. AgentEvent 回调转译成 SDKMessage，推给 generator
   */
  async *query(input: PiQueryOptions): AsyncIterable<SDKMessage> {
    const { sessionId, prompt, channelConfig, systemPrompt, tools, mcpConfig, cwd, beforeToolCall, abortSignal } = input

    // 创建或复用 Agent 实例
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = await this.createSession(sessionId, channelConfig, systemPrompt, tools, mcpConfig, cwd, beforeToolCall)
      this.sessions.set(sessionId, entry)
    }

    const { agent, controller } = entry

    // 如果外部有 AbortSignal，联动到内部 controller
    if (abortSignal) {
      const onAbort = () => controller.abort()
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    // 创建事件队列：AgentEvent 回调往里推，generator 从里取
    const queue: SDKMessage[] = []
    let waiting: boolean = false
    let resolveWait: (() => void) | null = null
    let generatorDone = false
    let generatorError: Error | null = null

    /** 推一条 SDKMessage 进队列，唤醒等待中的 generator */
    const pushMessage = (msg: SDKMessage) => {
      queue.push(msg)
      if (resolveWait) {
        const r = resolveWait
        resolveWait = null
        waiting = false
        r()
      }
    }

    /** 等 queue 里有新消息 */
    const waitForNext = (): Promise<void> => {
      if (queue.length > 0) return Promise.resolve()
      waiting = true
      return new Promise<void>((resolve) => {
        resolveWait = resolve
      })
    }

    /** 唤醒等待中的 generator（不推消息，仅解除等待） */
    const wakeGenerator = () => {
      if (resolveWait) {
        const r = resolveWait
        resolveWait = null
        waiting = false
        r()
      }
    }

    // 注册 Agent 事件监听
    let lastDeltaAt = 0
    let deltaCount = 0
    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      if (generatorDone) return

      // 临时诊断：记录 text_delta/thinking_delta 的到达间隔（排查"一块一块"是端点攒批还是我们攒批）
      if (event.type === 'message_update') {
        const ae = (event as { assistantMessageEvent: { type: string } }).assistantMessageEvent
        if (ae.type === 'text_delta' || ae.type === 'thinking_delta') {
          const now = Date.now()
          deltaCount++
          if (lastDeltaAt > 0) {
            const gap = now - lastDeltaAt
            // 只打印前 5 个 + 间隔异常的（>100ms 说明端点攒批）
            if (deltaCount <= 5 || gap > 100) {
              console.log(`[Pi delta ${sessionId}] #${deltaCount} ${ae.type} 间隔=${gap}ms`)
            }
          } else {
            console.log(`[Pi delta ${sessionId}] #1 ${ae.type} 首个 delta`)
          }
          lastDeltaAt = now
        }
      }

      try {
        const sdkMessages = piEventToSdkMessages(event, sessionId)
        for (const msg of sdkMessages) {
          pushMessage(msg)
        }
      } catch (err) {
        console.error(`[Pi 适配器 ${sessionId}] 转译 ${event.type} 抛错:`, err)
        generatorError = err instanceof Error ? err : new Error(String(err))
        wakeGenerator()
      }
    })

    // 启动对话（fire-and-forget，不 await：让 generator 并发消费 queue，
    // 这样 prompt 期间推入的流式 delta 能被实时 yield，而不是攒到 turn 结束一次性吐出）
    entry.isStreaming = true
    void agent.prompt(prompt)
      .catch((err: unknown) => {
        console.error(`[Pi 适配器 ${sessionId}] agent.prompt 抛错:`, err)
        // prompt 本身失败（如 abort），转成 error result 推给 renderer
        const errorMsg = err instanceof Error ? err.message : String(err)
        pushMessage({
          type: 'result',
          subtype: 'error_during_execution',
          usage: { input_tokens: 0, output_tokens: 0 },
          errors: [errorMsg],
        } as SDKResultMessage)
      })
      .finally(() => {
        entry.isStreaming = false
        generatorDone = true
        wakeGenerator()
      })

    // generator: 从队列消费 SDKMessage（与 prompt 并发跑，流式 delta 实时吐）
    try {
      while (true) {
        await waitForNext()

        if (generatorError) {
          throw generatorError
        }

        // 取出所有已入队消息
        const batch = queue.splice(0)
        for (const msg of batch) {
          yield msg

          // result 消息表示本轮结束，但 Pi Agent 天然常驻，不释放
          // 调用方可继续发消息（通过 sendQueuedMessage → agent.steer）
        }

        // generator 已结束且队列空，退出
        if (generatorDone && queue.length === 0) {
          break
        }
      }
    } finally {
      unsubscribe()
      // 不释放 Agent，保持常驻
    }
  }

  /** 查询某会话是否有活跃的 Agent 实例 */
  hasActiveChannel(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** 向活跃 Agent 注入消息（steer 模式，软中断后注入） */
  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) {
      throw new Error(`[pi adapter] 无活跃会话可注入: ${sessionId}`)
    }

    // 将 SDKUserMessage 转成 Pi 的 UserMessage 并 steer
    const content = typeof message.message?.content === 'string'
      ? message.message.content
      : ''
    const piUserMessage = {
      role: 'user' as const,
      content,
      timestamp: Date.now(),
    }

    // 如果 Agent 正在流式输出，用 steer 注入（当前 turn 结束后消费）
    // 否则用 prompt 启动新轮
    if (entry.isStreaming) {
      entry.agent.steer(piUserMessage)
    } else {
      // Agent 空闲，直接 prompt
      entry.isStreaming = true
      entry.agent.prompt(piUserMessage).finally(() => {
        entry!.isStreaming = false
      })
    }
  }

  /** 软中断当前 turn（agent.abort 保留 Agent 实例） */
  async interruptQuery(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    // Pi Agent 的 abort 是软中断：停止当前 turn，但 Agent 对象保留
    entry.agent.abort()
  }

  /** 中止会话（释放 Agent 实例） */
  abort(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.agent.abort()
    entry.controller.abort()
    this.sessions.delete(sessionId)
  }

  /** 释放所有会话的 Agent 实例 */
  dispose(): void {
    for (const [sessionId, entry] of this.sessions) {
      try {
        entry.agent.abort()
        entry.controller.abort()
      } catch {
        /* 忽略 */
      }
    }
    this.sessions.clear()
  }

  // ===== 内部方法 =====

  /** 创建新会话的 Agent 实例 */
  private async createSession(
    sessionId: string,
    channelConfig: PiAgentAdapterConfig,
    systemPrompt?: string,
    tools?: AgentTool[],
    mcpConfig?: { servers: Record<string, unknown> },
    cwd?: string,
    beforeToolCall?: (ctx: { toolCall: { name: string; arguments: Record<string, unknown> } }) => Promise<{ block: true; reason: string } | undefined>,
  ): Promise<SessionEntry> {
    const controller = new AbortController()

    // 动态加载 ESM-only 包
    const [piCore, piAgentCore] = await Promise.all([loadPiCore(), loadPiAgentCore()])

    // 合并 MCP 工具（buildMcpTools 真执行）+ descriptors（kscc bare 用）
    let mcpTools: AgentTool[] = []
    let mcpDescriptors: unknown[] = []
    if (mcpConfig && Object.keys(mcpConfig.servers).length > 0) {
      try {
        const mcpResult = await piCore.buildMcpTools(mcpConfig as never)
        mcpTools = mcpResult.tools
        mcpDescriptors = mcpResult.descriptors
      } catch (err) {
        console.error(`[Pi 适配器 ${sessionId}] MCP 工具加载失败:`, err)
      }
    }

    // 工具描述符（kscc bare 模式注入 system prompt，让模型知有工具）
    const descriptors = [...piCore.defaultToolDescriptors, ...(mcpDescriptors as typeof piCore.defaultToolDescriptors)]

    // 根据渠道配置创建 streamFn（kscc bare 传 descriptors 让模型知道工具）
    const streamFn = channelConfig.type === 'external'
      ? piCore.createHttpDirectStreamFn({
          provider: channelConfig.provider,
          apiKey: channelConfig.apiKey,
          baseUrl: channelConfig.baseUrl,
          modelId: channelConfig.modelId,
          thinkingEnabled: channelConfig.thinkingEnabled ?? false,
          thinkingLevel: channelConfig.thinkingLevel,
        })
      : piCore.createKsccBareStreamFn({
          ksccPath: channelConfig.ksccPath,
          defaultModelId: channelConfig.defaultModelId,
          tools: descriptors,
        } as never)

    // 构造初始 model
    const model = buildPlaceholderModel(channelConfig)

    // 工具：传入用传入的，否则 defaultTools + mcpTools；cwd 用闭包注入 bashTool
    const baseTools = tools ?? piCore.defaultTools
    // 如果传了 cwd 且没自定义 tools，把默认 bashTool 替换成 createBashTool(cwd)（避免 process.cwd 串）
    const finalBaseTools =
      cwd && tools == null
        ? baseTools.map((t) => (t.name === 'Bash' ? piCore.createBashTool(cwd) : t))
        : baseTools

    // 注册 task 工具（子代理：主 Agent 可派发子任务给独立子 Agent 执行）
    const taskTool = createTaskTool(sessionId, channelConfig, cwd ?? process.cwd(), piCore, piAgentCore)
    const agentTools = [...finalBaseTools, ...mcpTools, taskTool]

    // 创建 Agent（挂 beforeToolCall 权限钩子）
    const agent = new piAgentCore.Agent({
      initialState: {
        systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        model,
        thinkingLevel: channelConfig.type === 'external' && channelConfig.thinkingEnabled
          ? (channelConfig.thinkingLevel ?? 'medium')
          : 'off',
        tools: agentTools,
        messages: [],
      },
      streamFn,
      toolExecution: 'sequential',
      ...(beforeToolCall ? { beforeToolCall } : {}),
    } as never)

    return { agent, controller, isStreaming: false }
  }
}

// ===== AgentEvent → SDKMessage 转译 =====

/**
 * Pi AgentEvent → TAgent SDKMessage 数组
 *
 * 一个 AgentEvent 可能产出多条 SDKMessage（如 turn_end 同时产出 assistant + tool_result）
 * 参考 kscc-message-adapter.ts 的 IR 转译逻辑
 */
function piEventToSdkMessages(event: AgentEvent, sessionId: string): SDKMessage[] {
  const results: SDKMessage[] = []

  switch (event.type) {
    // ===== agent_start / agent_end：不产出转录消息 =====
    case 'agent_start':
      // Agent 启动，无转录消息
      break

    case 'agent_end':
      // Agent 结束，产出 result
      results.push({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
      } as SDKResultMessage)
      break

    // ===== turn_start / turn_end =====
    case 'turn_start':
      // 新 turn 开始，无转录消息
      break

    case 'turn_end': {
      // turn 结束：产出完整的 assistant 消息
      const { message: turnMsg, toolResults } = event
      // turn_end 的 message 一定是 AssistantMessage（agent 完成一轮 assistant 输出）
      if (turnMsg.role === 'assistant') {
        results.push(piAssistantToSdk(turnMsg as AssistantMessage, sessionId))
      }

      // tool_result 作为独立 user 消息（匹配 SDK 格式）
      if (toolResults && toolResults.length > 0) {
        for (const tr of toolResults) {
          results.push(piToolResultToSdk(tr, sessionId))
        }
      }
      break
    }

    // ===== message_start / message_update / message_end =====
    case 'message_start': {
      // 消息开始（assistant），产出流式 stream_event
      const msg = event.message
      if (msg.role === 'assistant') {
        // 检查是否有 thinking 或 text 内容开始
        for (const block of msg.content) {
          if (block.type === 'thinking') {
            results.push({
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: { type: 'thinking_delta', thinking: '' },
              },
            } as SDKMessage)
          }
        }
      }
      break
    }

    case 'message_update': {
      // 流式 delta：转成 stream_event
      const { assistantMessageEvent } = event
      const streamMsg = piStreamEventToSdk(assistantMessageEvent, sessionId)
      if (streamMsg) {
        results.push(streamMsg)
      }
      break
    }

    case 'message_end': {
      // pi-agent-core 的 Agent 会吞掉 streamFn 的 error 事件：stream 返回 error 时，
      // Agent 不抛、不走 error 路径，而是照常走 message_end / turn_end / agent_end，
      // 把错误信息藏在 message 的 stopReason='error' + errorMessage 里。
      // 不处理的话上层"不报错但回复看不到"（空白消息）。
      // 这里检测到 error 就产出一条可见的 assistant 文本 + error result，让 renderer 显示错误。
      const msg = event.message as { stopReason?: string; errorMessage?: string; role?: string }
      if (msg?.stopReason === 'error' && msg.errorMessage) {
        console.error(`[Pi 适配器 ${sessionId}] stream error 被 Agent 吞掉，已捕获: ${msg.errorMessage.slice(0, 120)}`)
        // 可见错误文本（renderer 会作为 assistant 消息显示）
        results.push({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `[请求失败] ${msg.errorMessage}` }],
            usage: { input_tokens: 0, output_tokens: 0 },
            model: '',
            stop_reason: 'error',
          },
          parent_tool_use_id: null,
          session_id: sessionId,
        } as SDKAssistantMessage)
        // error result（让 renderer 的 result 分支结束本轮 + 标红）
        results.push({
          type: 'result',
          subtype: 'error_during_execution',
          usage: { input_tokens: 0, output_tokens: 0 },
          errors: [msg.errorMessage],
        } as SDKResultMessage)
      }
      break
    }

    // ===== tool_execution_start / end =====
    case 'tool_execution_start': {
      // 工具开始执行：产出 tool_progress 类消息
      results.push({
        type: 'tool_progress',
        tool_use_id: event.toolCallId,
        tool_name: event.toolName,
        parent_tool_use_id: null,
      } as SDKMessage)
      break
    }

    case 'tool_execution_update':
      // 工具执行中间更新，暂不转译
      break

    case 'tool_execution_end': {
      // 工具执行结束：tool_result 已在 turn_end 处理
      // 这里不额外产出（避免重复）
      break
    }
  }

  return results
}

/**
 * Pi AssistantMessage → SDKAssistantMessage
 *
 * 将 Pi 的 assistant 消息转成 TAgent 渲染层能理解的 SDK 格式。
 */
function piAssistantToSdk(msg: AssistantMessage, sessionId: string): SDKAssistantMessage {
  const content = msg.content.map(block => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: (block as TextContent).text }
    }
    if (block.type === 'thinking') {
      return { type: 'thinking' as const, thinking: (block as ThinkingContent).thinking }
    }
    if (block.type === 'toolCall') {
      const tc = block as ToolCall
      return {
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      }
    }
    // 兜底
    return block as { type: string; [key: string]: unknown }
  })

  return {
    type: 'assistant',
    message: {
      content,
      usage: piUsageToSdk(msg.usage),
      model: msg.model,
      stop_reason: piStopReasonToSdk(msg.stopReason),
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  }
}

/**
 * Pi ToolResultMessage → SDKUserMessage（内含 tool_result 块）
 */
function piToolResultToSdk(tr: ToolResultMessage, sessionId: string): SDKUserMessage {
  // 提取文本内容
  const textContent = tr.content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('\n')

  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: tr.toolCallId,
          content: textContent || undefined,
          is_error: tr.isError,
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  }
}

/**
 * Pi AssistantMessageEvent → SDK stream_event（流式 delta）
 */
function piStreamEventToSdk(
  ev: AssistantMessageEvent,
  sessionId: string,
): SDKMessage | null {
  switch (ev.type) {
    case 'text_delta':
      return {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: ev.delta },
        },
        session_id: sessionId,
      } as SDKMessage

    case 'thinking_delta':
      return {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: ev.delta },
        },
        session_id: sessionId,
      } as SDKMessage

    case 'toolcall_delta':
      // 工具调用 delta，暂不转译（等 toolcall_end 产出完整 tool_use）
      return null

    case 'toolcall_end': {
      // 工具调用完成：产出包含 tool_use 块的 assistant 消息
      const tc = ev.toolCall
      return {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      } as SDKAssistantMessage
    }

    case 'done':
    case 'error':
      // done/error 由 agent_end / turn_end 处理
      return null

    default:
      // start / text_start / text_end / thinking_start / thinking_end / toolcall_start
      // 这些事件暂不产出流式 delta
      return null
  }
}

// ===== 工具函数 =====

/** Pi Usage → SDK usage 格式 */
function piUsageToSdk(usage: Usage): SDKAssistantMessage['message']['usage'] {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
  }
}

/** Pi stopReason → SDK stop_reason */
function piStopReasonToSdk(reason: string): string {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'length': return 'max_tokens'
    case 'toolUse': return 'tool_use'
    case 'error': return 'error'
    case 'aborted': return 'aborted'
    default: return reason
  }
}

/** 零成本占位（streamFn 内部有预构造的 Model，这里仅给 Agent initialState 用） */
const ZERO_COST: ModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

/** 根据渠道配置构造占位 Model 对象（streamFn 内部有预构造的，这里仅给 Agent initialState 用） */
function buildPlaceholderModel(config: PiAgentAdapterConfig): Model<Api> {
  if (config.type === 'external') {
    return {
      id: config.modelId,
      name: config.modelId,
      api: resolveApiForProvider(config.provider) as Api,
      provider: config.provider,
      baseUrl: config.baseUrl ?? '',
      reasoning: config.thinkingEnabled ?? false,
      input: ['text'],
      cost: ZERO_COST,
      contextWindow: 128_000,
      maxTokens: 8_192,
    }
  }
  // kscc bare 模式
  return {
    id: config.defaultModelId ?? 'glm-5.2',
    name: config.defaultModelId ?? 'glm-5.2',
    api: 'openai-completions' as Api,
    provider: 'kscc',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: ZERO_COST,
    contextWindow: 128_000,
    maxTokens: 8_192,
  }
}

/** provider 类型名 → pi-ai api 标识 */
function resolveApiForProvider(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'anthropic-messages'
    case 'deepseek': return 'openai-completions'
    case 'openai': return 'openai-responses'
    case 'google': return 'google-generative-ai'
    default: return 'openai-completions'
  }
}

/** 默认系统提示词 */
const DEFAULT_SYSTEM_PROMPT = `你是一个专业的编程助手，帮助用户完成软件开发任务。
你可以读取文件、编辑代码、执行命令来完成任务。
请用中文回复，保留必要的专业术语。`
