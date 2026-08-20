/** 旧 CollaborationMember -> RoomBotSeat 的兼容归一化。 */
import type {
  CollaborationMemberBackend,
  CollaborationMemberCapabilities,
  CollaborationRoleSnapshot,
} from './collaboration-room'
import {
  deriveLegacyRoomBotSeatId,
  normalizeFusionPermissionProfile,
  type RoomBotSeat,
} from './fusion-session'

export interface LegacyRoomMemberRecord {
  id: string
  roomId: string
  displayName: string
  roleSnapshot: CollaborationRoleSnapshot
  backend?: unknown
  channelId?: string
  modelId?: string
  logicalSessionId: string
  permissionProfile?: unknown
  capabilities?: Partial<CollaborationMemberCapabilities>
  status?: RoomBotSeat['status'] | 'offline' | 'done'
  isCoordinator?: boolean
  createdAt: number
  updatedAt: number
}

export type LegacySeatNormalization =
  | { ok: true; seat: RoomBotSeat; legacy: true }
  | { ok: false; errors: string[] }

const DEFAULT_CAPABILITIES: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asBackend(value: unknown): CollaborationMemberBackend | undefined {
  if (value === undefined) return 'channel'
  if (value === 'pi' || value === 'channel' || value === 'cli') return value
  return undefined
}

function asCapabilities(value: Partial<CollaborationMemberCapabilities> | undefined) {
  return { ...DEFAULT_CAPABILITIES, ...value }
}

/**
 * 只负责数据层兼容，不创建 BotProfile、不复制记忆，也不启动会话。
 * owner/config revision 由后续显式迁移流程补齐，避免把旧字段误当作全局身份。
 */
export function normalizeLegacyRoomMember(value: unknown): LegacySeatNormalization {
  if (!isRecord(value)) return { ok: false, errors: ['member 必须是对象'] }

  const member = value as Partial<LegacyRoomMemberRecord>
  const errors: string[] = []
  for (const field of ['id', 'roomId', 'displayName', 'logicalSessionId'] as const) {
    if (typeof member[field] !== 'string' || !member[field].trim()) {
      errors.push(`member.${field} 必填`)
    }
  }
  if (typeof member.roleSnapshot !== 'object' || member.roleSnapshot === null) {
    errors.push('member.roleSnapshot 必须是对象')
  }
  if (typeof member.createdAt !== 'number' || typeof member.updatedAt !== 'number') {
    errors.push('member.createdAt/updatedAt 必须是 number')
  }
  const backend = asBackend(member.backend)
  if (!backend) errors.push('member.backend 非法')
  if (errors.length > 0) return { ok: false, errors }

  const id = member.id as string
  const roomId = member.roomId as string
  const status = member.status === 'running' ? 'running' : member.status === 'paused' ? 'paused' : 'idle'

  return {
    ok: true,
    legacy: true,
    seat: {
      id: deriveLegacyRoomBotSeatId(roomId, id),
      roomId,
      botProfileId: `legacy-bot_${id}`,
      ownerUserId: 'legacy-unknown',
      configRevisionId: `legacy-revision_${id}`,
      displayNameSnapshot: member.displayName as string,
      roleSnapshot: member.roleSnapshot as CollaborationRoleSnapshot,
      backend: backend as CollaborationMemberBackend,
      channelId: member.channelId,
      modelId: member.modelId,
      permissionProfile: normalizeFusionPermissionProfile(member.permissionProfile),
      capabilities: asCapabilities(member.capabilities),
      status,
      logicalSessionId: member.logicalSessionId as string,
      isCoordinator: member.isCoordinator === true,
      createdAt: member.createdAt as number,
      updatedAt: member.updatedAt as number,
    },
  }
}

