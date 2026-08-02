/**
 * 看板调度器（Phase D — Desktop 轻量版）
 *
 * - 30s tick + 建任务后立即 tick
 * - per-board maxConcurrent
 * - resolveForWorker 分配模型
 * - runner 可注入（默认 stub；后续换 headless Agent）
 *
 * @see docs/plans/multi-runtime/07-implementation-phases.md Phase D
 */
import {
  KANBAN_DEFAULT_MAX_CONCURRENT,
  KANBAN_TICK_INTERVAL_MS,
  type KanbanTask,
} from '@tagent/shared'
import * as store from './kanban-store'
import { resolveForWorker } from './resolve-for-worker'
import { judgeGoalCompleteAsync } from './kanban-goal-judge'

export interface KanbanWorkerRunnerResult {
  summary?: string
  error?: string
  errorSource?: 'kanban' | 'worker-sdk' | 'kscc' | 'tagent'
  finalStatus?: 'done' | 'failed' | 'blocked'
  blockedReason?: string
}

export type KanbanWorkerRunner = (task: KanbanTask) => Promise<KanbanWorkerRunnerResult>

export interface KanbanDispatcherOptions {
  runner: KanbanWorkerRunner
  /** 渠道可用模型（按 channelId）；缺省空列表，仅靠 task.modelId / 角色池 */
  getAvailableModels?: (channelId: string) => string[]
  onTaskStatusChanged?: (taskId: string, status: string) => void
  onBoardCompleted?: (
    boardId: string,
    parentSessionId: string | undefined,
    summary: { total: number; done: number; failed: number },
  ) => void
}

let options: KanbanDispatcherOptions | null = null
let timer: ReturnType<typeof setInterval> | null = null
/** boardId → 在跑 taskId 集合 */
const runningByBoard = new Map<string, Set<string>>()
/** boardId → modelId → count */
const modelOccupancyByBoard = new Map<string, Map<string, number>>()
const notifiedCompletedBoards = new Set<string>()

export function configureKanbanDispatcher(opts: KanbanDispatcherOptions): void {
  options = opts
  console.log('[看板] 调度器已配置')
}

export function startKanbanDispatcher(): void {
  if (timer) return
  timer = setInterval(() => {
    try {
      dispatchKanbanTick()
    } catch (err) {
      console.error('[看板] tick 异常:', err)
    }
  }, KANBAN_TICK_INTERVAL_MS)
  // 不阻止进程退出
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    timer.unref()
  }
  console.log(`[看板] 调度器已启动（tick=${KANBAN_TICK_INTERVAL_MS}ms）`)
  // 启动后立即扫一轮
  queueMicrotask(() => dispatchKanbanTick())
}

export function stopKanbanDispatcher(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  console.log('[看板] 调度器已停止')
}

/** 建任务后调用，尽快派工 */
export function kickKanbanDispatcher(): void {
  queueMicrotask(() => dispatchKanbanTick())
}

function getRunningSet(boardId: string): Set<string> {
  let s = runningByBoard.get(boardId)
  if (!s) {
    s = new Set()
    runningByBoard.set(boardId, s)
  }
  return s
}

function occupancyRecord(boardId: string): Record<string, number> {
  const map = modelOccupancyByBoard.get(boardId)
  if (!map) return {}
  return Object.fromEntries(map.entries())
}

function incModel(boardId: string, modelId: string): void {
  let map = modelOccupancyByBoard.get(boardId)
  if (!map) {
    map = new Map()
    modelOccupancyByBoard.set(boardId, map)
  }
  map.set(modelId, (map.get(modelId) ?? 0) + 1)
}

function decModel(boardId: string, modelId: string): void {
  const map = modelOccupancyByBoard.get(boardId)
  if (!map) return
  const n = (map.get(modelId) ?? 0) - 1
  if (n <= 0) map.delete(modelId)
  else map.set(modelId, n)
}

export function dispatchKanbanTick(): void {
  if (!options) return
  const { runner, getAvailableModels, onTaskStatusChanged } = options

  const boards = store.listDispatchableBoards()
  for (const board of boards) {
    const runningSet = getRunningSet(board.id)
    // 与磁盘同步：清理已不在 running 的内存标记
    for (const tid of [...runningSet]) {
      const t = store.getTask(tid)
      if (!t || t.status !== 'running') {
        runningSet.delete(tid)
        if (t?.modelId) decModel(board.id, t.modelId)
      }
    }

    const maxConcurrent = board.maxConcurrent ?? KANBAN_DEFAULT_MAX_CONCURRENT
    if (runningSet.size >= maxConcurrent) continue

    const readyTasks = store.listTasksByBoard(board.id, 'ready')
    for (const task of readyTasks) {
      if (runningSet.size >= maxConcurrent) break
      if (runningSet.has(task.id)) continue

      const available = getAvailableModels?.(task.channelId) ?? []
      const resolved = resolveForWorker({
        roleId: task.roleId,
        modelId: task.modelId,
        availableModels: available,
        modelOccupancy: occupancyRecord(board.id),
        boardId: board.id,
        boardTitle: board.title || board.rootGoal,
        taskId: task.id,
        taskTitle: task.title,
        goalMode: task.goalMode,
        acceptanceCriteria: task.acceptanceCriteria,
      })

      // 无显式 model 且池满：保持 ready
      if (!task.modelId && !resolved.modelId && available.length > 0) {
        console.log(`[看板] 模型池忙，暂缓: ${task.id}`)
        continue
      }

      const modelId = task.modelId || resolved.modelId
      const workerSessionId = `kw_${task.id}`
      const claimed = store.claimReadyTask(task.id, {
        modelId,
        assigneeSessionId: workerSessionId,
      })
      if (!claimed) continue

      runningSet.add(claimed.id)
      if (modelId) incModel(board.id, modelId)
      onTaskStatusChanged?.(claimed.id, 'running')
      console.log(
        `[看板] 派工: ${claimed.id} 「${claimed.title}」 role=${claimed.roleId} model=${modelId ?? '—'} worker=${workerSessionId}`,
      )

      void runWorker(claimed, runner)
    }
  }
}

async function runWorker(task: KanbanTask, runner: KanbanWorkerRunner): Promise<void> {
  const boardId = task.boardId
  const modelId = task.modelId
  try {
    const result = await runner(task)
    let finalStatus = result.finalStatus ?? (result.error ? 'failed' : 'done')
    let blockedReason = result.blockedReason
    let error = result.error
    let errorSource = result.errorSource ?? (result.error ? 'kanban' : undefined)
    let summary = result.summary

    // goal 闸门（async）：假完成 → blocked；规则优先，LLM stub fail-open
    let judgeMetadata: KanbanTask['metadata'] | undefined
    if (finalStatus === 'done' && !error) {
      // 不传 taskId：由下方 updateTask 一并写入 metadata，避免双写
      const verdict = await judgeGoalCompleteAsync(task, summary, {
        preferLlm: false,
      })
      // 仅 goal 任务落 judgeResult（非 goal 的 skipped 不污染 metadata）
      if (task.goalMode === true && verdict.judgeResult) {
        judgeMetadata = {
          ...(task.metadata ?? {}),
          judgeResult: verdict.judgeResult,
        } as KanbanTask['metadata']
      }
      if (!verdict.ok) {
        finalStatus = 'blocked'
        blockedReason = verdict.reason
        error = undefined
        errorSource = 'kanban'
        summary = summary
          ? `${summary}\n\n[goal 闸门] ${verdict.reason}`
          : `[goal 闸门] ${verdict.reason}`
        console.warn(`[看板] goal 未通过: ${task.id} ${verdict.reason}`)
      }
    }

    const updated = store.updateTask(task.id, {
      status: finalStatus,
      resultSummary: summary,
      error,
      errorSource,
      blockedReason,
      finishedAt: Date.now(),
      ...(judgeMetadata ? { metadata: judgeMetadata } : {}),
    })
    options?.onTaskStatusChanged?.(task.id, finalStatus)
    console.log(
      `[看板] 工人结束: ${task.id} → ${finalStatus}${summary ? ` (${summary.slice(0, 80)})` : ''}`,
    )
    // 依赖图：done 后提升后继 pending → ready
    if (finalStatus === 'done' && updated) {
      const promoted = store.promoteReadyDependents(task.id)
      for (const p of promoted) {
        options?.onTaskStatusChanged?.(p.id, 'ready')
      }
    }
    if (updated) checkBoardCompletion(boardId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    store.updateTask(task.id, {
      status: 'failed',
      error: msg,
      errorSource: 'tagent',
      finishedAt: Date.now(),
    })
    options?.onTaskStatusChanged?.(task.id, 'failed')
    console.error(`[看板] 工人异常: ${task.id}`, err)
    checkBoardCompletion(boardId)
  } finally {
    getRunningSet(boardId).delete(task.id)
    if (modelId) decModel(boardId, modelId)
    // 事件驱动：立刻再派
    queueMicrotask(() => dispatchKanbanTick())
  }
}

function checkBoardCompletion(boardId: string): void {
  if (!options?.onBoardCompleted) return
  if (notifiedCompletedBoards.has(boardId)) return
  const all = store.listTasksByBoard(boardId)
  if (all.length === 0) return
  const terminal = new Set(['done', 'failed', 'cancelled'])
  if (!all.every((t) => terminal.has(t.status))) return
  notifiedCompletedBoards.add(boardId)
  const done = all.filter((t) => t.status === 'done').length
  const failed = all.filter((t) => t.status === 'failed').length
  const board = store.getBoard(boardId)
  try {
    options.onBoardCompleted(boardId, board?.parentSessionId, {
      total: all.length,
      done,
      failed,
    })
    console.log(`[看板] 看板完成: ${boardId} done=${done} failed=${failed}`)
  } catch (err) {
    console.error('[看板] onBoardCompleted 异常:', err)
  }
}

/** 测试辅助：清空内存态 */
export function __resetDispatcherStateForTests(): void {
  runningByBoard.clear()
  modelOccupancyByBoard.clear()
  notifiedCompletedBoards.clear()
  options = null
  stopKanbanDispatcher()
}
