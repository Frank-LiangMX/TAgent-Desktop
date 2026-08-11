/**
 * 协作室 IPC 注册（Stage 1）
 *
 * 注册 COLLABORATION_ROOM_IPC_CHANNELS 的 7 个请求/响应通道：
 * LIST / CREATE / GET / UPDATE / LIST_MESSAGES / APPEND_USER_MESSAGE / LIST_MEMBERS。
 * CHANGED 为 S2+ main→renderer 广播占位，Stage 1 不发送（渲染层在变更后主动重新拉取）。
 *
 * handler 直接返回 service 结果；service 在校验/非法状态时 throw，
 * ipcMain.handle 会让 invoke 的 Promise reject，渲染层 try/catch 即可。
 *
 * 设计参考：apps/electron/src/main/lib/kanban/kanban-ipc.ts（register 函数模式）
 */
import { ipcMain } from 'electron'
import {
  COLLABORATION_ROOM_IPC_CHANNELS,
  type AppendCollaborationUserMessageInput,
  type CollaborationMember,
  type CollaborationMessage,
  type CollaborationRoom,
  type CreateCollaborationRoomInput,
  type ListCollaborationMembersInput,
  type ListCollaborationMessagesInput,
  type ListCollaborationRoomsInput,
  type UpdateCollaborationRoomInput,
} from '@tagent/shared'
import { CollaborationRoomService } from './collaboration-room-service'

export function registerCollaborationRoomIpc(): void {
  const service = CollaborationRoomService.create()

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

  console.log(
    '[协作室] IPC 已注册（list/create/get/update/list-messages/append-user-message/list-members；Stage 1 不运行 Agent）',
  )
}
