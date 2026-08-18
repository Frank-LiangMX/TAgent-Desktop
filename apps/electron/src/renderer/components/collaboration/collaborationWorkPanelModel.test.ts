/**
 * 协作室工作面板纯模型单测（S5 室级任务/产物面板）。
 *
 * 仅测 collaborationWorkPanelModel 的纯函数：分组 / 状态标签 / sha 短码 / 产物计数 /
 * 任务↔产物相互链接 / 合法下一状态。不触 IPC、不读成员、不依赖时间。
 */
import { describe, expect, test } from 'vitest'
import {
  ROOM_TASK_STATUS_ORDER,
  artifactShaShort,
  buildArtifactLinkInfo,
  buildTaskLinkInfo,
  countArtifactsForTask,
  findTaskForArtifact,
  groupRoomTasksByStatus,
  legalNextTaskStatuses,
  roomTaskStatusLabel,
} from './collaborationWorkPanelModel'
import type {
  CollaborationArtifact,
  CollaborationRoomTask,
  CollaborationRoomTaskStatus,
} from '@tagent/shared'

function mkTask(over: Partial<CollaborationRoomTask> = {}): CollaborationRoomTask {
  return {
    id: 'crt_1',
    roomId: 'cr_1',
    title: 'T',
    status: 'todo',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function mkArtifact(over: Partial<CollaborationArtifact> = {}): CollaborationArtifact {
  return {
    id: 'cart_1',
    roomId: 'cr_1',
    memberId: 'cm_1',
    relativePath: 'a/b.txt',
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    byteSize: 3,
    createdAt: 10,
    ...over,
  }
}

describe('roomTaskStatusLabel', () => {
  test('五种状态各有中文标签', () => {
    expect(roomTaskStatusLabel('todo')).toBe('待办')
    expect(roomTaskStatusLabel('in_progress')).toBe('进行中')
    expect(roomTaskStatusLabel('blocked')).toBe('阻塞')
    expect(roomTaskStatusLabel('done')).toBe('已完成')
    expect(roomTaskStatusLabel('failed')).toBe('失败')
  })
})

describe('groupRoomTasksByStatus', () => {
  test('按状态分组并保留组内原序', () => {
    const tasks = [
      mkTask({ id: 'crt_a', status: 'todo', createdAt: 1 }),
      mkTask({ id: 'crt_b', status: 'in_progress', createdAt: 2 }),
      mkTask({ id: 'crt_c', status: 'todo', createdAt: 3 }),
      mkTask({ id: 'crt_d', status: 'failed', createdAt: 4 }),
      mkTask({ id: 'crt_e', status: 'done', createdAt: 5 }),
      mkTask({ id: 'crt_f', status: 'blocked', createdAt: 6 }),
      mkTask({ id: 'crt_g', status: 'in_progress', createdAt: 7 }),
    ]
    const g = groupRoomTasksByStatus(tasks)
    expect(g.todo.map((t) => t.id)).toEqual(['crt_a', 'crt_c'])
    expect(g.in_progress.map((t) => t.id)).toEqual(['crt_b', 'crt_g'])
    expect(g.blocked.map((t) => t.id)).toEqual(['crt_f'])
    expect(g.done.map((t) => t.id)).toEqual(['crt_e'])
    expect(g.failed.map((t) => t.id)).toEqual(['crt_d'])
  })

  test('空输入 → 五组皆空', () => {
    const g = groupRoomTasksByStatus([])
    expect(g.todo).toEqual([])
    expect(g.in_progress).toEqual([])
    expect(g.blocked).toEqual([])
    expect(g.done).toEqual([])
    expect(g.failed).toEqual([])
  })

  test('未知状态兜底归到 todo（防御，不丢项）', () => {
    // @ts-expect-error 故意传入非法状态模拟脏数据
    const g = groupRoomTasksByStatus([mkTask({ id: 'crt_x', status: 'weird' })])
    expect(g.todo.map((t) => t.id)).toEqual(['crt_x'])
  })
})

describe('artifactShaShort', () => {
  test('取前 12 位 hex', () => {
    const sha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    expect(artifactShaShort(sha)).toBe('0123456789ab')
  })
  test('短于 12 位时返回原串', () => {
    expect(artifactShaShort('abc')).toBe('abc')
  })
  test('空串兜底', () => {
    expect(artifactShaShort('')).toBe('')
    expect(artifactShaShort(undefined as unknown as string)).toBe('')
  })
})

describe('countArtifactsForTask / findTaskForArtifact', () => {
  test('按 taskId 计数与查找', () => {
    const tasks = [mkTask({ id: 'crt_1' }), mkTask({ id: 'crt_2' })]
    const artifacts = [
      mkArtifact({ id: 'cart_1', taskId: 'crt_1' }),
      mkArtifact({ id: 'cart_2', taskId: 'crt_1' }),
      mkArtifact({ id: 'cart_3', taskId: 'crt_2' }),
      mkArtifact({ id: 'cart_4' /* 无 taskId */ }),
    ]
    expect(countArtifactsForTask(artifacts, 'crt_1')).toBe(2)
    expect(countArtifactsForTask(artifacts, 'crt_2')).toBe(1)
    expect(countArtifactsForTask(artifacts, 'crt_no')).toBe(0)
    expect(findTaskForArtifact(tasks, artifacts[0]!)?.id).toBe('crt_1')
    expect(findTaskForArtifact(tasks, artifacts[3]!)).toBeUndefined()
  })
})

describe('buildTaskLinkInfo', () => {
  test('携带 runId / sourceMessageId / artifactCount', () => {
    const task = mkTask({ id: 'crt_1', runId: 'run_1', sourceMessageId: 'msg_1' })
    const artifacts = [
      mkArtifact({ id: 'cart_1', taskId: 'crt_1' }),
      mkArtifact({ id: 'cart_2', taskId: 'crt_1' }),
      mkArtifact({ id: 'cart_3', taskId: 'crt_other' }),
    ]
    expect(buildTaskLinkInfo(task, artifacts)).toEqual({
      runId: 'run_1',
      sourceMessageId: 'msg_1',
      artifactCount: 2,
    })
  })
  test('无关联时字段为 undefined / 0', () => {
    const task = mkTask({ id: 'crt_1' })
    expect(buildTaskLinkInfo(task, [])).toEqual({
      runId: undefined,
      sourceMessageId: undefined,
      artifactCount: 0,
    })
  })
})

describe('buildArtifactLinkInfo', () => {
  test('关联任务存在 → 返回 taskId + taskTitle', () => {
    const tasks = [mkTask({ id: 'crt_1', title: '写文档' })]
    const art = mkArtifact({ id: 'cart_1', taskId: 'crt_1', runId: 'run_1' })
    expect(buildArtifactLinkInfo(art, tasks)).toEqual({
      taskId: 'crt_1',
      taskTitle: '写文档',
      runId: 'run_1',
    })
  })
  test('taskId 指向已删除任务 → taskTitle=null（区分「无关联」与「任务已删」）', () => {
    const art = mkArtifact({ id: 'cart_1', taskId: 'crt_gone' })
    expect(buildArtifactLinkInfo(art, [])).toEqual({
      taskId: 'crt_gone',
      taskTitle: null,
      runId: undefined,
    })
  })
  test('无 taskId → taskTitle=null、taskId=undefined', () => {
    const art = mkArtifact({ id: 'cart_1' })
    expect(buildArtifactLinkInfo(art, [])).toEqual({
      taskId: undefined,
      taskTitle: null,
      runId: undefined,
    })
  })
})

describe('legalNextTaskStatuses', () => {
  test('todo 可迁移到 in_progress/blocked/failed（不含自环、不含 done）', () => {
    expect(legalNextTaskStatuses('todo').sort()).toEqual(
      ['blocked', 'failed', 'in_progress'].sort(),
    )
  })
  test('in_progress 可迁移到 blocked/done/failed', () => {
    expect(legalNextTaskStatuses('in_progress').sort()).toEqual(
      ['blocked', 'done', 'failed'].sort(),
    )
  })
  test('done 仅可 reopen 到 todo/in_progress', () => {
    expect(legalNextTaskStatuses('done').sort()).toEqual(['in_progress', 'todo'].sort())
  })
  test('failed 仅可 retry 到 todo/in_progress', () => {
    expect(legalNextTaskStatuses('failed').sort()).toEqual(['in_progress', 'todo'].sort())
  })
  test('blocked 可到 todo/in_progress/failed', () => {
    expect(legalNextTaskStatuses('blocked').sort()).toEqual(
      ['failed', 'in_progress', 'todo'].sort(),
    )
  })
  test('结果顺序遵循 ROOM_TASK_STATUS_ORDER', () => {
    const r = legalNextTaskStatuses('blocked')
    // ROOM_TASK_STATUS_ORDER = todo,in_progress,blocked,done,failed
    // blocked 的合法下一状态按该顺序为 todo,in_progress,failed
    expect(r).toEqual(['todo', 'in_progress', 'failed'])
  })
})

describe('ROOM_TASK_STATUS_ORDER', () => {
  test('五态齐备且顺序固定', () => {
    expect(ROOM_TASK_STATUS_ORDER).toEqual([
      'todo',
      'in_progress',
      'blocked',
      'done',
      'failed',
    ] as readonly CollaborationRoomTaskStatus[])
  })
})
