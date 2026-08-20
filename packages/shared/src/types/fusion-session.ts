/**
 * 多用户融合会话第一切片的领域契约。
 *
 * 本文件只定义可序列化的身份/席位/工作区边界和 fail-closed 纯函数；
 * 不直接启动 Agent，不改变旧 CollaborationRoom 的运行时。
 */
import type {
  CollaborationMemberBackend,
  CollaborationMemberCapabilities,
  CollaborationPermissionProfile,
  CollaborationRoleSnapshot,
} from './collaboration-room'

export type FusionConversationMode = 'ordinary' | 'single-bot' | 'multi-bot' | 'multi-user'

export type FusionHumanMemberStatus = 'invited' | 'active' | 'offline' | 'left' | 'removed'

export interface FusionHumanMember {
  id: string
  roomId: string
  userId: string
  displayName: string
  status: FusionHumanMemberStatus
  joinedAt: number
  updatedAt: number
  leftAt?: number
}

export type BotProfileStatus = 'draft' | 'active' | 'paused' | 'archived'

export interface BotConfigRevision {
  id: string
  botProfileId: string
  version: number
  backend: CollaborationMemberBackend
  channelId?: string
  modelId?: string
  roleSnapshot: CollaborationRoleSnapshot
  permissionProfile: CollaborationPermissionProfile
  capabilities: CollaborationMemberCapabilities
  createdAt: number
  publishedAt?: number
}

export interface BotProfile {
  id: string
  ownerUserId: string
  displayName: string
  description?: string
  status: BotProfileStatus
  currentConfigRevisionId: string
  memoryNamespace: string
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

export type RoomBotSeatStatus =
  | 'invited'
  | 'accepted'
  | 'idle'
  | 'running'
  | 'awaiting_user'
  | 'blocked'
  | 'paused'
  | 'removed'

/** BotProfile 在一个 RoomSession 内的配置快照，不是 BotProfile 本体。 */
export interface RoomBotSeat {
  id: string
  roomId: string
  botProfileId: string
  ownerUserId: string
  configRevisionId: string
  displayNameSnapshot: string
  roleSnapshot: CollaborationRoleSnapshot
  backend: CollaborationMemberBackend
  channelId?: string
  modelId?: string
  permissionProfile: CollaborationPermissionProfile
  capabilities: CollaborationMemberCapabilities
  status: RoomBotSeatStatus
  logicalSessionId: string
  isCoordinator: boolean
  createdAt: number
  updatedAt: number
  removedAt?: number
  handoffSummary?: string
}

export type RoomAgentSessionStatus = 'idle' | 'running' | 'paused' | 'ended' | 'failed'

export interface RoomAgentSession {
  id: string
  roomId: string
  seatId: string
  configRevisionId: string
  status: RoomAgentSessionStatus
  summary?: string
  backendResumeToken?: string
  createdAt: number
  updatedAt: number
  endedAt?: number
}

export type RoomWorkspaceKind = 'server' | 'local-host' | 'cloud-volume'
export type RoomWorkspaceStatus = 'active' | 'archived' | 'deleted'

export interface RoomWorkspace {
  id: string
  roomId: string
  kind: RoomWorkspaceKind
  /** 服务端内部根路径；客户端不得把它当作可读写任意路径。 */
  rootPath?: string
  storageKey?: string
  status: RoomWorkspaceStatus
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

/** 0/1/2+ Bot 的路由模式，人数不改变单 Bot 的稳定路径。 */
export function getFusionConversationMode(humanCount: number, botCount: number): FusionConversationMode {
  if (!Number.isInteger(humanCount) || humanCount < 1) return 'ordinary'
  if (humanCount > 1) return 'multi-user'
  if (botCount <= 0) return 'ordinary'
  if (botCount === 1) return 'single-bot'
  return 'multi-bot'
}

/** 权限解析 fail-closed：旧数据缺省或非法值不得意外升权。 */
export function normalizeFusionPermissionProfile(value: unknown): CollaborationPermissionProfile {
  return value === 'workspace-write' ? 'workspace-write' : 'read-only'
}

/** 旧 CollaborationMember 没有 seatId 时稳定派生；不使用随机数或时间戳。 */
export function deriveLegacyRoomBotSeatId(roomId: string, memberId: string): string {
  const safeRoomId = roomId.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeMemberId = memberId.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
  return `rbs_legacy_${safeRoomId}_${safeMemberId}`
}

export function validateRoomWorkspace(value: RoomWorkspace): string[] {
  const errors: string[] = []
  if (!value.id.trim()) errors.push('workspace.id 必填')
  if (!value.roomId.trim()) errors.push('workspace.roomId 必填')
  if (!['server', 'local-host', 'cloud-volume'].includes(value.kind)) {
    errors.push('workspace.kind 非法')
  }
  if (value.status === 'active' && !value.rootPath?.trim() && !value.storageKey?.trim()) {
    errors.push('active workspace 必须有 rootPath 或 storageKey')
  }
  return errors
}

