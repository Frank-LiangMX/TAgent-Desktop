import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ExecutionMode, TAgentPermissionMode } from '@tagent/shared'
import type { CodexJsonValue } from './codex-mcp-config'

export type CodexDynamicToolPermission =
  | 'read-only'
  | 'permission'
  | 'self-authorized'

export interface CodexDynamicToolSpec {
  type: 'function'
  name: string
  description: string
  inputSchema: CodexJsonValue
  deferLoading?: boolean
}

export interface CodexDynamicToolCallParams {
  threadId: string
  turnId: string
  callId: string
  namespace: string | null
  tool: string
  arguments: CodexJsonValue
}

export type CodexDynamicToolContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
  | { type: 'inputAudio'; audioUrl: string }

export interface CodexDynamicToolCallResponse {
  contentItems: CodexDynamicToolContentItem[]
  success: boolean
}

export interface CodexDynamicToolRegistration {
  tool: AgentTool
  permission: CodexDynamicToolPermission
  deferLoading?: boolean
}

export interface ResolvedCodexDynamicTool {
  registration: CodexDynamicToolRegistration
  params: CodexDynamicToolCallParams
  arguments: Record<string, unknown>
}

export type CodexDynamicToolPermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export interface DispatchCodexDynamicToolCallOptions {
  registry: CodexDynamicToolRegistry
  params: unknown
  executionMode: ExecutionMode
  permissionMode: TAgentPermissionMode
  requestPermission?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<CodexDynamicToolPermissionDecision>
  signal?: AbortSignal
}

const READ_ONLY_TOOL_NAMES = new Set([
  'browser_open',
  'browser_navigate',
  'browser_observe',
  'browser_scroll',
  'browser_screenshot',
  'browser_takeover',
  'browser_resume',
  'kb_list_roots',
  'kb_list_available',
  'kb_search',
  'kb_get',
  'kb_read_attachment',
  'kanban_list_boards',
  'kanban_list_tasks',
])

const PERMISSION_TOOL_NAMES = new Set([
  'browser_click',
  'browser_type',
  'kanban_create_board',
  'kanban_add_task',
  'kanban_complete',
  'kanban_block',
])

const SELF_AUTHORIZED_TOOL_NAMES = new Set(['kb_propose_save'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toJsonValue(value: unknown): CodexJsonValue {
  return JSON.parse(JSON.stringify(value)) as CodexJsonValue
}

function failure(message: string): CodexDynamicToolCallResponse {
  return {
    contentItems: [{ type: 'inputText', text: `错误：${message}` }],
    success: false,
  }
}

export function resolveCodexDynamicToolPermission(
  toolName: string,
): CodexDynamicToolPermission {
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return 'read-only'
  if (PERMISSION_TOOL_NAMES.has(toolName)) return 'permission'
  if (SELF_AUTHORIZED_TOOL_NAMES.has(toolName)) return 'self-authorized'
  throw new Error(`Codex Dynamic Tool 缺少权限分类：${toolName}`)
}

function resultContentItems(
  result: AgentToolResult<unknown>,
): CodexDynamicToolContentItem[] {
  const items: CodexDynamicToolContentItem[] = []
  for (const content of result.content) {
    if (content.type === 'text') {
      items.push({ type: 'inputText', text: content.text })
    } else if (content.type === 'image') {
      items.push({
        type: 'inputImage',
        imageUrl: `data:${content.mimeType};base64,${content.data}`,
      })
    }
  }
  return items.length > 0
    ? items
    : [{ type: 'inputText', text: '工具执行完成。' }]
}

export function parseCodexDynamicToolCallParams(
  value: unknown,
): CodexDynamicToolCallParams | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.threadId !== 'string' ||
    typeof value.turnId !== 'string' ||
    typeof value.callId !== 'string' ||
    (value.namespace !== null && typeof value.namespace !== 'string') ||
    typeof value.tool !== 'string'
  ) {
    return undefined
  }
  return {
    threadId: value.threadId,
    turnId: value.turnId,
    callId: value.callId,
    namespace: value.namespace,
    tool: value.tool,
    arguments: value.arguments as CodexJsonValue,
  }
}

export async function dispatchCodexDynamicToolCall(
  options: DispatchCodexDynamicToolCallOptions,
): Promise<CodexDynamicToolCallResponse> {
  const resolved = options.registry.resolve(options.params)
  if (!resolved) {
    return options.registry.failed('未知或无效的 Dynamic Tool 请求')
  }
  const policy = resolved.registration.permission
  const needsPermission =
    policy === 'permission' ||
    (policy === 'self-authorized' &&
      (options.executionMode === 'chat' ||
        options.permissionMode === 'plan'))
  if (needsPermission) {
    if (!options.requestPermission) {
      return options.registry.failed('TAgent 权限服务尚未初始化')
    }
    const decision = await options.requestPermission(
      resolved.registration.tool.name,
      resolved.arguments,
    )
    if (decision.behavior !== 'allow') {
      return options.registry.failed(decision.message)
    }
  }
  return options.registry.execute(resolved, options.signal)
}

export class CodexDynamicToolRegistry {
  readonly specs: CodexDynamicToolSpec[]
  private readonly registrations = new Map<
    string,
    CodexDynamicToolRegistration
  >()

  constructor(registrations: CodexDynamicToolRegistration[]) {
    this.specs = registrations.map((registration) => {
      const name = registration.tool.name.trim()
      if (!name) throw new Error('Codex Dynamic Tool 名称不能为空')
      if (this.registrations.has(name)) {
        throw new Error(`Codex Dynamic Tool 重名：${name}`)
      }
      this.registrations.set(name, registration)
      return {
        type: 'function',
        name,
        description: registration.tool.description,
        inputSchema: toJsonValue(registration.tool.parameters),
        ...(registration.deferLoading ? { deferLoading: true } : {}),
      }
    })
  }

  resolve(value: unknown): ResolvedCodexDynamicTool | undefined {
    const params = parseCodexDynamicToolCallParams(value)
    if (!params || params.namespace !== null) return undefined
    const registration = this.registrations.get(params.tool)
    if (!registration || !isRecord(params.arguments)) return undefined
    const prepared = registration.tool.prepareArguments
      ? registration.tool.prepareArguments(params.arguments)
      : params.arguments
    if (!isRecord(prepared)) return undefined
    return {
      registration,
      params,
      arguments: prepared,
    }
  }

  async execute(
    resolved: ResolvedCodexDynamicTool,
    signal?: AbortSignal,
  ): Promise<CodexDynamicToolCallResponse> {
    try {
      const result = await resolved.registration.tool.execute(
        resolved.params.callId,
        resolved.arguments,
        signal,
      )
      return {
        contentItems: resultContentItems(result),
        success: true,
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
  }

  failed(message: string): CodexDynamicToolCallResponse {
    return failure(message)
  }
}
