/**
 * 看板写路径 Work 模式守卫（D5 / D1）
 *
 * Chat 下禁止创建看板、派工、改任务状态；仅允许只读查询（list/get）由调用方自行区分。
 * @see docs/plans/multi-runtime/02-chat-work-and-permissions.md
 * @see docs/plans/multi-runtime/07-implementation-phases.md Phase D
 */
import {
  CREW_ORCHESTRATION_ENABLED,
  CREW_PAUSED_MESSAGE,
  migrateExecutionMode,
  type ExecutionMode,
} from '@tagent/shared'
import { getSessionMeta } from '../agent/session-store'

export const KANBAN_CHAT_BLOCK_REASON =
  '当前为 Chat 模式：不能创建看板、派工或修改看板任务。请切换到 Work 后再试。'

export function getSessionExecutionMode(sessionId: string | undefined | null): ExecutionMode {
  if (!sessionId) return migrateExecutionMode(undefined)
  const meta = getSessionMeta(sessionId)
  return migrateExecutionMode(meta?.executionMode)
}

export function isKanbanWriteAllowed(sessionId: string | undefined | null): boolean {
  if (!CREW_ORCHESTRATION_ENABLED) return false
  return getSessionExecutionMode(sessionId) === 'work'
}

export function assertKanbanWriteAllowed(
  sessionId: string | undefined | null,
): { ok: true } | { ok: false; error: string; executionMode: ExecutionMode } {
  const mode = getSessionExecutionMode(sessionId)
  if (!CREW_ORCHESTRATION_ENABLED) {
    return { ok: false, error: CREW_PAUSED_MESSAGE, executionMode: mode }
  }
  if (mode === 'work') return { ok: true }
  return { ok: false, error: KANBAN_CHAT_BLOCK_REASON, executionMode: mode }
}

/** Stop/pause remains available while orchestration is product-paused. */
export function assertKanbanStopAllowed(
  sessionId: string | undefined | null,
): { ok: true } | { ok: false; error: string; executionMode: ExecutionMode } {
  const mode = getSessionExecutionMode(sessionId)
  if (mode === 'work') return { ok: true }
  return { ok: false, error: KANBAN_CHAT_BLOCK_REASON, executionMode: mode }
}
