/**
 * 协作室看板桥（S5：只读投影）聚焦测试
 *
 * 覆盖：
 * - projectBoardTasks：挂载看板的房间能读取看板任务投影、未挂载返回空
 * - projectBoardSummary：全板统计摘要
 * - 房间隔离：不同房间挂不同看板返回不同数据
 * - 看板不存在 -> fail-open 空 / null（不抛错）
 * - 状态映射（KANBAN_STATUS_TO_ROOM_LABEL）
 * - mapKanbanTaskToProjected / summarizeProjectedBoardTasks 纯函数正确性
 * - 增量读取：看板任务变更后，下次投影读取到最新数据
 * - 只读守卫：验证 service 上没有写 kanban-store 的公开方法
 *
 * 通过 TAGENT_CONFIG_DIR 指向临时目录，与 collaboration-room-task.test.ts 同构。
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mapKanbanTaskToProjected,
  summarizeProjectedBoardTasks,
  KANBAN_STATUS_TO_ROOM_LABEL,
  type BoardProjectedTask,
  type MemberBackendAdapter,
  type MemberTurnInput,
  type MemberTurnResult,
} from '@tagent/shared'
import { CollaborationRoomService } from './collaboration-room-service'
import * as kanbanStore from '../kanban/kanban-store'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tagent-collab-bridge-test-'))
  process.env.TAGENT_CONFIG_DIR = tmpDir
})

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Mock adapter 捷径（与 collaboration-room-task.test.ts 同构） */
const MOCK_ADAPTER: MemberBackendAdapter = {
  capabilities: () => ({}) as never,
  runTurn(_: MemberTurnInput): Promise<MemberTurnResult> {
    return Promise.resolve({ type: 'done', text: '(mock)' })
  },
}

/** 构造一个带协调者成员的房间 */
function mkRoom(
  svc: CollaborationRoomService,
  title: string,
  attachedBoardId?: string,
): { room: ReturnType<CollaborationRoomService['createRoom']> } {
  const room = svc.createRoom({
    title,
    attachedBoardId,
    members: [{ displayName: 'coordinator', isCoordinator: true }],
  })
  return { room }
}

describe('mapKanbanTaskToProjected (pure function)', () => {
  test('maps kanban task to projection shape', () => {
    const projected = mapKanbanTaskToProjected({
      id: 't_abc123',
      boardId: 'b_board1',
      title: 'write tests',
      body: 'cover main logic',
      status: 'running',
      roleId: 'coder',
      assigneeSessionId: 'sess_1',
      priority: 5,
      createdAt: 1000,
      updatedAt: 2000,
    })
    expect(projected.kanbanTaskId).toBe('t_abc123')
    expect(projected.boardId).toBe('b_board1')
    expect(projected.title).toBe('write tests')
    expect(projected.description).toBe('cover main logic')
    expect(projected.kanbanStatus).toBe('running')
    expect(projected.roomLabel).toBe('执行中')
    expect(projected.roleId).toBe('coder')
    expect(projected.assigneeSessionId).toBe('sess_1')
    expect(projected.priority).toBe(5)
  })

  test('status mapping covers all kanban statuses', () => {
    const statuses = ['pending', 'ready', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled']
    for (const status of statuses) {
      const result = mapKanbanTaskToProjected({
        id: 't_1',
        boardId: 'b_1',
        title: '',
        status,
      })
      expect(KANBAN_STATUS_TO_ROOM_LABEL[status]).toBeDefined()
      expect(result.roomLabel).toBe(KANBAN_STATUS_TO_ROOM_LABEL[status])
    }
  })

  test('unknown status falls back to raw value', () => {
    const result = mapKanbanTaskToProjected({
      id: 't_1',
      boardId: 'b_1',
      title: 'unknown',
      status: 'unknown_status',
    })
    expect(result.roomLabel).toBe('unknown_status')
    expect(result.kanbanStatus).toBe('unknown_status')
  })

  test('missing optional fields get defaults', () => {
    const result = mapKanbanTaskToProjected({
      id: 't_no_opt',
      boardId: 'b_1',
      title: 'test',
      status: 'ready',
    })
    expect(result.description).toBe('')
    expect(result.priority).toBe(0)
    expect(result.createdAt).toBe(0)
    expect(result.updatedAt).toBe(0)
    expect(result.roleId).toBeUndefined()
    expect(result.assigneeSessionId).toBeUndefined()
    expect(result.blockedReason).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(result.resultSummary).toBeUndefined()
  })
})

describe('summarizeProjectedBoardTasks (pure function)', () => {
  test('empty task list', () => {
    const summary = summarizeProjectedBoardTasks('b_1', 'test kanban', 100, [])
    expect(summary.total).toBe(0)
    expect(summary.done).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.blocked).toBe(0)
    expect(summary.running).toBe(0)
    expect(summary.ready).toBe(0)
    expect(summary.pending).toBe(0)
    expect(summary.boardId).toBe('b_1')
    expect(summary.boardCreatedAt).toBe(100)
  })

  test('mixed status counting', () => {
    const tasks: BoardProjectedTask[] = [
      { kanbanTaskId: 't_1', boardId: 'b_1', title: 'a', description: '', kanbanStatus: 'done', roomLabel: '', priority: 0, createdAt: 0, updatedAt: 0 },
      { kanbanTaskId: 't_2', boardId: 'b_1', title: 'b', description: '', kanbanStatus: 'done', roomLabel: '', priority: 0, createdAt: 0, updatedAt: 0 },
      { kanbanTaskId: 't_3', boardId: 'b_1', title: 'c', description: '', kanbanStatus: 'failed', roomLabel: '', priority: 0, createdAt: 0, updatedAt: 0 },
      { kanbanTaskId: 't_4', boardId: 'b_1', title: 'd', description: '', kanbanStatus: 'blocked', roomLabel: '', priority: 0, createdAt: 0, updatedAt: 0 },
      { kanbanTaskId: 't_5', boardId: 'b_1', title: 'e', description: '', kanbanStatus: 'running', roomLabel: '', priority: 0, createdAt: 0, updatedAt: 0 },
      { kanbanTaskId: 't_6', boardId: 'b_1', title: 'f', description: '', kanbanStatus: 'ready', roomLabel: '', priority: 0, createdAt: 0, updatedAt: 0 },
      { kanbanTaskId: 't_7', boardId: 'b_1', title: 'g', description: '', kanbanStatus: 'pending', roomLabel: '', priority: 0, createdAt: 0, updatedAt: 0 },
    ]
    const summary = summarizeProjectedBoardTasks('b_1', 'test board', 5000, tasks)
    expect(summary.boardId).toBe('b_1')
    expect(summary.boardTitle).toBe('test board')
    expect(summary.boardCreatedAt).toBe(5000)
    expect(summary.total).toBe(7)
    expect(summary.done).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.blocked).toBe(1)
    expect(summary.running).toBe(1)
    expect(summary.ready).toBe(1)
    expect(summary.pending).toBe(1)
  })
})

describe('BoardProjectionBridge (service-level)', () => {
  let svc: CollaborationRoomService

  beforeAll(() => {
    kanbanStore.__resetKanbanStoreForTests()
    svc = CollaborationRoomService.create({ adapter: MOCK_ADAPTER })
  })

  test('projectBoardTasks: room without board returns empty array', () => {
    const { room } = mkRoom(svc, 'no-board-room')
    expect(svc.projectBoardTasks(room.id)).toEqual([])
  })

  test('projectBoardSummary: room without board returns null', () => {
    const { room } = mkRoom(svc, 'no-board-room-2')
    expect(svc.projectBoardSummary(room.id)).toBeNull()
  })

  test('nonexistent room returns empty array / null (fail-open)', () => {
    expect(svc.projectBoardTasks('cr_nonexistent')).toEqual([])
    expect(svc.projectBoardSummary('cr_nonexistent')).toBeNull()
  })

  test('room with missing board returns empty / null (fail-open)', () => {
    const { room } = mkRoom(svc, 'stale-board-room', 'b_nonexistent')
    expect(svc.projectBoardTasks(room.id)).toEqual([])
    expect(svc.projectBoardSummary(room.id)).toBeNull()
  })

  test('board-attached room reads kanban task projection', () => {
    const board = kanbanStore.createBoard({ rootGoal: 'test projection' })
    const task1 = kanbanStore.createTask({
      boardId: board.id,
      title: 'task 1',
      channelId: 'kscc-internal',
      body: 'first board task',
      priority: 1,
    })
    const task2 = kanbanStore.createTask({
      boardId: board.id,
      title: 'task 2 done',
      channelId: 'kscc-internal',
      body: 'second board task',
      priority: 2,
    })
    kanbanStore.updateTask(task2.id, { status: 'done', resultSummary: 'finished' })

    const { room } = mkRoom(svc, 'board-room', board.id)
    const projected = svc.projectBoardTasks(room.id)

    expect(projected).toHaveLength(2)
    // kanban-store sorts by priority desc, then createdAt asc
    expect(projected[0]!.title).toBe('task 2 done')
    expect(projected[0]!.kanbanStatus).toBe('done')
    expect(projected[0]!.roomLabel).toBe('已完成')
    expect(projected[0]!.description).toBe('second board task')
    expect(projected[0]!.resultSummary).toBe('finished')
    expect(projected[0]!.priority).toBe(2)

    expect(projected[1]!.title).toBe('task 1')
    expect(projected[1]!.kanbanStatus).toBe('ready')
    expect(projected[1]!.roomLabel).toBe('就绪')
    expect(projected[1]!.description).toBe('first board task')
    expect(projected[0]!.kanbanTaskId).toBe(task2.id)
    expect(projected[1]!.kanbanTaskId).toBe(task1.id)
  })

  test('projectBoardSummary returns correct stats', () => {
    const board = kanbanStore.createBoard({ rootGoal: 'summary board' })
    const t1 = kanbanStore.createTask({ boardId: board.id, title: 'A', channelId: 'kscc-internal' })
    const t2 = kanbanStore.createTask({ boardId: board.id, title: 'B', channelId: 'kscc-internal' })
    const t3 = kanbanStore.createTask({ boardId: board.id, title: 'C', channelId: 'kscc-internal' })
    kanbanStore.updateTask(t1.id, { status: 'done', resultSummary: 'ok' })
    kanbanStore.updateTask(t2.id, { status: 'running' })
    kanbanStore.updateTask(t3.id, { status: 'failed', error: 'boom' })

    const { room } = mkRoom(svc, 'summary-room', board.id)
    const summary = svc.projectBoardSummary(room.id)

    expect(summary).not.toBeNull()
    expect(summary!.boardId).toBe(board.id)
    expect(summary!.boardTitle).toMatch(/summary board/)
    expect(summary!.total).toBe(3)
    expect(summary!.done).toBe(1)
    expect(summary!.running).toBe(1)
    expect(summary!.failed).toBe(1)
    expect(summary!.blocked).toBe(0)
    expect(summary!.ready).toBe(0)
  })

  test('room isolation: different rooms on different boards return different data', () => {
    const boardA = kanbanStore.createBoard({ rootGoal: 'board A' })
    const boardB = kanbanStore.createBoard({ rootGoal: 'board B' })
    kanbanStore.createTask({ boardId: boardA.id, title: 'A-task', channelId: 'kscc-internal' })
    kanbanStore.createTask({ boardId: boardB.id, title: 'B-task', channelId: 'kscc-internal' })

    const { room: roomA } = mkRoom(svc, 'room-A', boardA.id)
    const { room: roomB } = mkRoom(svc, 'room-B', boardB.id)

    const projectedA = svc.projectBoardTasks(roomA.id)
    const projectedB = svc.projectBoardTasks(roomB.id)

    expect(projectedA).toHaveLength(1)
    expect(projectedA[0]!.title).toBe('A-task')
    expect(projectedA[0]!.boardId).toBe(boardA.id)

    expect(projectedB).toHaveLength(1)
    expect(projectedB[0]!.title).toBe('B-task')
    expect(projectedB[0]!.boardId).toBe(boardB.id)
  })

  test('incremental read: projectBoardTasks always reads fresh kanban state', () => {
    const board = kanbanStore.createBoard({ rootGoal: 'incremental board' })
    const task = kanbanStore.createTask({ boardId: board.id, title: 'initial', channelId: 'kscc-internal' })
    const { room } = mkRoom(svc, 'incremental-room', board.id)

    // initial read
    let projected = svc.projectBoardTasks(room.id)
    expect(projected).toHaveLength(1)
    expect(projected[0]!.kanbanStatus).toBe('ready')

    // kanban task status changes
    kanbanStore.updateTask(task.id, { status: 'done', resultSummary: 'finished' })

    // next projection sees latest data (no caching)
    projected = svc.projectBoardTasks(room.id)
    expect(projected).toHaveLength(1)
    expect(projected[0]!.kanbanStatus).toBe('done')
    expect(projected[0]!.roomLabel).toBe('已完成')
    expect(projected[0]!.resultSummary).toBe('finished')
  })

  test('projectBoardTasks reflects newly created tasks (no stale cache)', () => {
    const board = kanbanStore.createBoard({ rootGoal: 'cache-proof board' })
    const { room } = mkRoom(svc, 'cache-proof-room', board.id)

    expect(svc.projectBoardTasks(room.id)).toHaveLength(0)

    kanbanStore.createTask({ boardId: board.id, title: 'new task', channelId: 'kscc-internal' })

    expect(svc.projectBoardTasks(room.id)).toHaveLength(1)
  })

  test('bridge is read-only: service exposes no kanban-write method', () => {
    const proto = Object.getPrototypeOf(svc)
    const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor')
    // No service method performs a kanban write: filter for methods whose name pairs a
    // write verb (create/update/delete/add/assign) with a kanban/board subject.
    const kanbanWrite = methods.filter(
      (m) => /create|update|delete|add|assign/i.test(m) && /kanban|board/i.test(m),
    )
    // The board-related methods are all read-only / notification-only, never writes.
    const boardMethods = methods.filter((m) => /board/i.test(m))
    expect(boardMethods).toEqual(
      expect.arrayContaining(['projectBoardTasks', 'projectBoardSummary', 'broadcastBoardChanged']),
    )
    expect(kanbanWrite).toEqual([])
    // getTaskByIdFromKanban is a read helper (name carries 'Kanban' but no write verb).
    expect(methods).toContain('getTaskByIdFromKanban')
  })
})
