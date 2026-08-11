/**
 * 协作室服务（Stage 1 业务逻辑）
 *
 * 在 repository 之上做：输入校验、ID 生成、默认值、状态转换、协调者解析。
 * 不注册 IPC（由 collaboration-ipc.ts 持有实例并注册 handler）。
 * Stage 1 不运行 Agent、不 A2A、不调度；appendUserMessage 只落盘静态用户消息。
 *
 * 设计参考：apps/electron/src/main/lib/ipc/channel-service.ts（class + static create）
 */
import { randomUUID } from 'node:crypto'
import {
  COLLABORATION_LOGICAL_SESSION_ID_PREFIX,
  COLLABORATION_MEMBER_ID_PREFIX,
  COLLABORATION_MESSAGE_ID_PREFIX,
  COLLABORATION_ROOM_DEFAULT_MAX_A2A_DEPTH,
  COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS,
  COLLABORATION_ROOM_ID_PREFIX,
  isCollaborationRoomStatus,
  validateCreateCollaborationRoomInput,
  type CollaborationMember,
  type CollaborationMemberCapabilities,
  type CollaborationMessage,
  type CollaborationRoom,
  type CreateCollaborationMemberInput,
  type CreateCollaborationRoomInput,
  type UpdateCollaborationRoomInput,
  type AppendCollaborationUserMessageInput,
} from '@tagent/shared'
import {
  appendMembers,
  appendMessage,
  getRoom,
  listMembersByRoom,
  listMessagesByRoom,
  loadRooms,
  upsertRoom,
} from './collaboration-room-repository'

/** Stage 1 静态成员的默认能力（全 false，S2+ 由真实 probe 填充） */
const DEFAULT_MEMBER_CAPABILITIES: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
}

/** 生成带前缀的 ID */
function genId(prefix: string): string {
  return `${prefix}${randomUUID()}`
}

export class CollaborationRoomService {
  private constructor() {}

  static create(): CollaborationRoomService {
    return new CollaborationRoomService()
  }

  // ===== Room =====

  /** 列出全部房间（默认不含 archived，按 updatedAt 倒序） */
  listRooms(includeArchived = false): CollaborationRoom[] {
    const rooms = loadRooms()
    const filtered = includeArchived ? rooms : rooms.filter((r) => r.status !== 'archived')
    return filtered.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 取单个房间（不存在返回 undefined） */
  getRoomById(roomId: string): CollaborationRoom | undefined {
    return getRoom(roomId)
  }

  /**
   * 创建协作室房间（含可选静态成员）。
   *
   * 协调者解析：取第一个 isCoordinator=true 的成员；若无标记但提供了成员，
   * 指派第一个成员为协调者（满足「一个 room 一个协调者」不变量的骨架版）；
   * 空白团队（无成员）coordinatorMemberId 为空字符串，S2+ 再补。
   */
  createRoom(input: CreateCollaborationRoomInput): CollaborationRoom {
    const errors = validateCreateCollaborationRoomInput(input)
    if (errors.length > 0) {
      throw new Error(errors.join('；'))
    }

    const now = Date.now()
    const roomId = genId(COLLABORATION_ROOM_ID_PREFIX)

    // 构建静态成员
    const memberSpecs = input.members ?? []
    const members: CollaborationMember[] = memberSpecs.map((spec) => buildMember(roomId, spec, now))

    // 解析协调者
    let coordinatorMemberId = ''
    const markedCoordinator = members.find((m) => m.isCoordinator)
    if (markedCoordinator) {
      coordinatorMemberId = markedCoordinator.id
    } else if (members.length > 0) {
      // 未显式标记但提供了成员：指派第一个为协调者
      members[0]!.isCoordinator = true
      coordinatorMemberId = members[0]!.id
    }

    const room: CollaborationRoom = {
      id: roomId,
      title: input.title.trim(),
      goal: input.goal?.trim() ?? '',
      workspaceId: input.workspaceId,
      coordinatorMemberId,
      status: 'active',
      maxConcurrentRuns: input.maxConcurrentRuns ?? COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS,
      maxA2ADepth: input.maxA2ADepth ?? COLLABORATION_ROOM_DEFAULT_MAX_A2A_DEPTH,
      budget: input.budget ?? {},
      attachedBoardId: input.attachedBoardId,
      createdAt: now,
      updatedAt: now,
    }

    // 先写房间，再写成员；成员写失败时房间已落盘（可接受降级，见文件头注释）
    upsertRoom(room)
    appendMembers(members)

    return room
  }

  /** 更新房间（rename / pause / archive / complete / resume / 调整上限） */
  updateRoom(input: UpdateCollaborationRoomInput): CollaborationRoom {
    const existing = getRoom(input.roomId)
    if (!existing) {
      throw new Error('房间不存在')
    }
    if (input.status !== undefined && !isCollaborationRoomStatus(input.status)) {
      throw new Error(`非法房间状态：${String(input.status)}`)
    }

    const now = Date.now()
    const nextStatus = input.status ?? existing.status
    const updated: CollaborationRoom = {
      ...existing,
      title: input.title !== undefined ? input.title.trim() : existing.title,
      goal: input.goal !== undefined ? input.goal.trim() : existing.goal,
      status: nextStatus,
      maxConcurrentRuns: input.maxConcurrentRuns ?? existing.maxConcurrentRuns,
      maxA2ADepth: input.maxA2ADepth ?? existing.maxA2ADepth,
      budget: input.budget ?? existing.budget,
      updatedAt: now,
      // 归档记时间；从 archived 恢复到 active 清掉归档时间
      archivedAt:
        nextStatus === 'archived'
          ? existing.archivedAt ?? now
          : nextStatus === 'active'
            ? undefined
            : existing.archivedAt,
    }

    upsertRoom(updated)
    return updated
  }

  // ===== Message =====

  /** 列出某房间全部消息（按 createdAt 升序） */
  listMessages(roomId: string): CollaborationMessage[] {
    return listMessagesByRoom(roomId)
  }

  /**
   * 追加静态用户消息（Stage 1：只落盘 + 刷新，不触发 Agent）。
   *
   * authorId 暂用 'user' 占位（S2+ 接入真实用户身份）；
   * rootMessageId 暂等于自身（S2+ 接入回复链根解析）。
   */
  appendUserMessage(input: AppendCollaborationUserMessageInput): CollaborationMessage {
    const room = getRoom(input.roomId)
    if (!room) {
      throw new Error('房间不存在')
    }
    const text = input.content?.trim() ?? ''
    if (!text) {
      throw new Error('消息内容不能为空')
    }

    const now = Date.now()
    const id = genId(COLLABORATION_MESSAGE_ID_PREFIX)
    const message: CollaborationMessage = {
      id,
      roomId: input.roomId,
      authorType: 'user',
      authorId: 'user',
      kind: 'chat',
      content: text,
      visibility: 'room',
      targetMemberIds: input.targetMemberIds ?? [],
      replyToMessageId: input.replyToMessageId,
      rootMessageId: id,
      depth: 0,
      createdAt: now,
    }

    appendMessage(message)

    // 房间 updatedAt 刷新（便于侧栏按最后活动排序）
    upsertRoom({ ...room, updatedAt: now })

    return message
  }

  // ===== Member =====

  /** 列出某房间全部成员（静态身份，S2+ 才有运行状态） */
  listMembers(roomId: string): CollaborationMember[] {
    return listMembersByRoom(roomId)
  }
}

/** 根据创建输入 + 房间 ID 构建一个静态成员记录 */
function buildMember(
  roomId: string,
  spec: CreateCollaborationMemberInput,
  now: number,
): CollaborationMember {
  const displayName = spec.displayName.trim()
  return {
    id: genId(COLLABORATION_MEMBER_ID_PREFIX),
    roomId,
    displayName,
    roleId: spec.roleId,
    roleSnapshot: spec.roleSnapshot ?? { roleId: spec.roleId, displayName },
    backend: spec.backend ?? 'channel',
    channelId: spec.channelId,
    modelId: spec.modelId,
    cliWorkerId: spec.cliWorkerId,
    logicalSessionId: genId(COLLABORATION_LOGICAL_SESSION_ID_PREFIX),
    permissionProfile: spec.permissionProfile ?? 'read-only',
    capabilities: { ...DEFAULT_MEMBER_CAPABILITIES, ...(spec.capabilities ?? {}) },
    status: 'offline',
    isCoordinator: spec.isCoordinator ?? false,
    createdAt: now,
    updatedAt: now,
  }
}
