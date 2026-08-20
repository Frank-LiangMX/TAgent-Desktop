import { describe, expect, test } from 'vitest'
import {
  deriveLegacyRoomBotSeatId,
  getFusionConversationMode,
  normalizeFusionPermissionProfile,
  validateRoomWorkspace,
  type RoomWorkspace,
} from './fusion-session'

describe('fusion session domain slice', () => {
  test('0/1/2+ Bot 路由模式保持简单', () => {
    expect(getFusionConversationMode(1, 0)).toBe('ordinary')
    expect(getFusionConversationMode(1, 1)).toBe('single-bot')
    expect(getFusionConversationMode(1, 2)).toBe('multi-bot')
    expect(getFusionConversationMode(2, 1)).toBe('multi-user')
  })

  test('非法人数 fail-closed 为普通会话', () => {
    expect(getFusionConversationMode(0, 99)).toBe('ordinary')
    expect(getFusionConversationMode(-1, 1)).toBe('ordinary')
    expect(getFusionConversationMode(1.5, 1)).toBe('ordinary')
  })

  test('旧成员 seatId 稳定派生且不会使用时间戳', () => {
    const first = deriveLegacyRoomBotSeatId('room/a', 'member b')
    expect(first).toBe('rbs_legacy_room_a_member_b')
    expect(deriveLegacyRoomBotSeatId('room/a', 'member b')).toBe(first)
  })

  test('权限缺省和非法值都保持 read-only', () => {
    expect(normalizeFusionPermissionProfile(undefined)).toBe('read-only')
    expect(normalizeFusionPermissionProfile('workspace-write')).toBe('workspace-write')
    expect(normalizeFusionPermissionProfile('Workspace-Write')).toBe('read-only')
    expect(normalizeFusionPermissionProfile('admin')).toBe('read-only')
  })

  test('active workspace 必须绑定真实存储位置', () => {
    const workspace: RoomWorkspace = {
      id: 'rw_1',
      roomId: 'room_1',
      kind: 'server',
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    }
    expect(validateRoomWorkspace(workspace)).toContain(
      'active workspace 必须有 rootPath 或 storageKey',
    )
    expect(
      validateRoomWorkspace({ ...workspace, rootPath: 'F:/rooms/room_1' }),
    ).toEqual([])
  })

  test('已归档 workspace 可以保留没有当前存储位置的兼容记录', () => {
    const workspace: RoomWorkspace = {
      id: 'rw_old',
      roomId: 'room_1',
      kind: 'server',
      status: 'archived',
      createdAt: 0,
      updatedAt: 0,
    }
    expect(validateRoomWorkspace(workspace)).toEqual([])
  })
})

