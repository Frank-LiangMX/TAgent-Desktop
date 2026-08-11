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
  COLLABORATION_ROOM_IPC_CHANNELS,
  type AddCollaborationMemberInput,
  type AppendCollaborationUserMessageInput,
  type CancelCollaborationRunInput,
  type CollaborationMember,
  type CollaborationMessage,
  type CollaborationRoom,
  type CollaborationRun,
  type CreateCollaborationRoomInput,
  type ListCollaborationMembersInput,
  type ListCollaborationMessagesInput,
  type ListCollaborationRoomsInput,
  type ListCollaborationRunsInput,
  type UpdateCollaborationRoomInput,
} from '@tagent/shared'
import { CollaborationRoomService } from './collaboration-room-service'

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

  console.log(
    '[协作室] IPC 已注册（list/create/get/update/list-messages/append-user-message/list-members/add-member/list-runs/cancel-run；Stage 3 多成员并行 + 协调者路由）',
  )
}
