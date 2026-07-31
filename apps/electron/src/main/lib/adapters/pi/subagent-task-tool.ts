/**
 * Pi 核子代理 task 工具
 *
 * 主 Agent 调用 task 工具 → 创建子 Pi Agent（限制 tools + 自定义 prompt）→
 * 子 Agent 执行 → 收集结果 → 返回 tool_result 给主 Agent。
 *
 * 子 Agent 是独立的 Pi Agent 实例（内存，无进程），执行完成后销毁。
 * 不需要 IPC/渲染层参与：结果直接作为 tool_result 返回。
 */
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult, Agent as AgentType } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type { PiAgentAdapterConfig } from './pi-agent-adapter'
import { buildBuiltinSubagentDefinitions } from '../../agent/subagent-definitions'

// ESM-only 包延迟加载
type PiCoreModule = typeof import('@tagent/pi-core')
type PiAgentCoreModule = typeof import('@earendil-works/pi-agent-core')

/** task 工具参数 schema */
const taskSchema = Type.Object({
  subagent_type: Type.String({
    description:
      '子代理类型，必须是以下内置类型之一：explorer（只读探索代码库/搜索文件）、code-reviewer（代码修改后做质量审查）、researcher（调研技术方案/对比选项）。',
  }),
  prompt: Type.String({ description: '子代理要执行的任务描述' }),
  description: Type.Optional(Type.String({ description: '任务简短描述（日志用）' })),
})

/** 子代理名容错：模型偶尔用 explore/general 等近名，归一到内置类型，避免直接报错中断任务 */
function resolveSubagentType(raw: string, available: string[]): string {
  if (available.includes(raw)) return raw
  const lower = raw.toLowerCase()
  // explore / 探索 → explorer
  if (lower === 'explore' || lower === '探索' || lower.includes('explor')) {
    const hit = available.find((n) => n === 'explorer')
    if (hit) return hit
  }
  // general / 通用 → 退回 explorer（通用只读探索最安全）
  if (lower === 'general' || lower === '通用') {
    const hit = available.find((n) => n === 'explorer')
    if (hit) return hit
  }
  // 代码审查近名
  if (lower.includes('review') || lower.includes('审查')) {
    const hit = available.find((n) => n === 'code-reviewer')
    if (hit) return hit
  }
  // 调研近名
  if (lower.includes('research') || lower.includes('调研')) {
    const hit = available.find((n) => n === 'researcher')
    if (hit) return hit
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
 * 创建 task 工具实例
 *
 * @param parentSessionId - 父会话 ID（日志用）
 * @param channelConfig - 渠道配置（子 Agent 复用 streamFn）
 * @param cwd - 工作目录
 * @param piCore - 已加载的 pi-core 模块
 * @param piAgentCore - 已加载的 pi-agent-core 模块
 */
export function createTaskTool(
  parentSessionId: string,
  channelConfig: PiAgentAdapterConfig,
  cwd: string,
  piCore: PiCoreModule,
  piAgentCore: PiAgentCoreModule,
): AgentTool<typeof taskSchema, TaskToolDetails> {
  return {
    name: 'task',
    label: 'task',
    description: '派发子任务给独立子代理执行。子代理有独立上下文，执行完成后返回结果。支持并行派发多个子代理。',
    parameters: taskSchema,
    executionMode: 'parallel',
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult<TaskToolDetails>> => {
      const startTime = Date.now()
      const builtinAgents = buildBuiltinSubagentDefinitions()
      const subagentType = resolveSubagentType(params.subagent_type, Object.keys(builtinAgents))

      // 查找子代理定义
      const def = builtinAgents[subagentType]
      if (!def) {
        throw new Error(`未知的子代理类型: ${params.subagent_type}。可用类型: ${Object.keys(builtinAgents).join(', ')}`)
      }

      console.log(`[子代理 ${parentSessionId}] 启动 ${subagentType}: ${params.description ?? params.prompt.slice(0, 60)}`)

      // 创建子 Agent（限制 tools，自定义 systemPrompt）
      const subTools = resolveSubagentTools(def.tools ?? [], piCore, cwd)
      const subStreamFn = createSubagentStreamFn(channelConfig, piCore)

      const subAgent = new piAgentCore.Agent({
        initialState: {
          systemPrompt: def.prompt,
          model: buildSubagentModel(channelConfig),
          thinkingLevel: 'off',
          tools: subTools,
          messages: [],
        },
        streamFn: subStreamFn,
        toolExecution: 'sequential',
      })

      // 收集子 Agent 的文本输出
      const textChunks: string[] = []
      let toolCallCount = 0

      const unsubscribe = subAgent.subscribe(async (event) => {
        if (event.type === 'message_update') {
          const ae = (event as { assistantMessageEvent: { type: string; delta?: string } }).assistantMessageEvent
          if (ae.type === 'text_delta' && ae.delta) {
            textChunks.push(ae.delta)
          }
        } else if (event.type === 'tool_execution_start') {
          toolCallCount++
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

/** 为子 Agent 创建 streamFn（复用父 Agent 的渠道配置） */
function createSubagentStreamFn(
  channelConfig: PiAgentAdapterConfig,
  piCore: PiCoreModule,
) {
  if (channelConfig.type === 'external') {
    return piCore.createHttpDirectStreamFn({
      provider: channelConfig.provider,
      apiKey: channelConfig.apiKey,
      baseUrl: channelConfig.baseUrl,
      modelId: channelConfig.modelId,
      thinkingEnabled: false,
    })
  }
  // kscc bare 模式：子 Agent 也用 kscc bare
  return piCore.createKsccBareStreamFn({
    ksccPath: channelConfig.ksccPath,
    defaultModelId: channelConfig.defaultModelId,
    tools: piCore.defaultToolDescriptors,
  } as never)
}

/** 构造子 Agent 占位 Model */
function buildSubagentModel(channelConfig: PiAgentAdapterConfig) {
  const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  if (channelConfig.type === 'external') {
    return {
      id: channelConfig.modelId,
      name: channelConfig.modelId,
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
  return {
    id: channelConfig.defaultModelId ?? 'glm-5.2',
    name: channelConfig.defaultModelId ?? 'glm-5.2',
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
