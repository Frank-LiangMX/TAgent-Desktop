import { describe, expect, test } from 'vitest'
import {
  COLLABORATION_ROOM_DEFAULT_MAX_A2A_DEPTH,
  COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS,
  COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH,
  COLLABORATION_ROOM_MAX_MEMBERS,
  COLLABORATION_RUN_ID_PREFIX,
  collaborationRunIdempotencyKey,
  isCollaborationMemberStatus,
  isCollaborationRoomStatus,
  isCollaborationRunStatus,
  validateCreateCollaborationRoomInput,
  type CreateCollaborationRoomInput,
} from './collaboration-room'

describe('collaboration-room 常量', () => {
  test('默认并发与 A2A 深度对齐 02-RUNTIME-A2A-SPEC §9', () => {
    expect(COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS).toBe(3)
    expect(COLLABORATION_ROOM_DEFAULT_MAX_A2A_DEPTH).toBe(4)
    expect(COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH).toBe(10)
    expect(COLLABORATION_ROOM_MAX_MEMBERS).toBe(6)
  })

  test('run ID 前缀对齐', () => {
    expect(COLLABORATION_RUN_ID_PREFIX).toBe('run_')
  })
})

describe('isCollaborationRunStatus', () => {
  test('合法 run 状态', () => {
    expect(isCollaborationRunStatus('queued')).toBe(true)
    expect(isCollaborationRunStatus('running')).toBe(true)
    expect(isCollaborationRunStatus('done')).toBe(true)
    expect(isCollaborationRunStatus('failed')).toBe(true)
    expect(isCollaborationRunStatus('cancelled')).toBe(true)
    expect(isCollaborationRunStatus('blocked')).toBe(true)
  })

  test('非法 run 状态', () => {
    expect(isCollaborationRunStatus('active')).toBe(false)
    expect(isCollaborationRunStatus('interrupted')).toBe(false)
    expect(isCollaborationRunStatus(undefined)).toBe(false)
    expect(isCollaborationRunStatus(123)).toBe(false)
  })
})

describe('collaborationRunIdempotencyKey', () => {
  test('由 triggerMessageId + memberId 稳定派生（不含时间戳）', () => {
    const key1 = collaborationRunIdempotencyKey('msg_a', 'cm_b')
    const key2 = collaborationRunIdempotencyKey('msg_a', 'cm_b')
    expect(key1).toBe('msg_a:cm_b')
    expect(key1).toBe(key2)
  })

  test('不同触发或不同成员得到不同键', () => {
    expect(collaborationRunIdempotencyKey('msg_a', 'cm_b')).not.toBe(
      collaborationRunIdempotencyKey('msg_b', 'cm_b'),
    )
    expect(collaborationRunIdempotencyKey('msg_a', 'cm_b')).not.toBe(
      collaborationRunIdempotencyKey('msg_a', 'cm_c'),
    )
  })
})

describe('isCollaborationRoomStatus', () => {
  test('合法房间状态', () => {
    expect(isCollaborationRoomStatus('active')).toBe(true)
    expect(isCollaborationRoomStatus('paused')).toBe(true)
    expect(isCollaborationRoomStatus('archived')).toBe(true)
    expect(isCollaborationRoomStatus('completed')).toBe(true)
  })

  test('非法房间状态', () => {
    expect(isCollaborationRoomStatus('running')).toBe(false)
    expect(isCollaborationRoomStatus('')).toBe(false)
    expect(isCollaborationRoomStatus(undefined)).toBe(false)
    expect(isCollaborationRoomStatus(null)).toBe(false)
    expect(isCollaborationRoomStatus(123)).toBe(false)
  })
})

describe('isCollaborationMemberStatus', () => {
  test('合法成员状态', () => {
    expect(isCollaborationMemberStatus('offline')).toBe(true)
    expect(isCollaborationMemberStatus('idle')).toBe(true)
    expect(isCollaborationMemberStatus('running')).toBe(true)
    expect(isCollaborationMemberStatus('awaiting_peer')).toBe(true)
    expect(isCollaborationMemberStatus('awaiting_user')).toBe(true)
    expect(isCollaborationMemberStatus('done')).toBe(true)
  })

  test('非法成员状态', () => {
    expect(isCollaborationMemberStatus('active')).toBe(false)
    expect(isCollaborationMemberStatus('archived')).toBe(false)
    expect(isCollaborationMemberStatus(undefined)).toBe(false)
  })
})

describe('validateCreateCollaborationRoomInput', () => {
  test('合法输入：无错误', () => {
    const input: CreateCollaborationRoomInput = {
      title: '前端重构小组',
      goal: '把旧 React Class 组件迁到 Hooks',
      members: [
        { displayName: '协调者', isCoordinator: true },
        { displayName: '前端工程师' },
      ],
    }
    expect(validateCreateCollaborationRoomInput(input)).toEqual([])
  })

  test('空白团队（无成员）也合法', () => {
    const input: CreateCollaborationRoomInput = { title: '空白团队' }
    expect(validateCreateCollaborationRoomInput(input)).toEqual([])
  })

  test('title 为空报错', () => {
    expect(validateCreateCollaborationRoomInput({ title: '' })).toContain('title 不能为空')
    expect(validateCreateCollaborationRoomInput({ title: '   ' })).toContain('title 不能为空')
  })

  test('title 超长报错', () => {
    const input: CreateCollaborationRoomInput = { title: 'x'.repeat(201) }
    expect(validateCreateCollaborationRoomInput(input)).toContain('title 长度不能超过 200')
  })

  test('成员超过上限报错', () => {
    const members = Array.from({ length: COLLABORATION_ROOM_MAX_MEMBERS + 1 }, () => ({
      displayName: '成员',
    }))
    const input: CreateCollaborationRoomInput = { title: 't', members }
    const errors = validateCreateCollaborationRoomInput(input)
    expect(errors.some((e) => e.includes('members 数量不能超过'))).toBe(true)
  })

  test('成员 displayName 为空报错', () => {
    const input: CreateCollaborationRoomInput = {
      title: 't',
      members: [{ displayName: '' }, { displayName: '好成员' }],
    }
    const errors = validateCreateCollaborationRoomInput(input)
    expect(errors.some((e) => e.includes('members[0].displayName 不能为空'))).toBe(true)
    expect(errors.some((e) => e.includes('members[1]'))).toBe(false)
  })

  test('maxConcurrentRuns 越界报错', () => {
    expect(
      validateCreateCollaborationRoomInput({ title: 't', maxConcurrentRuns: 0 }),
    ).toContain('maxConcurrentRuns 须在 1–16')
    expect(
      validateCreateCollaborationRoomInput({ title: 't', maxConcurrentRuns: 99 }),
    ).toContain('maxConcurrentRuns 须在 1–16')
  })

  test('maxA2ADepth 超过硬上限报错', () => {
    expect(
      validateCreateCollaborationRoomInput({ title: 't', maxA2ADepth: COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH + 1 }),
    ).toContain(`maxA2ADepth 须在 1–${COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH}`)
  })
})
