/**
 * 看板 IPC（Phase D P0 + D remainder）
 * 写操作必须 Work 模式（assertKanbanWriteAllowed）。
 */
import { ipcMain } from 'electron'
import {
  KANBAN_IPC_CHANNELS,
  type CommentKanbanTaskInput,
  type CreateKanbanBoardIpcInput,
  type CreateKanbanTaskIpcInput,
  type ListKanbanBoardsInput,
  type UnblockKanbanTaskInput,
} from '@tagent/shared'
import { assertKanbanWriteAllowed } from './work-mode-guard'
import * as store from './kanban-store'
import { kickKanbanDispatcher } from './kanban-dispatcher'
import { handleComment } from './kanban-agent-tools'

export function registerKanbanIpc(): void {
  ipcMain.handle(KANBAN_IPC_CHANNELS.LIST_BOARDS, async (_e, input?: ListKanbanBoardsInput) => {
    return store.listBoards({ status: input?.status })
  })

  ipcMain.handle(KANBAN_IPC_CHANNELS.GET_BOARD, async (_e, boardId: string) => {
    return store.getBoard(boardId) ?? null
  })

  ipcMain.handle(
    KANBAN_IPC_CHANNELS.LIST_TASKS,
    async (_e, args: { boardId: string; status?: string }) => {
      if (!args?.boardId) return []
      return store.listTasksByBoard(
        args.boardId,
        args.status as Parameters<typeof store.listTasksByBoard>[1],
      )
    },
  )

  ipcMain.handle(KANBAN_IPC_CHANNELS.GET_TASK, async (_e, taskId: string) => {
    if (!taskId) return null
    return store.getTask(taskId) ?? null
  })

  ipcMain.handle(
    KANBAN_IPC_CHANNELS.CREATE_BOARD,
    async (_e, input: CreateKanbanBoardIpcInput & { sessionId?: string }) => {
      // 有 parentSessionId / sessionId 时校验该会话为 Work
      const sessionId = input?.sessionId ?? input?.parentSessionId
      const gate = assertKanbanWriteAllowed(sessionId)
      if (!gate.ok) {
        return { ok: false as const, error: gate.error }
      }
      if (!input?.rootGoal?.trim()) {
        return { ok: false as const, error: 'rootGoal 不能为空' }
      }
      const board = store.createBoard({
        rootGoal: input.rootGoal,
        parentSessionId: input.parentSessionId ?? input.sessionId,
        title: input.title,
        mode: input.mode,
        originChatId: input.originChatId,
        originBridge: input.originBridge,
        cwd: undefined,
        workspaceId: input.workspaceId,
      })
      return { ok: true as const, board }
    },
  )

  ipcMain.handle(
    KANBAN_IPC_CHANNELS.CREATE_TASK,
    async (
      _e,
      input: CreateKanbanTaskIpcInput & { sessionId?: string; availableModels?: string[] },
    ) => {
      const gate = assertKanbanWriteAllowed(input?.sessionId)
      if (!gate.ok) {
        return { ok: false as const, error: gate.error }
      }
      if (!input?.boardId || !input?.title?.trim() || !input?.channelId) {
        return { ok: false as const, error: 'boardId / title / channelId 必填' }
      }
      try {
        const task = store.createTask(
          {
            boardId: input.boardId,
            title: input.title,
            body: input.body,
            roleId: input.roleId,
            channelId: input.channelId,
            modelId: input.modelId,
            priority: input.priority,
            parentTaskId: input.parentTaskId,
            dependsOnTaskIds: input.dependsOnTaskIds,
            goalMode: input.goalMode,
            acceptanceCriteria: input.acceptanceCriteria,
            goalMaxTurns: input.goalMaxTurns,
            judgeModel: input.judgeModel,
            metadata: input.metadata,
          },
          { availableModels: input.availableModels },
        )
        // 事件驱动：立刻尝试派工
        kickKanbanDispatcher()
        return { ok: true as const, task }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  ipcMain.handle(
    KANBAN_IPC_CHANNELS.PAUSE_BOARD,
    async (_e, args: { boardId: string; sessionId?: string }) => {
      const gate = assertKanbanWriteAllowed(args?.sessionId)
      if (!gate.ok) return { ok: false as const, error: gate.error }
      const board = store.setBoardPaused(args.boardId, true)
      if (!board) return { ok: false as const, error: '看板不存在' }
      return { ok: true as const, board }
    },
  )

  ipcMain.handle(
    KANBAN_IPC_CHANNELS.RESUME_BOARD,
    async (_e, args: { boardId: string; sessionId?: string }) => {
      const gate = assertKanbanWriteAllowed(args?.sessionId)
      if (!gate.ok) return { ok: false as const, error: gate.error }
      const board = store.setBoardPaused(args.boardId, false)
      if (!board) return { ok: false as const, error: '看板不存在' }
      kickKanbanDispatcher()
      return { ok: true as const, board }
    },
  )

  // 解除阻塞 / 重试：用户从 Chat 班组条也可操作（后台工人恢复），不强制 Work
  ipcMain.handle(
    KANBAN_IPC_CHANNELS.UNBLOCK_TASK,
    async (_e, args: UnblockKanbanTaskInput | string) => {
      const taskId = typeof args === 'string' ? args : args?.taskId
      const reason = typeof args === 'string' ? undefined : args?.reason
      if (!taskId) return { ok: false as const, error: 'taskId 必填' }
      const task = store.unblockTask(taskId, reason)
      if (!task) return { ok: false as const, error: '任务不存在' }
      kickKanbanDispatcher()
      return { ok: true as const, task }
    },
  )

  ipcMain.handle(
    KANBAN_IPC_CHANNELS.RETRY_TASK,
    async (_e, args: { taskId: string } | string) => {
      const taskId = typeof args === 'string' ? args : args?.taskId
      if (!taskId) return { ok: false as const, error: 'taskId 必填' }
      const task = store.retryTask(taskId)
      if (!task) return { ok: false as const, error: '任务不存在' }
      kickKanbanDispatcher()
      return { ok: true as const, task }
    },
  )

  ipcMain.handle(
    KANBAN_IPC_CHANNELS.COMMENT_TASK,
    async (_e, args: CommentKanbanTaskInput & { sessionId?: string }) => {
      // 评论可在 Chat 写 blackboard；不强制 Work（主会话交接常用）
      if (!args?.taskId || !args?.comment?.trim()) {
        return { ok: false as const, error: 'taskId 与 comment 必填' }
      }
      try {
        const res = await handleComment(
          { taskId: args.taskId, comment: args.comment },
          args.author || 'main',
        )
        const text = res.content[0]?.text ?? ''
        return { ok: true as const, result: text }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  console.log(
    '[看板] IPC 已注册（list/get/create/pause/resume/unblock/retry/comment + Work 守卫 + 调度 kick）',
  )
}
