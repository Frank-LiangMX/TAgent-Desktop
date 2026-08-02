/**
 * 看板桌面通知（替代 Hermes Telegram：本地系统通知）
 * 受通用设置「系统通知」开关约束。
 */
import { Notification, type BrowserWindow } from 'electron'
import * as store from './kanban-store'
import { isSystemDesktopNotifyEnabled } from '../notification-prefs'

export function notifyKanbanDesktop(opts: {
  title: string
  body: string
  getWindow?: () => BrowserWindow | null
}): void {
  try {
    if (!isSystemDesktopNotifyEnabled()) {
      console.log(`[看板通知] (已关闭系统通知) ${opts.title}: ${opts.body}`)
      return
    }
    if (!Notification.isSupported()) {
      console.log(`[看板通知] (不支持 Notification) ${opts.title}: ${opts.body}`)
      return
    }
    const n = new Notification({
      title: opts.title,
      body: opts.body.slice(0, 250),
      silent: false,
    })
    n.on('click', () => {
      const win = opts.getWindow?.()
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
    n.show()
  } catch (err) {
    console.warn('[看板通知] 失败:', err)
  }
}

export function notifyTaskTerminal(
  taskId: string,
  status: string,
  getWindow?: () => BrowserWindow | null,
): void {
  if (status !== 'done' && status !== 'failed' && status !== 'blocked') return
  const task = store.getTask(taskId)
  if (!task) return
  const board = store.getBoard(task.boardId)
  const boardLabel = board?.title || board?.rootGoal || task.boardId
  const title =
    status === 'done'
      ? '班组任务完成'
      : status === 'failed'
        ? '班组任务失败'
        : '班组任务阻塞'
  const body =
    status === 'done'
      ? `「${task.title}」已完成 · ${boardLabel}`
      : status === 'failed'
        ? `「${task.title}」失败：${(task.error || '未知错误').slice(0, 120)}`
        : `「${task.title}」阻塞：${(task.blockedReason || '需处理').slice(0, 120)}`
  notifyKanbanDesktop({ title, body, getWindow })
}

export function notifyBoardComplete(
  boardId: string,
  summary: { total: number; done: number; failed: number },
  getWindow?: () => BrowserWindow | null,
): void {
  const board = store.getBoard(boardId)
  const label = board?.title || board?.rootGoal || boardId
  notifyKanbanDesktop({
    title: '班组全部结束',
    body: `「${label}」${summary.done}/${summary.total} 完成${summary.failed ? `，${summary.failed} 失败` : ''}`,
    getWindow,
  })
}
