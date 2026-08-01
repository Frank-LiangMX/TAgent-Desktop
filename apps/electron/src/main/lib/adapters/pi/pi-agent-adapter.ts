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
  TAgentMessage,
  TAgentContentBlock,
  TAgentUsage,
  TAgentControlEvent,
  TAgentDesktopStreamPayload,
} from '@tagent/shared'
import { buildRichContentSystemPrompt, isPromptTooLongMessage } from '@tagent/shared'
import {
  buildMemoryPromptSections,
  memoryLayerService,
  type MemoryMode,
} from '../../memory'

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

// Pi 栈（pi-core / pi-ai / pi-agent-core）在 build:main 时打进 dist/main.cjs（CJS），
// 勿再 external 后运行时 require——这些包 package.json 多为 ESM-only exports，
// Electron 主进程 require 会 ERR_PACKAGE_PATH_NOT_EXPORTED。
// 动态 import 仍可懒加载；打包后 esbuild 会解析进同一 CJS 包。
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
  /**
   * 模型标称上下文窗口（token）。由 session-service 从 ChannelModel.contextWindow 注入。
   * buildPlaceholderModel 用它替代旧的 128k 硬编码；缺失走 fallback(200k)。
   */
  contextWindow?: number
}

/** Pi 核适配器配置（kscc bare 模式） */
export interface PiKsccChannelConfig {
  type: 'kscc'
  /** kscc 可执行文件路径 */
  ksccPath?: string
  /** 默认模型 ID */
  defaultModelId?: string
  /** 模型标称上下文窗口（token），同 PiExternalChannelConfig.contextWindow */
  contextWindow?: number
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
  /** 记忆模式（Phase 2.2 Frozen 快照 / Phase 3 L-rag） */
  sessionMode?: MemoryMode
}

// ===== 会话状态 =====

/** 压缩资源（外部渠道创建 Agent 时缓存，供 transformContext / compactSession 复用） */
interface SessionCompactionBundle {
  contextWindow: number
  settings: import('@tagent/pi-core').TagentCompactionSettings
  piSettings: import('@earendil-works/pi-agent-core').CompactionSettings
  models: import('@earendil-works/pi-ai').Models
  model: Model<Api>
}

/** 单个会话的运行时状态 */
interface SessionEntry {
  /** Pi Agent 实例 */
  agent: AgentType
  /** 中止控制器 */
  controller: AbortController
  /** 是否正在流式输出 */
  isStreaming: boolean
  /** 当前 Agent 使用的渠道 / 模型配置 */
  channelConfig: PiAgentAdapterConfig
  /** 外部渠道压缩资源；kscc bare 为 undefined */
  compaction?: SessionCompactionBundle
  /** transformContext 自动压缩时暂存的 system 事件，下一轮 query 流开头排出 */
  pendingSystemMessages: TAgentDesktopStreamPayload[]
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
    const { sessionId, prompt, channelConfig, systemPrompt, tools, mcpConfig, cwd, beforeToolCall, abortSignal, sessionMode } = input

    // 创建或复用 Agent 实例。外部运行内核允许同会话切换渠道 / 模型：
    // streamFn 与 task 工具都捕获了渠道配置，因此配置变化时保留消息历史并重建 Agent。
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = await this.createSession(sessionId, channelConfig, systemPrompt, tools, mcpConfig, cwd, beforeToolCall, sessionMode)
      this.sessions.set(sessionId, entry)
    } else if (!isSameChannelConfig(entry.channelConfig, channelConfig)) {
      if (entry.isStreaming) {
        throw new Error(`[pi adapter] 会话 ${sessionId} 仍在运行，暂不能切换渠道或模型`)
      }
      const previousMessages = [...entry.agent.state.messages]
      const previousEntry = entry
      entry = await this.createSession(
        sessionId,
        channelConfig,
        systemPrompt,
        tools,
        mcpConfig,
        cwd,
        beforeToolCall,
        sessionMode,
      )
      ;(entry.agent.state as { messages: typeof previousMessages }).messages = previousMessages
      previousEntry.agent.abort()
      previousEntry.controller.abort()
      this.sessions.set(sessionId, entry)
    }

    const { agent, controller } = entry

    // 如果外部有 AbortSignal，联动到内部 controller
    if (abortSignal) {
      const onAbort = () => controller.abort()
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    // 创建事件队列：AgentEvent 回调往里推，generator 从里取
    // 队列装 TAgentDesktopStreamPayload（pi 直接产 IR，不经 SDKMessage 中转）
    const queue: TAgentDesktopStreamPayload[] = []
    let waiting: boolean = false
    let resolveWait: (() => void) | null = null
    let generatorDone = false
    let generatorError: Error | null = null

    /** 推一条 payload 进队列，唤醒等待中的 generator */
    const pushMessage = (p: TAgentDesktopStreamPayload) => {
      queue.push(p)
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
        const payloads = piEventToIR(event, sessionId)
        for (const p of payloads) {
          pushMessage(p)
        }
      } catch (err) {
        console.error(`[Pi 适配器 ${sessionId}] 转译 ${event.type} 抛错:`, err)
        generatorError = err instanceof Error ? err : new Error(String(err))
        wakeGenerator()
      }
    })

    // 排出上一次 compactSession / transformContext 暂存的 system 事件（UI 压缩条）
    if (entry.pendingSystemMessages.length > 0) {
      const pending = entry.pendingSystemMessages.splice(0, entry.pendingSystemMessages.length)
      for (const msg of pending) pushMessage(msg)
    }

    // 启动对话（fire-and-forget，与 generator 并发）；过长时 force compact 再试一次
    entry.isStreaming = true
    void (async () => {
      const runPrompt = async (): Promise<void> => {
        await agent.prompt(prompt)
      }
      try {
        await runPrompt()
      } catch (err: unknown) {
        console.error(`[Pi 适配器 ${sessionId}] agent.prompt 抛错:`, err)
        const errorMsg = err instanceof Error ? err.message : String(err)
        if (isPromptTooLongMessage(errorMsg) && entry.compaction) {
          console.log(`[pi-compaction] ${sessionId} 过长错误 → force compact 后重试一次`)
          entry.isStreaming = false
          const cr = await this.compactSession(sessionId, { force: true, trigger: 'auto' })
          // compactSession 写入 pending；立即排出到当前流
          while (entry.pendingSystemMessages.length > 0) {
            pushMessage(entry.pendingSystemMessages.shift()!)
          }
          if (cr.compacted) {
            try {
              await runPrompt()
              return
            } catch (err2: unknown) {
              const msg2 = err2 instanceof Error ? err2.message : String(err2)
              pushMessage({
                kind: 'result',
                subtype: 'error_during_execution',
                usage: { inputTokens: 0, outputTokens: 0 },
                // errors 供 session-runtime 过长检测（见 runLoop 归一化）
                errors: [msg2],
              } as TAgentControlEvent)
              return
            }
          }
        }
        pushMessage({
          kind: 'result',
          subtype: 'error_during_execution',
          usage: { inputTokens: 0, outputTokens: 0 },
          errors: [errorMsg],
        } as TAgentControlEvent)
      } finally {
        entry.isStreaming = false
        generatorDone = true
        wakeGenerator()
      }
    })()

    // generator: 从队列消费 SDKMessage（与 prompt 并发跑，流式 delta 实时吐）
    try {
      while (true) {
        await waitForNext()

        if (generatorError) {
          throw generatorError
        }

        const batch = queue.splice(0)
        for (const p of batch) {
          // 接口契约为 AsyncIterable<SDKMessage>；pi 实际产 TAgentDesktopStreamPayload，
          // 单点 as 适配，session-service 按 coreKind 还原（见 handlePiStreamPayload）
          yield p as unknown as SDKMessage
        }

        if (generatorDone && queue.length === 0) {
          break
        }
      }
    } finally {
      unsubscribe()
    }
  }

  /** 查询某会话是否有活跃的 Agent 实例 */
  hasActiveChannel(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** 取出并清空 pending system 消息（手动压缩后立即推 UI） */
  drainPendingSystemMessages(sessionId: string): TAgentDesktopStreamPayload[] {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.pendingSystemMessages.length === 0) return []
    return entry.pendingSystemMessages.splice(0, entry.pendingSystemMessages.length)
  }

  /**
   * 压缩会话上下文（手动 IPC / 过长重试）。
   * 仅外部渠道且已有 Agent 时可用；算法走 Pi generateSummary，编排自研。
   */
  async compactSession(
    sessionId: string,
    options?: { force?: boolean; trigger?: 'auto' | 'manual' },
  ): Promise<{
    ok: boolean
    compacted: boolean
    reason?: string
    tokensBefore?: number
    summary?: string
  }> {
    const entry = this.sessions.get(sessionId)
    if (!entry) {
      return { ok: false, compacted: false, reason: 'no active session' }
    }
    // 过长重试时 force=true 且可能仍标记 isStreaming：允许强制压缩
    if (entry.isStreaming && !options?.force) {
      return { ok: false, compacted: false, reason: 'session is streaming' }
    }
    if (!entry.compaction) {
      return { ok: false, compacted: false, reason: 'compaction not available (kscc bare or missing)' }
    }
    const trigger = options?.trigger ?? 'manual'
    const force = options?.force ?? trigger === 'manual'
    entry.pendingSystemMessages.push(makeCompactingEvent())
    try {
      const piCore = await loadPiCore()
      const result = await piCore.maybeCompactMessages({
        messages: [...entry.agent.state.messages],
        contextWindow: entry.compaction.contextWindow,
        settings: entry.compaction.piSettings,
        models: entry.compaction.models,
        model: entry.compaction.model,
        force,
      })
      if (!result.compacted) {
        entry.pendingSystemMessages.push(
          makeCompactBoundaryEvent({
            trigger,
            noop: true,
            reason: result.reason,
            tokensBefore: result.tokensBefore,
          }),
        )
        return {
          ok: true,
          compacted: false,
          reason: result.reason,
          tokensBefore: result.tokensBefore,
        }
      }
      entry.agent.state.messages = result.messages
      entry.pendingSystemMessages.push(
        makeCompactBoundaryEvent({
          trigger,
          tokensBefore: result.tokensBefore,
          summary: result.summary,
        }),
      )
      console.log(
        `[pi-compaction] ${sessionId} compactSession(${trigger}) ok tokensBefore=${result.tokensBefore}`,
      )
      return {
        ok: true,
        compacted: true,
        tokensBefore: result.tokensBefore,
        summary: result.summary,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[pi-compaction] ${sessionId} compactSession 失败:`, err)
      return { ok: false, compacted: false, reason }
    }
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
    void loadPiCore()
      .then((piCore) => {
        piCore.disposeSessionMemoryCoordinator?.(sessionId)
      })
      .catch(() => {
        /* ignore */
      })
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
    sessionMode: MemoryMode = 'general',
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

    // 上下文自动压缩接线（TAgent 自研，仅外部渠道；kscc bare 暂不接线，见 plan §4.2）。
    // 算法用 Pi（estimateContextTokens/shouldCompact/generateSummary），编排/写回用 TAgent。
    // transformContext 仅影响本轮请求视图，故压缩后需显式写回 state.messages（plan §4.3），
    // 并原地替换本轮视图避免同一 run 内重复压缩。
    let agentRef: AgentType | null = null
    let entryRef: SessionEntry | null = null
    let transformContext: ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined
    let compactionBundle: SessionCompactionBundle | undefined
    if (channelConfig.type === 'external') {
      const compactionSettings = piCore.buildTagentCompactionSettings(model.contextWindow)
      const piCompactionSettings = piCore.toPiCompactionSettings(compactionSettings)
      const compactionModels = piCore.createCompactionModelsShim(streamFn, model)
      compactionBundle = {
        contextWindow: compactionSettings.contextWindow,
        settings: compactionSettings,
        piSettings: piCompactionSettings,
        models: compactionModels,
        model,
      }
      // Phase 3：8k 四层协调器（L-rag + L-mid 链 + 异步自动压缩）
      const coordinator = piCore.getSessionMemoryCoordinator(sessionId)
      transformContext = async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
        try {
          const result = await coordinator.reconcile({
            messages,
            contextWindow: compactionSettings.contextWindow,
            settings: piCompactionSettings,
            models: compactionModels,
            model,
            signal,
            asyncAuto: true,
            retrieveRag: async (query: string) => {
              const out: Array<{ source: string; text: string; score?: number }> = []
              try {
                const hits = memoryLayerService.searchSessions(sessionMode, query, 5)
                for (const h of hits) {
                  out.push({
                    source: `L4:${h.session_slug ?? h.id}`,
                    text: `${h.title ?? ''}\n${h.summary ?? ''}`.trim(),
                    score: 1,
                  })
                }
              } catch {
                /* ignore L4 */
              }
              // 本会话向量（D11）
              try {
                const { searchSessionVectors } = await import('../../memory/session-vector-store')
                const local = await searchSessionVectors({
                  sessionId,
                  query,
                  topK: 3,
                })
                for (const h of local) {
                  out.push({
                    source: `local:${h.turnHint ?? h.id}`,
                    text: h.text,
                    score: h.score,
                  })
                }
              } catch {
                /* ignore local */
              }
              return out
            },
            onCompacted: (r) => {
              if (!r.compacted) return
              if (agentRef) agentRef.state.messages = r.messages
              entryRef?.pendingSystemMessages.push(
                makeCompactingEvent(),
                makeCompactBoundaryEvent({
                  trigger: 'auto',
                  tokensBefore: r.tokensBefore,
                  summary: r.summary,
                }),
              )
              // 被压出窗口的摘要段进本会话向量库（异步）
              if (r.summary) {
                void import('../../memory/session-vector-store')
                  .then(({ indexSessionChunks }) =>
                    indexSessionChunks({
                      sessionId,
                      chunks: [
                        {
                          id: `compact-${Date.now()}`,
                          text: r.summary ?? '',
                          turnHint: 'mid',
                        },
                      ],
                    }),
                  )
                  .catch(() => {
                    /* ignore */
                  })
              }
            },
          })
          if (!result.compacted) {
            if (
              result.reason &&
              result.reason !== 'below threshold' &&
              result.reason !== 'disabled' &&
              result.reason !== 'empty' &&
              result.reason !== 'async pending'
            ) {
              console.log(`[pi-compaction] ${sessionId} 跳过压缩: ${result.reason}`)
            }
            // 仍可能注入了 L-rag / L-mid 前缀
            if (result.messages !== messages) {
              messages.length = 0
              messages.push(...result.messages)
            }
            return messages
          }
          console.log(
            `[pi-compaction] ${sessionId} 已压缩 tokensBefore=${result.tokensBefore} ` +
              `summaryLen=${result.summary?.length ?? 0} 压后消息数=${result.messages.length}`,
          )
          if (agentRef) agentRef.state.messages = result.messages
          entryRef?.pendingSystemMessages.push(
            makeCompactingEvent(),
            makeCompactBoundaryEvent({
              trigger: 'auto',
              tokensBefore: result.tokensBefore,
              summary: result.summary,
            }),
          )
          if (result.ragHits.length > 0) {
            entryRef?.pendingSystemMessages.push({
              kind: 'tagent_event',
              event: { type: 'rag_hit', hits: result.ragHits },
            } as TAgentDesktopStreamPayload)
          }
          messages.length = 0
          messages.push(...result.messages)
          return messages
        } catch (err) {
          console.error(`[pi-compaction] ${sessionId} 压缩异常，回退原消息:`, err)
          return messages
        }
      }
    }

    // Phase 2.2/2.4：记忆管理规则 + Frozen 记忆快照（createSession 读一次写死，保 cache）
    const snap = memoryLayerService.readMemorySnapshot(sessionMode)
    const mem = buildMemoryPromptSections({
      mode: sessionMode,
      memorySnapshot: { l0: snap.l0User, l1: snap.l1Project, l2: snap.l2Facts },
    })
    const baseSystem = systemPrompt ?? DEFAULT_SYSTEM_PROMPT
    const fullSystemPrompt = [baseSystem, buildRichContentSystemPrompt(), mem.managementRules, mem.memorySnapshotSection]
      .filter(Boolean)
      .join('\n\n')

    // 创建 Agent（挂 beforeToolCall 权限钩子 + 外部渠道的 transformContext 压缩钩子）
    const agent = new piAgentCore.Agent({
      initialState: {
        systemPrompt: fullSystemPrompt,
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
      ...(transformContext ? { transformContext } : {}),
    } as never)
    agentRef = agent
    const entry: SessionEntry = {
      agent,
      controller,
      isStreaming: false,
      channelConfig,
      compaction: compactionBundle,
      pendingSystemMessages: [],
    }
    entryRef = entry
    return entry
  }
}

// ===== 压缩控制事件工厂（TAgent 自研，直接产 IR tagent_event，不绕伪 SDK system 消息） =====

function makeCompactingEvent(): TAgentControlEvent {
  return { kind: 'tagent_event', event: { type: 'compacting' } }
}

function makeCompactBoundaryEvent(opts: {
  trigger: 'auto' | 'manual'
  tokensBefore?: number
  summary?: string
  noop?: boolean
  reason?: string
}): TAgentControlEvent {
  return {
    kind: 'tagent_event',
    event: {
      type: 'compact_complete',
      trigger: opts.trigger,
      tokensBefore: opts.tokensBefore,
    },
  }
}

// ===== AgentEvent → IR（TAgentDesktopStreamPayload）转译 =====
// 彻底脱离 Claude SDKMessage：pi 事件直接翻成渲染层 IR + 控制事件，不再中转 SDKMessage。
// 覆盖 4 件原翻译层凭空做的事：① content block 改名(toolCall→tool_use, arguments→input)
// ② usage 字段名(input→inputTokens …) ③ stream error 兜底 ④ compact 控制事件。

/** Pi Usage → IR TAgentUsage（字段名映射） */
function piUsageToIR(u: Usage): TAgentUsage {
  return {
    inputTokens: Number(u.input ?? 0),
    outputTokens: Number(u.output ?? 0),
    cacheReadTokens: Number(u.cacheRead ?? 0),
    cacheCreationTokens: Number(u.cacheWrite ?? 0),
    costUsd: typeof u.cost?.total === 'number' ? u.cost.total : undefined,
  }
}

/** Pi AssistantMessage content block → IR TAgentContentBlock */
function piBlockToIR(block: AssistantMessage['content'][number]): TAgentContentBlock {
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'thinking') {
    return { type: 'thinking', thinking: block.thinking }
  }
  // toolCall → tool_use，arguments → input
  const tc = block as ToolCall
  return { type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments }
}

/** Pi AssistantMessage → IR TAgentAssistantMessage */
function piAssistantToIR(msg: AssistantMessage, sessionId: string): TAgentMessage {
  const content = msg.content.map(piBlockToIR)
  const isError = msg.stopReason === 'error'
  return {
    type: 'assistant',
    sessionId,
    modelId: msg.model,
    content,
    usage: msg.usage ? piUsageToIR(msg.usage) : undefined,
    error: isError ? { message: msg.errorMessage ?? '' } : undefined,
  }
}

/** Pi ToolResultMessage → IR TAgentUserMessage（内含 tool_result 块） */
function piToolResultToIR(tr: ToolResultMessage, sessionId: string): TAgentMessage {
  const textContent = tr.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
  return {
    type: 'user',
    sessionId,
    content: [
      {
        type: 'tool_result',
        toolUseId: tr.toolCallId,
        content: textContent || undefined,
        isError: tr.isError,
      },
    ],
  } as TAgentMessage
}

/** Pi AssistantMessageEvent → IR 流式 delta / 工具完成消息 */
function piStreamEventToIR(ev: AssistantMessageEvent, sessionId: string): TAgentDesktopStreamPayload | null {
  switch (ev.type) {
    case 'text_delta':
      return { kind: 'stream_text_delta', text: ev.delta }
    case 'thinking_delta':
      return { kind: 'stream_thinking_delta', text: ev.delta }
    case 'toolcall_end': {
      const tc = ev.toolCall
      const message: TAgentMessage = {
        type: 'assistant',
        sessionId,
        content: [{ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments }],
      }
      return { kind: 'sdk_message', message }
    }
    // toolcall_delta / done / error / start 类：不产流式 delta（done/error 由 turn_end/agent_end 处理）
    default:
      return null
  }
}

/**
 * Pi AgentEvent → IR payload 数组（一个事件可产多条，如 turn_end 产 assistant + tool_result）
 */
function piEventToIR(event: AgentEvent, sessionId: string): TAgentDesktopStreamPayload[] {
  const results: TAgentDesktopStreamPayload[] = []

  switch (event.type) {
    case 'agent_start':
    case 'turn_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
      // 无转录 / 已在 turn_end 处理（tool_progress 渲染层不消费，直接略）
      break

    case 'agent_end': {
      // 从最后一条带 usage 的 assistant 汇总 result.usage（底栏 TokenStatsBar）
      const endMsgs = event.messages ?? []
      let usage: TAgentUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }
      let totalCostUsd: number | undefined
      for (let i = endMsgs.length - 1; i >= 0; i--) {
        const m = endMsgs[i]
        if (m && m.role === 'assistant' && 'usage' in m && m.usage) {
          const u = m.usage as Usage
          const ir = piUsageToIR(u)
          const inTok = ir.inputTokens ?? 0
          const cacheRead = ir.cacheReadTokens ?? 0
          const cacheWrite = ir.cacheCreationTokens ?? 0
          // 占用口径：优先 provider totalTokens；否则 input+cache（与 statusline 一致）
          const contextUsed =
            typeof u.totalTokens === 'number' && u.totalTokens > 0 ? u.totalTokens : inTok + cacheRead + cacheWrite
          usage = {
            inputTokens: contextUsed,
            outputTokens: ir.outputTokens,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheWrite,
            costUsd: ir.costUsd,
          }
          totalCostUsd = ir.costUsd
          break
        }
      }
      results.push({ kind: 'result', subtype: 'success', usage, totalCostUsd })
      break
    }

    case 'turn_end': {
      const { message: turnMsg, toolResults } = event
      if (turnMsg.role === 'assistant') {
        results.push({ kind: 'sdk_message', message: piAssistantToIR(turnMsg as AssistantMessage, sessionId) })
      }
      if (toolResults && toolResults.length > 0) {
        for (const tr of toolResults) {
          results.push({ kind: 'sdk_message', message: piToolResultToIR(tr, sessionId) })
        }
      }
      break
    }

    case 'message_start': {
      // 仅有 thinking block 时产一条空 thinking_delta 占位（流式起点，对齐旧逻辑）
      const msg = event.message
      if (msg.role === 'assistant' && msg.content.some((b) => b.type === 'thinking')) {
        results.push({ kind: 'stream_thinking_delta', text: '' })
      }
      break
    }

    case 'message_update': {
      const streamPayload = piStreamEventToIR(event.assistantMessageEvent, sessionId)
      if (streamPayload) results.push(streamPayload)
      break
    }

    case 'message_end': {
      // stream error 兜底：pi-agent-core 吞掉 stream error、走 message_end，错误藏在
      // stopReason='error'+errorMessage。检测到就产一条可见错误 assistant + error result，否则"不报错但空白"。
      const msg = event.message as { stopReason?: string; errorMessage?: string; role?: string }
      if (msg?.stopReason === 'error' && msg.errorMessage) {
        console.error(`[Pi 适配器 ${sessionId}] stream error 被 Agent 吞掉，已捕获: ${msg.errorMessage.slice(0, 120)}`)
        const errorText = formatStreamErrorForUser(msg.errorMessage)
        results.push({
          kind: 'sdk_message',
          message: {
            type: 'assistant',
            sessionId,
            content: [{ type: 'text', text: errorText }],
            error: { message: msg.errorMessage },
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        })
        results.push({
          kind: 'result',
          subtype: 'error_during_execution',
          usage: { inputTokens: 0, outputTokens: 0 },
        })
      }
      break
    }

    case 'tool_execution_start':
      // 渲染层不消费 tool_progress（sdkMessageToIR 也丢弃），略。工具调用展示靠 turn_end 的 tool_use + tool_result。
      break
  }

  return results
}

// ===== 工具函数 =====

/**
 * 将 pi-ai / SDK 原始错误文案整理成用户可读的中文提示。
 * 常见：「Request timed out.」来自 OpenAI SDK 的 APIConnectionTimeoutError（到首包超时）。
 */
function formatStreamErrorForUser(raw: string): string {
  const msg = (raw || '').trim()
  const lower = msg.toLowerCase()

  if (
    lower.includes('request timed out') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('etimedout')
  ) {
    return [
      '[请求失败] 模型接口响应超时。',
      '多轮工具后上下文变大，或 thinking 模型在出字前处理较久时容易触发。',
      '可稍后重试；若反复出现，可新开会话缩短上下文，或检查网络与渠道连通性。',
      msg ? `（原始错误：${msg}）` : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key') ||
    lower.includes('authentication')
  ) {
    return `[请求失败] 鉴权失败，请检查 API Key 与渠道配置。（${msg}）`
  }

  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  ) {
    return `[请求失败] 请求过于频繁或额度受限，请稍后重试。（${msg}）`
  }

  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('network') ||
    lower.includes('fetch failed')
  ) {
    return `[请求失败] 网络连接失败，请检查网络与 base URL。（${msg}）`
  }

  return `[请求失败] ${msg || '未知错误'}`
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
      // 优先用注入的真实窗口（session-service 从 ChannelModel.contextWindow 解析），
      // 缺失走 fallback(200k)。替代旧的 128k 硬编码（Phase 1.1）。
      contextWindow: config.contextWindow && config.contextWindow > 0 ? config.contextWindow : 200_000,
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
    contextWindow: config.contextWindow && config.contextWindow > 0 ? config.contextWindow : 200_000,
    maxTokens: 8_192,
  }
}

/** 判断 Pi streamFn 所依赖的配置是否完全一致。 */
function isSameChannelConfig(
  left: PiAgentAdapterConfig,
  right: PiAgentAdapterConfig,
): boolean {
  if (left.type !== right.type) return false
  if (left.type === 'external' && right.type === 'external') {
    return left.provider === right.provider
      && left.apiKey === right.apiKey
      && left.baseUrl === right.baseUrl
      && left.modelId === right.modelId
      && left.thinkingEnabled === right.thinkingEnabled
      && left.thinkingLevel === right.thinkingLevel
  }
  if (left.type === 'kscc' && right.type === 'kscc') {
    return left.ksccPath === right.ksccPath
      && left.defaultModelId === right.defaultModelId
  }
  return false
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
