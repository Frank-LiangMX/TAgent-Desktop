/**
 * 看板子系统启动：调度器 + headless 工人 + 桌面通知 + 完成回流
 */
import { BrowserWindow } from 'electron'
import { KANBAN_IPC_CHANNELS } from '@tagent/shared'
import { configureKanbanDispatcher, startKanbanDispatcher } from './kanban-dispatcher'
import { runKanbanWorkerHeadless } from './kanban-worker-runner'
import { getChannel } from '../channel/channel-store'
import { notifyBoardComplete, notifyTaskTerminal } from './kanban-notify'
import { refluxBoardCompletion } from './kanban-reflux'

type KanbanTaskStatus = import('@tagent/shared').KanbanTaskStatus
type KanbanTaskStatusChangedHandler = (taskId: string, status: KanbanTaskStatus) => void
const taskStatusChangedHandlers = new Set<KanbanTaskStatusChangedHandler>()

/** 供主进程内其他模块订阅看板状态变化；看板真值仍由 kanban-store 持有。 */
export function onKanbanTaskStatusChanged(handler: KanbanTaskStatusChangedHandler): () => void {
  taskStatusChangedHandlers.add(handler)
  return () => taskStatusChangedHandlers.delete(handler)
}

export function bootstrapKanban(getWindow: () => BrowserWindow | null): void {
  configureKanbanDispatcher({
    runner: runKanbanWorkerHeadless,
    getAvailableModels: (channelId) => {
      try {
        const ch = getChannel(channelId)
        if (!ch?.models?.length) return []
        return ch.models.filter((m) => m.enabled !== false).map((m) => m.id)
      } catch {
        return []
      }
    },
    onTaskStatusChanged: (taskId, status) => {
      const win = getWindow()
      win?.webContents.send(KANBAN_IPC_CHANNELS.CHANGED, { taskId, status, at: Date.now() })
      for (const handler of taskStatusChangedHandlers) {
        try {
          handler(taskId, status)
        } catch (err) {
          console.error('[看板] 状态订阅回调失败:', err)
        }
      }
      notifyTaskTerminal(taskId, status, getWindow)
    },
    onBoardCompleted: (boardId, parentSessionId, summary) => {
      // 先回流父会话 panel（写 JSONL + mark board completed）
      let refluxText: string | undefined
      let inject = false
      try {
        const reflux = refluxBoardCompletion(boardId, parentSessionId, summary)
        refluxText = reflux.refluxText
        inject = reflux.ok && !reflux.skipped
      } catch (err) {
        console.error('[看板] 回流失败:', err)
      }

      const win = getWindow()
      win?.webContents.send(KANBAN_IPC_CHANNELS.BOARD_COMPLETED, {
        boardId,
        parentSessionId,
        summary,
        inject,
        refluxText,
        at: Date.now(),
      })
      notifyBoardComplete(boardId, summary, getWindow)
      console.log(
        `[看板] 完成通知: board=${boardId} parent=${parentSessionId ?? '—'} ${summary.done}/${summary.total} inject=${inject}`,
      )
    },
  })
  startKanbanDispatcher()
}
