/**
 * Collaboration Room 协作室 IPC 通道常量与请求/响应类型
 *
 * 渲染进程通过 window.electronAPI.collaborationRoom.* 调用，主进程在
 * main/lib/collaboration/collaboration-ipc.ts 注册处理器。
 * 通道命名与 kanban/automation 一致：动词:名词 形式，CHANGED 为 main→renderer 广播。
 *
 * Stage 2：在 Stage 1 的 7 个通道基础上新增 LIST_RUNS / CANCEL_RUN，并启用 CHANGED
 * 广播（run/member/message 变更时主进程主动推送，渲染层据此重新拉取）。
 * Stage 3：新增 ADD_MEMBER（向已有房间追加成员，「添加成员」按钮用）。
 */

import type {
  CollaborationRoom,
  CollaborationMember,
  CollaborationMessage,
  CollaborationRun,
  CreateCollaborationRoomInput,
  CreateCollaborationMemberInput,
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
  /** 追加用户消息（Stage 2：落盘后异步触发成员 run） */
  APPEND_USER_MESSAGE: 'collaboration-room:append-user-message',
  /** 列出某房间全部成员（静态身份 + 运行状态） */
  LIST_MEMBERS: 'collaboration-room:list-members',
  /** 向已有房间追加一个成员（Stage 3：「添加成员」按钮；displayName + 自动绑默认渠道） */
  ADD_MEMBER: 'collaboration-room:add-member',
  /** 列出某房间全部 run（按 createdAt 升序，Stage 2） */
  LIST_RUNS: 'collaboration-room:list-runs',
  /** 取消某 run（abort 后端调用 + 置 cancelled，Stage 2） */
  CANCEL_RUN: 'collaboration-room:cancel-run',
  /** 列出某房间全部 A2A 信箱信封（S4 审计视图） */
  LIST_MAILBOX: 'collaboration-room:list-mailbox',
  /** 房间数据变更事件（main → renderer，Stage 2 起广播） */
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

/** 追加成员输入（Stage 3）；复用 CreateCollaborationMemberInput 字段，加 roomId */
export type AddCollaborationMemberInput = {
  /** 房间 ID */
  roomId: string
} & CreateCollaborationMemberInput

/** 列出某房间 run 输入（Stage 2） */
export interface ListCollaborationRunsInput {
  /** 房间 ID */
  roomId: string
}

/** 取消某 run 输入（Stage 2） */
export interface CancelCollaborationRunInput {
  /** 房间 ID */
  roomId: string
  /** run ID */
  runId: string
}

/** 列出某房间全部 A2A 信箱信封输入（S4） */
export interface ListCollaborationMailboxInput {
  /** 房间 ID */
  roomId: string
}

/**
 * 房间数据变更事件 payload（main → renderer，Stage 2 起广播）
 *
 * 渲染层收到后重新 LIST/GET/LIST_MESSAGES/LIST_MEMBERS/LIST_RUNS 该房间即可，
 * 不依赖 kind 做增量更新（payload 仅用于日志/过滤）。
 */
export interface CollaborationRoomChangedPayload {
  /** 发生变更的房间 ID */
  roomId: string
  /** 变更类型 */
  kind:
    | 'created'
    | 'updated'
    | 'archived'
    | 'message-appended'
    | 'member-message-appended'
    | 'run-started'
    | 'run-finished'
    | 'run-cancelled'
    | 'run-awaiting-peer'
    | 'mailbox-updated'
  /** 发生时间戳 */
  at: number
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
//   - ADD_MEMBER        → CollaborationMember
//   - LIST_RUNS         → CollaborationRun[]
//   - CANCEL_RUN        → CollaborationRun | null

/** 重新导出领域输入类型，便于 handler / preload / 渲染层统一引用 */
export type {
  CreateCollaborationRoomInput,
  UpdateCollaborationRoomInput,
  AppendCollaborationUserMessageInput,
  CollaborationRoom,
  CollaborationMember,
  CollaborationMessage,
  CollaborationRun,
}
