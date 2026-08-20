import { describe, expect, test } from 'vitest'
import { normalizeLegacyRoomMember } from './fusion-session-legacy'

const legacyMember = {
  id: 'cm_old',
  roomId: 'cr_old',
  displayName: '研究员',
  roleSnapshot: { displayName: '研究员', description: '只读旧角色' },
  backend: 'channel',
  modelId: 'glm-5.2',
  logicalSessionId: 'ls_old',
  capabilities: {},
  isCoordinator: true,
  createdAt: 100,
  updatedAt: 200,
}

describe('legacy CollaborationMember normalization', () => {
  test('旧成员可归一化为稳定的 RoomBotSeat', () => {
    const result = normalizeLegacyRoomMember(legacyMember)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.legacy).toBe(true)
    expect(result.seat.id).toBe('rbs_legacy_cr_old_cm_old')
    expect(result.seat.botProfileId).toBe('legacy-bot_cm_old')
    expect(result.seat.ownerUserId).toBe('legacy-unknown')
    expect(result.seat.permissionProfile).toBe('read-only')
    expect(result.seat.capabilities.supportsToolBridge).toBe(false)
    expect(result.seat.isCoordinator).toBe(true)
  })

  test('缺省 backend 兼容为 channel，但非法 backend 拒绝', () => {
    const withoutBackend = normalizeLegacyRoomMember({ ...legacyMember, backend: undefined })
    expect(withoutBackend.ok).toBe(true)
    if (withoutBackend.ok) expect(withoutBackend.seat.backend).toBe('channel')

    const invalid = normalizeLegacyRoomMember({ ...legacyMember, backend: 'admin' })
    expect(invalid).toEqual({ ok: false, errors: ['member.backend 非法'] })
  })

  test('未知权限不会升权，缺失基础字段 fail-closed', () => {
    const result = normalizeLegacyRoomMember({
      ...legacyMember,
      permissionProfile: 'workspace-write-please',
      logicalSessionId: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toContain('member.logicalSessionId 必填')
  })
})

