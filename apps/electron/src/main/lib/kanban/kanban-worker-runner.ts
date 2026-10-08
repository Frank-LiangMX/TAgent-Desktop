/**
 * 看板 headless 工人：一轮 Agent query 执行任务 body
 *
 * - 独立会话 meta（parentBoardId / sourceKanbanTaskId）
 * - executionMode=work；工具侧 auto-allow，但拦截建板/交互式工具（防死锁/防递归）
 * - 角色投影 systemPrompt 注入
 * - 首轮 result 后 abort 释放进程
 *
 * @see docs/plans/multi-runtime/07-implementation-phases.md D1
 */
import type {
  BlockedApprovalRecord,
  Channel,
  KanbanTask,
  ProgressLogEntry,
  SDKMessage,
  TAgentPermissionMode,
} from '@tagent/shared'
import { isAutoModeAutoAllowTool, isWriteTool, resolveChannelRequestHeaders } from '@tagent/shared'
import { getAdapter, type ChannelKind } from '../adapters'
import type { PiQueryOptions } from '../adapters/pi/pi-agent-adapter'
import { createSession, getSessionMeta, updateSessionMeta } from '../agent/session-store'
import {
  getChannel,
  getDecryptedApiKey,
} from '../channel/channel-store'
import { validateDelegationModelSelection } from '../agent/delegation-model-policy'
import { resolveModelContextWindow } from '../channel/model-window'
import { getEnabledMcpServers } from '../mcp/mcp-store'
import { listWorkspaces } from '../workspace/workspace-manager'
import type { KanbanWorkerRunnerResult } from './kanban-dispatcher'
import { getBoard, getTask, previewWorkerResolution, updateTask } from './kanban-store'

const WORKER_TIMEOUT_MS = 15 * 60 * 1000
const WORKER_MAX_TURNS = 40

/**
 * 工人禁止工具：防递归建板 / 防交互死锁
 * 导出供单测
 */
export function isBlockedWorkerTool(toolName: string): string | null {
  const lower = toolName.toLowerCase().replace(/[\s-]+/g, '_')
  // 防递归：禁止建板 / 追加任务
  if (
    lower.includes('kanban_create') ||
    lower.includes('kanban_add_task') ||
    lower.includes('create_board') ||
    (lower.includes('kanban') && lower.includes('add'))
  ) {
    return '工人禁止创建看板或追加任务'
  }
  // 防递归：工人不能再启动 Task/Agent/Subagent（也覆盖 mcp__...__Task 等命名）。
  if (
    lower === 'task' ||
    lower === 'agent' ||
    lower === 'subagent' ||
    lower.startsWith('task_') ||
    lower.startsWith('task.') ||
    lower.startsWith('agent_') ||
    lower.startsWith('agent.') ||
    lower.startsWith('subagent_') ||
    lower.startsWith('subagent.') ||
    /(?:^|[_:.])(?:task|agent|subagent)(?:$|[_:.])/.test(lower) ||
    lower.includes('spawn_agent') ||
    lower.includes('delegate_agent')
  ) {
    return '工人禁止递归启动 Task/Agent/Subagent'
  }
  // 交互式审批 / 提问 / Plan 模式退出 → 无人值守自动拒绝
  if (
    lower.includes('askuserquestion') ||
    lower.includes('ask_user') ||
    lower === 'ask' ||
    lower.includes('exitplanmode') ||
    lower.includes('exit_plan') ||
    lower.includes('requestpermission') ||
    lower.includes('request_permission') ||
    lower.includes('permission_request') ||
    lower.includes('user_confirm') ||
    lower.includes('userconfirm') ||
    lower.includes('confirm_user') ||
    lower.includes('needs_confirmation') ||
    lower.includes('needsconfirmation')
  ) {
    return '无人值守：自动拒绝交互式审批/提问'
  }
  // Browser 交互（通常会卡住等待页面/用户）
  if (
    lower.startsWith('browser_') ||
    lower.startsWith('browser.') ||
    lower === 'browser' ||
    lower.includes('browser_click') ||
    lower.includes('browser_type') ||
    lower.includes('browser_navigate') ||
    lower.includes('browser_fill') ||
    lower.includes('browser_snapshot')
  ) {
    return '无人值守：拒绝 Browser_* 交互工具'
  }
  return null
}

export type WorkerPermissionResolution =
  | { ok: true; permissionMode: Exclude<TAgentPermissionMode, 'plan'> }
  | { ok: false; reason: string }

/**
 * Bound worker permission is the intersection of role and parent session policy.
 * A parent-owned worker may not elevate a Chat/Plan parent; missing parent policy
 * is fail-closed. Standalone boards keep their legacy behavior and do not call this.
 */
export function resolveWorkerPermission(
  parent: { executionMode?: string; permissionMode?: TAgentPermissionMode } | undefined,
  rolePermission: 'auto' | 'bypassPermissions',
): WorkerPermissionResolution {
  if (!parent) return { ok: false, reason: '来源主会话不存在，无法确认工人权限' }
  if (parent.executionMode === 'chat') {
    return { ok: false, reason: '来源主会话为 Chat 模式，禁止写入型班组工人' }
  }
  if (parent.permissionMode === 'plan') {
    return { ok: false, reason: '来源主会话为计划模式，禁止写入型班组工人' }
  }
  if (parent.permissionMode !== 'auto' && parent.permissionMode !== 'bypassPermissions') {
    return { ok: false, reason: '无法确认来源主会话权限，已阻止班组工人启动' }
  }
  return {
    ok: true,
    permissionMode: parent.permissionMode === 'auto' || rolePermission === 'auto'
      ? 'auto'
      : 'bypassPermissions',
  }
}

/** 把被拒绝的工具调用记入 task.metadata.blockedApprovals */
function recordBlockedApproval(
  taskId: string,
  toolName: string,
  input: unknown,
  reason: string,
): void {
  try {
    const task = getTask(taskId)
    if (!task) return
    const prev = Array.isArray(task.metadata?.blockedApprovals)
      ? [...(task.metadata!.blockedApprovals as BlockedApprovalRecord[])]
      : []
    const entry: BlockedApprovalRecord = {
      tool: toolName,
      input: input ?? {},
      reason,
      timestamp: Date.now(),
    }
    prev.push(entry)
    // 防止无限膨胀
    const capped = prev.length > 50 ? prev.slice(-50) : prev
    updateTask(taskId, {
      metadata: {
        ...(task.metadata ?? {}),
        blockedApprovals: capped,
      } as KanbanTask['metadata'],
    })
  } catch (err) {
    console.warn(`[看板工人] 记录 blockedApprovals 失败: ${taskId}`, err)
  }
}

/** 从 content 块数组抽 text */
function textsFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('')
}

/**
 * 合并多帧 assistant 文本。
 * - 若后帧以前帧为前缀（累积全文）→ 取最长
 * - 否则视为真增量拼接
 */
export function mergeAssistantTextChunks(chunks: string[]): string {
  const cleaned = chunks.map((c) => c.trim()).filter(Boolean)
  if (cleaned.length === 0) return ''
  let best = cleaned[0]!
  for (let i = 1; i < cleaned.length; i++) {
    const c = cleaned[i]!
    if (c.startsWith(best)) best = c
    else if (best.startsWith(c)) continue
    else best = `${best}${c}`
  }
  return best.trim()
}

/** 从 SDK / IR / Pi 流式载荷抽 assistant 文本 */
export function extractAssistantText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const m = msg as Record<string, unknown>

  // Pi 桌面流：{ kind: 'sdk_message', message: IR }
  if (m.kind === 'sdk_message' && m.message && typeof m.message === 'object') {
    return extractAssistantText(m.message)
  }
  // 部分控制事件内嵌 message
  if (m.kind === 'message' && m.message && typeof m.message === 'object') {
    return extractAssistantText(m.message)
  }

  if (m.type === 'assistant' || m.role === 'assistant') {
    // IR：{ type, content: [{type:'text', text}] }
    const fromContent = textsFromContentBlocks(m.content)
    if (fromContent) return fromContent
    // SDK：{ type, message: { content: [...] } }
    const message = m.message as { content?: unknown; role?: string } | undefined
    if (message) {
      const t = textsFromContentBlocks(message.content)
      if (t) return t
    }
  }

  // 裸 content 数组
  const bare = textsFromContentBlocks(m.content)
  if (bare) return bare

  if (m.type === 'result' || m.kind === 'result') {
    if (typeof m.result === 'string' && m.result.trim()) return m.result.trim()
    if (typeof m.subtype === 'string' && m.subtype === 'success' && typeof m.result === 'string') {
      return (m.result as string).trim()
    }
    // 部分 SDK result 把正文放在 content
    const fromResContent = textsFromContentBlocks(m.content)
    if (fromResContent) return fromResContent
  }

  // stream 事件：assistantMessageEvent / text_delta 累计字段
  const ame = m.assistantMessageEvent as { type?: string; text?: string; delta?: string } | undefined
  if (ame && typeof ame === 'object') {
    if (typeof ame.text === 'string' && ame.text) return ame.text
    if (typeof ame.delta === 'string' && ame.delta) return ame.delta
  }
  if (typeof m.text === 'string' && m.text.trim()) return m.text.trim()
  if (typeof m.delta === 'string' && m.delta.trim()) return m.delta.trim()

  return ''
}

/** 从流消息尝试抽 tool 名（进度日志用） */
export function extractToolName(msg: unknown): string | undefined {
  if (!msg || typeof msg !== 'object') return undefined
  const m = msg as Record<string, unknown>
  const inner = (m.kind === 'sdk_message' ? m.message : m) as Record<string, unknown>
  if (!inner || typeof inner !== 'object') return undefined
  const content = (inner as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  for (const b of content as Array<{ type?: string; name?: string }>) {
    if (b?.type === 'tool_use' && typeof b.name === 'string') return b.name
  }
  return undefined
}

function classifyErrorSource(error: string): KanbanWorkerRunnerResult['errorSource'] {
  const msg = error.toLowerCase()
  if (
    /\bkscc\b/i.test(error) ||
    /\beconn/i.test(msg) ||
    /\btimeout\b/i.test(msg) ||
    /\bnetwork\b/i.test(msg)
  ) {
    return 'kscc'
  }
  if (/\bsession\b/i.test(msg) || /\bquery\b/i.test(msg) || /\bsdk\b/i.test(msg)) {
    return 'worker-sdk'
  }
  return 'tagent'
}

export type WorkerTerminalResolution = {
  finalStatus: 'done' | 'failed'
  error?: string
}

/** Only an explicit successful terminal event can complete a headless task. */
export function resolveWorkerTerminal(
  terminal: {
    subtype?: unknown
    errors?: unknown
    error?: unknown
    is_error?: unknown
    isError?: unknown
    result?: unknown
  } | undefined,
): WorkerTerminalResolution {
  const subtype = typeof terminal?.subtype === 'string' ? terminal.subtype : ''
  const errors = Array.isArray(terminal?.errors)
    ? terminal.errors.filter((error): error is string => Boolean(typeof error === 'string' && error.trim()))
    : []
  const hasErrors = Array.isArray(terminal?.errors) && terminal.errors.length > 0
  const error = typeof terminal?.error === 'string' ? terminal.error.trim() : ''
  // Error evidence wins over a nominal success/completed subtype. Official and
  // Pi runners can preserve a success-looking envelope while carrying an error.
  if (terminal?.is_error === true || terminal?.isError === true || hasErrors || error) {
    return {
      finalStatus: 'failed',
      error: errors.join('\n') || error || '工人终态包含错误证据',
    }
  }
  if (subtype === 'success' || subtype === 'completed') return { finalStatus: 'done' }
  const result = typeof terminal?.result === 'string' ? terminal.result.trim() : ''
  return {
    finalStatus: 'failed',
    error: errors.join('\n') || result || `工人未成功完成（终态: ${subtype || 'unknown'}）`,
  }
}

function resolveWorkerCwd(task: KanbanTask): { cwd: string; workspaceId?: string } {
  const board = getBoard(task.boardId)
  if (board?.cwd) {
    return { cwd: board.cwd, workspaceId: board.workspaceId }
  }
  const workspaceId = board?.workspaceId
  if (workspaceId) {
    try {
      const ws = listWorkspaces().find((w) => w.id === workspaceId)
      if (ws?.projectDirectory) {
        return { cwd: ws.projectDirectory, workspaceId }
      }
    } catch {
      /* ignore */
    }
  }
  return { cwd: process.cwd(), workspaceId }
}

function pickModel(channel: Channel, preferred?: string): string {
  const models = (channel.models ?? []).filter((m) => m.enabled !== false)
  if (preferred && models.some((m) => m.id === preferred)) return preferred
  if (channel.defaultModelId && models.some((m) => m.id === channel.defaultModelId)) {
    return channel.defaultModelId
  }
  return models[0]?.id ?? preferred ?? 'unknown'
}

/**
 * headless 执行一条看板任务
 */
export async function runKanbanWorkerHeadless(task: KanbanTask): Promise<KanbanWorkerRunnerResult> {
  const channel = getChannel(task.channelId)
  if (!channel) {
    return {
      error: `渠道不存在: ${task.channelId}`,
      errorSource: 'tagent',
      finalStatus: 'failed',
    }
  }
  if (!channel.enabled) {
    return {
      error: `渠道已禁用: ${channel.name}`,
      errorSource: 'tagent',
      finalStatus: 'failed',
    }
  }

  const { cwd, workspaceId } = resolveWorkerCwd(task)
  const availableModels = (channel.models ?? [])
    .filter((m) => m.enabled !== false)
    .map((m) => m.id)
  const sessionId = `kw_${task.id}`
  // 历史 kscc CLI 通路已移除：绑定该渠道的看板任务不再可运行。
  if (channel.provider === 'kscc-internal') {
    return {
      error: '该渠道已停用（历史 kscc CLI 通路已移除），无法启动看板工人',
      errorSource: 'tagent',
      finalStatus: 'failed',
    }
  }
  const kind: ChannelKind = 'external'
  const parentSessionId = getBoard(task.boardId)?.parentSessionId?.trim()
  const parentMeta = parentSessionId ? getSessionMeta(parentSessionId) : undefined
  const inheritedModelId = parentMeta?.channelId === task.channelId
    ? parentMeta.modelId?.trim()
    : undefined
  const parentBoundModelId = task.modelId || inheritedModelId
  const boundModel = parentBoundModelId
    ? channel.models.find((model) => model.id === parentBoundModelId)
    : undefined
  if (parentSessionId && (!parentBoundModelId || !channel.enabled || !boundModel?.enabled)) {
    const reason = '无法从来源主会话继承同渠道的已启用模型，未启动工人'
    return { error: reason, errorSource: 'kanban', finalStatus: 'blocked', blockedReason: reason }
  }
  if (
    parentSessionId &&
    parentBoundModelId &&
    channel.provider !== 'codex-internal'
  ) {
    try {
      validateDelegationModelSelection({
        channelId: task.channelId,
        modelId: parentBoundModelId,
        reason: typeof task.metadata?.selectionReason === 'string' && task.metadata.selectionReason.trim()
          ? task.metadata.selectionReason
          : '继承来源主会话同渠道模型，启动前重新校验当前渠道与画像状态',
        complexity: task.metadata?.complexity === 'simple' || task.metadata?.complexity === 'standard' || task.metadata?.complexity === 'complex'
          ? task.metadata.complexity
          : 'standard',
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { error: reason, errorSource: 'kanban', finalStatus: 'blocked', blockedReason: reason }
    }
  }
  const resolution = previewWorkerResolution(task, parentSessionId ? [] : availableModels)
  const modelId = pickModel(
    channel,
    task.modelId || inheritedModelId || (parentSessionId ? undefined : resolution.modelId),
  )
  const permission = parentSessionId
    ? resolveWorkerPermission(parentMeta, resolution.permissionMode)
    : { ok: true as const, permissionMode: resolution.permissionMode }
  if (!permission.ok) {
    return { error: permission.reason, errorSource: 'kanban', finalStatus: 'blocked', blockedReason: permission.reason }
  }
  const workerPermissionMode = permission.permissionMode
  const getLiveWorkerPermission = (): WorkerPermissionResolution => {
    if (!parentSessionId) return { ok: true, permissionMode: resolution.permissionMode }
    return resolveWorkerPermission(getSessionMeta(parentSessionId), resolution.permissionMode)
  }

  // 工人会话：hidden，绝不进侧栏列表（过程在班组详情内看）
  if (!getSessionMeta(sessionId)) {
    createSession({
      id: sessionId,
      title: `工人·${task.title}`.slice(0, 40),
      channelId: channel.id,
      modelId,
      workspaceId,
      turnCount: 1,
    })
  }
  updateSessionMeta(sessionId, {
    executionMode: 'work',
    permissionMode: workerPermissionMode,
    parentBoardId: task.boardId,
    sourceKanbanTaskId: task.id,
    hidden: true,
    channelId: channel.id,
    modelId,
    workspaceId,
  })

  const userPrompt = [
    `# 任务：${task.title}`,
    '',
    task.body?.trim() || '（无 body，请按标题完成可验收交付）',
    '',
    '## 交付要求',
    '- 请直接动手完成任务，不要只复述标题。',
    '- 结束后用清晰中文写**可验收摘要**（做了什么、改了哪些文件/结论、如何验证）。',
    '- 摘要至少 3 句，禁止只回复「完成/好了/ok」。',
  ].join('\n')

  const workerSystemAppend = [
    resolution.systemPrompt,
    '',
    '## 工人交付契约',
    '- 你必须在结束前给出可独立阅读的中文摘要（不少于 80 字）。',
    '- 摘要结构建议：1) 做了什么 2) 产出/结论 3) 如何验证。',
    '- 若工具调用后无文件变更，也要说明调查结论与依据。',
  ]
    .filter(Boolean)
    .join('\n')
  const adapter = getAdapter(kind)
  const textChunks: string[] = []
  const toolNames: string[] = []
  let terminal: { subtype?: unknown; errors?: unknown; result?: unknown } | undefined
  const abort = new AbortController()
  // Timeout must tear down the provider session immediately. Merely aborting Pi's
  // local signal would leave a Claude/KSCC child process waiting until its next event.
  const timeout = setTimeout(() => {
    abort.abort()
    try {
      adapter.abort(sessionId)
    } catch (error) {
      console.warn(`[看板工人] 超时中止 adapter 失败: ${task.id}`, error)
    }
  }, WORKER_TIMEOUT_MS)

  const workerCanUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    _options?: { mcpServers?: unknown },
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > => {
    const block = isBlockedWorkerTool(toolName)
    if (block) {
      recordBlockedApproval(task.id, toolName, input, block)
      return { behavior: 'deny', message: block }
    }
    const livePermission = getLiveWorkerPermission()
    if (!livePermission.ok) {
      recordBlockedApproval(task.id, toolName, input, livePermission.reason)
      return { behavior: 'deny', message: livePermission.reason }
    }
    if (
      livePermission.permissionMode === 'auto' &&
      (!isAutoModeAutoAllowTool(toolName, input, cwd) || isWriteTool(toolName, input))
    ) {
      const reason = '当前班组工人自动审批仅允许已知安全工具；该工具需用户授权或已被阻止'
      recordBlockedApproval(task.id, toolName, input, reason)
      return { behavior: 'deny', message: reason }
    }
    // SDK allow 必须带 updatedInput，否则 Zod 校验失败整次工具权限崩掉
    return { behavior: 'allow', updatedInput: input }
  }

  const workerBeforeToolCall = async (ctx: {
    toolCall: { name: string; arguments?: Record<string, unknown> }
  }): Promise<{ block: true; reason: string } | undefined> => {
    const block = isBlockedWorkerTool(ctx.toolCall.name)
    if (block) {
      recordBlockedApproval(task.id, ctx.toolCall.name, ctx.toolCall.arguments ?? {}, block)
      return { block: true, reason: block }
    }
    const livePermission = getLiveWorkerPermission()
    if (!livePermission.ok) {
      recordBlockedApproval(task.id, ctx.toolCall.name, ctx.toolCall.arguments ?? {}, livePermission.reason)
      return { block: true, reason: livePermission.reason }
    }
    if (
      livePermission.permissionMode === 'auto' &&
      (!isAutoModeAutoAllowTool(ctx.toolCall.name, ctx.toolCall.arguments ?? {}, cwd) ||
        isWriteTool(ctx.toolCall.name, ctx.toolCall.arguments ?? {}))
    ) {
      const reason = '当前班组工人自动审批仅允许已知安全工具；该工具需用户授权或已被阻止'
      recordBlockedApproval(task.id, ctx.toolCall.name, ctx.toolCall.arguments ?? {}, reason)
      return { block: true, reason }
    }
    return undefined
  }

  try {
    let queryInput: PiQueryOptions

    {
      const apiKey = getDecryptedApiKey(channel.id)
      if (!apiKey) {
        return {
          error: `渠道「${channel.name}」apiKey 无效，请重新配置`,
          errorSource: 'tagent',
          finalStatus: 'failed',
        }
      }
      const sanitizedPath = workspaceId ?? ''
      const enabledMcp = sanitizedPath ? getEnabledMcpServers(sanitizedPath) : {}
      const { buildPiKanbanTools } = await import('./kanban-agent-tools')
      const workerTools = buildPiKanbanTools({
        sessionId,
        channelId: channel.id,
        agentCwd: cwd,
        workspaceId,
        toolMode: 'worker',
      })
      queryInput = {
        sessionId,
        prompt: userPrompt,
        model: modelId,
        cwd,
        mcpConfig: { servers: enabledMcp },
        beforeToolCall: workerBeforeToolCall,
        systemPromptAppend: workerSystemAppend,
        extraTools: workerTools,
        abortSignal: abort.signal,
        maxTurns: WORKER_MAX_TURNS,
        channelConfig: {
          type: 'external',
          provider: channel.provider,
          apiKey,
          baseUrl: channel.baseUrl,
          modelId,
          apiProtocol: channel.apiProtocol,
          thinkingEnabled: false,
          thinkingLevel: 'medium',
          contextWindow: resolveModelContextWindow(channel, modelId),
          headers: resolveChannelRequestHeaders(channel.provider, apiKey),
        },
      } as PiQueryOptions
    }

    console.log(
      `[看板工人] 启动 headless: task=${task.id} session=${sessionId} channel=${channel.name} model=${modelId}`,
    )

    for await (const msg of adapter.query(queryInput as never)) {
      if (abort.signal.aborted) {
        adapter.abort?.(sessionId)
        return {
          error: `工人超时（>${WORKER_TIMEOUT_MS / 60000} 分钟）`,
          errorSource: 'kanban',
          finalStatus: 'blocked',
          blockedReason: 'worker_timeout',
        }
      }
      const piece = extractAssistantText(msg)
      if (piece) textChunks.push(piece)
      const tool = extractToolName(msg)
      if (tool && toolNames[toolNames.length - 1] !== tool) {
        toolNames.push(tool)
        // 过程日志：工具调用即时写入，详情页可回看
        try {
          const existing = getTask(task.id)
          const logs = Array.isArray(existing?.metadata?.progressLogs)
            ? [...(existing!.metadata!.progressLogs as ProgressLogEntry[])]
            : []
          logs.push({
            text: `调用工具 ${tool}`,
            status: 'running',
            lastToolName: tool,
            ts: Date.now(),
          })
          updateTask(task.id, {
            metadata: {
              ...(existing?.metadata ?? {}),
              progressLogs: logs.slice(-40),
            } as KanbanTask['metadata'],
          })
        } catch {
          /* ignore */
        }
      }

      const m = msg as SDKMessage & { type?: string; kind?: string }
      // 一轮结束（SDK type=result 或 Pi kind=result）。EOF 没有 terminal 不能算成功。
      if (m.type === 'result' || m.kind === 'result') {
        terminal = m as unknown as {
          subtype?: unknown
          errors?: unknown
          result?: unknown
        }
        break
      }
    }

    if (abort.signal.aborted) {
      return {
        error: `工人超时（>${WORKER_TIMEOUT_MS / 60000} 分钟）`,
        errorSource: 'kanban',
        finalStatus: 'blocked',
        blockedReason: 'worker_timeout',
      }
    }
    const terminalResolution = resolveWorkerTerminal(terminal)
    if (terminalResolution.finalStatus !== 'done') {
      return {
        error: terminalResolution.error,
        errorSource: classifyErrorSource(terminalResolution.error ?? ''),
        finalStatus: 'failed',
      }
    }

    // 优先：智能合并流式帧（防累积全文被 join 成重复字）
    let summary = mergeAssistantTextChunks(textChunks)

    // 截断过长摘要
    const truncated =
      summary.length > 8000 ? `${summary.slice(0, 8000)}\n…(截断)` : summary

    try {
      const existing = getTask(task.id)
      const logs = Array.isArray(existing?.metadata?.progressLogs)
        ? [...(existing!.metadata!.progressLogs as ProgressLogEntry[])]
        : []
      logs.push({
        text: truncated.slice(0, 500),
        status: 'done',
        ts: Date.now(),
      })
      updateTask(task.id, {
        metadata: {
          ...(existing?.metadata ?? {}),
          progressLogs: logs.slice(-40),
        } as KanbanTask['metadata'],
      })
    } catch {
      /* ignore */
    }

    return {
      summary: truncated,
      finalStatus: 'done',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[看板工人] 失败: ${task.id}`, err)
    if (abort.signal.aborted) {
      return {
        error: `工人超时（>${WORKER_TIMEOUT_MS / 60000} 分钟）`,
        errorSource: 'kanban',
        finalStatus: 'blocked',
        blockedReason: 'worker_timeout',
      }
    }
    return {
      error: msg,
      errorSource: classifyErrorSource(msg),
      finalStatus: 'failed',
    }
  } finally {
    clearTimeout(timeout)
    try {
      adapter.abort?.(sessionId)
    } catch {
      /* ignore */
    }
  }
}
