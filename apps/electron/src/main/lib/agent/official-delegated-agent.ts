import type {
  SDKMessage,
  TAgentAssistantMessage,
  TAgentDesktopStreamPayload,
  TAgentMessage,
} from '@tagent/shared'
import { resolveChannelApiProtocol, resolveChannelRequestHeaders, sdkMessageToIR } from '@tagent/shared'
import {
  CodexAppServerAdapter,
  type CodexQueryOptions,
} from '../adapters/codex/codex-app-server-adapter'
import type { CodexAppServerIncomingRequest } from '../adapters/codex/codex-app-server-client'
import { ClaudeAgentAdapter, type KsccQueryOptions } from '../adapters/claude/claude-agent-adapter'
import { getChannel, getDecryptedApiKey } from '../channel/channel-store'

const MAX_DELEGATED_TURNS = 20
const MAX_DELEGATED_EVENTS = 2_000
const DELEGATED_TIMEOUT_MS = 5 * 60_000
const CONNECTION_UNAVAILABLE = '渠道/模型/协议/API凭据不可用'
const PERMISSION_HOOK_MISSING = '父权限hook缺失'
const RUN_TIMED_OUT = '官方子代理运行超时，已停止'
const NO_TERMINAL_RESULT = '官方子代理未返回完成终态'
const RUN_FAILED = '官方子代理执行失败'
const RUN_STOPPED = '官方子代理已停止'

export interface OfficialDelegatedAgentInput {
  runtime: 'codex' | 'claude-code'
  parentSessionId: string
  taskId: string
  channelId: string
  modelId: string
  cwd: string
  prompt: string
  systemPrompt?: string
  readOnly: boolean
  signal?: AbortSignal
  beforeToolCall?: (ctx: {
    toolCall: { name: string; arguments?: Record<string, unknown> }
  }) => Promise<{ block: boolean; reason?: string } | void>
  onPayload?: (payload: TAgentDesktopStreamPayload) => void
}

export interface OfficialDelegatedAgentResult {
  status: 'completed' | 'failed' | 'stopped'
  text: string
  toolCalls: number
}

interface OwnedAdapter {
  query(input: unknown): AsyncIterable<unknown>
  abort(sessionId: string): void
  dispose(): void
  interruptQuery?(sessionId: string): Promise<void>
}

interface ValidatedConnection {
  apiConnection: {
    channelId: string
    provider?: string
    baseUrl: string
    apiKey: string
    apiProtocol?: 'anthropic-messages' | 'openai-responses' | 'openai-chat'
    contextWindow?: number
    headers?: Record<string, string>
  }
}

/**
 * Runs one short-lived official-runtime delegation.  This deliberately owns a
 * fresh adapter: delegated work must not enter the parent session's CLI pool,
 * native thread, credentials, or terminal lifecycle.
 */
export async function runOfficialDelegatedAgent(
  input: OfficialDelegatedAgentInput,
): Promise<OfficialDelegatedAgentResult> {
  const connection = validateConnection(input)
  if (input.signal?.aborted) return emptyResult('stopped', RUN_STOPPED)
  if (!connection) return emptyResult('failed', CONNECTION_UNAVAILABLE)
  if (!input.beforeToolCall) return emptyResult('failed', PERMISSION_HOOK_MISSING)

  const sessionId = delegatedSessionId(input)
  const adapter: OwnedAdapter = input.runtime === 'codex'
    ? new CodexAppServerAdapter()
    : new ClaudeAgentAdapter()
  const toolCallIds = new Set<string>()
  let terminal: 'completed' | 'failed' | 'stopped' | undefined
  let terminalText = ''
  let lastAssistantText = ''
  let timedOut = false
  let eventLimitReached = false
  let turnLimitReached = false
  let ownedRunStopped = false
  let stopWakeResolve: ((value: 'timeout' | 'aborted') => void) | undefined
  const stopWake = new Promise<'timeout' | 'aborted'>((resolve) => {
    stopWakeResolve = resolve
  })
  const timeoutId = setTimeout(() => {
    timedOut = true
    stopOwnedRun()
    stopWakeResolve?.('timeout')
  }, DELEGATED_TIMEOUT_MS)

  const stopOwnedRun = (): void => {
    if (ownedRunStopped) return
    ownedRunStopped = true
    void adapter.interruptQuery?.(sessionId).catch(() => undefined)
    adapter.abort(sessionId)
  }
  const onAbort = (): void => {
    stopOwnedRun()
    // Adapter shutdown should settle the underlying iterator, but race the
    // pending next() too so a caller's Stop never waits for the wall timeout.
    stopWakeResolve?.('aborted')
  }

  if (input.signal) input.signal.addEventListener('abort', onAbort, { once: true })

  let iterator: AsyncIterator<unknown> | undefined
  try {
    if (input.signal?.aborted) {
      terminal = 'stopped'
      return emptyResult('stopped', RUN_STOPPED)
    }
    const query = input.runtime === 'codex'
      ? adapter.query(buildCodexOptions(input, sessionId, connection.apiConnection))
      : adapter.query(buildClaudeOptions(input, sessionId, connection.apiConnection))
    iterator = query[Symbol.asyncIterator]()
    let eventCount = 0

    while (true) {
      const next = await Promise.race([
        iterator.next().then((value) => ({ kind: 'next' as const, value })),
        stopWake,
      ])
      if (next === 'timeout' || next === 'aborted') {
        terminal = next === 'aborted' || input.signal?.aborted
          ? 'stopped'
          : 'failed'
        if (next === 'timeout') terminalText = RUN_TIMED_OUT
        break
      }
      if (next.value.done) break
      eventCount += 1
      if (eventCount > MAX_DELEGATED_EVENTS) {
        eventLimitReached = true
        stopOwnedRun()
        terminal = 'failed'
        terminalText = RUN_FAILED
        break
      }
      const raw = next.value.value
      if (input.signal?.aborted) {
        terminal = 'stopped'
        break
      }

      const normalized = normalizePayload(raw)
      if (normalized.message) {
        const message = withParentToolUseId(normalized.message, input.taskId)
        const assistantText = collectMessage(message, toolCallIds)
        if (assistantText) lastAssistantText = assistantText
        input.onPayload?.({ kind: 'sdk_message', message })
        if (toolCallIds.size > MAX_DELEGATED_TURNS) {
          turnLimitReached = true
          stopOwnedRun()
          terminal = 'failed'
          terminalText = RUN_FAILED
          break
        }
      }

      if (normalized.result) {
        terminal = terminalFromSubtype(normalized.result.subtype)
        terminalText = terminal === 'completed'
          ? normalized.result.text
          : terminal === 'stopped'
            ? RUN_STOPPED
            : RUN_FAILED
        break
      }
    }
  } catch {
    terminal = input.signal?.aborted ? 'stopped' : 'failed'
    terminalText = input.signal?.aborted ? RUN_STOPPED : RUN_FAILED
  } finally {
    clearTimeout(timeoutId)
    input.signal?.removeEventListener('abort', onAbort)
    // `return()` is queued behind an outstanding `next()` for async
    // generators.  Abort the owned adapter first so it releases that next(),
    // then await the generator's finally before this one-shot slot is freed.
    stopOwnedRun()
    if (iterator) {
      try {
        await iterator.return?.()
      } catch {
        /* Shutdown must not replace the terminal result. */
      }
    }
    adapter.dispose()
  }

  if (input.signal?.aborted) {
    terminal = 'stopped'
    terminalText = RUN_STOPPED
  }
  const status = timedOut || eventLimitReached || turnLimitReached
    ? 'failed'
    : (terminal ?? 'failed')
  const text = status === 'completed'
    ? terminalText.trim() || lastAssistantText
    : status === 'stopped'
      ? RUN_STOPPED
      : terminalText.trim() || (terminal ? RUN_FAILED : NO_TERMINAL_RESULT)
  return {
    status,
    text,
    toolCalls: toolCallIds.size,
  }
}

function validateConnection(
  input: OfficialDelegatedAgentInput,
): ValidatedConnection | undefined {
  const channel = getChannel(input.channelId)
  const model = channel?.models.find(
    (candidate) => candidate.id === input.modelId && candidate.enabled,
  )
  const decryptedKey = channel ? getDecryptedApiKey(channel.id) : ''
  const apiKey = typeof decryptedKey === 'string' ? decryptedKey.trim() : ''
  const apiProtocol = channel ? resolveChannelApiProtocol(channel) : null
  if (
    !channel?.enabled ||
    !model ||
    (apiProtocol !== 'openai-responses' && apiProtocol !== 'openai-chat' && apiProtocol !== 'anthropic-messages') ||
    !channel.baseUrl?.trim() ||
    !apiKey
  ) {
    return undefined
  }
  return {
    apiConnection: {
      channelId: channel.id,
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey,
      apiProtocol,
      ...(model.contextWindow !== undefined
        ? { contextWindow: model.contextWindow }
        : {}),
      headers: resolveChannelRequestHeaders(channel.provider, apiKey),
    },
  }
}

function buildCodexOptions(
  input: OfficialDelegatedAgentInput,
  sessionId: string,
  apiConnection: ValidatedConnection['apiConnection'],
): CodexQueryOptions {
  return {
    sessionId,
    prompt: input.prompt,
    cwd: input.cwd,
    model: input.modelId,
    apiConnection,
    // Keep native approvals enabled.  The handler below is the sole authority
    // for requests which would expand the sandbox or mutate the workspace.
    approvalPolicy: 'on-request',
    // A delegated Codex runner never receives native write authority.  Native
    // App Server writes can occur inside workspace-write without a callback,
    // which would bypass the parent task's permission boundary.
    sandbox: 'read-only',
    config: { 'features.multi_agent': false },
    // App Server has no stable max-turns request field.  The explicit bound is
    // still stated to the model; Claude receives the native maxTurns option.
    baseInstructions: `${delegationInstructions(input.systemPrompt)}\n\nDo not make more than ${MAX_DELEGATED_TURNS} tool-call turns.`,
    onServerRequest: (request) => handleCodexServerRequest(input, request),
  }
}

function buildClaudeOptions(
  input: OfficialDelegatedAgentInput,
  sessionId: string,
  apiConnection: ValidatedConnection['apiConnection'],
): KsccQueryOptions {
  return {
    sessionId,
    prompt: input.prompt,
    cwd: input.cwd,
    model: input.modelId,
    apiConnection,
    maxTurns: MAX_DELEGATED_TURNS,
    // `plan` is Claude Code's native no-write mode.  No bypass mode is used.
    sdkPermissionMode: input.readOnly ? 'plan' : 'default',
    allowDangerouslySkipPermissions: false,
    disallowedTools: ['Agent', 'Task'],
    systemPrompt: delegationInstructions(input.systemPrompt),
    canUseTool: async (name, arguments_) => {
      if (isRecursiveDelegationTool(name)) {
        return { behavior: 'deny', message: '子代理不得继续委派任务' }
      }
      const decision = await runPermissionHook(input, name, arguments_)
      if (decision.block) {
        return { behavior: 'deny', message: decision.reason ?? '父任务未授权该工具调用' }
      }
      return { behavior: 'allow', updatedInput: arguments_ }
    },
  }
}

async function handleCodexServerRequest(
  input: OfficialDelegatedAgentInput,
  request: CodexAppServerIncomingRequest,
): Promise<unknown> {
  const params = asRecord(request.params)
  if (request.method === 'item/commandExecution/requestApproval') {
    return codexApprovalResponse(
      input,
      'Bash',
      {
        ...(typeof params?.command === 'string' ? { command: params.command } : {}),
        ...(typeof params?.cwd === 'string' ? { cwd: params.cwd } : {}),
      },
    )
  }
  if (request.method === 'item/fileChange/requestApproval') {
    return codexApprovalResponse(input, 'ApplyPatch', params ?? {})
  }
  if (request.method === 'item/permissions/requestApproval') {
    // Permission profile expansion cannot be represented as a single tool
    // call.  Never mirror it back wholesale from an untrusted native request.
    return { permissions: {}, scope: 'turn' }
  }
  // Dynamic tools are intentionally not registered here.  Returning a result
  // would create a new authority path, so reject it and every unknown request.
  throw new Error(`委派 Codex 不支持原生请求：${request.method}`)
}

async function codexApprovalResponse(
  input: OfficialDelegatedAgentInput,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<{ decision: 'accept' | 'decline' }> {
  if (input.readOnly && (name === 'Bash' || name === 'ApplyPatch')) {
    return { decision: 'decline' }
  }
  const decision = await runPermissionHook(input, name, arguments_)
  return { decision: decision.block ? 'decline' : 'accept' }
}

async function runPermissionHook(
  input: OfficialDelegatedAgentInput,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<{ block: boolean; reason?: string }> {
  if (!input.beforeToolCall) {
    return { block: true, reason: '未提供父任务权限处理器' }
  }
  try {
    const result = await input.beforeToolCall({
      toolCall: { name, arguments: arguments_ },
    })
    return result?.block ? result : { block: false }
  } catch {
    return { block: true, reason: '父任务权限处理器未完成' }
  }
}

function delegationInstructions(systemPrompt?: string): string {
  return [
    systemPrompt?.trim(),
    '你是一次性受委派执行器。不得调用 Task、Agent、subagent 或任何递归委派能力；直接完成当前任务。不得尝试绕过宿主权限、沙箱或审批。',
  ].filter(Boolean).join('\n\n')
}

function normalizePayload(raw: unknown): {
  message?: TAgentMessage
  result?: { subtype?: string; text: string }
} {
  const record = asRecord(raw)
  if (record && (record.kind === 'result' || record.type === 'result')) {
    // Error evidence wins over nominal completion labels from any native protocol.
    const hasError = record.is_error === true || record.isError === true ||
      (Array.isArray(record.errors) && record.errors.length > 0) || Boolean(record.error)
    return { result: {
      subtype: hasError ? 'error' : typeof record.subtype === 'string' ? record.subtype : undefined,
      text: typeof record.result === 'string' ? record.result : '',
    } }
  }
  if (isDesktopPayload(raw)) {
    if (raw.kind === 'sdk_message') return { message: raw.message }
    if (raw.kind === 'result') {
      return { result: { subtype: raw.subtype, text: '' } }
    }
    return {}
  }
  const sdk = raw as SDKMessage
  const converted = sdkMessageToIR(sdk)
  if (converted.message) return { message: converted.message }
  if (converted.event?.kind === 'result') {
    const record = raw as Record<string, unknown>
    return {
      result: {
        subtype: converted.event.subtype,
        text: typeof record.result === 'string' ? record.result : '',
      },
    }
  }
  return {}
}

function isDesktopPayload(value: unknown): value is TAgentDesktopStreamPayload {
  return value !== null && typeof value === 'object' && 'kind' in value
}

function withParentToolUseId(
  message: TAgentMessage,
  taskId: string,
): TAgentMessage {
  return { ...message, parentToolUseId: taskId }
}

function collectMessage(
  message: TAgentMessage,
  toolCallIds: Set<string>,
): string {
  if (message.type !== 'assistant') return ''
  const assistant = message as TAgentAssistantMessage
  const text = assistant.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
  if (text) {
    // return after collecting tools so a terminal text+tool message is not
    // accidentally excluded from task accounting.
  }
  for (const block of assistant.content) {
    if (block.type !== 'tool_use') continue
    const candidate = block as { id?: unknown }
    toolCallIds.add(
      typeof candidate.id === 'string' && candidate.id
        ? candidate.id
        : `${assistant.uuid ?? 'anonymous'}:${toolCallIds.size}`,
    )
  }
  return text
}

function terminalFromSubtype(
  subtype?: string,
): OfficialDelegatedAgentResult['status'] {
  if (subtype === 'success' || subtype === 'completed') return 'completed'
  if (subtype === 'interrupted' || subtype === 'stopped' || subtype === 'aborted') {
    return 'stopped'
  }
  return 'failed'
}

function isRecursiveDelegationTool(name: string): boolean {
  return /^(task|agent|subagent)$/i.test(name.trim())
}

function delegatedSessionId(input: OfficialDelegatedAgentInput): string {
  return `official-delegated:${input.parentSessionId}:${input.taskId}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function emptyResult(
  status: OfficialDelegatedAgentResult['status'],
  text: string,
): OfficialDelegatedAgentResult {
  return { status, text, toolCalls: 0 }
}
