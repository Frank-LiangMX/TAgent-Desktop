/**
 * 看板 Agent 工具（主会话 full / 工人 worker）
 *
 * - full：create_board / add_task / list_*（Work 才允许写）
 * - worker：complete / block / list_tasks / comment（禁止建板）
 *
 * kscc：createSdkMcpServer 注入 mcpServers.kanban
 * Pi：TypeBox AgentTool 列表 extraTools
 */
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { KanbanTask } from '@tagent/shared'
import { assertKanbanWriteAllowed, KANBAN_CHAT_BLOCK_REASON } from './work-mode-guard'
import * as store from './kanban-store'
import { kickKanbanDispatcher } from './kanban-dispatcher'
import { updateTask } from './kanban-store'

export type KanbanToolMode = 'full' | 'worker'

export interface KanbanToolContext {
  sessionId: string
  channelId?: string
  agentCwd?: string
  workspaceId?: string
  toolMode?: KanbanToolMode
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

function piText(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text', text }], details: {} }
}

// ── handlers ──────────────────────────────────────────

export async function handleCreateBoard(
  args: Record<string, unknown>,
  ctx: KanbanToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const gate = assertKanbanWriteAllowed(ctx.sessionId)
  if (!gate.ok) return textResult(`错误：${gate.error}`)

  const rootGoal = String(args.rootGoal ?? '').trim()
  if (!rootGoal) return textResult('错误：rootGoal 不能为空')

  const board = store.createBoard({
    rootGoal,
    parentSessionId: String(args.parentSessionId ?? ctx.sessionId),
    title: args.title != null ? String(args.title) : undefined,
    mode: args.mode === 'ta' ? 'ta' : 'general',
    originBridge: 'desktop',
    cwd: args.cwd != null ? String(args.cwd) : ctx.agentCwd,
    workspaceId: args.workspaceId != null ? String(args.workspaceId) : ctx.workspaceId,
    requireSummary: args.requireSummary === true,
  })
  // 绑定主会话 boardId（侧栏/团队 Tab 用）
  try {
    const { updateSessionMeta } = await import('../agent/session-store')
    updateSessionMeta(ctx.sessionId, { boardId: board.id })
  } catch {
    /* ignore */
  }
  kickKanbanDispatcher()
  return textResult(
    JSON.stringify(
      {
        ok: true,
        boardId: board.id,
        title: board.title,
        message: `看板已创建。请用 kanban_add_task 添加任务（boardId=${board.id}）。`,
      },
      null,
      2,
    ),
  )
}

export async function handleAddTask(
  args: Record<string, unknown>,
  ctx: KanbanToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const gate = assertKanbanWriteAllowed(ctx.sessionId)
  if (!gate.ok) return textResult(`错误：${gate.error}`)

  const boardId = String(args.boardId ?? '').trim()
  const title = String(args.title ?? '').trim()
  const channelId = String(args.channelId ?? ctx.channelId ?? '').trim()
  if (!boardId || !title) return textResult('错误：boardId 与 title 必填')
  if (!channelId) return textResult('错误：channelId 缺失（请传 channelId 或绑定会话渠道）')

  const dependsOnTaskIds = Array.isArray(args.dependsOnTaskIds)
    ? (args.dependsOnTaskIds as unknown[]).map((x) => String(x)).filter(Boolean)
    : typeof args.dependsOnTaskIds === 'string' && args.dependsOnTaskIds.trim()
      ? args.dependsOnTaskIds.split(/[,\s]+/).filter(Boolean)
      : undefined

  try {
    const task = store.createTask(
      {
        boardId,
        title,
        body: args.body != null ? String(args.body) : undefined,
        roleId: args.roleId != null ? String(args.roleId) : undefined,
        channelId,
        modelId: args.modelId != null ? String(args.modelId) : undefined,
        priority: typeof args.priority === 'number' ? args.priority : undefined,
        parentTaskId: args.parentTaskId != null ? String(args.parentTaskId) : undefined,
        dependsOnTaskIds,
        goalMode: args.goalMode === true,
        acceptanceCriteria:
          args.acceptanceCriteria != null ? String(args.acceptanceCriteria) : undefined,
        goalMaxTurns: typeof args.goalMaxTurns === 'number' ? args.goalMaxTurns : undefined,
      },
      { availableModels: [] },
    )
    kickKanbanDispatcher()
    const queued = task.status === 'ready' ? 'ready，将派工' : 'pending，等待前置完成'
    return textResult(
      JSON.stringify(
        {
          ok: true,
          taskId: task.id,
          status: task.status,
          roleId: task.roleId,
          modelId: task.modelId,
          dependsOnTaskIds: dependsOnTaskIds ?? [],
          message: `任务已入队（${queued}）。`,
        },
        null,
        2,
      ),
    )
  } catch (e) {
    return textResult(`错误：${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function handleListBoards(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const status =
    args.status === 'active' || args.status === 'completed' || args.status === 'cancelled'
      ? args.status
      : 'active'
  const boards = store.listBoards({ status })
  return textResult(
    JSON.stringify(
      {
        count: boards.length,
        boards: boards.map((b) => ({
          id: b.id,
          title: b.title,
          rootGoal: b.rootGoal,
          status: b.status,
          paused: b.paused,
          maxConcurrent: b.maxConcurrent,
        })),
      },
      null,
      2,
    ),
  )
}

export async function handleListTasks(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const boardId = String(args.boardId ?? '').trim()
  if (!boardId) return textResult('错误：boardId 必填')
  const status = args.status != null ? String(args.status) : undefined
  const tasks = store.listTasksByBoard(
    boardId,
    status as Parameters<typeof store.listTasksByBoard>[1],
  )
  return textResult(
    JSON.stringify(
      {
        count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          roleId: t.roleId,
          modelId: t.modelId,
          blockers: store.listBlockersOf(t.id),
          blockedReason: t.blockedReason,
          resultSummary: t.resultSummary?.slice(0, 200),
          error: t.error,
        })),
      },
      null,
      2,
    ),
  )
}

export async function handleComplete(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const taskId = String(args.taskId ?? '').trim()
  if (!taskId) return textResult('错误：taskId 必填')
  const summary = String(args.summary ?? args.result ?? args.evidence ?? '').trim()
  const task = store.getTask(taskId)
  if (!task) return textResult(`错误：任务不存在 ${taskId}`)
  if (task.status !== 'running' && task.status !== 'ready') {
    return textResult(`错误：任务状态为 ${task.status}，无法 complete`)
  }
  const { judgeGoalComplete } = await import('./kanban-goal-judge')
  const verdict = judgeGoalComplete(task, summary || `任务「${task.title}」已完成`)
  if (!verdict.ok) {
    return textResult(
      JSON.stringify(
        {
          ok: false,
          taskId,
          status: task.status,
          reason: verdict.reason,
          message: 'goal 验收未通过，请补充证据后重试 kanban_complete 或 kanban_block',
        },
        null,
        2,
      ),
    )
  }
  updateTask(taskId, {
    status: 'done',
    resultSummary: summary || `任务「${task.title}」已完成`,
    finishedAt: Date.now(),
  })
  const promoted = store.promoteReadyDependents(taskId)
  kickKanbanDispatcher()
  return textResult(
    JSON.stringify(
      {
        ok: true,
        taskId,
        status: 'done',
        promoted: promoted.map((p) => p.id),
      },
      null,
      2,
    ),
  )
}

export async function handleBlock(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const taskId = String(args.taskId ?? '').trim()
  const reason = String(args.reason ?? '').trim()
  if (!taskId || !reason) return textResult('错误：taskId 与 reason 必填')
  const task = store.getTask(taskId)
  if (!task) return textResult(`错误：任务不存在 ${taskId}`)
  updateTask(taskId, {
    status: 'blocked',
    blockedReason: reason,
    finishedAt: Date.now(),
  })
  return textResult(JSON.stringify({ ok: true, taskId, status: 'blocked', reason }, null, 2))
}

export async function handleComment(
  args: Record<string, unknown>,
  author = 'main',
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const taskId = String(args.taskId ?? '').trim()
  const comment = String(args.comment ?? '').trim()
  if (!taskId || !comment) return textResult('错误：taskId 与 comment 必填')
  const task = store.getTask(taskId)
  if (!task) return textResult(`错误：任务不存在 ${taskId}`)
  const bb = Array.isArray(task.metadata?.blackboard)
    ? [...(task.metadata!.blackboard as unknown[])]
    : []
  bb.push({ author, comment, ts: Date.now() })
  const metadata = { ...(task.metadata ?? {}), blackboard: bb }
  updateTask(taskId, { metadata: metadata as KanbanTask['metadata'] })
  return textResult(JSON.stringify({ ok: true, taskId, author }, null, 2))
}

// ── Pi tools ──────────────────────────────────────────

export function buildPiKanbanTools(ctx: KanbanToolContext): AgentTool[] {
  const mode = ctx.toolMode ?? 'full'
  const tools: AgentTool[] = []

  if (mode === 'full') {
    tools.push(
      {
        name: 'kanban_create_board',
        label: 'kanban_create_board',
        description:
          '创建长任务派工看板（Work 模式）。传入 rootGoal；创建后用 kanban_add_task 加任务，调度器会自动派 headless 工人。',
        parameters: Type.Object({
          rootGoal: Type.String({ description: '用户原始目标' }),
          title: Type.Optional(Type.String()),
          requireSummary: Type.Optional(Type.Boolean()),
        }),
        execute: async (_id, params) =>
          piText((await handleCreateBoard(params as Record<string, unknown>, ctx)).content[0]!.text),
      },
      {
        name: 'kanban_add_task',
        label: 'kanban_add_task',
        description:
          '向看板追加任务并入队派工。roleId 推荐：generalist/coder/analyst/reviewer/writer 等。',
        parameters: Type.Object({
          boardId: Type.String(),
          title: Type.String(),
          body: Type.Optional(Type.String()),
          roleId: Type.Optional(Type.String()),
          channelId: Type.Optional(Type.String()),
          modelId: Type.Optional(Type.String()),
          priority: Type.Optional(Type.Number()),
          dependsOnTaskIds: Type.Optional(Type.Array(Type.String())),
          goalMode: Type.Optional(Type.Boolean()),
          acceptanceCriteria: Type.Optional(Type.String()),
        }),
        execute: async (_id, params) =>
          piText((await handleAddTask(params as Record<string, unknown>, ctx)).content[0]!.text),
      },
      {
        name: 'kanban_list_boards',
        label: 'kanban_list_boards',
        description: '列出看板（默认 active）',
        parameters: Type.Object({
          status: Type.Optional(
            Type.Union([
              Type.Literal('active'),
              Type.Literal('completed'),
              Type.Literal('cancelled'),
            ]),
          ),
        }),
        execute: async (_id, params) =>
          piText((await handleListBoards(params as Record<string, unknown>)).content[0]!.text),
      },
    )
  }

  tools.push(
    {
      name: 'kanban_list_tasks',
      label: 'kanban_list_tasks',
      description: '列出看板任务及状态',
      parameters: Type.Object({
        boardId: Type.String(),
        status: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) =>
        piText((await handleListTasks(params as Record<string, unknown>)).content[0]!.text),
    },
    {
      name: 'kanban_complete',
      label: 'kanban_complete',
      description: '工人完成任务并提交摘要',
      parameters: Type.Object({
        taskId: Type.String(),
        summary: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) =>
        piText((await handleComplete(params as Record<string, unknown>)).content[0]!.text),
    },
    {
      name: 'kanban_block',
      label: 'kanban_block',
      description: '工人标记任务阻塞',
      parameters: Type.Object({
        taskId: Type.String(),
        reason: Type.String(),
      }),
      execute: async (_id, params) =>
        piText((await handleBlock(params as Record<string, unknown>)).content[0]!.text),
    },
  )

  return tools
}

// ── kscc MCP 注入 ─────────────────────────────────────

export async function injectKanbanMcpServer(
  mcpServers: Record<string, unknown>,
  ctx: KanbanToolContext,
): Promise<void> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')
  const mode: KanbanToolMode = ctx.toolMode ?? 'full'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = []

  if (mode === 'full') {
    tools.push(
      sdk.tool(
        'kanban_create_board',
        '创建长任务派工看板（仅 Work）。创建后 kanban_add_task 加任务，调度器自动派工。',
        {
          rootGoal: z.string(),
          title: z.string().optional(),
          requireSummary: z.boolean().optional(),
        },
        async (args: Record<string, unknown>) => handleCreateBoard(args, ctx),
      ),
      sdk.tool(
        'kanban_add_task',
        '向看板追加任务（仅 Work）。roleId: generalist/coder/analyst/reviewer/writer。dependsOnTaskIds 指定前置任务，未完成前保持 pending。',
        {
          boardId: z.string(),
          title: z.string(),
          body: z.string().optional(),
          roleId: z.string().optional(),
          channelId: z.string().optional(),
          modelId: z.string().optional(),
          priority: z.number().optional(),
          dependsOnTaskIds: z.array(z.string()).optional(),
          goalMode: z.boolean().optional(),
          acceptanceCriteria: z.string().optional(),
        },
        async (args: Record<string, unknown>) =>
          handleAddTask(
            { ...args, channelId: args.channelId ?? ctx.channelId },
            ctx,
          ),
      ),
      sdk.tool(
        'kanban_list_boards',
        '列出看板',
        {
          status: z.enum(['active', 'completed', 'cancelled']).optional(),
        },
        async (args: Record<string, unknown>) => handleListBoards(args),
        { annotations: { readOnlyHint: true } },
      ),
    )
  }

  tools.push(
    sdk.tool(
      'kanban_list_tasks',
      '列出看板任务',
      {
        boardId: z.string(),
        status: z.string().optional(),
      },
      async (args: Record<string, unknown>) => handleListTasks(args),
      { annotations: { readOnlyHint: true } },
    ),
    sdk.tool(
      'kanban_complete',
      '完成任务',
      { taskId: z.string(), summary: z.string().optional() },
      async (args: Record<string, unknown>) => handleComplete(args),
    ),
    sdk.tool(
      'kanban_block',
      '阻塞任务',
      { taskId: z.string(), reason: z.string() },
      async (args: Record<string, unknown>) => handleBlock(args),
    ),
  )

  const server = sdk.createSdkMcpServer({
    name: 'kanban',
    version: '1.0.0',
    tools,
  })
  mcpServers.kanban = server
  console.log(`[看板] 已注入 MCP 工具 mode=${mode} session=${ctx.sessionId}`)
}

export { KANBAN_CHAT_BLOCK_REASON }
