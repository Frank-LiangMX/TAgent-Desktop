/**
 * 外部 Agent 统一运行契约。
 *
 * 这里统一的是 TAgent 宿主看到的运行边界，不是外部 Agent 的内部协议。
 * Codex / Claude Code / KSCC / custom-cli 仍由各自 Adapter 负责启动、解析和恢复。
 * 所有字段都只保存配置引用、摘要和状态；不要把 API Key、token 或其它凭据放入快照。
 */

/** TAgent 支持管理的外部 Agent runtime。 */
export type AgentRuntime =
  | 'pi-in-process'
  | 'codex'
  | 'claude-code'
  | 'kscc'
  | 'custom-cli'

/** 外部 Agent 运行状态。 */
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Agent 运行时权限边界。 */
export type AgentRunPermission = 'read-only' | 'workspace-write' | 'full'

/** 运行时使用的模型引用；只引用已有渠道配置，不携带凭据。 */
export interface AgentRunModelRef {
  channelId: string
  modelId: string
}

/** 运行契约事件类型。新增事件只能追加，已有事件语义保持稳定。 */
export type AgentRunEventType =
  | 'started'
  | 'progress'
  | 'text'
  | 'tool_call'
  | 'artifact'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 所有运行事件共享的宿主元数据。 */
export interface AgentRunEventBase {
  eventId: string
  runId: string
  sequence: number
  occurredAt: number
}

/** runtime 已接受任务并开始执行。 */
export interface AgentRunStartedEvent extends AgentRunEventBase {
  type: 'started'
}

/** runtime 的可选阶段进度；progress 为 0 到 1 的粗略值。 */
export interface AgentRunProgressEvent extends AgentRunEventBase {
  type: 'progress'
  message: string
  progress?: number
}

/** 面向用户的文本增量或文本片段。 */
export interface AgentRunTextEvent extends AgentRunEventBase {
  type: 'text'
  text: string
  delta?: boolean
}

/** 工具调用摘要；不保存原始输入、输出或环境变量，避免把敏感内容带入统一事件。 */
export interface AgentRunToolCallEvent extends AgentRunEventBase {
  type: 'tool_call'
  toolName: string
  callId?: string
  phase?: 'started' | 'completed' | 'failed'
  summary?: string
}

/** 可被宿主识别的文件或补丁产物。 */
export interface AgentRunArtifactEvent extends AgentRunEventBase {
  type: 'artifact'
  artifactId: string
  path: string
  kind?: 'file' | 'directory' | 'patch' | 'other'
  label?: string
}

/** runtime 成功结束；summary 是回投给 Pi 的最小结果摘要。 */
export interface AgentRunCompletedEvent extends AgentRunEventBase {
  type: 'completed'
  summary: string
}

/** runtime 执行失败；message 应为可展示的错误摘要。 */
export interface AgentRunFailedEvent extends AgentRunEventBase {
  type: 'failed'
  message: string
  code?: string
  retryable?: boolean
}

/** runtime 被用户或宿主主动取消。 */
export interface AgentRunCancelledEvent extends AgentRunEventBase {
  type: 'cancelled'
  reason?: string
}

/** 宿主边界的最小运行事件联合。 */
export type AgentRunEvent =
  | AgentRunStartedEvent
  | AgentRunProgressEvent
  | AgentRunTextEvent
  | AgentRunToolCallEvent
  | AgentRunArtifactEvent
  | AgentRunCompletedEvent
  | AgentRunFailedEvent
  | AgentRunCancelledEvent

/**
 * 派发时冻结的运行配置快照。
 *
 * `channelId` / `modelId` 只是外部渠道配置的引用；runtime 私有参数应由对应
 * Adapter 通过 `runtimeConfigId` 查找，不能在这里内嵌 API Key 或完整环境变量。
 */
export interface AgentRunSpec {
  schemaVersion: 1
  runId: string
  agentId: string
  runtime: AgentRuntime
  prompt: string
  workspace: string
  permission: AgentRunPermission
  configRevision: string
  createdAt: number
  model?: AgentRunModelRef
  runtimeConfigId?: string
  toolNames?: readonly string[]
  skillIds?: readonly string[]
  parentRunId?: string
  sessionId?: string
}

/** 创建快照时的输入类型；数组会在构造时复制，避免调用方后续修改快照。 */
export type AgentRunSpecInput = AgentRunSpec

/** 运行失败摘要；不承载外部 runtime 的原始日志或凭据。 */
export interface AgentRunFailure {
  message: string
  code?: string
  retryable?: boolean
}

/** 一次外部 Agent 运行的持久化记录。 */
export interface AgentRunRecord {
  schemaVersion: 1
  spec: AgentRunSpec
  status: AgentRunStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  events: readonly AgentRunEvent[]
  summary?: string
  failure?: AgentRunFailure
}

const AGENT_RUNTIMES: ReadonlySet<AgentRuntime> = new Set([
  'pi-in-process',
  'codex',
  'claude-code',
  'kscc',
  'custom-cli',
])

const AGENT_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])

const AGENT_RUN_PERMISSIONS: ReadonlySet<AgentRunPermission> = new Set([
  'read-only',
  'workspace-write',
  'full',
])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item))
}

/** 校验 runtime 字面量，供 Adapter 注册和配置加载复用。 */
export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === 'string' && AGENT_RUNTIMES.has(value as AgentRuntime)
}

/** 校验运行状态字面量。 */
export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && AGENT_RUN_STATUSES.has(value as AgentRunStatus)
}

/** 校验权限边界字面量。 */
export function isAgentRunPermission(value: unknown): value is AgentRunPermission {
  return typeof value === 'string' && AGENT_RUN_PERMISSIONS.has(value as AgentRunPermission)
}

function validateModelRef(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'model 须为对象'
  const model = value as Partial<AgentRunModelRef>
  if (!isNonEmptyString(model.channelId)) return 'model.channelId 须为非空字符串'
  if (!isNonEmptyString(model.modelId)) return 'model.modelId 须为非空字符串'
  return null
}

/** 校验运行配置快照；只检查结构，不访问文件、渠道或 runtime。 */
export function validateAgentRunSpec(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'AgentRunSpec 须为对象'
  const spec = value as Partial<AgentRunSpec>
  if (spec.schemaVersion !== 1) return 'AgentRunSpec.schemaVersion 须为 1'
  if (!isNonEmptyString(spec.runId)) return 'runId 须为非空字符串'
  if (!isNonEmptyString(spec.agentId)) return 'agentId 须为非空字符串'
  if (!isAgentRuntime(spec.runtime)) return 'runtime 不是支持的 Agent runtime'
  if (typeof spec.prompt !== 'string') return 'prompt 须为字符串'
  if (!isNonEmptyString(spec.workspace)) return 'workspace 须为非空字符串'
  if (!isAgentRunPermission(spec.permission)) return 'permission 不是支持的权限边界'
  if (!isNonEmptyString(spec.configRevision)) return 'configRevision 须为非空字符串'
  if (!isFiniteTimestamp(spec.createdAt)) return 'createdAt 须为非负有限数字'
  if (spec.model != null) {
    const modelError = validateModelRef(spec.model)
    if (modelError) return modelError
  }
  if (spec.runtimeConfigId != null && !isNonEmptyString(spec.runtimeConfigId)) {
    return 'runtimeConfigId 须为非空字符串'
  }
  if (spec.toolNames != null && !isStringArray(spec.toolNames)) return 'toolNames 须为字符串数组'
  if (spec.skillIds != null && !isStringArray(spec.skillIds)) return 'skillIds 须为字符串数组'
  if (spec.parentRunId != null && !isNonEmptyString(spec.parentRunId)) return 'parentRunId 须为非空字符串'
  if (spec.sessionId != null && !isNonEmptyString(spec.sessionId)) return 'sessionId 须为非空字符串'
  return null
}

/** 运行配置快照类型守卫。 */
export function isValidAgentRunSpec(value: unknown): value is AgentRunSpec {
  return validateAgentRunSpec(value) === null
}

/** 校验宿主事件的公共字段。 */
function validateEventBase(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'AgentRunEvent 须为对象'
  const event = value as Partial<AgentRunEventBase>
  if (!isNonEmptyString(event.eventId)) return 'eventId 须为非空字符串'
  if (!isNonEmptyString(event.runId)) return 'event.runId 须为非空字符串'
  if (typeof event.sequence !== 'number' || !Number.isInteger(event.sequence) || event.sequence < 0) {
    return 'sequence 须为非负整数'
  }
  if (!isFiniteTimestamp(event.occurredAt)) return 'occurredAt 须为非负有限数字'
  return null
}

/** 校验单个宿主边界事件；不解析外部 Agent 原生 payload。 */
export function validateAgentRunEvent(value: unknown): string | null {
  const baseError = validateEventBase(value)
  if (baseError) return baseError
  const event = value as Partial<AgentRunEvent> & { type?: unknown }
  if (!AGENT_RUN_EVENT_TYPES.has(event.type as AgentRunEventType)) return 'type 不是支持的 AgentRunEvent 类型'
  switch (event.type) {
    case 'started':
      return null
    case 'progress':
      if (!isNonEmptyString(event.message)) return 'progress.message 须为非空字符串'
      if (event.progress != null && (typeof event.progress !== 'number' || event.progress < 0 || event.progress > 1)) {
        return 'progress.progress 须在 0 到 1 之间'
      }
      return null
    case 'text':
      return typeof event.text === 'string' ? null : 'text.text 须为字符串'
    case 'tool_call':
      if (!isNonEmptyString(event.toolName)) return 'tool_call.toolName 须为非空字符串'
      if (event.callId != null && !isNonEmptyString(event.callId)) return 'tool_call.callId 须为非空字符串'
      if (event.phase != null && !TOOL_CALL_PHASES.has(event.phase)) return 'tool_call.phase 不是支持的阶段'
      if (event.summary != null && typeof event.summary !== 'string') return 'tool_call.summary 须为字符串'
      return null
    case 'artifact':
      if (!isNonEmptyString(event.artifactId)) return 'artifact.artifactId 须为非空字符串'
      if (!isNonEmptyString(event.path)) return 'artifact.path 须为非空字符串'
      if (event.kind != null && !ARTIFACT_KINDS.has(event.kind)) return 'artifact.kind 不是支持的产物类型'
      if (event.label != null && typeof event.label !== 'string') return 'artifact.label 须为字符串'
      return null
    case 'completed':
      return isNonEmptyString(event.summary) ? null : 'completed.summary 须为非空字符串'
    case 'failed':
      if (!isNonEmptyString(event.message)) return 'failed.message 须为非空字符串'
      if (event.code != null && !isNonEmptyString(event.code)) return 'failed.code 须为非空字符串'
      return null
    case 'cancelled':
      return event.reason != null && typeof event.reason !== 'string' ? 'cancelled.reason 须为字符串' : null
    default:
      return 'type 不是支持的 AgentRunEvent 类型'
  }
}

/** 宿主事件类型守卫。 */
export function isValidAgentRunEvent(value: unknown): value is AgentRunEvent {
  return validateAgentRunEvent(value) === null
}

/** 校验运行记录及其事件归属和终态字段。 */
export function validateAgentRunRecord(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'AgentRunRecord 须为对象'
  const record = value as Partial<AgentRunRecord>
  if (record.schemaVersion !== 1) return 'AgentRunRecord.schemaVersion 须为 1'
  const specError = validateAgentRunSpec(record.spec)
  if (specError) return `spec 无效：${specError}`
  if (!isAgentRunStatus(record.status)) return 'status 不是支持的 AgentRunStatus'
  if (!isFiniteTimestamp(record.createdAt)) return 'createdAt 须为非负有限数字'
  if (!Array.isArray(record.events)) return 'events 须为数组'
  let previousSequence = -1
  for (const event of record.events) {
    const eventError = validateAgentRunEvent(event)
    if (eventError) return `events 无效：${eventError}`
    if (event.runId !== record.spec!.runId) return 'events 中存在不属于该 run 的事件'
    if (event.sequence <= previousSequence) return 'events.sequence 须严格递增'
    previousSequence = event.sequence
  }
  if (record.startedAt != null && !isFiniteTimestamp(record.startedAt)) return 'startedAt 须为非负有限数字'
  if (record.finishedAt != null && !isFiniteTimestamp(record.finishedAt)) return 'finishedAt 须为非负有限数字'
  if (record.summary != null && typeof record.summary !== 'string') return 'summary 须为字符串'
  if (record.failure != null) {
    if (!record.failure || typeof record.failure !== 'object' || !isNonEmptyString(record.failure.message)) {
      return 'failure.message 须为非空字符串'
    }
  }
  return null
}

/** 运行记录类型守卫。 */
export function isValidAgentRunRecord(value: unknown): value is AgentRunRecord {
  return validateAgentRunRecord(value) === null
}

/**
 * 构造不可变配置快照。
 * 该函数只复制输入数据并校验结构，不读取环境、不访问文件系统，也不生成凭据。
 */
export function createAgentRunSpec(input: AgentRunSpecInput): AgentRunSpec {
  const error = validateAgentRunSpec(input)
  if (error) throw new Error(`无法创建 AgentRunSpec：${error}`)
  // 显式挑选快照字段。不要 spread input，否则运行时调用方误传的 apiKey、
  // token 或环境对象会绕过 TypeScript 类型进入持久化/回投数据。
  return {
    schemaVersion: 1,
    runId: input.runId,
    agentId: input.agentId,
    runtime: input.runtime,
    prompt: input.prompt,
    workspace: input.workspace,
    permission: input.permission,
    configRevision: input.configRevision,
    createdAt: input.createdAt,
    model: input.model ? { ...input.model } : undefined,
    runtimeConfigId: input.runtimeConfigId,
    toolNames: input.toolNames ? [...input.toolNames] : undefined,
    skillIds: input.skillIds ? [...input.skillIds] : undefined,
    parentRunId: input.parentRunId,
    sessionId: input.sessionId,
  }
}

/** 从配置快照创建 queued 状态的初始运行记录。 */
export function createAgentRunRecord(spec: AgentRunSpec): AgentRunRecord {
  const error = validateAgentRunSpec(spec)
  if (error) throw new Error(`无法创建 AgentRunRecord：${error}`)
  return {
    schemaVersion: 1,
    spec: createAgentRunSpec(spec),
    status: 'queued',
    createdAt: spec.createdAt,
    events: [],
  }
}

/**
 * 纯函数追加一条事件并推进宿主状态。
 * 事件必须属于同一 run、序号严格递增，终态后不可继续追加。
 */
export function appendAgentRunEvent(record: AgentRunRecord, event: AgentRunEvent): AgentRunRecord {
  const recordError = validateAgentRunRecord(record)
  if (recordError) throw new Error(`无法追加事件：运行记录无效：${recordError}`)
  const eventError = validateAgentRunEvent(event)
  if (eventError) throw new Error(`无法追加事件：${eventError}`)
  if (event.runId !== record.spec.runId) throw new Error('无法追加事件：runId 不匹配')
  if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') {
    throw new Error('无法追加事件：运行已进入终态')
  }
  const lastEvent = record.events[record.events.length - 1]
  if (lastEvent && event.sequence <= lastEvent.sequence) {
    throw new Error('无法追加事件：sequence 必须严格递增')
  }
  const next: AgentRunRecord = {
    ...record,
    events: [...record.events, event],
  }
  switch (event.type) {
    case 'started':
      return { ...next, status: 'running', startedAt: event.occurredAt }
    case 'completed':
      return { ...next, status: 'completed', finishedAt: event.occurredAt, summary: event.summary }
    case 'failed':
      return {
        ...next,
        status: 'failed',
        finishedAt: event.occurredAt,
        failure: { message: event.message, code: event.code, retryable: event.retryable },
      }
    case 'cancelled':
      return { ...next, status: 'cancelled', finishedAt: event.occurredAt }
    default:
      return next
  }
}

const AGENT_RUN_EVENT_TYPES: ReadonlySet<AgentRunEventType> = new Set([
  'started',
  'progress',
  'text',
  'tool_call',
  'artifact',
  'completed',
  'failed',
  'cancelled',
])

const TOOL_CALL_PHASES: ReadonlySet<NonNullable<AgentRunToolCallEvent['phase']>> = new Set([
  'started',
  'completed',
  'failed',
])

const ARTIFACT_KINDS: ReadonlySet<NonNullable<AgentRunArtifactEvent['kind']>> = new Set([
  'file',
  'directory',
  'patch',
  'other',
])
