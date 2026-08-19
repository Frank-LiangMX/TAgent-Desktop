/**
 * 协作室 IPC 注册（Stage 3）
 *
 * 注册 COLLABORATION_ROOM_IPC_CHANNELS 的 10 个请求/响应通道：
 * LIST / CREATE / GET / UPDATE / LIST_MESSAGES / APPEND_USER_MESSAGE / LIST_MEMBERS /
 * ADD_MEMBER / LIST_RUNS / CANCEL_RUN。
 *
 * CHANGED 为 main → renderer 广播：run/member/message 变更时 service 调 broadcast，
 * 此处包装成 `getWindow()?.webContents.send(CHANGED, { roomId, kind, at })`（对齐
 * kanban-bootstrap 的广播模式）。渲染层收到后重新拉取该房间数据。
 *
 * 注册时调用 service.recoverInterruptedRuns()，把上次未完成的 queued/running run
 * 标为 failed(INTERRUPTED)，避免重启后「假 running」。
 *
 * handler 直接返回 service 结果；service 在校验/非法状态时 throw，
 * ipcMain.handle 会让 invoke 的 Promise reject，渲染层 try/catch 即可。
 *
 * 设计参考：apps/electron/src/main/lib/kanban/kanban-bootstrap.ts（getWindow 广播模式）
 */
import { BrowserWindow, ipcMain } from 'electron'
import {
  canContinueCollaborationDepthStop,
  COLLABORATION_ROOM_IPC_CHANNELS,
  type AddCollaborationMemberInput,
  type AppendCollaborationUserMessageInput,
  type BoardProjectedSummary,
  type BoardProjectedTask,
  type CancelCollaborationRunInput,
  type CollaborationArtifact,
  type CollaborationMailboxEnvelope,
  type CollaborationMember,
  type CollaborationMemberPreset,
  type CollaborationMessage,
  type CollaborationRoom,
  type CollaborationRoomTask,
  type CollaborationRun,
  type ContinueCollaborationDepthStopInput,
  type ContinueCollaborationDepthStopResult,
  type CreateCollaborationRoomInput,
  type SaveCollaborationMemberPresetInput,
  type CreateCollaborationRoomTaskInput,
  type GetBoardProjectedSummaryInput,
  type ListBoardProjectedTasksInput,
  type ListCollaborationArtifactsInput,
  type ListCollaborationMailboxInput,
  type ListCollaborationMembersInput,
  type ListCollaborationMessagesInput,
  type ListCollaborationRoomTasksInput,
  type ListCollaborationUserApprovalsInput,
  type ListCollaborationRoomsInput,
  type ListCollaborationRunsInput,
  type ReadCollaborationArtifactInput,
  type ReadCollaborationArtifactResult,
  type ResolveCollaborationUserApprovalInput,
  type ResolveCollaborationUserApprovalResult,
  type UpdateCollaborationMemberInput,
  type UpdateCollaborationRoomInput,
  type UpdateCollaborationRoomTaskInput,
} from '@tagent/shared'
import { CollaborationRoomService } from './collaboration-room-service'
import {
  deleteCollaborationMemberPreset,
  listCollaborationMemberPresets,
  saveCollaborationMemberPreset,
} from './collaboration-room-repository'
import { onKanbanTaskStatusChanged } from '../kanban/kanban-bootstrap'

/**
 * S4.5 IPC 守卫：委托 service.continueDepthStop 前校验信封属于该房间且仍可继续一次。
 * 纯函数（不读 DB、不触 backend），便于离线单测；envelopes 由 handler 从
 * service.listMailbox(roomId) 传入，确保信封 roomId 与 input.roomId 一致，防跨房间继续。
 */
export function resolveCollaborationDepthStopContinue(
  envelopes: CollaborationMailboxEnvelope[],
  input: ContinueCollaborationDepthStopInput,
): { ok: true; envelope: CollaborationMailboxEnvelope } | { ok: false; reason: string } {
  const envelope = envelopes.find((e) => e.id === input.envelopeId && e.roomId === input.roomId)
  if (!envelope) {
    return { ok: false, reason: '深度停止信封不存在或不属于该房间' }
  }
  if (!canContinueCollaborationDepthStop(envelope)) {
    return { ok: false, reason: '该深度停止不可继续或已使用过继续机会' }
  }
  return { ok: true, envelope }
}

export function registerCollaborationRoomIpc(
  getWindow?: () => BrowserWindow | null,
): void {
  const service = CollaborationRoomService.create({
    broadcast: (roomId, kind) => {
      const win = getWindow?.()
      if (!win) return
      win.webContents.send(COLLABORATION_ROOM_IPC_CHANNELS.CHANGED, {
        roomId,
        kind,
        at: Date.now(),
      })
    },
    onTextDelta: (payload) => {
      const win = getWindow?.()
      if (!win) return
      win.webContents.send(COLLABORATION_ROOM_IPC_CHANNELS.TEXT_DELTA, payload)
    },
  })

  // 启动恢复：标记遗留 queued/running run 为 interrupted/failed
  try {
    service.recoverInterruptedRuns()
  } catch (err) {
    console.error('[协作室] 启动恢复失败:', err)
  }

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST,
    async (_e, input?: ListCollaborationRoomsInput): Promise<CollaborationRoom[]> => {
      return service.listRooms(input?.includeArchived ?? false)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.CREATE,
    async (_e, input: CreateCollaborationRoomInput): Promise<CollaborationRoom> => {
      return service.createRoom(input)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.GET,
    async (_e, input: { roomId: string }): Promise<CollaborationRoom | null> => {
      return service.getRoomById(input.roomId) ?? null
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.UPDATE,
    async (_e, input: UpdateCollaborationRoomInput): Promise<CollaborationRoom> => {
      return service.updateRoom(input)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_MESSAGES,
    async (_e, input: ListCollaborationMessagesInput): Promise<CollaborationMessage[]> => {
      return service.listMessages(input.roomId)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.APPEND_USER_MESSAGE,
    async (_e, input: AppendCollaborationUserMessageInput): Promise<CollaborationMessage> => {
      return service.appendUserMessage(input)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_MEMBERS,
    async (_e, input: ListCollaborationMembersInput): Promise<CollaborationMember[]> => {
      return service.listMembers(input.roomId)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.ADD_MEMBER,
    async (_e, input: AddCollaborationMemberInput): Promise<CollaborationMember> => {
      return service.addMember(input.roomId, input)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.UPDATE_MEMBER,
    async (_e, input: UpdateCollaborationMemberInput): Promise<CollaborationMember> => {
      return service.updateMember(input)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_RUNS,
    async (_e, input: ListCollaborationRunsInput): Promise<CollaborationRun[]> => {
      return service.listRuns(input.roomId)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.CANCEL_RUN,
    async (_e, input: CancelCollaborationRunInput): Promise<CollaborationRun | null> => {
      // 校验 roomId 与 run 归属一致（防止跨房间取消）
      const run = service.getRunById(input.runId)
      if (!run || run.roomId !== input.roomId) return null
      return service.cancelRun(input.runId) ?? null
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_MAILBOX,
    async (_e, input: ListCollaborationMailboxInput): Promise<CollaborationMailboxEnvelope[]> => {
      return service.listMailbox(input.roomId)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.CONTINUE_DEPTH_STOP,
    async (
      _e,
      input: ContinueCollaborationDepthStopInput,
    ): Promise<ContinueCollaborationDepthStopResult> => {
      // 先做 IPC 侧跨房间守卫（service.continueDepthStop 按 envelopeId 全局取信封，
      // 不带 roomId），再委托 service 执行继续。失败返回 { ok: false, reason }，不抛错。
      const resolved = resolveCollaborationDepthStopContinue(service.listMailbox(input.roomId), input)
      if (!resolved.ok) return { ok: false, reason: resolved.reason }
      return service.continueDepthStop(resolved.envelope.id)
    },
  )

  // ===== S5 室级任务/产物面板：复用 service 既有真值层与守卫 =====
  // 任务 create/update 的挂板 fail-closed、负责人归属、严格状态机、CAS 全在 service 内；
  // handler 仅做薄转发，错误以 throw 传递（与 create/update room 一致，渲染层 try/catch）。
  // READ_ARTIFACT 的跨房间校验在 service.readArtifact 内（按 artifactId 反查记录 + 安全区间解析）。

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_ROOM_TASKS,
    async (_e, input: ListCollaborationRoomTasksInput): Promise<CollaborationRoomTask[]> => {
      return service.listRoomTasks(input.roomId)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.CREATE_ROOM_TASK,
    async (_e, input: CreateCollaborationRoomTaskInput): Promise<CollaborationRoomTask> => {
      return service.createRoomTask(input)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.UPDATE_ROOM_TASK,
    async (_e, input: UpdateCollaborationRoomTaskInput): Promise<CollaborationRoomTask> => {
      return service.updateRoomTask(input)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_ARTIFACTS,
    async (_e, input: ListCollaborationArtifactsInput): Promise<CollaborationArtifact[]> => {
      return service.listArtifacts(input.roomId)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.READ_ARTIFACT,
    async (_e, input: ReadCollaborationArtifactInput): Promise<ReadCollaborationArtifactResult> => {
      return service.readArtifact(input)
    },
  )

  // ===== S5 看板桥：把挂载看板的只读投影暴露给房间（不反向覆盖真值） =====
  // 房间未挂载 / 看板不存在时 projectBoard* 返回空/fail-open 只读；写操作仍由既有
  // 挂板 fail-closed（createRoomTask / roomTaskUpdate）拒绝。

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_BOARD_TASKS,
    async (_e, input: ListBoardProjectedTasksInput): Promise<BoardProjectedTask[]> => {
      return service.projectBoardTasks(input.roomId)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.GET_BOARD_SUMMARY,
    async (_e, input: GetBoardProjectedSummaryInput): Promise<BoardProjectedSummary | null> => {
      return service.projectBoardSummary(input.roomId)
    },
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_MEMBER_PRESETS,
    async (): Promise<CollaborationMemberPreset[]> => listCollaborationMemberPresets(),
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.SAVE_MEMBER_PRESET,
    async (_e, input: SaveCollaborationMemberPresetInput): Promise<CollaborationMemberPreset> =>
      saveCollaborationMemberPreset(input),
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.DELETE_MEMBER_PRESET,
    async (_e, input: { id: string }): Promise<{ ok: boolean }> => ({
      ok: deleteCollaborationMemberPreset(input.id),
    }),
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.LIST_USER_APPROVALS,
    async (_e, input: ListCollaborationUserApprovalsInput) => service.listUserApprovals(input.roomId),
  )

  ipcMain.handle(
    COLLABORATION_ROOM_IPC_CHANNELS.RESOLVE_USER_APPROVAL,
    async (
      _e,
      input: ResolveCollaborationUserApprovalInput,
    ): Promise<ResolveCollaborationUserApprovalResult> => service.resolveUserApproval(input),
  )

  // 看板任务状态变化 → 广播给「挂载了该看板」的协作室房间，让面板能及时刷新投影。
  // 复用既有 kanban CHANGED 事件，不另造真值；对每个挂载该看板的房间发 collaboration-room:changed
  // （kind 沿用 'updated'），渲染层收到后重新拉取投影。
  const boardChangedHandler = (taskId: string): void => {
    // 反查任务所属看板；取不到则跳过（任务可能已删除）
    const task = service.getTaskByIdFromKanban(taskId)
    if (!task) return
    for (const room of service.listRooms(false)) {
      if (room.attachedBoardId === task.boardId) {
        service.broadcastBoardChanged(room.id)
      }
    }
  }
  onKanbanTaskStatusChanged(boardChangedHandler)

  console.log(
    '[协作室] IPC 已注册（list/create/get/update/list-messages/append-user-message/list-members/add-member/update-member/list-runs/cancel-run/list-mailbox/continue-depth-stop/list-room-tasks/create-room-task/update-room-task/list-artifacts/read-artifact/list-board-tasks/get-board-summary；S4.5 深度停止继续；S5 任务/产物面板 + 看板桥）',
  )
}
