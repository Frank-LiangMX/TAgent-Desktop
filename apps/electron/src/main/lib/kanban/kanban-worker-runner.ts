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
} from '@tagent/shared'
import { getAdapter, type ChannelKind } from '../adapters'
import type { KsccQueryOptions } from '../adapters/claude/claude-agent-adapter'
import type { PiQueryOptions } from '../adapters/pi/pi-agent-adapter'
import { resolveKsccPath } from '../adapters/claude/kscc-path'
import { createSession, getSessionMeta, updateSessionMeta } from '../agent/session-store'
import {
  getChannel,
  getDecryptedApiKey,
} from '../channel/channel-store'
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
  const resolution = previewWorkerResolution(task, availableModels)
  const modelId = pickModel(channel, task.modelId || resolution.modelId)
  const sessionId = `kw_${task.id}`
  const kind: ChannelKind = channel.provider === 'kscc-internal' ? 'kscc' : 'external'

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
    permissionMode: 'bypassPermissions',
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
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), WORKER_TIMEOUT_MS)

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
    return undefined
  }

  try {
    let queryInput: KsccQueryOptions | PiQueryOptions

    if (kind === 'kscc') {
      const ksccPath = resolveKsccPath()
      if (!ksccPath) {
        return {
          error: '未检测到 kscc，无法启动内网工人',
          errorSource: 'kscc',
          finalStatus: 'failed',
        }
      }
      const sanitizedPath = workspaceId ?? ''
      const enabledMcp = sanitizedPath ? getEnabledMcpServers(sanitizedPath) : {}
      const mcpServers: Record<string, unknown> = {
        ...(Object.keys(enabledMcp).length > 0
          ? (enabledMcp as Record<string, unknown>)
          : {}),
      }
      try {
        const { injectKanbanMcpServer } = await import('./kanban-agent-tools')
        await injectKanbanMcpServer(mcpServers, {
          sessionId,
          channelId: channel.id,
          agentCwd: cwd,
          workspaceId,
          toolMode: 'worker',
        })
      } catch (err) {
        console.warn(`[看板工人] 注入 worker 看板工具失败:`, err)
      }
      queryInput = {
        sessionId,
        prompt: userPrompt,
        model: modelId,
        cwd,
        sdkCliPath: ksccPath,
        env: { ...process.env } as Record<string, string | undefined>,
        maxTurns: WORKER_MAX_TURNS,
        sdkPermissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: workerSystemAppend,
        },
        persistSession: true,
        mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
        canUseTool: workerCanUseTool,
        onSessionId: (sdkSessionId: string) => {
          updateSessionMeta(sessionId, { sdkSessionId })
        },
        onStderr: (data: string) => {
          console.error(`[看板工人 ${task.id} stderr] ${data}`)
        },
      } as KsccQueryOptions
    } else {
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
        channelConfig: {
          type: 'external',
          provider: channel.provider,
          apiKey,
          baseUrl: channel.baseUrl,
          modelId,
          thinkingEnabled: false,
          thinkingLevel: 'medium',
          contextWindow: resolveModelContextWindow(channel, modelId),
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
      // 一轮结束（SDK type=result 或 Pi kind=result）
      if (m.type === 'result' || m.kind === 'result') break
    }

    // 优先：智能合并流式帧（防累积全文被 join 成重复字）
    let summary = mergeAssistantTextChunks(textChunks)

    // 回读面板 JSONL（Pi 常把最终正文只落盘）
    if (summary.length < 40) {
      try {
        const { readPanelMessages, readSdkMessages } = await import('../agent/session-store')
        const panel = [
          ...readPanelMessages(workspaceId, sessionId),
          ...readSdkMessages(workspaceId, sessionId),
        ]
        const parts: string[] = []
        for (const raw of panel) {
          const piece = extractAssistantText(raw)
          if (piece) parts.push(piece)
        }
        const fromDisk = mergeAssistantTextChunks(parts)
        if (fromDisk.length > summary.length) summary = fromDisk
      } catch {
        /* ignore */
      }
    }

    // 仍过短：用工具轨迹合成可读摘要（避免「无文本输出」占位）
    if (summary.length < 30) {
      const toolLine =
        toolNames.length > 0
          ? `过程中调用了工具：${toolNames.slice(0, 12).join(' → ')}${toolNames.length > 12 ? '…' : ''}。`
          : '未观测到工具调用记录。'
      summary = [
        `任务「${task.title}」已跑完一轮 headless 工人。`,
        toolLine,
        '模型未给出足够长的自然语言摘要；请结合任务说明与工具轨迹判断是否达标，必要时重试并要求明确交付说明。',
      ].join('')
    }

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
