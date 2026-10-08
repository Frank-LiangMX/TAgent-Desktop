/**
 * Pi / Claude 共用的委派宿主工具桥。
 *
 * 这里只负责把宿主上下文传给 Pi delegation factory，并把生命周期事件
 * 包成 TAgent 的 tagent_event；后台任务的注册、回投和容量限制由既有服务负责。
 * 本模块不读取渠道/API Key/Agent 目录，也不发起真实模型请求。
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TAgentDesktopStreamPayload } from '@tagent/shared'
import type { AnyZodRawShape, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { PiAgentAdapterConfig } from '../adapters/pi/pi-agent-adapter'
import { randomUUID } from 'node:crypto'

export const DELEGATION_MCP_NAMESPACE = 'tagent-delegation'
export const DELEGATION_TASK_TOOL_NAME = 'task'
export const DELEGATION_MODELS_TOOL_NAME = 'list_delegation_models'
export const CLAUDE_DELEGATION_TASK_TOOL_NAME =
  `mcp__${DELEGATION_MCP_NAMESPACE}__${DELEGATION_TASK_TOOL_NAME}`

export type DelegationApproval = (profileName: string, signal?: AbortSignal) => Promise<boolean>
export type DelegationEmitPayload = (payload: TAgentDesktopStreamPayload) => void

export interface DelegationHostToolsInput {
  sessionId: string
  channelConfig: PiAgentAdapterConfig
  cwd: string
  channelId?: string
  beforeToolCall?: (ctx: {
    toolCall: { name: string; arguments: Record<string, unknown> }
  }) => Promise<{ block: true; reason: string } | undefined>
  emitPayload?: DelegationEmitPayload
  requestApproval?: DelegationApproval
}

type JsonSchema = {
  type?: string
  const?: unknown
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
}

type UnknownRecord = Record<string, unknown>

/** 延迟加载 Pi ESM-only 包，保持主进程启动路径可控。 */
async function loadPiModules(): Promise<{
  piCore: typeof import('@tagent/pi-core')
  piAgentCore: typeof import('@earendil-works/pi-agent-core')
}> {
  const [piCore, piAgentCore] = await Promise.all([
    import('@tagent/pi-core'),
    import('@earendil-works/pi-agent-core'),
  ])
  return { piCore, piAgentCore }
}

/**
 * 构造 Pi 可用的委派工具。
 *
 * task 工具来自 Electron adapter；本桥只负责按位置参数接入，不复制 task 实现。
 * adapter 抛出的错误原样向上传递，宿主可以统一处理失败状态。
 */
export async function buildDelegationHostTools(
  input: DelegationHostToolsInput,
): Promise<AgentTool[]> {
  const [{ piCore, piAgentCore }, delegation] = await Promise.all([
    loadPiModules(),
    import('../adapters/pi/subagent-task-tool'),
  ])
  type TaskEventSink = NonNullable<Parameters<typeof delegation.createTaskTool>[6]>
  const onTaskEvent: TaskEventSink | undefined = input.emitPayload
    ? (event) => {
        input.emitPayload?.({ kind: 'tagent_event', event })
      }
    : undefined
  const task = delegation.createTaskTool(
    input.sessionId,
    input.channelConfig,
    input.cwd,
    piCore,
    piAgentCore,
    input.beforeToolCall,
    onTaskEvent,
    input.emitPayload,
    undefined,
    undefined,
    input.channelId,
    input.requestApproval,
  )
  const models = delegation.createDelegationModelsTool()
  return [
    task,
    { ...models, name: DELEGATION_MODELS_TOOL_NAME, label: DELEGATION_MODELS_TOOL_NAME } as unknown as AgentTool,
  ]
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type ZodRuntime = {
  any: () => { refine: (check: (value: unknown) => boolean) => unknown }
  array: (schema: unknown) => unknown
  boolean: () => unknown
  enum: (values: [string, ...string[]]) => unknown
  literal: (value: unknown) => unknown
  number: () => { int: () => unknown }
  object: (shape: UnknownRecord) => unknown
  string: () => unknown
  union: (schemas: [unknown, unknown, ...unknown[]]) => unknown
  unknown: () => unknown
}

function jsonSchemaToZod(schema: JsonSchema, z: ZodRuntime): unknown {
  const anyOf = schema.anyOf ?? schema.oneOf
  if (anyOf?.length) {
    const alternatives = anyOf.map((item) => jsonSchemaToZod(item, z))
    return z.union(alternatives as [unknown, unknown, ...unknown[]])
  }
  if (schema.enum?.length) {
    if (schema.enum.every((item) => typeof item === 'string')) {
      return z.enum(schema.enum as [string, ...string[]])
    }
    return z.any().refine((value: unknown) => schema.enum!.some((item) => Object.is(item, value)))
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    return z.literal(schema.const)
  }
  switch (schema.type) {
    case 'object': {
      const shape: UnknownRecord = {}
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        let field = jsonSchemaToZod(property, z) as { optional?: () => unknown }
        if (!schema.required?.includes(key)) field = field.optional?.() ?? field
        shape[key] = field
      }
      return z.object(shape)
    }
    case 'array':
      return z.array(jsonSchemaToZod(schema.items ?? {}, z))
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'string':
      return z.string()
    default:
      return z.unknown()
  }
}

/** Claude SDK 的 tool() 接受 object schema 的 raw shape，而不是 z.object 本身。 */
function jsonSchemaToZodShape(schema: JsonSchema, z: ZodRuntime): AnyZodRawShape {
  if (schema.type !== 'object') return { value: jsonSchemaToZod(schema, z) } as AnyZodRawShape
  const shape: Record<string, unknown> = {}
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    let field = jsonSchemaToZod(property, z) as { optional?: () => unknown }
    if (!schema.required?.includes(key)) field = field.optional?.() ?? field
    shape[key] = field
  }
  return shape as AnyZodRawShape
}

function asJsonSchema(value: unknown): JsonSchema {
  return isRecord(value) ? (value as JsonSchema) : { type: 'object', properties: {} }
}

function toolParameters(tool: AgentTool): JsonSchema {
  return asJsonSchema((tool as unknown as { parameters?: unknown }).parameters)
}

function toolDescription(tool: AgentTool, fallback: string): string {
  return typeof tool.description === 'string' && tool.description.trim()
    ? tool.description
    : fallback
}

function getSignal(extra: unknown): AbortSignal | undefined {
  if (!isRecord(extra)) return undefined
  return extra.signal instanceof AbortSignal ? extra.signal : undefined
}

/** MCP extra 中若有真实 call id 就复用，否则为每次调用生成独立 id。 */
function getCallId(extra: unknown): string | undefined {
  if (!isRecord(extra)) return undefined
  return typeof extra.callId === 'string' && extra.callId.trim() ? extra.callId : undefined
}

function asMcpResult(result: AgentToolResult<unknown>): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: result.content.map((item) =>
      item.type === 'text'
        ? item
        : { type: 'text', text: JSON.stringify(item) },
    ),
  }
}

/**
 * 将同一组 Pi delegation tools 注入 Claude SDK MCP。
 * Claude 看到的 task 全名是 mcp__tagent-delegation__task，默认 mode=background。
 */
export async function injectDelegationMcpServer(
  mcpServers: Record<string, unknown>,
  input: DelegationHostToolsInput,
): Promise<void> {
  const [sdk, zod, tools] = await Promise.all([
    import('@anthropic-ai/claude-agent-sdk'),
    import('zod'),
    buildDelegationHostTools(input),
  ])
  const task = tools.find((tool) => tool.name === DELEGATION_TASK_TOOL_NAME)
  const models = tools.find((tool) => tool.name === DELEGATION_MODELS_TOOL_NAME)
  if (!task || !models) {
    throw new Error('Pi delegation tools 必须包含 task 和 list_delegation_models')
  }

  const taskDescription = [
    `Pi task 的 Claude MCP 映射名是 ${CLAUDE_DELEGATION_TASK_TOOL_NAME}。`,
    '默认使用 background，避免前台长任务导致 MCP 超时；需要前台结果时显式传 mode=foreground。',
    toolDescription(task, '派发子任务给 Pi delegation Agent。'),
  ].join('\n')
  const modelsDescription = [
    '列出当前 delegation 可用的模型候选。',
    'Claude 应先调用此工具了解可用模型，再决定是否显式指定模型。',
    toolDescription(models, '列出 delegation 模型。'),
  ].join('\n')

  const z = zod.z as unknown as ZodRuntime
  const taskSchema = jsonSchemaToZodShape(toolParameters(task), z)
  const modelsSchema = jsonSchemaToZodShape(toolParameters(models), z)
  const mcpTools: Array<SdkMcpToolDefinition<any>> = [
    sdk.tool(
      DELEGATION_TASK_TOOL_NAME,
      taskDescription,
      taskSchema,
      async (args: UnknownRecord, extra: unknown) => {
        const params = { ...args }
        if (params.mode == null) params.mode = 'background'
        const result = await task.execute(
          getCallId(extra) ?? randomUUID(),
          params as never,
          getSignal(extra),
        )
        return asMcpResult(result)
      },
    ),
    sdk.tool(
      DELEGATION_MODELS_TOOL_NAME,
      modelsDescription,
      modelsSchema,
      async (args: UnknownRecord, extra: unknown) => {
        const result = await models.execute(
          getCallId(extra) ?? randomUUID(),
          args as never,
          getSignal(extra),
        )
        return asMcpResult(result)
      },
    ),
  ]

  mcpServers[DELEGATION_MCP_NAMESPACE] = sdk.createSdkMcpServer({
    name: DELEGATION_MCP_NAMESPACE,
    version: '1.0.0',
    tools: mcpTools,
  })
}
