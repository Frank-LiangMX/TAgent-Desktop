/**
 * Collaboration Room 协作室 IPC 通道常量与请求/响应类型
 *
 * 渲染进程通过 window.electronAPI.collaborationRoom.* 调用，主进程在
 * main/lib/collaboration/collaboration-ipc.ts 注册处理器。
 * 通道命名与 kanban/automation 一致：动词:名词 形式，CHANGED 为 main→renderer 广播。
 *
 * Stage 1 只实现 LIST / CREATE / GET / UPDATE / LIST_MESSAGES / APPEND_USER_MESSAGE /
 * LIST_MEMBERS；CHANGED 为 S2+ 事件订阅占位（Stage 1 渲染层在变更后主动重新拉取）。
 */

import type {
  CollaborationRoom,
  CollaborationMember,
  CollaborationMessage,
  CreateCollaborationRoomInput,
  UpdateCollaborationRoomInput,
  AppendCollaborationUserMessageInput,
} from './collaboration-room'

export const COLLABORATION_ROOM_IPC_CHANNELS = {
  /** 列出全部协作室房间（默认不含 archived） */
  LIST: 'collaboration-room:list',
  /** 创建协作室房间（含可选静态成员） */
  CREATE: 'collaboration-room:create',
  /** 获取单个房间（不存在返回 null） */
  GET: 'collaboration-room:get',
  /** 更新房间（rename / pause / archive / complete） */
  UPDATE: 'collaboration-room:update',
  /** 列出某房间全部消息（按 createdAt 升序） */
  LIST_MESSAGES: 'collaboration-room:list-messages',
  /** 追加静态用户消息（Stage 1：只落盘+刷新，不触发 Agent） */
  APPEND_USER_MESSAGE: 'collaboration-room:append-user-message',
  /** 列出某房间全部成员（静态身份，S2+ 才有运行状态） */
  LIST_MEMBERS: 'collaboration-room:list-members',
  /** 房间数据变更事件（main → renderer，S2+ 广播占位，Stage 1 不发送） */
  CHANGED: 'collaboration-room:changed',
} as const

/** 列出全部房间输入 */
export interface ListCollaborationRoomsInput {
  /** 是否包含已归档房间（默认 false，只看 active/paused/completed） */
  includeArchived?: boolean
}

/** 获取单个房间输入 */
export interface GetCollaborationRoomInput {
  /** 房间 ID */
  roomId: string
}

/** 列出某房间消息输入 */
export interface ListCollaborationMessagesInput {
  /** 房间 ID */
  roomId: string
}

/** 列出某房间成员输入 */
export interface ListCollaborationMembersInput {
  /** 房间 ID */
  roomId: string
}

/**
 * 房间数据变更事件 payload（main → renderer，S2+）
 *
 * Stage 1 不发送此事件；渲染层在 CREATE/UPDATE/APPEND 后主动重新 LIST/GET。
 */
export interface CollaborationRoomChangedPayload {
  /** 发生变更的房间 ID */
  roomId: string
  /** 变更类型 */
  kind: 'created' | 'updated' | 'archived' | 'message-appended'
}

// ===== 复用领域输入类型作为 IPC payload =====
// 创建/更新/追加消息的 IPC 输入与领域输入完全一致，直接复用，避免重复定义。
// 见 ./collaboration-room.ts 中的：
//   - CreateCollaborationRoomInput   → CREATE
//   - UpdateCollaborationRoomInput    → UPDATE
//   - AppendCollaborationUserMessageInput → APPEND_USER_MESSAGE
//
// 返回类型：
//   - LIST              → CollaborationRoom[]
//   - CREATE            → CollaborationRoom
//   - GET               → CollaborationRoom | null
//   - UPDATE            → CollaborationRoom
//   - LIST_MESSAGES     → CollaborationMessage[]
//   - APPEND_USER_MESSAGE → CollaborationMessage
//   - LIST_MEMBERS      → CollaborationMember[]

/** 重新导出领域输入类型，便于 handler / preload / 渲染层统一引用 */
export type {
  CreateCollaborationRoomInput,
  UpdateCollaborationRoomInput,
  AppendCollaborationUserMessageInput,
  CollaborationRoom,
  CollaborationMember,
  CollaborationMessage,
}
