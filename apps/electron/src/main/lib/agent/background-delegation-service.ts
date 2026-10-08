/**
 * 后台子代理运行登记 + 完成回投钩子。
 *
 * session-service 在启动时注入钩子，避免 task 工具反向 import 会话层。
 */

import {
  BACKGROUND_DELEGATION_MAX_CONCURRENT,
  type BackgroundCallbackPayload,
} from './background-delegation'

export interface RunningBackgroundTask {
  taskId: string
  parentSessionId: string
  description: string
  subagentType: string
  startedAt: number
  abort: AbortController
}

export interface BackgroundDelegationHooks {
  enqueueCallback: (parentSessionId: string, payload: BackgroundCallbackPayload) => void
  notifyParentEvent: (
    parentSessionId: string,
    event: {
      type: string
      taskId: string
      toolUseId?: string
      description?: string
      taskType?: string
      lastToolName?: string
      status?: 'completed' | 'failed' | 'stopped'
      summary?: string
    },
  ) => void
}

const running = new Map<string, RunningBackgroundTask>()
let hooks: BackgroundDelegationHooks | null = null

export function setBackgroundDelegationHooks(next: BackgroundDelegationHooks | null): void {
  hooks = next
}

export function countRunningBackgroundTasks(parentSessionId: string): number {
  let n = 0
  for (const rec of running.values()) {
    if (rec.parentSessionId === parentSessionId) n++
  }
  return n
}

export function canStartBackgroundTask(parentSessionId: string): boolean {
  return countRunningBackgroundTasks(parentSessionId) < BACKGROUND_DELEGATION_MAX_CONCURRENT
}

export function registerBackgroundTask(rec: RunningBackgroundTask): void {
  running.set(rec.taskId, rec)
}

export function unregisterBackgroundTask(taskId: string): RunningBackgroundTask | undefined {
  const rec = running.get(taskId)
  running.delete(taskId)
  return rec
}

export function abortBackgroundTasksForSession(parentSessionId: string): void {
  for (const rec of [...running.values()]) {
    if (rec.parentSessionId !== parentSessionId) continue
    rec.abort.abort()
    running.delete(rec.taskId)
  }
}

export function abortAllBackgroundTasks(): void {
  for (const rec of running.values()) rec.abort.abort()
  running.clear()
}

export function enqueueParentCallback(
  parentSessionId: string,
  payload: BackgroundCallbackPayload,
): void {
  hooks?.enqueueCallback(parentSessionId, payload)
}

export function notifyParentBackgroundEvent(
  parentSessionId: string,
  event: Parameters<BackgroundDelegationHooks['notifyParentEvent']>[1],
): void {
  hooks?.notifyParentEvent(parentSessionId, event)
}
