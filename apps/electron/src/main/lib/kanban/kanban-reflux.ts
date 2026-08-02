/**
 * 看板完成后回流父会话面板消息（Phase D — Board completion reflux）
 *
 * 班组全部终态后，向 parentSession 的 panel JSONL 注入中文摘要，
 * 便于主会话下次加载或 Chat 打开时看到完成通知。
 */
import type { KanbanBoard, KanbanTask } from '@tagent/shared'
import { appendPanelMessages, getSessionMeta } from '../agent/session-store'
import * as store from './kanban-store'

export interface BoardCompletionSummary {
  total: number
  done: number
  failed: number
}

export interface RefluxBoardCompletionResult {
  ok: boolean
  refluxText?: string
  skipped?: boolean
  reason?: string
}

/** 状态 → 中文标签 */
function statusLabel(status: KanbanTask['status']): string {
  switch (status) {
    case 'done':
      return '完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '取消'
    case 'blocked':
      return '阻塞'
    case 'running':
      return '执行中'
    case 'ready':
      return '就绪'
    case 'pending':
      return '等待'
    default:
      return status
  }
}

/**
 * 构建班组完成中文摘要（纯函数，便于单测）
 */
export function buildBoardCompletionMessage(
  board: Pick<KanbanBoard, 'id' | 'title' | 'rootGoal' | 'requireSummary'>,
  tasks: Array<Pick<KanbanTask, 'title' | 'status' | 'resultSummary' | 'error'>>,
  summary: BoardCompletionSummary,
): string {
  const title = (board.title || board.rootGoal || board.id).trim()
  const lines: string[] = [
    `【班组完成】${title}`,
    `合计 ${summary.total} 项：完成 ${summary.done}，失败 ${summary.failed}。`,
  ]

  if (tasks.length > 0) {
    lines.push('')
    lines.push('任务明细：')
    for (const t of tasks) {
      const snippet = (t.resultSummary || t.error || '').trim().replace(/\s+/g, ' ')
      const short = snippet.length > 120 ? `${snippet.slice(0, 120)}…` : snippet
      const tail = short ? ` — ${short}` : ''
      lines.push(`· ${t.title} [${statusLabel(t.status)}]${tail}`)
    }
  }

  lines.push('')
  if (board.requireSummary === true) {
    lines.push(
      '【请队长撰写综合报告】本看板 requireSummary=true：请根据以上任务结果写一份合成交付报告（背景、做了什么、验收证据、风险与后续建议）。请直接输出报告正文。',
    )
  } else {
    lines.push('班组已全部终态。如需汇总，可基于上述明细整理结论。')
  }

  return lines.join('\n')
}

/**
 * 看板完成 → 父会话面板注入摘要 + 标记 board completed
 *
 * @param boardId 看板 ID
 * @param parentSessionId 父会话（可选；缺省时仅 updateBoard，不写消息）
 * @param summary 完成统计
 */
export function refluxBoardCompletion(
  boardId: string,
  parentSessionId: string | undefined,
  summary: BoardCompletionSummary,
): RefluxBoardCompletionResult {
  const board = store.getBoard(boardId)
  if (!board) {
    return { ok: false, reason: `看板不存在: ${boardId}` }
  }

  const tasks = store.listTasksByBoard(boardId)
  const refluxText = buildBoardCompletionMessage(board, tasks, summary)

  // 始终标记看板 completed（幂等）
  try {
    store.updateBoard(boardId, { status: 'completed' })
  } catch (err) {
    console.warn('[看板回流] updateBoard 失败:', err)
  }

  const sessionId = parentSessionId?.trim() || board.parentSessionId?.trim()
  if (!sessionId) {
    return {
      ok: true,
      refluxText,
      skipped: true,
      reason: '无 parentSessionId，仅标记 board completed',
    }
  }

  const meta = getSessionMeta(sessionId)
  const workspaceId = meta?.workspaceId ?? board.workspaceId

  // 系统通知形态（assistant + modelId=班组通知），禁止写成 user
  const now = Date.now()
  const irNotice = {
    type: 'assistant' as const,
    modelId: '班组通知',
    content: [{ type: 'text' as const, text: refluxText }],
    createdAt: now,
  }

  try {
    appendPanelMessages(workspaceId, sessionId, [irNotice])
    console.log(
      `[看板回流] 已注入父会话 ${sessionId} board=${boardId} requireSummary=${board.requireSummary === true}`,
    )
  } catch (err) {
    console.error('[看板回流] appendPanelMessages 失败:', err)
    return {
      ok: false,
      refluxText,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  return { ok: true, refluxText }
}
