/**
 * 协作室 room task（S5 第一刀：无看板时轻量任务真值层）聚焦测试
 *
 * 覆盖：
 * - 纯状态机 transitionCollaborationRoomTaskStatus：合法 / 非法 / 自环 + 类型守卫
 * - createRoomTask：持久化（id 前缀 / version=1 / status=todo / timestamps）、标题校验、
 *   负责人归属（跨成员拒绝）、挂载看板拒绝（不变量 §15.7）、房间不存在
 * - listRoomTasks：跨房间隔离；getRoomTaskById
 * - updateRoomTask：合法迁移 + version 自增、非法迁移拒绝（状态/版本不变）、跨房间拒绝、
 *   跨成员拒绝、挂载看板拒绝、expectedVersion CAS、任务不存在、空串解除指派
 * - 重启读取：新 service 实例读到已落盘 task（version / status / 字段保留）
 *
 * 通过 TAGENT_CONFIG_DIR 指向临时目录，与 collaboration-room-repository.test.ts 同构。
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canTransitionCollaborationRoomTaskStatus,
  isCollaborationRoomTaskStatus,
  transitionCollaborationRoomTaskStatus,
  COLLABORATION_ROOM_TASK_SUMMARY_MAX_LENGTH,
  type CollaborationRoomTask,
  type CollaborationRoomTaskStatus,
  type CollaborationRun,
  type CollaborationMemberCapabilities,
  type MemberBackendAdapter,
  type MemberTurnInput,
  type MemberTurnResult,
} from '@tagent/shared'
import { CollaborationRoomService } from './collaboration-room-service'
import { getRoom, upsertRoom, upsertRun } from './collaboration-room-repository'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tagent-collab-task-test-'))
  process.env.TAGENT_CONFIG_DIR = tmpDir
})

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(tmpDir, { recursive: true, force: true })
})

/** 构造一个带协调者成员的房间，返回 { room, coordinatorId } */
function mkRoomWithCoordinator(
  svc: CollaborationRoomService,
  title: string,
): { room: ReturnType<CollaborationRoomService['createRoom']>; coordinatorId: string } {
  const room = svc.createRoom({
    title,
    members: [{ displayName: '协调者', isCoordinator: true }],
  })
  const coordinatorId = svc.listMembers(room.id)[0]!.id
  return { room, coordinatorId }
}

const TASK_TEST_CAPABILITIES: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
}

function mkTaskTriggerAdapter(): { adapter: MemberBackendAdapter; calls: MemberTurnInput[] } {
  const calls: MemberTurnInput[] = []
  const adapter: MemberBackendAdapter = {
    capabilities: () => TASK_TEST_CAPABILITIES,
    runTurn: async (input: MemberTurnInput): Promise<MemberTurnResult> => {
      calls.push(input)
      return { text: '已收到任务' }
    },
  }
  return { adapter, calls }
}

// ===== 纯状态机（不读 DB / 不依赖时间） =====

describe('transitionCollaborationRoomTaskStatus 纯状态机', () => {
  test('合法迁移全部放行', () => {
    const legal: Array<[CollaborationRoomTaskStatus, CollaborationRoomTaskStatus]> = [
      ['todo', 'in_progress'],
      ['todo', 'blocked'],
      ['todo', 'failed'],
      ['in_progress', 'blocked'],
      ['in_progress', 'done'],
      ['in_progress', 'failed'],
      ['blocked', 'todo'],
      ['blocked', 'in_progress'],
      ['blocked', 'failed'],
      ['done', 'todo'],
      ['done', 'in_progress'],
      ['failed', 'todo'],
      ['failed', 'in_progress'],
    ]
    for (const [from, to] of legal) {
      expect(transitionCollaborationRoomTaskStatus(from, to)).toEqual({ ok: true })
      expect(canTransitionCollaborationRoomTaskStatus(from, to)).toBe(true)
    }
  })

  test('非法迁移全部拒绝（不改变状态）', () => {
    const illegal: Array<[CollaborationRoomTaskStatus, CollaborationRoomTaskStatus]> = [
      ['todo', 'done'],
      ['in_progress', 'todo'],
      ['blocked', 'done'],
      ['done', 'blocked'],
      ['done', 'failed'],
      ['failed', 'blocked'],
      ['failed', 'done'],
    ]
    for (const [from, to] of illegal) {
      const r = transitionCollaborationRoomTaskStatus(from, to)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('非法状态迁移')
      expect(canTransitionCollaborationRoomTaskStatus(from, to)).toBe(false)
    }
  })

  test('自环一律拒绝（状态迁移必须改变状态）', () => {
    const states: CollaborationRoomTaskStatus[] = [
      'todo',
      'in_progress',
      'blocked',
      'done',
      'failed',
    ]
    for (const s of states) {
      const r = transitionCollaborationRoomTaskStatus(s, s)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('状态未变化')
      expect(canTransitionCollaborationRoomTaskStatus(s, s)).toBe(false)
    }
  })

  test('isCollaborationRoomTaskStatus 类型守卫', () => {
    for (const s of ['todo', 'in_progress', 'blocked', 'done', 'failed'] as const) {
      expect(isCollaborationRoomTaskStatus(s)).toBe(true)
    }
    // 旧占位值已废弃，不应被当作合法 room task 状态
    for (const s of ['pending', 'ready', 'running', 'cancelled', undefined, null, 1, 'done ']) {
      expect(isCollaborationRoomTaskStatus(s)).toBe(false)
    }
  })
})

// ===== service 集成（持久化 / 校验 / 重启） =====

describe('CollaborationRoomService.createRoomTask', () => {
  test('未 @ / 未指派：建任务自动触发协调者，并把任务内容投影给它', async () => {
    const { adapter, calls } = mkTaskTriggerAdapter()
    const svc = CollaborationRoomService.create({ adapter })
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '自动协调')

    const task = svc.createRoomTask({
      roomId: room.id,
      title: '补任务入口',
      description: '不能只停在面板里',
      acceptanceCriteria: '创建后能看到 run',
    })
    await svc.awaitAllRuns()

    const runs = svc.listRuns(room.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.memberId).toBe(coordinatorId)
    expect(runs[0]!.status).toBe('done')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.prompt).toContain('补任务入口')
    expect(calls[0]!.prompt).toContain('不能只停在面板里')
    expect(calls[0]!.prompt).toContain('创建后能看到 run')

    const notice = svc.listMessages(room.id).find((m) => m.taskId === task.id)!
    expect(notice.kind).toBe('warning')
    expect(notice.authorType).toBe('system')
    expect(notice.targetMemberIds).toEqual([])
  })

  test('显式负责人：建任务直接触发负责人，不再额外批量启动', async () => {
    const { adapter, calls } = mkTaskTriggerAdapter()
    const svc = CollaborationRoomService.create({ adapter })
    const room = svc.createRoom({
      title: '直接指派',
      members: [
        { displayName: '协调者', isCoordinator: true },
        { displayName: '开发', isCoordinator: false },
      ],
    })
    const members = svc.listMembers(room.id)
    const developer = members.find((member) => member.displayName === '开发')!

    const task = svc.createRoomTask({
      roomId: room.id,
      title: '直接做',
      assigneeMemberId: developer.id,
    })
    await svc.awaitAllRuns()

    expect(svc.listRuns(room.id)).toHaveLength(1)
    expect(svc.listRuns(room.id)[0]!.memberId).toBe(developer.id)
    expect(calls[0]!.memberId).toBe(developer.id)
    expect(svc.listMessages(room.id).find((m) => m.taskId === task.id)?.targetMemberIds).toEqual([
      developer.id,
    ])
  })

  test('持久化：id 前缀 crt_ / version=1 / status=todo / timestamps', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '任务持久化')

    const task = svc.createRoomTask({
      roomId: room.id,
      title: '搭骨架',
      description: '先落真值层',
      assigneeMemberId: coordinatorId,
      acceptanceCriteria: '测试通过',
    })

    expect(task.id).toMatch(/^crt_/)
    expect(task.roomId).toBe(room.id)
    expect(task.title).toBe('搭骨架')
    expect(task.description).toBe('先落真值层')
    expect(task.status).toBe('todo')
    expect(task.assigneeMemberId).toBe(coordinatorId)
    expect(task.version).toBe(1)
    expect(task.acceptanceCriteria).toBe('测试通过')
    expect(task.createdAt).toBeTypeOf('number')
    expect(task.updatedAt).toBe(task.createdAt)

    // 落盘可读回
    expect(svc.getRoomTaskById(task.id)?.id).toBe(task.id)
    expect(svc.listRoomTasks(room.id).map((t) => t.id)).toContain(task.id)
  })

  test('可选字段：description / dependsOnTaskIds / sourceMessageId / runId 存储 + 去重', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkRoomWithCoordinator(svc, '可选字段')

    const task = svc.createRoomTask({
      roomId: room.id,
      title: '带依赖',
      description: '   ',
      dependsOnTaskIds: ['crt_a', 'crt_a', ' crt_b ', ''],
      sourceMessageId: 'msg_x',
      runId: 'run_y',
    })
    expect(task.description).toBeUndefined()
    expect(task.dependsOnTaskIds).toEqual(['crt_a', 'crt_b'])
    expect(task.sourceMessageId).toBe('msg_x')
    expect(task.runId).toBe('run_y')
  })

  test('房间不存在 → 抛错', () => {
    const svc = CollaborationRoomService.create()
    expect(() => svc.createRoomTask({ roomId: 'cr_no', title: 'x' })).toThrow(/房间不存在/)
  })

  test('标题为空 → 抛错', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkRoomWithCoordinator(svc, '空标题')
    expect(() => svc.createRoomTask({ roomId: room.id, title: '' })).toThrow(/标题不能为空/)
    expect(() => svc.createRoomTask({ roomId: room.id, title: '   ' })).toThrow(/标题不能为空/)
  })

  test('负责人跨房间 → 拒绝；同房间 → 放行', () => {
    const svc = CollaborationRoomService.create()
    const a = mkRoomWithCoordinator(svc, '房间 A')
    const b = mkRoomWithCoordinator(svc, '房间 B')
    const memberB = svc.listMembers(b.room.id)[0]!.id

    // B 的成员不能被指派到 A 的任务
    expect(() =>
      svc.createRoomTask({ roomId: a.room.id, title: '越界指派', assigneeMemberId: memberB }),
    ).toThrow(/负责人不属于该房间/)

    // A 的协调者可以
    const ok = svc.createRoomTask({
      roomId: a.room.id,
      title: '本房间指派',
      assigneeMemberId: a.coordinatorId,
    })
    expect(ok.assigneeMemberId).toBe(a.coordinatorId)
  })

  test('房间已挂载看板 → 拒绝创建（不变量 §15.7：不能形成双真值）', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({ title: '挂板房', attachedBoardId: 'b_board1' })
    expect(room.attachedBoardId).toBe('b_board1')
    expect(() => svc.createRoomTask({ roomId: room.id, title: '不该建' })).toThrow(
      /已挂载看板/,
    )
  })
})

describe('CollaborationRoomService.listRoomTasks / getRoomTaskById', () => {
  test('跨房间隔离：listRoomTasks 只返回本房间任务', () => {
    const svc = CollaborationRoomService.create()
    const a = mkRoomWithCoordinator(svc, '隔离 A')
    const b = mkRoomWithCoordinator(svc, '隔离 B')

    svc.createRoomTask({ roomId: a.room.id, title: 'A1' })
    svc.createRoomTask({ roomId: a.room.id, title: 'A2' })
    svc.createRoomTask({ roomId: b.room.id, title: 'B1' })

    expect(svc.listRoomTasks(a.room.id).map((t) => t.title)).toEqual(['A1', 'A2'])
    expect(svc.listRoomTasks(b.room.id).map((t) => t.title)).toEqual(['B1'])
    expect(svc.listRoomTasks('cr_no_exist')).toEqual([])
  })

  test('getRoomTaskById：存在 / 不存在', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkRoomWithCoordinator(svc, '按 id 查')
    const task = svc.createRoomTask({ roomId: room.id, title: '查我' })
    expect(svc.getRoomTaskById(task.id)?.title).toBe('查我')
    expect(svc.getRoomTaskById('crt_no')).toBeUndefined()
  })
})

describe('CollaborationRoomService.updateRoomTask 状态迁移', () => {
  test('合法迁移放行 + version 自增', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkRoomWithCoordinator(svc, '合法迁移')
    const task = svc.createRoomTask({ roomId: room.id, title: '走全流程' })

    const r1 = svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'in_progress' })
    expect(r1.status).toBe('in_progress')
    expect(r1.version).toBe(2)

    const r2 = svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'done' })
    expect(r2.status).toBe('done')
    expect(r2.version).toBe(3)

    // reopen：done → in_progress 合法
    const r3 = svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'in_progress' })
    expect(r3.status).toBe('in_progress')
    expect(r3.version).toBe(4)

    // blocked → in_progress 合法
    const r4 = svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'blocked' })
    expect(r4.status).toBe('blocked')
    const r5 = svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'in_progress' })
    expect(r5.status).toBe('in_progress')

    // failed → retry：in_progress → failed → in_progress
    const r6 = svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'failed' })
    expect(r6.status).toBe('failed')
    const r7 = svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'in_progress' })
    expect(r7.status).toBe('in_progress')
  })

  test('非法迁移拒绝：状态与 version 都不变（未落盘）', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkRoomWithCoordinator(svc, '非法迁移')
    const task = svc.createRoomTask({ roomId: room.id, title: '不能跳级' })

    // todo → done 非法（必须经 in_progress）
    expect(() =>
      svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'done' }),
    ).toThrow(/非法状态迁移/)

    // 未变更：状态仍 todo、version 仍 1
    const after = svc.getRoomTaskById(task.id)
    expect(after?.status).toBe('todo')
    expect(after?.version).toBe(1)
  })

  test('不传 status：仅改字段，不改状态、version 仍自增', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkRoomWithCoordinator(svc, '改字段')
    const task = svc.createRoomTask({ roomId: room.id, title: '原标题' })

    const r = svc.updateRoomTask({ roomId: room.id, taskId: task.id, title: '新标题' })
    expect(r.title).toBe('新标题')
    expect(r.status).toBe('todo')
    expect(r.version).toBe(2)
  })

  test('传等于当前 status：视为不改状态（不触发迁移校验），version 仍自增', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkRoomWithCoordinator(svc, '同态更新')
    const task = svc.createRoomTask({ roomId: room.id, title: '同态' })
    const r = svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'todo' })
    expect(r.status).toBe('todo')
    expect(r.version).toBe(2)
  })
})

describe('CollaborationRoomService.updateRoomTask 守卫', () => {
  test('跨房间：任务属于 A，用 B 的 roomId 更新 → 拒绝', () => {
    const svc = CollaborationRoomService.create()
    const a = mkRoomWithCoordinator(svc, '跨房间 A')
    const b = mkRoomWithCoordinator(svc, '跨房间 B')
    const task = svc.createRoomTask({ roomId: a.room.id, title: 'A 的任务' })

    expect(() =>
      svc.updateRoomTask({ roomId: b.room.id, taskId: task.id, status: 'in_progress' }),
    ).toThrow(/任务不属于该房间/)
    // 未被改
    expect(svc.getRoomTaskById(task.id)?.status).toBe('todo')
  })

  test('跨成员：改指派为别房间成员 → 拒绝', () => {
    const svc = CollaborationRoomService.create()
    const a = mkRoomWithCoordinator(svc, '跨成员 A')
    const b = mkRoomWithCoordinator(svc, '跨成员 B')
    const memberB = svc.listMembers(b.room.id)[0]!.id
    const task = svc.createRoomTask({ roomId: a.room.id, title: '指派' })

    expect(() =>
      svc.updateRoomTask({ roomId: a.room.id, taskId: task.id, assigneeMemberId: memberB }),
    ).toThrow(/负责人不属于该房间/)

    // 同房间成员可指派
    const ok = svc.updateRoomTask({
      roomId: a.room.id,
      taskId: task.id,
      assigneeMemberId: a.coordinatorId,
    })
    expect(ok.assigneeMemberId).toBe(a.coordinatorId)

    // 空字符串解除指派
    const cleared = svc.updateRoomTask({
      roomId: a.room.id,
      taskId: task.id,
      assigneeMemberId: '',
    })
    expect(cleared.assigneeMemberId).toBeUndefined()
  })

  test('挂载看板后：create/update 拒绝，list/get 仍开放（历史追溯）', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkRoomWithCoordinator(svc, '后挂看板')
    const task = svc.createRoomTask({ roomId: room.id, title: '挂板前建的' })

    // 模拟看板桥后续挂载：直接翻房间的 attachedBoardId
    upsertRoom({ ...getRoom(room.id)!, attachedBoardId: 'b_late' })

    // update 被拒
    expect(() =>
      svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'in_progress' }),
    ).toThrow(/已挂载看板/)
    // create 也被拒
    expect(() => svc.createRoomTask({ roomId: room.id, title: '挂板后建' })).toThrow(
      /已挂载看板/,
    )

    // list / get 仍可读（历史追溯不丢失）
    expect(svc.listRoomTasks(room.id).map((t) => t.id)).toContain(task.id)
    expect(svc.getRoomTaskById(task.id)?.title).toBe('挂板前建的')
  })

  test('expectedVersion CAS：过期拒绝 / 匹配放行 / 不传跳过', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkRoomWithCoordinator(svc, 'CAS')
    const task = svc.createRoomTask({ roomId: room.id, title: '乐观锁' })
    expect(task.version).toBe(1)

    // 过期版本（传 0，实际 1）→ 拒绝
    expect(() =>
      svc.updateRoomTask({
        roomId: room.id,
        taskId: task.id,
        status: 'in_progress',
        expectedVersion: 0,
      }),
    ).toThrow(/版本已过期/)

    // 匹配版本（传 1）→ 放行，version → 2
    const r1 = svc.updateRoomTask({
      roomId: room.id,
      taskId: task.id,
      status: 'in_progress',
      expectedVersion: 1,
    })
    expect(r1.version).toBe(2)

    // 再次用过期版本（仍传 1）→ 拒绝
    expect(() =>
      svc.updateRoomTask({
        roomId: room.id,
        taskId: task.id,
        status: 'done',
        expectedVersion: 1,
      }),
    ).toThrow(/版本已过期/)

    // 不传 expectedVersion → 跳过 CAS，正常放行
    const r2 = svc.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'done' })
    expect(r2.status).toBe('done')
    expect(r2.version).toBe(3)
  })

  test('任务不存在 → 抛错', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkRoomWithCoordinator(svc, '不存在的任务')
    expect(() =>
      svc.updateRoomTask({ roomId: room.id, taskId: 'crt_no', status: 'in_progress' }),
    ).toThrow(/任务不存在/)
  })
})

describe('CollaborationRoomService room task 重启读取', () => {
  test('新 service 实例读到已落盘 task（version / status / 字段保留）', () => {
    // 第一阶段：写入
    const svc1 = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc1, '重启验证')
    const task = svc1.createRoomTask({
      roomId: room.id,
      title: '落盘任务',
      description: '关掉再开还在',
      assigneeMemberId: coordinatorId,
      acceptanceCriteria: '能读回',
    })
    const updated = svc1.updateRoomTask({
      roomId: room.id,
      taskId: task.id,
      status: 'in_progress',
    })
    expect(updated.status).toBe('in_progress')
    expect(updated.version).toBe(2)

    // 第二阶段：模拟重启 —— 新 service 实例（无内存状态，纯读盘）
    const svc2 = CollaborationRoomService.create()
    const loaded = svc2.getRoomTaskById(task.id) as CollaborationRoomTask
    expect(loaded).toBeDefined()
    expect(loaded.id).toBe(task.id)
    expect(loaded.roomId).toBe(room.id)
    expect(loaded.title).toBe('落盘任务')
    expect(loaded.description).toBe('关掉再开还在')
    expect(loaded.assigneeMemberId).toBe(coordinatorId)
    expect(loaded.acceptanceCriteria).toBe('能读回')
    // 状态机 + version 跨实例保留
    expect(loaded.status).toBe('in_progress')
    expect(loaded.version).toBe(2)

    // list 也跨实例可用
    expect(svc2.listRoomTasks(room.id).map((t) => t.id)).toContain(task.id)

    // 新实例可继续合法迁移（version → 3）
    const r = svc2.updateRoomTask({ roomId: room.id, taskId: task.id, status: 'done' })
    expect(r.status).toBe('done')
    expect(r.version).toBe(3)
  })
})

// ===== room_task_update（S5 第二刀：受控模型工具）=====

/**
 * 给某成员造一个 running run（直接落盘，不经调度器），返回 runId。
 * runId/triggerMessageId 由 (roomId, memberId) 派生，保证同房间不同成员的 run 互不覆盖、跨测试唯一。
 */
function mkRunningRun(roomId: string, memberId: string): string {
  const runId = `run_${roomId}_${memberId}`
  const run: CollaborationRun = {
    id: runId,
    roomId,
    memberId,
    triggerMessageId: `msg_${roomId}_${memberId}`,
    idempotencyKey: `msg_${roomId}_${memberId}:${memberId}`,
    status: 'running',
    attempt: 0,
  }
  upsertRun(run)
  return runId
}

describe('CollaborationRoomService.roomTaskUpdate（受控 room_task_update 工具）', () => {
  test('授权：负责人更新自己任务 + 合法迁移 → ok，version 自增 + task_event 落盘', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '授权-ok')
    const task = svc.createRoomTask({
      roomId: room.id,
      title: '搭骨架',
      assigneeMemberId: coordinatorId,
    })
    const runId = mkRunningRun(room.id, coordinatorId)

    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'in_progress',
      summary: '已开工',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.taskId).toBe(task.id)
    expect(res.status).toBe('in_progress')
    expect(res.version).toBe(2)

    // 落盘：状态/version 更新
    const after = svc.getRoomTaskById(task.id)
    expect(after?.status).toBe('in_progress')
    expect(after?.version).toBe(2)
    // 权威字段未被 summary 改写（summary 没漏进 description/acceptanceCriteria/assignee）
    expect(after?.title).toBe('搭骨架')
    expect(after?.description).toBeUndefined()
    expect(after?.acceptanceCriteria).toBeUndefined()
    expect(after?.assigneeMemberId).toBe(coordinatorId)

    // task_event 消息落盘（可审计；含状态迁移 + 说明）
    const events = svc.listMessages(room.id).filter((m) => m.kind === 'task_event')
    expect(events).toHaveLength(1)
    expect(events[0]!.taskId).toBe(task.id)
    expect(events[0]!.authorId).toBe(coordinatorId)
    expect(events[0]!.authorType).toBe('member')
    // 记录了标题 + 旧状态 + 新状态 + summary（证明状态迁移被审计、summary 未丢）
    expect(events[0]!.content).toContain('搭骨架')
    expect(events[0]!.content).toContain('todo')
    expect(events[0]!.content).toContain('in_progress')
    expect(events[0]!.content).toContain('已开工')
  })

  test('授权：无 summary 也能更新，task_event 仍记录状态迁移（不含「说明：」）', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '授权无说明')
    const task = svc.createRoomTask({
      roomId: room.id,
      title: '无说明',
      assigneeMemberId: coordinatorId,
    })
    const runId = mkRunningRun(room.id, coordinatorId)

    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'in_progress',
    })
    expect(res.ok).toBe(true)

    const ev = svc.listMessages(room.id).filter((m) => m.kind === 'task_event')[0]!
    expect(ev.content).toContain('todo')
    expect(ev.content).toContain('in_progress')
    expect(ev.content).not.toContain('说明：')
  })

  test('summary 仅空白 → 视为无说明，task_event 不含「说明：」', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '空白说明')
    const task = svc.createRoomTask({ roomId: room.id, title: '空白', assigneeMemberId: coordinatorId })
    const runId = mkRunningRun(room.id, coordinatorId)

    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'in_progress',
      summary: '   ',
    })
    expect(res.ok).toBe(true)
    const ev = svc.listMessages(room.id).filter((m) => m.kind === 'task_event')[0]!
    expect(ev.content).not.toContain('说明：')
  })

  test('拒绝：未指派任务 → 任何成员都改不了（未指派 = 无负责人）', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '未指派')
    const task = svc.createRoomTask({ roomId: room.id, title: '没人领' })
    expect(task.assigneeMemberId).toBeUndefined()
    const runId = mkRunningRun(room.id, coordinatorId)

    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'in_progress',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/未指派/)
    // 状态未变 + 无 task_event
    expect(svc.getRoomTaskById(task.id)?.status).toBe('todo')
    expect(svc.listMessages(room.id).filter((m) => m.kind === 'task_event')).toHaveLength(0)
  })

  test('拒绝：别人的任务 → 非负责人改不了；负责人自己可改', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({
      title: '别人的任务',
      members: [
        { displayName: '协调者', isCoordinator: true },
        { displayName: '开发' },
      ],
    })
    const members = svc.listMembers(room.id)
    const coord = members.find((m) => m.isCoordinator)!
    const dev = members.find((m) => !m.isCoordinator)!
    const task = svc.createRoomTask({ roomId: room.id, title: '开发的活', assigneeMemberId: dev.id })

    // 协调者尝试改开发的任务 → 拒绝
    const coordRun = mkRunningRun(room.id, coord.id)
    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: coordRun,
      taskId: task.id,
      status: 'in_progress',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/不是该任务的负责人/)
    expect(svc.getRoomTaskById(task.id)?.status).toBe('todo')

    // 开发自己改 → ok
    const devRun = mkRunningRun(room.id, dev.id)
    const ok = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: devRun,
      taskId: task.id,
      status: 'in_progress',
    })
    expect(ok.ok).toBe(true)
  })

  test('拒绝：跨房间 —— 即便知道别房间 taskId 也碰不到（roomId 取自 run 上下文）', () => {
    const svc = CollaborationRoomService.create()
    const a = mkRoomWithCoordinator(svc, '跨房间源')
    const b = mkRoomWithCoordinator(svc, '跨房间目标')
    const taskA = svc.createRoomTask({
      roomId: a.room.id,
      title: 'A 的任务',
      assigneeMemberId: a.coordinatorId,
    })
    // B 的协调者 run
    const runB = mkRunningRun(b.room.id, b.coordinatorId)

    const res = svc.roomTaskUpdate({
      roomId: b.room.id,
      fromRunId: runB,
      taskId: taskA.id,
      status: 'in_progress',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/不属于该房间/)
    // A 的任务未被碰
    expect(svc.getRoomTaskById(taskA.id)?.status).toBe('todo')
  })

  test('拒绝：非法状态迁移（todo → done 必须经 in_progress）', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '非法迁移工具')
    const task = svc.createRoomTask({
      roomId: room.id,
      title: '不能跳级',
      assigneeMemberId: coordinatorId,
    })
    const runId = mkRunningRun(room.id, coordinatorId)

    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'done',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/非法状态迁移/)
    expect(svc.getRoomTaskById(task.id)?.status).toBe('todo')
    expect(svc.getRoomTaskById(task.id)?.version).toBe(1)
  })

  test('拒绝：自环（传等于当前 status）→ 状态机拒绝', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '自环工具')
    const task = svc.createRoomTask({ roomId: room.id, title: '同态', assigneeMemberId: coordinatorId })
    const runId = mkRunningRun(room.id, coordinatorId)

    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'todo',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/状态未变化/)
  })

  test('拒绝：非法 status 枚举值（如 cancelled/running 等旧占位）', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '非法枚举')
    const task = svc.createRoomTask({ roomId: room.id, title: '枚举', assigneeMemberId: coordinatorId })
    const runId = mkRunningRun(room.id, coordinatorId)

    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'cancelled',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/非法任务状态/)
  })

  test('拒绝：挂载看板后 → 任务真值归看板，工具不能改（不变量 §15.7）', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '挂板工具')
    const task = svc.createRoomTask({
      roomId: room.id,
      title: '挂板前',
      assigneeMemberId: coordinatorId,
    })
    // 模拟后续挂板
    upsertRoom({ ...getRoom(room.id)!, attachedBoardId: 'b_late' })
    const runId = mkRunningRun(room.id, coordinatorId)

    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'in_progress',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/已挂载看板/)
    expect(svc.getRoomTaskById(task.id)?.status).toBe('todo')
  })

  test('拒绝：summary 超长 → fail-closed（防借超长说明注入指令/刷屏）', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '超长说明')
    const task = svc.createRoomTask({ roomId: room.id, title: 'x', assigneeMemberId: coordinatorId })
    const runId = mkRunningRun(room.id, coordinatorId)

    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'in_progress',
      summary: 'x'.repeat(COLLABORATION_ROOM_TASK_SUMMARY_MAX_LENGTH + 1),
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/说明过长/)
    expect(svc.getRoomTaskById(task.id)?.status).toBe('todo')
  })

  test('拒绝：任务不存在', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '不存在工具')
    const runId = mkRunningRun(room.id, coordinatorId)
    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: 'crt_no',
      status: 'in_progress',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/任务不存在/)
  })

  test('拒绝：run 不存在', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, 'run 不存在')
    const task = svc.createRoomTask({ roomId: room.id, title: 'x', assigneeMemberId: coordinatorId })
    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: 'run_no',
      taskId: task.id,
      status: 'in_progress',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/run 不存在/)
  })

  test('拒绝：run 非 running/awaiting_peer（如 done）', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, 'run 态')
    const task = svc.createRoomTask({ roomId: room.id, title: 'x', assigneeMemberId: coordinatorId })
    const runId = mkRunningRun(room.id, coordinatorId)
    // 改成 done 后再调用
    const existing = svc.getRunById(runId)!
    upsertRun({ ...existing, status: 'done' })

    const res = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'in_progress',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/非 running\/awaiting_peer/)
  })

  test('成功后可继续合法迁移：in_progress → done（version 持续自增）', () => {
    const svc = CollaborationRoomService.create()
    const { room, coordinatorId } = mkRoomWithCoordinator(svc, '多步迁移')
    const task = svc.createRoomTask({ roomId: room.id, title: '走两步', assigneeMemberId: coordinatorId })
    const runId = mkRunningRun(room.id, coordinatorId)

    const r1 = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'in_progress',
    })
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.version).toBe(2)

    const r2 = svc.roomTaskUpdate({
      roomId: room.id,
      fromRunId: runId,
      taskId: task.id,
      status: 'done',
      summary: '完成',
    })
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.status).toBe('done')
    expect(r2.version).toBe(3)
    // 两条 task_event（todo→in_progress、in_progress→done）
    expect(svc.listMessages(room.id).filter((m) => m.kind === 'task_event')).toHaveLength(2)
  })
})

describe('CollaborationRoomService.roomTaskAssign（受控 room_task_assign 工具）', () => {
  test('协调者分派未指派任务后，目标成员自动获得 run', async () => {
    const { adapter, calls } = mkTaskTriggerAdapter()
    const svc = CollaborationRoomService.create({ adapter })
    const room = svc.createRoom({
      title: '协调分派',
      members: [{ displayName: '协调者', isCoordinator: true }, { displayName: '开发' }],
    })
    const members = svc.listMembers(room.id)
    const coordinator = members.find((member) => member.isCoordinator)!
    const developer = members.find((member) => !member.isCoordinator)!
    const task = svc.createRoomTask({ roomId: room.id, title: '待分派' })
    await svc.awaitAllRuns()

    const coordinatorRunId = mkRunningRun(room.id, coordinator.id)
    const result = svc.roomTaskAssign({
      roomId: room.id,
      fromRunId: coordinatorRunId,
      taskId: task.id,
      assigneeMemberId: developer.id,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.assigneeMemberId).toBe(developer.id)
    expect(result.runId).toBeDefined()

    await svc.awaitAllRuns()
    expect(svc.getRoomTaskById(task.id)?.assigneeMemberId).toBe(developer.id)
    expect(svc.getRoomTaskById(task.id)?.version).toBe(2)
    expect(svc.listRuns(room.id).find((run) => run.id === result.runId)?.memberId).toBe(developer.id)
    expect(svc.listRuns(room.id).find((run) => run.id === result.runId)?.status).toBe('done')
    expect(calls.some((call) => call.memberId === developer.id && call.prompt.includes('待分派'))).toBe(
      true,
    )

    const assignment = svc
      .listMessages(room.id)
      .find((message) => message.kind === 'task_event' && message.taskId === task.id)!
    expect(assignment.authorId).toBe(coordinator.id)
    expect(assignment.targetMemberIds).toEqual([developer.id])
  })

  test('非协调者、跨房间成员和已有负责人均拒绝分派', async () => {
    const { adapter } = mkTaskTriggerAdapter()
    const svc = CollaborationRoomService.create({ adapter })
    const room = svc.createRoom({
      title: '分派权限',
      members: [{ displayName: '协调者', isCoordinator: true }, { displayName: '开发' }],
    })
    const otherRoom = svc.createRoom({ title: '另一个房间', members: [{ displayName: '外部' }] })
    const members = svc.listMembers(room.id)
    const coordinator = members.find((member) => member.isCoordinator)!
    const developer = members.find((member) => !member.isCoordinator)!
    const outsider = svc.listMembers(otherRoom.id)[0]!
    const task = svc.createRoomTask({ roomId: room.id, title: '待分派' })
    await svc.awaitAllRuns()

    const developerRun: CollaborationRun = {
      id: `run_${room.id}_${developer.id}`,
      roomId: room.id,
      memberId: developer.id,
      triggerMessageId: `msg_${room.id}_${developer.id}`,
      idempotencyKey: `msg_${room.id}_${developer.id}:${developer.id}`,
      status: 'running',
      attempt: 0,
    }
    upsertRun(developerRun)
    const notCoordinator = svc.roomTaskAssign({
      roomId: room.id,
      fromRunId: developerRun.id,
      taskId: task.id,
      assigneeMemberId: coordinator.id,
    })
    expect(notCoordinator).toEqual({ ok: false, reason: '只有协调者可以分派任务' })

    const coordinatorRun = mkRunningRun(room.id, coordinator.id)
    const crossRoom = svc.roomTaskAssign({
      roomId: room.id,
      fromRunId: coordinatorRun,
      taskId: task.id,
      assigneeMemberId: outsider.id,
    })
    expect(crossRoom).toEqual({ ok: false, reason: '负责人不属于该房间' })

    const assigned = svc.createRoomTask({
      roomId: room.id,
      title: '已有负责人',
      assigneeMemberId: developer.id,
    })
    const alreadyAssigned = svc.roomTaskAssign({
      roomId: room.id,
      fromRunId: coordinatorRun,
      taskId: assigned.id,
      assigneeMemberId: coordinator.id,
    })
    expect(alreadyAssigned).toEqual({
      ok: false,
      reason: '任务已有负责人，不能通过工具覆盖（请由用户/面板重新指派）',
    })
  })
})
