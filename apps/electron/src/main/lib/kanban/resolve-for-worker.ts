/**
 * 看板工人投影单点：roleId → prompt / 模型 / 权限 / 工具
 *
 * 分配顺序（与 General dispatcher 对齐，简化跨渠道合规）：
 * 1. task.modelId 显式
 * 2. role.modelPool 按序找未超并发
 * 3. fallbackToChannelDefault → availableModels 轮询
 * 4. 全满 → modelId undefined（保持 ready 等下一 tick）
 *
 * @see docs/plans/multi-runtime/04-role-library.md §5
 * @see docs/plans/multi-runtime/07-implementation-phases.md D2
 */
import type { AgentRolePermissionMode, AgentRoleProfile } from '@tagent/shared'
import { DEFAULT_KANBAN_ROLE_ID } from '@tagent/shared'
import { resolveRole } from '../role/agent-role-service'
import {
  composeRoleSystemPrompt,
  toolsForRolePermission,
} from '../role/role-projection'

export interface ResolveForWorkerInput {
  roleId?: string | null
  /** 任务显式模型 */
  modelId?: string | null
  /** 看板/任务渠道可用模型（已过滤合规） */
  availableModels?: string[]
  /** 当前在途：modelId → count */
  modelOccupancy?: Record<string, number>
  /** 全局单模型并发上限（角色未设时） */
  globalMaxConcurrentPerModel?: number
  /** 注入工人上下文用 */
  boardId?: string
  boardTitle?: string
  taskId?: string
  taskTitle?: string
  goalMode?: boolean
  acceptanceCriteria?: string
}

export interface WorkerResolution {
  role: AgentRoleProfile
  systemPrompt: string
  permissionMode: AgentRolePermissionMode
  /** 分配到的模型；undefined 表示池满，任务应保持 ready */
  modelId?: string
  maxConcurrentPerModel: number
  tools: string[]
  fallbackToChannelDefault: boolean
  /** 角色可选默认渠道 */
  channelId?: string
}

/**
 * 从模型池分配（池优先 → 渠道可用列表轮询）
 */
export function assignModelFromPools(args: {
  explicitModelId?: string | null
  modelPool: string[]
  availableModels: string[]
  occupancy: Record<string, number>
  maxPerModel: number
  fallbackToChannelDefault: boolean
}): string | undefined {
  const { occupancy, maxPerModel } = args
  const underCap = (id: string): boolean => (occupancy[id] ?? 0) < maxPerModel

  if (args.explicitModelId?.trim()) {
    const id = args.explicitModelId.trim()
    // 显式指定：不因并发拒绝（与 General 一致：显式直接用）
    return id
  }

  for (const id of args.modelPool) {
    if (!id?.trim()) continue
    if (underCap(id)) return id
  }

  if (!args.fallbackToChannelDefault && args.modelPool.length > 0) {
    return undefined
  }

  for (const id of args.availableModels) {
    if (!id?.trim()) continue
    if (underCap(id)) return id
  }

  return undefined
}

/**
 * 合成看板工人 system prompt
 * 顺序：角色投影 → 防递归/执行约束 → goal 验收（可选）
 */
export function buildKanbanWorkerSystemPrompt(
  role: AgentRoleProfile,
  ctx: {
    boardId?: string
    boardTitle?: string
    taskId?: string
    taskTitle?: string
    goalMode?: boolean
    acceptanceCriteria?: string
  },
): string {
  const boardLabel = ctx.boardTitle || ctx.boardId || '看板'
  const taskLabel = ctx.taskTitle || ctx.taskId || '任务'
  const runtimeConstraints = [
    `这是看板「${boardLabel}」任务「${taskLabel}」${ctx.taskId ? `(${ctx.taskId})` : ''} 的自动执行。`,
    '本任务由看板调度器派工，请直接执行任务内容，不要建议用户再创建看板或定时任务。',
    '禁止创建看板或追加任务（无 kanban_create_board / kanban_add_task）。',
    ctx.taskId
      ? `完成后必须调用 kanban_complete(taskId="${ctx.taskId}", summary="...充分证据...") 结案。`
      : '完成后给出可验收摘要。',
    '若缺信息或无法继续，调用 kanban_block 说明原因。',
  ]

  if (ctx.goalMode) {
    const criteria =
      ctx.acceptanceCriteria?.trim() ||
      `${ctx.taskTitle ?? ''}\n`.trim() ||
      '按任务 body 交付'
    runtimeConstraints.push(
      '',
      '【Goal 模式】本任务启用验收闸门。',
      'kanban_complete 前会对照验收标准裁判；证据不足会被拒绝，请在 summary 中写明验证步骤与结果。',
      `验收标准：\n${criteria.slice(0, 2000)}`,
    )
  }

  return composeRoleSystemPrompt(role, {
    purpose: 'kanban-worker',
    runtimeConstraints: runtimeConstraints.join('\n'),
  })
}

/**
 * 看板工人投影：resolveRole + 模型池 + 工人 prompt
 */
export function resolveForWorker(input: ResolveForWorkerInput = {}): WorkerResolution {
  const role = resolveRole(input.roleId ?? DEFAULT_KANBAN_ROLE_ID)
  const globalMax = input.globalMaxConcurrentPerModel ?? 2
  const maxConcurrentPerModel =
    typeof role.maxConcurrentPerModel === 'number' && role.maxConcurrentPerModel > 0
      ? role.maxConcurrentPerModel
      : globalMax

  const modelId = assignModelFromPools({
    explicitModelId: input.modelId,
    modelPool: role.modelPool ?? [],
    availableModels: input.availableModels ?? [],
    occupancy: input.modelOccupancy ?? {},
    maxPerModel: maxConcurrentPerModel,
    fallbackToChannelDefault: role.fallbackToChannelDefault !== false,
  })

  const systemPrompt = buildKanbanWorkerSystemPrompt(role, {
    boardId: input.boardId,
    boardTitle: input.boardTitle,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    goalMode: input.goalMode,
    acceptanceCriteria: input.acceptanceCriteria,
  })

  return {
    role,
    systemPrompt,
    permissionMode: role.permissionMode,
    modelId,
    maxConcurrentPerModel,
    tools: toolsForRolePermission(role.permissionMode, 'kanban-worker'),
    fallbackToChannelDefault: role.fallbackToChannelDefault !== false,
    channelId: role.channelId,
  }
}
