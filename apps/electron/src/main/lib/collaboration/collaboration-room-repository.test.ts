/**
 * 协作室仓库 + 服务 集成测试（Stage 1）
 *
 * 通过 TAGENT_CONFIG_DIR 指向临时目录，验证：
 * - createRoom + 静态成员 + 协调者解析
 * - getRoom / listRooms（含/不含归档）
 * - appendUserMessage + listMessages
 * - updateRoom（rename / pause / archive）
 * - 「重启后数据仍在」：新建一个 service 实例（模拟重启）仍能读到已落盘数据
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollaborationRoomService } from './collaboration-room-service'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `tagent-collab-test-`))
  process.env.TAGENT_CONFIG_DIR = tmpDir
})

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('CollaborationRoomService（Stage 1 持久化）', () => {
  test('createRoom：空白团队 + 默认值', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({ title: '空白团队', goal: '试试骨架' })
    expect(room.id).toMatch(/^cr_/)
    expect(room.title).toBe('空白团队')
    expect(room.goal).toBe('试试骨架')
    expect(room.status).toBe('active')
    expect(room.coordinatorMemberId).toBe('')
    expect(room.maxConcurrentRuns).toBe(3)
    expect(room.maxA2ADepth).toBe(4)
    expect(svc.listMembers(room.id)).toEqual([])
  })

  test('createRoom：成员 + 协调者解析（显式标记）', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({
      title: '前端组',
      members: [
        { displayName: '协调者', isCoordinator: true },
        { displayName: '工程师 A' },
        { displayName: '工程师 B' },
      ],
    })
    const members = svc.listMembers(room.id)
    expect(members).toHaveLength(3)
    expect(members.every((m) => m.id.startsWith('cm_'))).toBe(true)
    expect(members.every((m) => m.logicalSessionId.startsWith('ls_'))).toBe(true)
    const coord = members.find((m) => m.isCoordinator)
    expect(coord).toBeDefined()
    expect(room.coordinatorMemberId).toBe(coord?.id)
    expect(members.filter((m) => m.isCoordinator)).toHaveLength(1)
    // Stage 1 静态成员：offline + 全 false 能力
    expect(members.every((m) => m.status === 'offline')).toBe(true)
    expect(members.every((m) => m.capabilities.supportsResume === false)).toBe(true)
  })

  test('createRoom：未标记协调者 → 指派第一个成员', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({
      title: '无标记',
      members: [{ displayName: '甲' }, { displayName: '乙' }],
    })
    const members = svc.listMembers(room.id)
    expect(members[0]!.isCoordinator).toBe(true)
    expect(room.coordinatorMemberId).toBe(members[0]!.id)
  })

  test('createRoom：校验失败抛错', () => {
    const svc = CollaborationRoomService.create()
    expect(() => svc.createRoom({ title: '' })).toThrow(/title/)
    expect(() => svc.createRoom({ title: 'x', members: Array.from({ length: 7 }, () => ({ displayName: 'm' })) })).toThrow(
      /members/,
    )
  })

  test('getRoomById + listRooms', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({ title: '查找测试' })
    expect(svc.getRoomById(room.id)?.title).toBe('查找测试')
    expect(svc.getRoomById('cr_not_exist')).toBeUndefined()
    const list = svc.listRooms()
    expect(list.some((r) => r.id === room.id)).toBe(true)
  })

  test('appendUserMessage + listMessages', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({ title: '消息测试' })
    const m1 = svc.appendUserMessage({ roomId: room.id, content: '第一条' })
    const m2 = svc.appendUserMessage({ roomId: room.id, content: '第二条' })
    expect(m1.id).toMatch(/^msg_/)
    expect(m1.authorType).toBe('user')
    expect(m1.kind).toBe('chat')
    expect(m1.rootMessageId).toBe(m1.id)
    expect(m1.depth).toBe(0)
    const msgs = svc.listMessages(room.id)
    expect(msgs.map((m) => m.content)).toEqual(['第一条', '第二条'])
    expect(m2.createdAt).toBeGreaterThanOrEqual(m1.createdAt)
  })

  test('历史分页：首屏取最新记录，before 游标向前翻页且不重复', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({ title: '历史分页' })
    svc.updateRoom({ roomId: room.id, status: 'paused' })
    svc.appendUserMessage({ roomId: room.id, content: '第一条' })
    svc.appendUserMessage({ roomId: room.id, content: '第二条' })
    svc.appendUserMessage({ roomId: room.id, content: '第三条' })

    const latest = svc.listMessagesPage({ roomId: room.id, limit: 2 })
    expect(latest.items.map((message) => message.content)).toEqual(['第二条', '第三条'])
    expect(latest.hasMore).toBe(true)
    expect(latest.nextCursor).toBeDefined()

    const older = svc.listMessagesPage({
      roomId: room.id,
      limit: 2,
      before: latest.nextCursor,
    })
    expect(older.items.map((message) => message.content)).toEqual(['第一条'])
    expect(older.hasMore).toBe(false)
    expect(older.nextCursor).toBeUndefined()
  })

  test('appendUserMessage：房间不存在 / 空内容抛错', () => {
    const svc = CollaborationRoomService.create()
    expect(() => svc.appendUserMessage({ roomId: 'cr_no', content: 'x' })).toThrow(/房间不存在/)
    const room = svc.createRoom({ title: '空内容' })
    expect(() => svc.appendUserMessage({ roomId: room.id, content: '   ' })).toThrow(/不能为空/)
  })

  test('updateRoom：rename / pause / archive + archivedAt', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({ title: '原名' })

    const renamed = svc.updateRoom({ roomId: room.id, title: '新名' })
    expect(renamed.title).toBe('新名')

    const paused = svc.updateRoom({ roomId: room.id, status: 'paused' })
    expect(paused.status).toBe('paused')
    expect(paused.archivedAt).toBeUndefined()

    const archived = svc.updateRoom({ roomId: room.id, status: 'archived' })
    expect(archived.status).toBe('archived')
    expect(archived.archivedAt).toBeTypeOf('number')

    // listRooms 默认不含归档
    expect(svc.listRooms().some((r) => r.id === room.id)).toBe(false)
    // includeArchived=true 含归档
    expect(svc.listRooms(true).some((r) => r.id === room.id && r.status === 'archived')).toBe(true)

    // 恢复 → 清 archivedAt
    const restored = svc.updateRoom({ roomId: room.id, status: 'active' })
    expect(restored.status).toBe('active')
    expect(restored.archivedAt).toBeUndefined()
  })

  test('updateRoom：房间不存在 / 非法状态抛错', () => {
    const svc = CollaborationRoomService.create()
    expect(() => svc.updateRoom({ roomId: 'cr_no', title: 'x' })).toThrow(/房间不存在/)
    const room = svc.createRoom({ title: '非法状态' })
    expect(() => svc.updateRoom({ roomId: room.id, status: 'running' as never })).toThrow(/非法房间状态/)
  })

  test('重启后数据仍在：新 service 实例读到已落盘房间/成员/消息', () => {
    // 第一阶段：写入
    const svc1 = CollaborationRoomService.create()
    const room = svc1.createRoom({
      title: '重启验证',
      goal: '关掉再开还在',
      members: [{ displayName: '协调者', isCoordinator: true }],
    })
    svc1.appendUserMessage({ roomId: room.id, content: '重启前的消息' })
    svc1.updateRoom({ roomId: room.id, status: 'paused' })

    // 第二阶段：模拟重启 —— 新 service 实例（无内存状态，纯读盘）
    const svc2 = CollaborationRoomService.create()
    const loaded = svc2.getRoomById(room.id)
    expect(loaded?.title).toBe('重启验证')
    expect(loaded?.goal).toBe('关掉再开还在')
    expect(loaded?.status).toBe('paused')
    expect(svc2.listMembers(room.id).map((m) => m.displayName)).toEqual(['协调者'])
    expect(svc2.listMessages(room.id).map((m) => m.content)).toEqual(['重启前的消息'])
  })
})
