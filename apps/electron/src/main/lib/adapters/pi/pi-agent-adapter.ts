/**
 * Pi 核适配器（外部渠道 + kscc bare 双模式）
 *
 * 2.0 双核之一。见 docs/plans/2026-07-25-2.0-architecture-decision-dual-core.md §7.1。
 *
 * 跟 kscc 核的区别：
 * - 不 spawn 子进程（Pi Agent 在主进程内存）
 * - **Agent 对象**可跨轮保留在 `sessions` Map（state.messages 自管）；**但**
 *   SessionRuntime 的事件 loop 每轮 result 后关闭（非 kscc 式长驻 query）
 * - 多轮 = 下一轮重新 `query()` 复用 entry，不是 channel.enqueue 续跑
 * - 上下文 Pi 自管（state.messages），无 SDK resume cache
 * - Xfast/MoA 全活（Pi 管工具循环，可并行）
 *
 * 架构：
 * - PiAgentAdapter 单例管理 Map<sessionId, SessionEntry>，每个会话一个 Agent 实例
 * - query() 创建/复用 Agent，subscribe 监听 AgentEvent，转译成 IR 推给调用方
 * - 外部渠道用 createHttpDirectStreamFn，kscc bare 用 createKsccBareStreamFn
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
import {
  buildOutputStylePrompt,
  buildRichContentSystemPrompt,
  isPromptTooLongMessage,
} from '@tagent/shared'
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
  /**
   * 追加到系统提示词末尾（不整体替换默认 prompt）
   * 用于 executionMode 策略等短段落
   */
  systemPromptAppend?: string
  /**
   * 执行形态（Chat|Work）。SessionRuntime 用其判断是否需 re-spawn；
   * Pi 核内还用 extraTools/systemPromptAppend 指纹热重建 Agent。
   */
  executionMode?: 'chat' | 'work'
  /** 自定义工具列表（默认用 pi-core 的 defaultTools + mcpTools） */
  tools?: AgentTool[]
  /** 追加工具（与默认工具合并，不替换） */
  extraTools?: AgentTool[]
  /** 工作区 MCP 配置（合并 mcpTools） */
  mcpConfig?: { servers: Record<string, unknown> }
  /** 工作目录（bashTool/相对路径用，不传 process.cwd） */
  cwd?: string
  /** 权限模式回调（beforeToolCall 用） */
  beforeToolCall?: (ctx: { toolCall: { name: string; arguments: Record<string, unknown> } }) => Promise<{ block: true; reason: string } | undefined>
  /** 记忆模式（Phase 2.2 Frozen 快照 / Phase 3 L-rag） */
  sessionMode?: MemoryMode
  /**
   * 单轮工具循环上限（assistant 响应次数）。默认 {@link DEFAULT_PI_MAX_TURNS}。
   * 超限产 error_max_turns 并结束本轮，防止死循环。
   */
  maxTurns?: number
}

// ===== 稳定性常量（turn 重试 / maxTurns）=====

/** 单轮工具循环默认上限（与 kscc 核 session-service maxTurns:50 对齐） */
export const DEFAULT_PI_MAX_TURNS = 50
/** agent.prompt / 本轮执行失败时可重试次数（不含首次） */
export const PI_TURN_MAX_RETRIES = 3
/** 指数退避基数（ms）：1s → 2s → 4s */
export const PI_TURN_RETRY_BASE_DELAY_MS = 1000

/**
 * 判断错误文案是否适合 turn 级重试。
 * 可重试：网络、5xx、超时、429 限流类。
 * 不可重试：鉴权、余额/配额、用户中止/拒绝。
 */
export function isRetryablePiTurnError(raw: string): boolean {
  const msg = (raw || '').trim().toLowerCase()
  if (!msg) return false

  // 不可重试优先
  if (
    /unauthorized|invalid api key|authentication|api[_ -]?key|\b401\b|\b403\b|forbidden/.test(msg) ||
    /insufficient.*(quota|credit|balance|fund)|payment required|billing|out of credit|余额不足|欠费|额度用尽/.test(
      msg,
    ) ||
    /aborted|user rejected|user refused|permission denied by user|cancelled by user|canceled by user|用户取消|用户拒绝/.test(
      msg,
    )
  ) {
    return false
  }

  // 可重试：超时 / 网络 / 5xx / 限流
  if (
    /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|network|fetch failed|socket|eai_again/.test(
      msg,
    ) ||
    /\b50[0234]\b|bad gateway|service unavailable|gateway timeout|overloaded|temporarily unavailable|internal server error/.test(
      msg,
    ) ||
    /\b429\b|rate limit|too many requests/.test(msg)
  ) {
    return true
  }

  return false
}

/** 指数退避延迟（attempt 从 0 起）：base * 2^attempt */
export function piTurnRetryDelayMs(attempt: number, baseMs = PI_TURN_RETRY_BASE_DELAY_MS): number {
  const a = Math.max(0, Math.floor(attempt))
  return baseMs * 2 ** a
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 剥离 transcript 末尾的 error/aborted assistant，便于 continue() 续跑（不整会话清空、不重放工具） */
export function dropTrailingFailedAssistants(messages: AgentMessage[]): AgentMessage[] {
  const out = messages.slice()
  while (out.length > 0) {
    const last = out[out.length - 1]
    if (
      last &&
      last.role === 'assistant' &&
      ((last as AssistantMessage).stopReason === 'error' ||
        (last as AssistantMessage).stopReason === 'aborted')
    ) {
      out.pop()
      continue
    }
    break
  }
  return out
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
  /**
   * 工具 + 执行形态指纹（extraTools 名 + systemPromptAppend）。
   * Chat↔Work 切换后不同 → 须重建 Agent（否则看板工具永远不进上下文）。
   */
  toolingKey: string
  /** 外部渠道压缩资源；kscc bare 为 undefined */
  compaction?: SessionCompactionBundle
  /** transformContext 自动压缩时暂存的 system 事件，下一轮 query 流开头排出 */
  pendingSystemMessages: TAgentDesktopStreamPayload[]
  /**
   * 当前 query 活跃时的直播推送（= pushMessage）。
   * 子代理 task_* 等异步事件优先走这里；无活跃 query 时退回 pendingSystemMessages。
   */
  emitLive?: (p: TAgentDesktopStreamPayload) => void
  /** 本轮 query 的工具循环上限 */
  maxTurns: number
  /** 本轮 query 已发生的 turn_start 次数 */
  turnCount: number
  /** 是否因 maxTurns 强制结束（result → error_max_turns） */
  maxTurnsHit: boolean
}

/** 计算工具/执行形态指纹，供 Chat↔Work 热切换判断 */
function computeToolingKey(
  systemPromptAppend: string | undefined,
  extraTools: AgentTool[] | undefined,
): string {
  const tools = (extraTools ?? [])
    .map((t) => t.name)
    .sort()
    .join(',')
  // append 可能较长，取稳定摘要即可
  const append = systemPromptAppend ?? ''
  const mode =
    /协作模式：Work|Work（执行）/.test(append)
      ? 'work'
      : /协作模式：Chat|Chat（只读/.test(append)
        ? 'chat'
        : 'unknown'
  return `${mode}|tools=${tools}|appendLen=${append.length}`
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
    const {
      sessionId,
      prompt,
      channelConfig,
      systemPrompt,
      systemPromptAppend,
      tools,
      extraTools,
      mcpConfig,
      cwd,
      beforeToolCall,
      abortSignal,
      sessionMode,
      maxTurns: maxTurnsOpt,
    } = input

    // 创建或复用 Agent 实例。
    // 渠道/模型变化，或 Chat↔Work 导致 extraTools/systemPromptAppend 变化时：
    // 保留消息历史并重建 Agent（否则看板工具 / Work 文案永远停留在首轮状态）。
    const toolingKey = computeToolingKey(systemPromptAppend, extraTools)
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = await this.createSession(
        sessionId,
        channelConfig,
        systemPrompt,
        tools,
        mcpConfig,
        cwd,
        beforeToolCall,
        sessionMode,
        systemPromptAppend,
        extraTools,
      )
      this.sessions.set(sessionId, entry)
    } else {
      const channelChanged = !isSameChannelConfig(entry.channelConfig, channelConfig)
      const toolingChanged = entry.toolingKey !== toolingKey
      if (channelChanged || toolingChanged) {
        if (entry.isStreaming) {
          throw new Error(
            `[pi adapter] 会话 ${sessionId} 仍在运行，暂不能切换渠道/模型/执行形态工具集`,
          )
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
          systemPromptAppend,
          extraTools,
        )
        ;(entry.agent.state as { messages: typeof previousMessages }).messages = previousMessages
        previousEntry.agent.abort()
        previousEntry.controller.abort()
        this.sessions.set(sessionId, entry)
        if (toolingChanged) {
          console.log(
            `[Pi 适配器 ${sessionId}] 工具/执行形态已热切换: ${previousEntry.toolingKey} → ${toolingKey}`,
          )
        }
      }
    }

    const { agent, controller } = entry
    // 每轮 query 重置 maxTurns 计数（不跨用户回合累计）
    entry.maxTurns =
      typeof maxTurnsOpt === 'number' && maxTurnsOpt > 0 ? Math.floor(maxTurnsOpt) : DEFAULT_PI_MAX_TURNS
    entry.turnCount = 0
    entry.maxTurnsHit = false

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

    // turn 级 retry gate：可重试错误暂扣终态，耗尽后再 flush（避免 UI 先报错再恢复）
    // 用对象承载跨 subscribe / await 的可变状态，避免 TS 把 let 窄化成 never
    const retryGate = {
      retriesLeft: PI_TURN_MAX_RETRIES,
      heldErrorAssistant: null as TAgentDesktopStreamPayload | null,
      heldResult: null as TAgentControlEvent | null,
      lastEndRetryableError: null as string | null,
    }

    const isAborted = () => controller.signal.aborted || !!abortSignal?.aborted

    const flushHeldTerminal = () => {
      if (retryGate.heldErrorAssistant) {
        pushMessage(retryGate.heldErrorAssistant)
        retryGate.heldErrorAssistant = null
      }
      if (retryGate.heldResult) {
        pushMessage(retryGate.heldResult)
        retryGate.heldResult = null
      }
    }

    const remapResultIfMaxTurns = (p: TAgentControlEvent): TAgentControlEvent => {
      if (!entry.maxTurnsHit || p.kind !== 'result') return p
      return {
        kind: 'result',
        subtype: 'error_max_turns',
        usage: p.usage,
        totalCostUsd: p.totalCostUsd,
        errors: [
          `已达最大工具循环轮次（${entry.maxTurns}），本轮已停止，避免死循环。可新开一轮或精简任务后再试。`,
        ],
      }
    }

    // ===== 单真源流式（S1）：partial assistant 合并器 =====
    // Pi 每个 delta 都携带累计 partial（thinking/text/tool_use 在 content[] 长大）。
    // 限频 50ms（20fps）推 partial assistant（同 uuid，_partial 标记，不落盘），
    // 渲染层按 uuid 原地 upsert；turn_end/message_end 同 uuid final 替换 partial。
    // 对齐 Proma `createPartialMessageCoalescer`。
    const PI_PARTIAL_FLUSH_MS = 50
    let pendingPartial: AssistantMessage | null = null
    let partialFlushTimer: ReturnType<typeof setTimeout> | null = null

    const flushPartial = (): void => {
      if (partialFlushTimer != null) {
        clearTimeout(partialFlushTimer)
        partialFlushTimer = null
      }
      const msg = pendingPartial
      pendingPartial = null
      if (!msg) return
      const ir = piAssistantToIR(msg, sessionId, { partial: true })
      if (ir.type === 'assistant') {
        pushMessage({ kind: 'sdk_message', message: ir })
      }
    }

    /** 调度一条 partial（合并到下一帧 flush）；无 content 时跳过，避免空占位噪声 */
    const schedulePartial = (msg: AssistantMessage): void => {
      if (!msg.content || msg.content.length === 0) return
      pendingPartial = msg
      if (partialFlushTimer == null) {
        partialFlushTimer = setTimeout(flushPartial, PI_PARTIAL_FLUSH_MS)
      }
    }

    /** 取 message_update 携带的累计 partial assistant（pi-ai AssistantMessage） */
    const partialFromEvent = (event: AgentEvent): AssistantMessage | null => {
      if (event.type !== 'message_update') return null
      const ae = (event as { assistantMessageEvent?: { partial?: AssistantMessage } })
        .assistantMessageEvent
      const partial = ae?.partial
      if (!partial || typeof partial !== 'object') return null
      if (!('role' in partial) || (partial as { role?: string }).role !== 'assistant') return null
      return partial
    }

    const disposePartialCoalescer = (): void => {
      if (partialFlushTimer != null) {
        clearTimeout(partialFlushTimer)
        partialFlushTimer = null
      }
      pendingPartial = null
    }

    // 注册 Agent 事件监听
    let lastDeltaAt = 0
    let deltaCount = 0
    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      if (generatorDone) return

      // maxTurns：计数 turn_start；超限软中止，禁止继续工具循环
      if (event.type === 'turn_start') {
        entry.turnCount += 1
        if (entry.turnCount > entry.maxTurns) {
          entry.maxTurnsHit = true
          console.warn(
            `[Pi 适配器 ${sessionId}] maxTurns=${entry.maxTurns} 超限（turn #${entry.turnCount}），abort`,
          )
          agent.abort()
        }
      }

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
        // 单真源流式（S1）：
        // - message_update：把累计 partial 调度进 content[]（thinking/text/tool_use 原地长，不靠 streamState）。
        // - tool_execution_start / turn_end / message_end / agent_end：先 flush partial，
        //   让 partial 的最新状态落地；turn_end 的 final 同 uuid 原地替换 partial。
        if (event.type === 'message_update') {
          const partial = partialFromEvent(event)
          if (partial) schedulePartial(partial)
        } else if (
          event.type === 'tool_execution_start' ||
          event.type === 'turn_end' ||
          event.type === 'message_end' ||
          event.type === 'agent_end'
        ) {
          flushPartial()
        }

        const payloads = piEventToIR(event, sessionId)
        for (const p of payloads) {
          // message_end 错误气泡：可重试时暂扣，避免 retry 中途闪错误
          if (
            event.type === 'message_end' &&
            p.kind === 'sdk_message' &&
            p.message.type === 'assistant' &&
            p.message.error
          ) {
            const errText = p.message.error.message ?? ''
            if (
              !isAborted() &&
              !entry.maxTurnsHit &&
              retryGate.retriesLeft > 0 &&
              isRetryablePiTurnError(errText)
            ) {
              retryGate.heldErrorAssistant = p
              continue
            }
          }

          // agent_end result：maxTurns 覆盖；可重试错误暂扣
          if (event.type === 'agent_end' && p.kind === 'result') {
            const remapped = remapResultIfMaxTurns(p)
            if (entry.maxTurnsHit) {
              retryGate.heldErrorAssistant = null
              retryGate.heldResult = null
              retryGate.lastEndRetryableError = null
              pushMessage(remapped)
              continue
            }
            const endMsgs = (event as { messages?: AgentMessage[] }).messages ?? []
            let lastAssistant: AssistantMessage | undefined
            for (let i = endMsgs.length - 1; i >= 0; i--) {
              const m = endMsgs[i]
              if (m && m.role === 'assistant') {
                lastAssistant = m as AssistantMessage
                break
              }
            }
            const errText = (lastAssistant?.errorMessage ?? '').trim()
            if (
              lastAssistant?.stopReason === 'error' &&
              !isAborted() &&
              retryGate.retriesLeft > 0 &&
              isRetryablePiTurnError(errText)
            ) {
              retryGate.lastEndRetryableError = errText || 'stream error'
              retryGate.heldResult = remapped
              continue
            }
            retryGate.lastEndRetryableError = null
            retryGate.heldErrorAssistant = null
            retryGate.heldResult = null
            pushMessage(remapped)
            continue
          }

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

    // 启动对话（fire-and-forget，与 generator 并发）
    // - turn 级 retry：可重试错误指数退避最多 PI_TURN_MAX_RETRIES 次，保留 state.messages
    // - 过长：force compact 后再试一次
    entry.isStreaming = true
    entry.emitLive = pushMessage
    void (async () => {
      const pushExecError = (errorMsg: string) => {
        pushMessage({
          kind: 'result',
          subtype: 'error_during_execution',
          usage: { inputTokens: 0, outputTokens: 0 },
          errors: [errorMsg],
        } as TAgentControlEvent)
      }

      const stripFailedAssistants = () => {
        agent.state.messages = dropTrailingFailedAssistants([...agent.state.messages])
      }

      try {
        let attempt = 0
        while (true) {
          retryGate.lastEndRetryableError = null
          retryGate.heldErrorAssistant = null
          retryGate.heldResult = null

          try {
            if (attempt === 0) {
              await agent.prompt(prompt)
            } else {
              // 同 transcript 续跑：去掉末尾 error assistant，不重放已成功工具
              stripFailedAssistants()
              await agent.continue()
            }
          } catch (err: unknown) {
            console.error(`[Pi 适配器 ${sessionId}] agent.prompt/continue 抛错:`, err)
            const errorMsg = err instanceof Error ? err.message : String(err)

            // 用户中止 / maxTurns abort：agent_end 通常已推 result，勿再叠 error result
            if (isAborted() || /aborted/i.test(errorMsg)) {
              flushHeldTerminal()
              return
            }

            // 上下文过长：force compact 后重试一次（既有路径）
            if (isPromptTooLongMessage(errorMsg) && entry.compaction) {
              console.log(`[pi-compaction] ${sessionId} 过长错误 → force compact 后重试一次`)
              entry.isStreaming = false
              const cr = await this.compactSession(sessionId, { force: true, trigger: 'auto' })
              while (entry.pendingSystemMessages.length > 0) {
                pushMessage(entry.pendingSystemMessages.shift()!)
              }
              entry.isStreaming = true
              if (cr.compacted) {
                try {
                  stripFailedAssistants()
                  // compact 后可能仍有 user 消息在末尾；prompt 会再插一条 user，故用 continue
                  const msgs = agent.state.messages
                  const last = msgs[msgs.length - 1]
                  if (last && (last.role === 'user' || last.role === 'toolResult')) {
                    await agent.continue()
                  } else {
                    await agent.prompt(prompt)
                  }
                  // continue/prompt 成功则落入下方 retry 判定
                } catch (err2: unknown) {
                  const msg2 = err2 instanceof Error ? err2.message : String(err2)
                  pushExecError(msg2)
                  return
                }
              } else {
                pushExecError(errorMsg)
                return
              }
            } else if (
              !entry.maxTurnsHit &&
              attempt < PI_TURN_MAX_RETRIES &&
              isRetryablePiTurnError(errorMsg)
            ) {
              const delay = piTurnRetryDelayMs(attempt)
              console.log(
                `[Pi 适配器 ${sessionId}] prompt 可重试错误，${delay}ms 后第 ${attempt + 1}/${PI_TURN_MAX_RETRIES} 次重试: ${errorMsg.slice(0, 120)}`,
              )
              retryGate.retriesLeft = Math.max(0, retryGate.retriesLeft - 1)
              attempt++
              try {
                await sleepMs(delay, controller.signal)
              } catch {
                pushExecError(errorMsg)
                return
              }
              stripFailedAssistants()
              continue
            } else {
              pushExecError(errorMsg)
              return
            }
          }

          // stream 编码的 error（prompt 不抛）：subscribe 已暂扣 result
          // 注：subscribe 在 await 期间写入 lastEndRetryableError；as 读出避免 TS 因循环头赋值 null 窄化
          const streamErr = retryGate.lastEndRetryableError as string | null
          if (
            streamErr != null &&
            streamErr.length > 0 &&
            !entry.maxTurnsHit &&
            !isAborted() &&
            attempt < PI_TURN_MAX_RETRIES &&
            isRetryablePiTurnError(streamErr)
          ) {
            const delay = piTurnRetryDelayMs(attempt)
            console.log(
              `[Pi 适配器 ${sessionId}] 流式错误可重试，${delay}ms 后第 ${attempt + 1}/${PI_TURN_MAX_RETRIES} 次续跑: ${streamErr.slice(0, 120)}`,
            )
            retryGate.retriesLeft = Math.max(0, retryGate.retriesLeft - 1)
            attempt++
            retryGate.heldErrorAssistant = null
            retryGate.heldResult = null
            try {
              await sleepMs(delay, controller.signal)
            } catch {
              pushExecError(streamErr)
              return
            }
            continue
          }

          // 不再重试：释放暂扣终态（若有）
          flushHeldTerminal()
          break
        }
      } finally {
        entry.isStreaming = false
        entry.emitLive = undefined
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
      disposePartialCoalescer()
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

  /**
   * 向活跃 Agent 注入消息（**次要路径**，勿当作 Pi 多轮主通道）。
   *
   * Pi 多轮主路径：SessionRuntime 每 turn 后 loop 关闭 → 下一轮重新 `query()`。
   * 真·soft-steer / 长驻 enqueue 由 session-service 对 Pi 降级为 pending_next_turn
   *（本轮结束后 auto handleSend），不依赖本方法。
   *
   * 本方法保留给：
   * - 极端情况下 runtime 仍认为 hasLiveProcess 且调用方走 live steer
   * - isStreaming 时 `agent.steer`（best-effort，当前 turn 内/边界消费，无 generator 监听则无效）
   * - 非 streaming 时 fire-and-forget `prompt`（**无** query generator 订阅时事件会丢，仅保 messages）
   */
  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) {
      throw new Error(`[pi adapter] 无活跃会话可注入: ${sessionId}`)
    }

    const content = typeof message.message?.content === 'string'
      ? message.message.content
      : ''
    const piUserMessage = {
      role: 'user' as const,
      content,
      timestamp: Date.now(),
    }

    if (entry.isStreaming) {
      // best-effort：依赖 pi-agent-core 在当前 prompt 生命周期内消费 steer
      entry.agent.steer(piUserMessage)
    } else {
      // 无活跃 query generator 时事件不会进 SessionRuntime；仅推进 Agent 内部状态
      entry.isStreaming = true
      entry.agent.prompt(piUserMessage).finally(() => {
        entry!.isStreaming = false
      })
    }
  }

  /**
   * 软中断当前 turn（`agent.abort`，**保留** Agent 实例与 state.messages）。
   * 终态 turn_end / 清 running 由 session-service STOP_AGENT 显式推送兜底，
   * 不依赖 abort 后 prompt 是否抛错。
   */
  async interruptQuery(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
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
    systemPromptAppend?: string,
    extraTools?: AgentTool[],
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

    // 注册 task 工具（子代理）+ extraTools（看板等）
    // 把主会话 beforeToolCall 传给子 Agent，避免子代理裸奔（危险命令 / Chat 只读）
    // onTaskEvent：进度进入口卡；execute 时 entryRef 已就绪，优先 emitLive，否则暂存
    const taskTool = createTaskTool(
      sessionId,
      channelConfig,
      cwd ?? process.cwd(),
      piCore,
      piAgentCore,
      beforeToolCall,
      (event) => {
        const payload: TAgentDesktopStreamPayload = { kind: 'tagent_event', event }
        if (entryRef?.emitLive) {
          entryRef.emitLive(payload)
        } else {
          entryRef?.pendingSystemMessages.push(payload)
        }
      },
    )
    const agentTools = [...finalBaseTools, ...mcpTools, taskTool, ...(extraTools ?? [])]

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
    const fullSystemPrompt = [
      baseSystem,
      // W8：输出风格沟通红线（与 kscc append 中 buildOutputStylePrompt 同文）
      buildOutputStylePrompt(),
      systemPromptAppend,
      buildRichContentSystemPrompt(),
      mem.managementRules,
      mem.memorySnapshotSection,
    ]
      .filter(Boolean)
      .join('\n\n')

    // 创建 Agent（挂 beforeToolCall 权限钩子 + maxTurns afterToolCall + 外部渠道 transformContext）
    const toolingKey = computeToolingKey(systemPromptAppend, extraTools)
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
      // maxTurns 兜底：本轮工具批结束后若已达上限则 terminate，避免再开一轮 LLM
      afterToolCall: async () => {
        if (entryRef && entryRef.turnCount >= entryRef.maxTurns) {
          entryRef.maxTurnsHit = true
          return { terminate: true }
        }
        return undefined
      },
      ...(transformContext ? { transformContext } : {}),
    } as never)
    agentRef = agent
    const entry: SessionEntry = {
      agent,
      controller,
      isStreaming: false,
      channelConfig,
      toolingKey,
      compaction: compactionBundle,
      pendingSystemMessages: [],
      maxTurns: DEFAULT_PI_MAX_TURNS,
      turnCount: 0,
      maxTurnsHit: false,
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
function piUsageToIR(u?: Usage): TAgentUsage {
  return {
    inputTokens: Number(u?.input ?? 0),
    outputTokens: Number(u?.output ?? 0),
    cacheReadTokens: Number(u?.cacheRead ?? 0),
    cacheCreationTokens: Number(u?.cacheWrite ?? 0),
    costUsd: typeof u?.cost?.total === 'number' ? u.cost.total : undefined,
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

/**
 * 同一条 Pi assistant partial 的稳定 uuid（流式 delta / turn_end 共用）。
 * 优先用 partial.timestamp（stream start 时写入且整段不变）；无则回退 session 级时间戳。
 */
function piAssistantUuid(msg: { timestamp?: number }, sessionId: string): string {
  if (typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)) {
    return `pi-${sessionId}-${msg.timestamp}`
  }
  return `pi-${sessionId}-${Date.now()}`
}

/**
 * Pi AssistantMessage → IR TAgentAssistantMessage。
 *
 * `partial: true` 时产**流式 partial**：带 `_partial` 标记、无 `stop_reason`（渲染层据此视为仍在流式），
 * thinking/text/tool_use 在 content[] 原地累积。与 turn_end final 共用 `piAssistantUuid`
 * （同 partial.timestamp），渲染层按 uuid 原地 upsert，final 同 uuid 替换 partial。
 * 见 docs/dev/core-loop/S1S2-single-source-brief.md（单真源流式）。
 */
/** Pi AssistantMessage → IR TAgentAssistantMessage（`partial:true` 产流式 partial，见上） */
export function piAssistantToIR(
  msg: AssistantMessage,
  sessionId: string,
  opts?: { partial?: boolean },
): TAgentMessage {
  const content = msg.content.map(piBlockToIR)
  const isError = msg.stopReason === 'error'
  const isPartial = opts?.partial === true
  return {
    type: 'assistant',
    uuid: piAssistantUuid(msg, sessionId),
    sessionId,
    modelId: msg.model,
    content,
    usage: isPartial ? undefined : msg.usage ? piUsageToIR(msg.usage) : undefined,
    error: isPartial ? undefined : isError ? { message: msg.errorMessage ?? '' } : undefined,
    // partial：无 stop_reason（仍在流式）；final：带 stop_reason（回合完成）
    stop_reason: isPartial ? undefined : msg.stopReason,
    ...(isPartial ? { _partial: true } : {}),
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

/**
 * Pi AssistantMessageEvent → IR 流式 delta。
 *
 * toolcall_end **不再**单独推 tool_use sdk_message（避免与 turn_end 双发卡）。
 * 进行中工具卡片由 tool_execution_start 推一次无 stop_reason 的 tool_use；
 * 终态 tool_use+tool_result 由 turn_end 产出。
 */
function piStreamEventToIR(ev: AssistantMessageEvent, sessionId: string): TAgentDesktopStreamPayload | null {
  // text/thinking 事件带 partial；uuid 与 turn_end 最终消息同源
  const partial =
    'partial' in ev && ev.partial && typeof ev.partial === 'object'
      ? (ev.partial as { timestamp?: number })
      : undefined
  const uuid = partial ? piAssistantUuid(partial, sessionId) : undefined

  switch (ev.type) {
    case 'text_delta':
    case 'thinking_delta':
      // 单真源（S1）：text/thinking 已由 message_update → partial assistant content[] 承载。
      // 再推 stream_*_delta 会与 partial 双写，渲染层来回抢长度 → 正文前几行抽搐。
      // delta 仅保留 uuid 侧诊断价值不够，直接省略。
      return null
    case 'toolcall_end':
      // 故意不推 sdk_message：终态由 turn_end 统一产出，过程中由 partial content[] 展示
      return null
    // toolcall_delta / done / error / start 类：不产流式 delta（done/error 由 turn_end/agent_end 处理）
    default:
      return null
  }
}

/**
 * 从最后一条 assistant 的 stopReason 推导 result.subtype。
 * result 唯一出口在 agent_end；message_end 不再推 result（避免双 turn_end / 错误被当成功）。
 *
 * - error → error_during_execution + errors[]
 * - length → max_tokens
 * - stop / toolUse / aborted / 缺省 → success（aborted=用户软停，不当错误）
 */
export function mapPiStopReasonToResult(msg?: {
  stopReason?: string
  errorMessage?: string
}): { subtype: string; errors?: string[] } {
  const reason = msg?.stopReason
  if (reason === 'error') {
    const raw = (msg?.errorMessage ?? '').trim()
    return {
      subtype: 'error_during_execution',
      errors: [raw || 'stream error'],
    }
  }
  if (reason === 'length') {
    return { subtype: 'max_tokens' }
  }
  return { subtype: 'success' }
}

/**
 * Pi AgentEvent → IR payload 数组（一个事件可产多条，如 turn_end 产 assistant + tool_result）
 * 导出供单测覆盖终态收束（agent_end subtype / message_end 不产 result）。
 */
export function piEventToIR(event: AgentEvent, sessionId: string): TAgentDesktopStreamPayload[] {
  const results: TAgentDesktopStreamPayload[] = []

  switch (event.type) {
    case 'agent_start':
    case 'turn_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
      // 无转录 / 已在 turn_end 处理（tool_progress 渲染层不消费，直接略）
      break

    case 'tool_execution_start': {
      // 单真源流式（S1）：不再推「只有 tool_use、无 thinking」的孤儿 assistant——
      // 那会覆盖/顶掉同 uuid partial 的 thinking，且自身无 uuid 无法原地 upsert。
      // tool_use 已在 message_update 的 partial content[] 中累积（toolcall_delta/end），
      // subscribe 在本事件 flush partial 即可让工具卡就地展示；
      // 终态完整 assistant（含 stop_reason + thinking）+ tool_result 仍由 turn_end 产出。
      break
    }

    case 'agent_end': {
      // result 唯一出口：从最后一条 assistant 的 stopReason 推 subtype，
      // 并从最后一条带 usage 的 assistant 汇总 usage（底栏 TokenStatsBar）
      const endMsgs = event.messages ?? []
      let usage: TAgentUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }
      let totalCostUsd: number | undefined
      let lastAssistant: { stopReason?: string; errorMessage?: string } | undefined
      let usageFound = false
      for (let i = endMsgs.length - 1; i >= 0; i--) {
        const m = endMsgs[i]
        if (!m || m.role !== 'assistant') continue
        // stopReason 取时间上最后一条 assistant（含 error/aborted 空内容）
        if (!lastAssistant) {
          lastAssistant = m as { stopReason?: string; errorMessage?: string }
        }
        if (!usageFound && 'usage' in m && m.usage) {
          const u = m.usage as Usage
          const ir = piUsageToIR(u)
          const inTok = ir.inputTokens ?? 0
          const cacheRead = ir.cacheReadTokens ?? 0
          const cacheWrite = ir.cacheCreationTokens ?? 0
          // 占用口径：优先 provider totalTokens；否则 input+cache（与 statusline 一致）
          const contextUsed =
            typeof u?.totalTokens === 'number' && u.totalTokens > 0 ? u.totalTokens : inTok + cacheRead + cacheWrite
          usage = {
            inputTokens: contextUsed,
            outputTokens: ir.outputTokens,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheWrite,
            costUsd: ir.costUsd,
          }
          totalCostUsd = ir.costUsd
          usageFound = true
        }
        if (lastAssistant && usageFound) break
      }
      const { subtype, errors } = mapPiStopReasonToResult(lastAssistant)
      const resultPayload: TAgentControlEvent = {
        kind: 'result',
        subtype,
        usage,
        totalCostUsd,
        ...(errors ? { errors } : {}),
      }
      results.push(resultPayload)
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
        results.push({
          kind: 'stream_thinking_delta',
          text: '',
          uuid: piAssistantUuid(msg as { timestamp?: number }, sessionId),
        })
      }
      break
    }

    case 'message_update': {
      const streamPayload = piStreamEventToIR(event.assistantMessageEvent, sessionId)
      if (streamPayload) results.push(streamPayload)
      break
    }

    case 'message_end': {
      // stream error 可见气泡：pi-agent-core 吞掉 stream error、走 message_end，错误藏在
      // stopReason='error'+errorMessage。只推友好 assistant 文本，**不**推 result——
      // result 一律由 agent_end 按 stopReason 产出，避免双 turn_end / 错误被当成功。
      const msg = event.message as { stopReason?: string; errorMessage?: string; role?: string }
      if (msg?.stopReason === 'error' && msg.errorMessage) {
        console.error(`[Pi 适配器 ${sessionId}] stream error 被 Agent 吞掉，已捕获: ${msg.errorMessage.slice(0, 120)}`)
        const errorText = formatStreamErrorForUser(msg.errorMessage)
        results.push({
          kind: 'sdk_message',
          message: {
            type: 'assistant',
            uuid: piAssistantUuid(msg as { timestamp?: number }, sessionId),
            sessionId,
            content: [{ type: 'text', text: errorText }],
            error: { message: msg.errorMessage },
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        })
      }
      break
    }

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
请用中文回复，保留必要的专业术语。

安全规则：
- git 提交（commit）/推送（push）/强制回退（reset --hard）/丢弃工作区改动（checkout --）等会改变仓库状态的操作，只能由用户明确发起。你可以分析、建议，但不要自行规划执行，也不要在总结里把这类操作列为待办执行项。
- Windows 环境不要使用 more/less 分页命令（如 \`git diff | more\`）：cmd 的 more.com 会把中文输出转成乱码，且满屏后暂停等待按键导致命令挂起。工具会自动截断过长的输出，无需分页。`
