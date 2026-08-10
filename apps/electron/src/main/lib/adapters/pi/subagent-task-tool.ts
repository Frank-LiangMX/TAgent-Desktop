/**
 * Pi 核子代理 task 工具
 *
 * 主 Agent 调用 task 工具 → 创建子 Pi Agent（限制 tools + 自定义 prompt）→
 * 子 Agent 执行 → 收集结果 → 返回 tool_result 给主 Agent。
 *
 * 子 Agent 是独立的 Pi Agent 实例（内存，无进程），执行完成后销毁。
 * 进度通过 onTaskEvent 推送 task_started / task_progress / task_notification，
 * 供主会话入口卡展示；完整 token 流仍不进主时间线（Checkpoint 2 W6）。
 */
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TAgentDesktopStreamPayload, TAgentMessage } from '@tagent/shared'
import type { PiAgentAdapterConfig } from './pi-agent-adapter'
import {
  buildBuiltinSubagentDefinitions,
  resolveSubagentDefinition,
} from '../../agent/subagent-definitions'
import {
  listEnabledCliWorkerIds,
  resolveTaskSubagentBackend,
} from '../../agent/cli-workers/resolve-backend'
import { runCliWorker } from '../../agent/cli-workers/run-cli-worker'

// ESM-only 包延迟加载
type PiCoreModule = typeof import('@tagent/pi-core')
type PiAgentCoreModule = typeof import('@earendil-works/pi-agent-core')

/** task 工具参数 schema */
const taskSchema = Type.Object({
  subagent_type: Type.String({
    description:
      '子代理类型：explorer（只读探索）、code-reviewer（代码审查，角色库 reviewer 投影）、researcher（技术调研）；亦可使用角色库 id：reviewer、analyst、coder、generalist 等。',
  }),
  prompt: Type.String({ description: '子代理要执行的任务描述' }),
  description: Type.Optional(Type.String({ description: '任务简短描述（日志用）' })),
  /**
   * 本机 CLI 工人 id（可选）。设置启用本机 CLI 后端时生效；
   * 省略则按启用列表优先级自动选第一个本机可用的。
   * 同会话可并行多路 task，每路可指定不同 cli。
   */
  cli: Type.Optional(
    Type.String({
      description:
        '本机 CLI 工人 id（如 kscc / grok / codex / mimo）。仅当设置启用了「本机 CLI」后端时有效；省略则按优先级自动挑选。可与其它 task 并行且各选不同 CLI。',
    }),
  ),
})

/**
 * 子代理生命周期事件（与 AgentEvent 中 task_* 同形；走 tagent_event 通道）。
 * 不用 Extract&lt;TAgentEvent&gt;——TAgentEvent 不含这三类。
 */
export type SubagentTaskLifecycleEvent =
  | {
      type: 'task_started'
      taskId: string
      toolUseId?: string
      description: string
      taskType?: string
    }
  | {
      type: 'task_progress'
      toolUseId: string
      taskId?: string
      description?: string
      lastToolName?: string
    }
  | {
      type: 'task_notification'
      taskId: string
      toolUseId?: string
      status: 'completed' | 'failed' | 'stopped'
      summary: string
    }

/** 子代理生命周期事件回调（推到父会话流，供入口卡 reduceTaskEvent） */
export type SubagentTaskEventSink = (event: SubagentTaskLifecycleEvent) => void

/** 子代理名容错：近名归一 + 角色库 id 直通 */
function resolveSubagentType(raw: string, available: string[]): string {
  if (available.includes(raw)) return raw
  // 角色库 id 可能未进 available 快照但 resolveSubagentDefinition 能解析
  if (resolveSubagentDefinition(raw, { claudeAvailable: false })) return raw

  const lower = raw.toLowerCase()
  if (lower === 'explore' || lower === '探索' || lower.includes('explor')) {
    const hit = available.find((n) => n === 'explorer')
    if (hit) return hit
  }
  if (lower === 'general' || lower === '通用' || lower === 'generalist') {
    if (available.includes('generalist')) return 'generalist'
    const hit = available.find((n) => n === 'explorer')
    if (hit) return hit
  }
  if (lower.includes('review') || lower.includes('审查')) {
    const hit = available.find((n) => n === 'code-reviewer' || n === 'reviewer')
    if (hit) return hit
  }
  if (lower.includes('research') || lower.includes('调研')) {
    const hit = available.find((n) => n === 'researcher')
    if (hit) return hit
  }
  if (lower.includes('architect') || lower.includes('架构') || lower === 'analyst') {
    if (available.includes('analyst')) return 'analyst'
  }
  if (lower.includes('coder') || lower.includes('后端') || lower.includes('implement')) {
    if (available.includes('coder')) return 'coder'
  }
  return raw
}

/** task 工具详情 */
export interface TaskToolDetails {
  subagentType: string
  resultLength: number
  toolCalls: number
  durationMs: number
}

/**
 * 与主会话 beforeToolCall / PermissionService.createBeforeToolCall 兼容的钩子签名。
 * arguments 标可选以兼容 pi-agent-core 入参；父会话钩子（required arguments）可直接传入。
 */
export type SubagentBeforeToolCall = (ctx: {
  toolCall: { name: string; arguments: Record<string, unknown> }
  args?: unknown
}) => Promise<{ block: true; reason: string } | undefined>

/**
 * 创建 task 工具实例
 *
 * @param parentSessionId - 父会话 ID（日志用）
 * @param channelConfig - 渠道配置（子 Agent 复用 streamFn）
 * @param cwd - 工作目录
 * @param piCore - 已加载的 pi-core 模块
 * @param piAgentCore - 已加载的 pi-agent-core 模块
 * @param beforeToolCall - 父会话权限钩子（危险命令 + Chat 只读等）；缺省时退化为 pi-core 危险命令拦截
 * @param onTaskEvent - 进度事件出口（入口卡）；缺省则静默（仅 tool_result）
 * @param emitPayload - 推 IR 到父会话流（CLI 子代理详情 parentToolUseId 消息）；缺省则详情页无过程
 */
export function createTaskTool(
  parentSessionId: string,
  channelConfig: PiAgentAdapterConfig,
  cwd: string,
  piCore: PiCoreModule,
  piAgentCore: PiAgentCoreModule,
  beforeToolCall?: SubagentBeforeToolCall,
  onTaskEvent?: SubagentTaskEventSink,
  emitPayload?: (p: TAgentDesktopStreamPayload) => void,
): AgentTool<typeof taskSchema, TaskToolDetails> {
  // 优先挂父会话 beforeToolCall（含 Chat 硬只读 / plan / 弹窗确认）。
  // 缺口：创建路径若拿不到 PermissionService，仅用 checkToolPermission——
  // 只拦 Bash 危险命令，不含 Chat 只读 / plan 写拒 / 白名单 / 弹窗。
  const subBeforeToolCall: SubagentBeforeToolCall =
    beforeToolCall ??
    (async (ctx) => {
      const input =
        (ctx.args as Record<string, unknown> | undefined) ??
        ctx.toolCall.arguments ??
        {}
      const result = piCore.checkToolPermission(ctx.toolCall.name, input, false)
      if (result.block) {
        return { block: true, reason: result.reason ?? '权限拒绝' }
      }
      return undefined
    })

  // 描述里带上当前启用池（创建时快照；execute 时再 resolve，允许设置变更后新 task 生效）
  const enabledAtCreate = listEnabledCliWorkerIds()
  const cliHint =
    enabledAtCreate.length > 0
      ? ` 本机 CLI 后端已开；启用优先级：${enabledAtCreate.join(' > ')}。可用参数 cli 指定其一，省略则按优先级自动选；支持并行多路且各选不同 CLI。`
      : ' 子代理默认走内置（进程内）；设置中可改用本机 CLI 工人池。'

  return {
    name: 'task',
    label: 'task',
    description:
      '派发子任务给独立子代理执行。子代理有独立上下文，执行完成后返回结果。支持并行派发多个子代理。' +
      cliHint,
    parameters: taskSchema,
    executionMode: 'parallel',
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult<TaskToolDetails>> => {
      const startTime = Date.now()
      const toolUseId = _toolCallId
      const taskId = _toolCallId
      // Pi 非 Claude 渠道：子代理继承父模型（不写死 haiku）
      const builtinAgents = buildBuiltinSubagentDefinitions(false)
      const subagentType = resolveSubagentType(params.subagent_type, Object.keys(builtinAgents))

      // 目录命中 或 角色库动态投影
      const def =
        builtinAgents[subagentType] ??
        resolveSubagentDefinition(subagentType, { claudeAvailable: false })
      if (!def?.prompt) {
        throw new Error(
          `未知的子代理类型: ${params.subagent_type}。可用: ${Object.keys(builtinAgents).join(', ')} 或角色库 id`,
        )
      }

      const description =
        (typeof params.description === 'string' && params.description.trim()) ||
        params.prompt.slice(0, 60)

      const preferredCli =
        typeof params.cli === 'string' && params.cli.trim() ? params.cli.trim() : undefined

      console.log(
        `[子代理 ${parentSessionId}] 启动 ${subagentType}（角色投影）: ${description}` +
          (preferredCli ? ` [cli=${preferredCli}]` : ''),
      )

      onTaskEvent?.({
        type: 'task_started',
        taskId,
        toolUseId,
        description,
        taskType: subagentType,
      })

      // CLI 工人池：启用 + 优先级排序；task.cli 可指定，否则按序选第一个本机可用的。
      // 同会话多路 parallel task 各自独立 resolve/spawn，可并发且 CLI 可不同。
      const backend = resolveTaskSubagentBackend({ preferredCliId: preferredCli })
      if (backend.kind === 'cli') {
        const workerId = backend.worker.id
        // CLI 无 subagent_type 人格，把角色 system + 用户任务拼成单 prompt
        const fullPrompt = [def.prompt, '', '## 任务', params.prompt].join('\n')
        // 详情消息 modelId 标签：worker.defaultModel 优先，否则用 worker.id（如 'grok'/'codex'）
        const modelId = backend.worker.defaultModel?.trim() || workerId
        const detailStartedAt = startTime
        /** 流式正文 uuid：partial 与 final 同 uuid，渲染层原地 upsert */
        const streamUuid = `cli-${toolUseId}-stream`
        let streamedText = ''
        /** 推一条挂在本 task tool_use 下的详情消息（主时间线不展示过程） */
        const emitDetail = (message: TAgentMessage): void => {
          if (!emitPayload) return
          emitPayload({ kind: 'sdk_message', message })
        }
        try {
          const r = await runCliWorker({
            worker: backend.worker,
            prompt: fullPrompt,
            cwd,
            signal,
            onProgress: (name) =>
              onTaskEvent?.({ type: 'task_progress', toolUseId, taskId, lastToolName: name }),
            onToolUse: (t) => {
              emitDetail({
                type: 'assistant',
                uuid: `cli-${toolUseId}-tu-${t.id}`,
                sessionId: parentSessionId,
                parentToolUseId: toolUseId,
                modelId,
                createdAt: detailStartedAt,
                content: [
                  {
                    type: 'tool_use',
                    id: t.id,
                    name: t.name,
                    input: t.input,
                  },
                ],
              })
            },
            onToolResult: (t) => {
              emitDetail({
                type: 'user',
                uuid: `cli-${toolUseId}-tr-${t.toolUseId}`,
                sessionId: parentSessionId,
                parentToolUseId: toolUseId,
                createdAt: Date.now(),
                content: [
                  {
                    type: 'tool_result',
                    toolUseId: t.toolUseId,
                    content: t.content,
                    isError: t.isError,
                  },
                ],
              })
            },
            // 阶段性正文：打开详情页时可看到增量；_partial 不落盘，final 再落盘结论
            onTextChunk: (chunk) => {
              if (!chunk) return
              streamedText += chunk
              emitDetail({
                type: 'assistant',
                uuid: streamUuid,
                sessionId: parentSessionId,
                parentToolUseId: toolUseId,
                modelId,
                createdAt: detailStartedAt,
                _partial: true,
                content: [{ type: 'text', text: streamedText }],
              })
            },
          })
          const durationMs = Date.now() - startTime
          const resultText = r.summary || streamedText || `(${workerId} 无输出)`
          // 截断过长结果（与 in-process 路径同口径，主 Agent context 有限）
          const truncated =
            resultText.length > 12000
              ? resultText.slice(0, 12000) + `\n... (截断，共 ${resultText.length} 字符)`
              : resultText
          const aborted = Boolean(signal?.aborted)
          const status: 'completed' | 'failed' | 'stopped' = aborted
            ? 'stopped'
            : r.ok
              ? 'completed'
              : 'failed'
          const summary =
            status === 'completed'
              ? `${r.toolCalls} 次工具 · ${Math.round(durationMs / 1000)}s`
              : status === 'failed'
                ? '执行失败'
                : '已停止'
          // 详情页最终正文（同 uuid 替换 partial；无 _partial → 落盘结论）
          // createdAt 用结束时刻，便于详情页算「运行了 Xs」（勿与 startedAt 相同导致 0.0s）
          emitDetail({
            type: 'assistant',
            uuid: streamUuid,
            sessionId: parentSessionId,
            parentToolUseId: toolUseId,
            modelId,
            createdAt: Date.now(),
            stop_reason: status === 'completed' ? 'end_turn' : status === 'failed' ? 'error' : 'aborted',
            content: [{ type: 'text', text: resultText }],
          })
          onTaskEvent?.({ type: 'task_notification', taskId, toolUseId, status, summary })
          console.log(
            `[子代理 ${parentSessionId}] ${subagentType} (${workerId}) 完成: ok=${r.ok}, ${r.toolCalls} 次工具调用, ${durationMs}ms, exit=${r.exitCode}`,
          )
          return {
            content: [{ type: 'text', text: truncated }],
            details: {
              subagentType,
              resultLength: resultText.length,
              toolCalls: r.toolCalls,
              durationMs,
            },
          }
        } catch (err) {
          const durationMs = Date.now() - startTime
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[子代理 ${parentSessionId}] ${subagentType} (${workerId}) 异常:`, msg)
          const resultText = `[${workerId} 子代理异常] ${msg}`
          emitDetail({
            type: 'assistant',
            uuid: `cli-${toolUseId}-final`,
            sessionId: parentSessionId,
            parentToolUseId: toolUseId,
            modelId,
            createdAt: Date.now(),
            stop_reason: 'error',
            content: [{ type: 'text', text: resultText }],
          })
          onTaskEvent?.({
            type: 'task_notification',
            taskId,
            toolUseId,
            status: 'failed',
            summary: '执行失败',
          })
          return {
            content: [{ type: 'text', text: resultText }],
            details: { subagentType, resultLength: resultText.length, toolCalls: 0, durationMs },
          }
        }
      }

      // 创建子 Agent（限制 tools，自定义 systemPrompt；模型：角色池 > 渠道默认）
      // 挂 beforeToolCall：与主会话同权限（至少危险命令 + Chat 只读）
      const subTools = resolveSubagentTools(def.tools ?? [], piCore, cwd)
      const subStreamFn = createSubagentStreamFn(channelConfig, piCore, def.model)

      const subAgent = new piAgentCore.Agent({
        initialState: {
          systemPrompt: def.prompt,
          model: buildSubagentModel(channelConfig, def.model),
          thinkingLevel: 'off',
          tools: subTools,
          messages: [],
        },
        streamFn: subStreamFn,
        toolExecution: 'sequential',
        beforeToolCall: subBeforeToolCall,
      })

      // 收集子 Agent 的文本输出
      const textChunks: string[] = []
      let toolCallCount = 0
      let failed = false

      const unsubscribe = subAgent.subscribe(async (event) => {
        if (event.type === 'message_update') {
          const ae = (event as { assistantMessageEvent: { type: string; delta?: string } }).assistantMessageEvent
          if (ae.type === 'text_delta' && ae.delta) {
            textChunks.push(ae.delta)
          }
        } else if (event.type === 'tool_execution_start') {
          toolCallCount++
          const toolName =
            typeof (event as { toolName?: string }).toolName === 'string'
              ? (event as { toolName: string }).toolName
              : 'tool'
          onTaskEvent?.({
            type: 'task_progress',
            toolUseId,
            taskId,
            lastToolName: toolName,
          })
        }
      })

      try {
        // 执行子 Agent（带 abort signal）
        const promptPromise = subAgent.prompt(params.prompt)

        // 监听 abort signal
        if (signal) {
          signal.addEventListener('abort', () => subAgent.abort(), { once: true })
        }

        await promptPromise
        // 等待 Agent 空闲（确保所有工具执行完成）
        await subAgent.waitForIdle()
      } catch (err) {
        failed = true
        const msg = err instanceof Error ? err.message : String(err)
        textChunks.push(`\n[子代理执行失败] ${msg}`)
        console.error(`[子代理 ${parentSessionId}] ${subagentType} 执行失败:`, msg)
      } finally {
        unsubscribe()
        subAgent.abort()
      }

      const durationMs = Date.now() - startTime
      const resultText = textChunks.join('') || '(子代理无文本输出)'
      // 截断过长结果（主 Agent context 有限）
      const truncated = resultText.length > 12000
        ? resultText.slice(0, 12000) + `\n... (截断，共 ${resultText.length} 字符)`
        : resultText

      const aborted = Boolean(signal?.aborted)
      const status: 'completed' | 'failed' | 'stopped' = aborted
        ? 'stopped'
        : failed
          ? 'failed'
          : 'completed'
      const summary =
        status === 'completed'
          ? `${toolCallCount} 次工具 · ${Math.round(durationMs / 1000)}s`
          : status === 'failed'
            ? '执行失败'
            : '已停止'

      onTaskEvent?.({
        type: 'task_notification',
        taskId,
        toolUseId,
        status,
        summary,
      })

      console.log(`[子代理 ${parentSessionId}] ${subagentType} 完成: ${toolCallCount} 次工具调用, ${durationMs}ms, ${resultText.length} 字符`)

      return {
        content: [{ type: 'text', text: truncated }],
        details: {
          subagentType,
          resultLength: resultText.length,
          toolCalls: toolCallCount,
          durationMs,
        },
      }
    },
  }
}

/** 根据子代理定义的 tools 列表，从 pi-core 取对应工具（限制子代理可用工具） */
function resolveSubagentTools(
  toolNames: string[],
  piCore: PiCoreModule,
  cwd: string,
): AgentTool[] {
  const allTools = piCore.defaultTools
  if (toolNames.length === 0) return allTools
  const allowed = new Set(toolNames)
  return allTools
    .filter((t) => allowed.has(t.name))
    .map((t) => (t.name === 'Bash' ? piCore.createBashTool(cwd) : t))
}

/** 为子 Agent 创建 streamFn（复用父 Agent 的渠道配置；可选角色 model 覆盖） */
function createSubagentStreamFn(
  channelConfig: PiAgentAdapterConfig,
  piCore: PiCoreModule,
  modelOverride?: string,
) {
  if (channelConfig.type === 'external') {
    return piCore.createHttpDirectStreamFn({
      provider: channelConfig.provider,
      apiKey: channelConfig.apiKey,
      baseUrl: channelConfig.baseUrl,
      modelId: modelOverride || channelConfig.modelId,
      thinkingEnabled: false,
    })
  }
  // kscc bare 模式：子 Agent 也用 kscc bare
  return piCore.createKsccBareStreamFn({
    ksccPath: channelConfig.ksccPath,
    defaultModelId: modelOverride || channelConfig.defaultModelId,
    tools: piCore.defaultToolDescriptors,
  } as never)
}

/** 构造子 Agent 占位 Model（role.modelPool 首项可覆盖） */
function buildSubagentModel(channelConfig: PiAgentAdapterConfig, modelOverride?: string) {
  const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  if (channelConfig.type === 'external') {
    const id = modelOverride || channelConfig.modelId
    return {
      id,
      name: id,
      api: resolveApiForProvider(channelConfig.provider) as 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'google-generative-ai',
      provider: channelConfig.provider,
      baseUrl: channelConfig.baseUrl ?? '',
      reasoning: false,
      input: ['text'] as ('text' | 'image')[],
      cost: ZERO_COST,
      contextWindow: 200_000,
      maxTokens: 8_192,
    }
  }
  const id = modelOverride || channelConfig.defaultModelId || 'glm-5.2'
  return {
    id,
    name: id,
    api: 'openai-completions' as 'openai-completions',
    provider: 'kscc',
    baseUrl: '',
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    cost: ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 8_192,
  }
}

function resolveApiForProvider(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'anthropic-messages'
    case 'deepseek': return 'openai-completions'
    case 'openai': return 'openai-responses'
    case 'google': return 'google-generative-ai'
    default: return 'openai-completions'
  }
}
