/**
 * 看板轻量存储（JSON）— Phase D P0
 *
 * 完整 SQLite 调度器后续从 General 移植；此处先支持建板/建任务/列表，
 * 并在建任务时 resolveForWorker 写入 role 投影后的 modelId。
 * 依赖：KanbanTaskLink type=blocks（from 完成前 to 保持 pending）。
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_KANBAN_ROLE_ID,
  KANBAN_DEFAULT_MAX_CONCURRENT,
  type CreateKanbanBoardInput,
  type CreateKanbanTaskInput,
  type KanbanBoard,
  type KanbanTask,
  type KanbanTaskLink,
  type KanbanTaskStatus,
} from '@tagent/shared'
import { getConfigDir } from '../config/config-paths'
import { writeJsonAtomic } from '../atomic-json'
import { resolveForWorker } from './resolve-for-worker'

interface KanbanStoreFile {
  boards: KanbanBoard[]
  tasks: KanbanTask[]
  /** 任务依赖（blocks / relates） */
  links: KanbanTaskLink[]
}

function storePath(): string {
  return join(getConfigDir(), 'kanban-store.json')
}

function genId(prefix: 'b' | 't'): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
}

function readStore(): KanbanStoreFile {
  const path = storePath()
  if (!existsSync(path)) return { boards: [], tasks: [], links: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as KanbanStoreFile
    return {
      boards: Array.isArray(raw.boards) ? raw.boards : [],
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
      links: Array.isArray(raw.links) ? raw.links : [],
    }
  } catch {
    return { boards: [], tasks: [], links: [] }
  }
}

function emptyStore(): KanbanStoreFile {
  return { boards: [], tasks: [], links: [] }
}

function writeStore(data: KanbanStoreFile): void {
  const path = storePath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeJsonAtomic(path, data)
}

export function createBoard(input: CreateKanbanBoardInput): KanbanBoard {
  const now = Date.now()
  const board: KanbanBoard = {
    id: genId('b'),
    rootGoal: input.rootGoal.trim(),
    parentSessionId: input.parentSessionId,
    title: input.title?.trim() || input.rootGoal.trim().slice(0, 80),
    mode: input.mode ?? 'general',
    originChatId: input.originChatId,
    originBridge: input.originBridge,
    status: 'active',
    maxConcurrent: input.maxConcurrent ?? KANBAN_DEFAULT_MAX_CONCURRENT,
    paused: false,
    requireSummary: input.requireSummary === true,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    createdAt: now,
    updatedAt: now,
  }
  const store = readStore()
  store.boards.push(board)
  writeStore(store)
  console.log(`[看板] 已创建: ${board.id} ${board.title}`)
  return board
}

export function getBoard(boardId: string): KanbanBoard | undefined {
  return readStore().boards.find((b) => b.id === boardId)
}

export function listBoards(filter?: {
  status?: KanbanBoard['status']
}): KanbanBoard[] {
  let list = readStore().boards
  if (filter?.status) list = list.filter((b) => b.status === filter.status)
  return list.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function listTasksByBoard(
  boardId: string,
  status?: KanbanTaskStatus,
): KanbanTask[] {
  let list = readStore().tasks.filter((t) => t.boardId === boardId)
  if (status) list = list.filter((t) => t.status === status)
  return list.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
}

/**
 * 创建任务：默认 roleId=generalist；未指定 modelId 时用 resolveForWorker 从角色池/渠道池取。
 * dependsOnTaskIds 写入 blocks 边；若前置未全部 done 则 status=pending。
 */
export function createTask(
  input: CreateKanbanTaskInput,
  options?: { availableModels?: string[] },
): KanbanTask {
  const board = getBoard(input.boardId)
  if (!board) throw new Error(`看板不存在: ${input.boardId}`)

  const roleId = input.roleId?.trim() || DEFAULT_KANBAN_ROLE_ID
  const resolved = resolveForWorker({
    roleId,
    modelId: input.modelId,
    availableModels: options?.availableModels ?? [],
    boardId: board.id,
    boardTitle: board.title || board.rootGoal,
    taskTitle: input.title,
  })

  const now = Date.now()
  const taskId = genId('t')
  const depIds = (input.dependsOnTaskIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean)
    .filter((id, i, arr) => arr.indexOf(id) === i)

  // 校验前置任务存在且同板
  const existingTasks = listTasksByBoard(input.boardId)
  for (const depId of depIds) {
    const dep = existingTasks.find((t) => t.id === depId)
    if (!dep) throw new Error(`前置任务不存在或不在本板: ${depId}`)
  }

  const depsUnmet = depIds.some((depId) => {
    const dep = existingTasks.find((t) => t.id === depId)
    return dep?.status !== 'done'
  })

  const task: KanbanTask = {
    id: taskId,
    boardId: input.boardId,
    parentTaskId: input.parentTaskId,
    title: input.title.trim(),
    body: input.body?.trim() || input.title.trim(),
    status: depsUnmet ? 'pending' : 'ready',
    roleId,
    channelId: input.channelId,
    modelId: input.modelId?.trim() || resolved.modelId,
    priority: input.priority ?? 0,
    createdAt: now,
    updatedAt: now,
    goalMode: input.goalMode,
    acceptanceCriteria: input.acceptanceCriteria,
    goalMaxTurns: input.goalMaxTurns,
    judgeModel: input.judgeModel,
    metadata: input.metadata as KanbanTask['metadata'],
  }

  const store = readStore()
  store.tasks.push(task)
  for (const fromTaskId of depIds) {
    const exists = store.links.some(
      (l) => l.type === 'blocks' && l.fromTaskId === fromTaskId && l.toTaskId === taskId,
    )
    if (!exists) {
      store.links.push({ fromTaskId, toTaskId: taskId, type: 'blocks' })
    }
  }
  // 触碰 board updatedAt
  const bi = store.boards.findIndex((b) => b.id === board.id)
  if (bi >= 0) {
    store.boards[bi] = { ...store.boards[bi]!, updatedAt: now }
  }
  writeStore(store)
  console.log(
    `[看板] 任务已创建: ${task.id} status=${task.status} role=${task.roleId} model=${task.modelId ?? '（待分配）'}${depIds.length ? ` deps=${depIds.join(',')}` : ''}`,
  )
  return task
}

/** 列出某板全部依赖边 */
export function listLinksByBoard(boardId: string): KanbanTaskLink[] {
  const data = readStore()
  const taskIds = new Set(data.tasks.filter((t) => t.boardId === boardId).map((t) => t.id))
  return data.links.filter((l) => taskIds.has(l.fromTaskId) || taskIds.has(l.toTaskId))
}

/** 某任务的 blocks 前置（from → 本任务） */
export function listBlockersOf(taskId: string): string[] {
  return readStore()
    .links.filter((l) => l.type === 'blocks' && l.toTaskId === taskId)
    .map((l) => l.fromTaskId)
}

/** 某任务 blocks 的后继（本任务 → to） */
export function listBlockedBy(taskId: string): string[] {
  return readStore()
    .links.filter((l) => l.type === 'blocks' && l.fromTaskId === taskId)
    .map((l) => l.toTaskId)
}

/**
 * 当前置任务变为 done 时，把依赖已满足的 pending 后继提升为 ready。
 * 返回被提升的任务列表。
 */
export function promoteReadyDependents(completedTaskId: string): KanbanTask[] {
  const data = readStore()
  const completed = data.tasks.find((t) => t.id === completedTaskId)
  if (!completed || completed.status !== 'done') return []

  const successors = data.links
    .filter((l) => l.type === 'blocks' && l.fromTaskId === completedTaskId)
    .map((l) => l.toTaskId)

  if (successors.length === 0) return []

  const taskById = new Map(data.tasks.map((t) => [t.id, t]))
  const now = Date.now()
  const promoted: KanbanTask[] = []

  for (const toId of successors) {
    const idx = data.tasks.findIndex((t) => t.id === toId)
    if (idx < 0) continue
    const task = data.tasks[idx]!
    if (task.status !== 'pending') continue

    const blockers = data.links
      .filter((l) => l.type === 'blocks' && l.toTaskId === toId)
      .map((l) => l.fromTaskId)
    const allDone = blockers.every((bid) => taskById.get(bid)?.status === 'done')
    if (!allDone) continue

    const next: KanbanTask = { ...task, status: 'ready', updatedAt: now }
    data.tasks[idx] = next
    taskById.set(toId, next)
    promoted.push(next)
    console.log(`[看板] 依赖满足，提升 ready: ${toId}（前置 ${completedTaskId}）`)
  }

  if (promoted.length > 0) {
    const bi = data.boards.findIndex((b) => b.id === completed.boardId)
    if (bi >= 0) {
      data.boards[bi] = { ...data.boards[bi]!, updatedAt: now }
    }
    writeStore(data)
  }
  return promoted
}

/** blocked → ready（用户/IPC 解除阻塞） */
export function unblockTask(taskId: string, reason?: string): KanbanTask | undefined {
  const task = getTask(taskId)
  if (!task) return undefined
  if (task.status !== 'blocked') return task
  const metadata = {
    ...(task.metadata ?? {}),
    unblockReason: reason,
    unblockedAt: Date.now(),
  } as KanbanTask['metadata']
  return updateTask(taskId, {
    status: 'ready',
    blockedReason: undefined,
    error: undefined,
    finishedAt: undefined,
    metadata,
  })
}

/** failed / cancelled → ready 重试 */
export function retryTask(taskId: string): KanbanTask | undefined {
  const task = getTask(taskId)
  if (!task) return undefined
  if (task.status !== 'failed' && task.status !== 'cancelled' && task.status !== 'blocked') {
    return task
  }
  // 若仍有未完成前置，回到 pending
  const blockers = listBlockersOf(taskId)
  const data = readStore()
  const taskById = new Map(data.tasks.map((t) => [t.id, t]))
  const unmet = blockers.some((bid) => taskById.get(bid)?.status !== 'done')
  return updateTask(taskId, {
    status: unmet ? 'pending' : 'ready',
    error: undefined,
    errorSource: undefined,
    blockedReason: undefined,
    resultSummary: undefined,
    finishedAt: undefined,
    startedAt: undefined,
    assigneeSessionId: undefined,
  })
}

/** 更新看板 status（完成回流用） */
export function updateBoard(
  boardId: string,
  patch: Partial<Pick<KanbanBoard, 'status' | 'title' | 'paused' | 'requireSummary' | 'maxConcurrent'>>,
): KanbanBoard | undefined {
  const data = readStore()
  const idx = data.boards.findIndex((b) => b.id === boardId)
  if (idx < 0) return undefined
  const now = Date.now()
  data.boards[idx] = { ...data.boards[idx]!, ...patch, updatedAt: now }
  writeStore(data)
  return data.boards[idx]
}

/** 预览工人投影（不落库，供调试/UI） */
export function previewWorkerResolution(task: Pick<KanbanTask, 'roleId' | 'modelId' | 'title' | 'id' | 'boardId' | 'goalMode' | 'acceptanceCriteria'>, availableModels: string[] = []) {
  const board = getBoard(task.boardId)
  return resolveForWorker({
    roleId: task.roleId,
    modelId: task.modelId,
    availableModels,
    boardId: task.boardId,
    boardTitle: board?.title || board?.rootGoal,
    taskId: task.id,
    taskTitle: task.title,
    goalMode: task.goalMode,
    acceptanceCriteria: task.acceptanceCriteria,
  })
}

export function getTask(taskId: string): KanbanTask | undefined {
  return readStore().tasks.find((t) => t.id === taskId)
}

/** active 且未暂停的看板（调度器用） */
export function listDispatchableBoards(): KanbanBoard[] {
  return readStore().boards.filter((b) => b.status === 'active' && !b.paused)
}

export function setBoardPaused(boardId: string, paused: boolean): KanbanBoard | undefined {
  const store = readStore()
  const idx = store.boards.findIndex((b) => b.id === boardId)
  if (idx < 0) return undefined
  const now = Date.now()
  store.boards[idx] = { ...store.boards[idx]!, paused, updatedAt: now }
  writeStore(store)
  return store.boards[idx]
}

export interface UpdateTaskPatch {
  status?: KanbanTaskStatus
  modelId?: string
  assigneeSessionId?: string
  error?: string
  errorSource?: KanbanTask['errorSource']
  resultSummary?: string
  blockedReason?: string
  startedAt?: number
  finishedAt?: number
  metadata?: KanbanTask['metadata']
}

export function updateTask(taskId: string, patch: UpdateTaskPatch): KanbanTask | undefined {
  const data = readStore()
  const idx = data.tasks.findIndex((t) => t.id === taskId)
  if (idx < 0) return undefined
  const now = Date.now()
  const prev = data.tasks[idx]!
  const next: KanbanTask = {
    ...prev,
    ...patch,
    updatedAt: now,
  }
  data.tasks[idx] = next
  const bi = data.boards.findIndex((b) => b.id === prev.boardId)
  if (bi >= 0) {
    data.boards[bi] = { ...data.boards[bi]!, updatedAt: now }
  }
  writeStore(data)
  return next
}

/**
 * 原子领取：ready → running（带 modelId / startedAt）
 * 若状态已不是 ready 返回 undefined
 */
export function claimReadyTask(
  taskId: string,
  opts: { modelId?: string; assigneeSessionId?: string },
): KanbanTask | undefined {
  const store = readStore()
  const idx = store.tasks.findIndex((t) => t.id === taskId)
  if (idx < 0) return undefined
  const prev = store.tasks[idx]!
  if (prev.status !== 'ready') return undefined
  const now = Date.now()
  const next: KanbanTask = {
    ...prev,
    status: 'running',
    modelId: opts.modelId ?? prev.modelId,
    assigneeSessionId: opts.assigneeSessionId,
    startedAt: now,
    updatedAt: now,
    error: undefined,
    blockedReason: undefined,
  }
  store.tasks[idx] = next
  writeStore(store)
  return next
}

/** 测试用：重置存储 */
export function __resetKanbanStoreForTests(pathOverride?: string): void {
  const empty = emptyStore()
  if (pathOverride) {
    writeJsonAtomic(pathOverride, empty)
    return
  }
  writeStore(empty)
}
