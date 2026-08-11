/**
 * RoomScheduler 单元测试（Stage 3）
 *
 * 隔离测试调度器本身：注入 mock start（记录被启动的 runId）+ mock getMaxConcurrentRuns，
 * 验证房间并发上限、成员内串行、FIFO 公平、dequeue、跨房间独立、isIdle/hasQueuedForMember。
 * 不触达 DB / adapter（service 集成测试见 collaboration-room-multi.test.ts）。
 */
import { describe, expect, test } from 'vitest'
import { RoomScheduler, type RoomSchedulerEntry } from './collaboration-room-scheduler'
import type {
  CollaborationMember,
  CollaborationMessage,
  CollaborationRoom,
  CollaborationRun,
} from '@tagent/shared'

/** 构造最小调度条目（调度器只读 runId/roomId/memberId；payload 透传给 mock start） */
function mkEntry(runId: string, roomId: string, memberId: string): RoomSchedulerEntry {
  return {
    runId,
    roomId,
    memberId,
    room: { id: roomId } as CollaborationRoom,
    member: { id: memberId } as CollaborationMember,
    run: { id: runId, roomId, memberId } as CollaborationRun,
    triggerMessage: { id: 'msg_' + runId } as CollaborationMessage,
  }
}

function createScheduler(max: number): {
  scheduler: RoomScheduler
  started: string[]
  setMax: (m: number) => void
} {
  let currentMax = max
  const started: string[] = []
  const scheduler = new RoomScheduler({
    getMaxConcurrentRuns: () => currentMax,
    start: (entry) => started.push(entry.runId),
  })
  return { scheduler, started, setMax: (m) => (currentMax = m) }
}

describe('RoomScheduler 房间并发上限', () => {
  test('max=2：3 个不同成员的 run → 启动 2、排队 1；释放后第 3 启动', () => {
    const { scheduler, started } = createScheduler(2)
    const e1 = mkEntry('run_1', 'cr_a', 'cm_a')
    const e2 = mkEntry('run_2', 'cr_a', 'cm_b')
    const e3 = mkEntry('run_3', 'cr_a', 'cm_c')

    scheduler.enqueue(e1)
    scheduler.enqueue(e2)
    scheduler.enqueue(e3)

    expect(started).toEqual(['run_1', 'run_2'])
    expect(scheduler.queuedCount).toBe(1)
    expect(scheduler.runningCount).toBe(2)
    expect(scheduler.runningCountForRoom('cr_a')).toBe(2)

    // 释放 run_1 → drain 启动 run_3
    scheduler.release('run_1', 'cr_a', 'cm_a')
    expect(started).toEqual(['run_1', 'run_2', 'run_3'])
    expect(scheduler.queuedCount).toBe(0)
    expect(scheduler.runningCount).toBe(2) // run_2 + run_3

    scheduler.release('run_2', 'cr_a', 'cm_b')
    scheduler.release('run_3', 'cr_a', 'cm_c')
    expect(scheduler.isIdle()).toBe(true)
  })

  test('max=1：同时只 1 个 running', () => {
    const { scheduler, started } = createScheduler(1)
    scheduler.enqueue(mkEntry('r1', 'cr_a', 'cm_a'))
    scheduler.enqueue(mkEntry('r2', 'cr_a', 'cm_b'))
    scheduler.enqueue(mkEntry('r3', 'cr_a', 'cm_c'))

    expect(started).toEqual(['r1'])
    expect(scheduler.queuedCount).toBe(2)

    scheduler.release('r1', 'cr_a', 'cm_a')
    expect(started).toEqual(['r1', 'r2'])
    scheduler.release('r2', 'cr_a', 'cm_b')
    expect(started).toEqual(['r1', 'r2', 'r3'])
    scheduler.release('r3', 'cr_a', 'cm_c')
    expect(scheduler.isIdle()).toBe(true)
  })
})

describe('RoomScheduler 成员内串行', () => {
  test('同成员 2 个 run：仅 1 running，另 1 排队（即便房间容量充足）', () => {
    const { scheduler, started } = createScheduler(3)
    scheduler.enqueue(mkEntry('r1', 'cr_a', 'cm_x'))
    scheduler.enqueue(mkEntry('r2', 'cr_a', 'cm_x')) // 同成员

    expect(started).toEqual(['r1'])
    expect(scheduler.queuedCount).toBe(1)
    expect(scheduler.isMemberRunning('cm_x')).toBe(true)
    expect(scheduler.hasQueuedForMember('cm_x')).toBe(true)

    // r1 完成 → r2 启动（同成员串行：r2 等 r1 释放后才跑）
    scheduler.release('r1', 'cr_a', 'cm_x')
    expect(started).toEqual(['r1', 'r2'])
    expect(scheduler.queuedCount).toBe(0)

    scheduler.release('r2', 'cr_a', 'cm_x')
    expect(scheduler.isIdle()).toBe(true)
  })

  test('max=1 同成员 3 个 run：严格串行，一次一个', () => {
    const { scheduler, started } = createScheduler(1)
    scheduler.enqueue(mkEntry('r1', 'cr_a', 'cm_x'))
    scheduler.enqueue(mkEntry('r2', 'cr_a', 'cm_x'))
    scheduler.enqueue(mkEntry('r3', 'cr_a', 'cm_x'))

    expect(started).toEqual(['r1'])
    scheduler.release('r1', 'cr_a', 'cm_x')
    expect(started).toEqual(['r1', 'r2'])
    scheduler.release('r2', 'cr_a', 'cm_x')
    expect(started).toEqual(['r1', 'r2', 'r3'])
    scheduler.release('r3', 'cr_a', 'cm_x')
    expect(scheduler.isIdle()).toBe(true)
  })
})

describe('RoomScheduler FIFO 公平', () => {
  test('被成员阻塞的早条目不会插队越过可启动的晚条目，但成员空闲后按入队顺序启动', () => {
    // cap=2；r1(cm_x) 启动；r2(cm_x) 被同成员阻塞；r3(cm_y) 可启动
    const { scheduler, started } = createScheduler(2)
    scheduler.enqueue(mkEntry('r1', 'cr_a', 'cm_x'))
    scheduler.enqueue(mkEntry('r2', 'cr_a', 'cm_x'))
    scheduler.enqueue(mkEntry('r3', 'cr_a', 'cm_y'))

    expect(started).toEqual(['r1', 'r3']) // r2 被 cm_x 串行阻塞，r3 抢占容量
    expect(scheduler.queuedCount).toBe(1)

    // r1 完成 → r2 启动（cm_x 空闲）
    scheduler.release('r1', 'cr_a', 'cm_x')
    expect(started).toEqual(['r1', 'r3', 'r2'])
    scheduler.release('r3', 'cr_a', 'cm_y')
    scheduler.release('r2', 'cr_a', 'cm_x')
    expect(scheduler.isIdle()).toBe(true)
  })
})

describe('RoomScheduler dequeue（排队中取消）', () => {
  test('dequeue 移除未启动的 run，无需 release', () => {
    const { scheduler, started } = createScheduler(1)
    scheduler.enqueue(mkEntry('r1', 'cr_a', 'cm_a'))
    scheduler.enqueue(mkEntry('r2', 'cr_a', 'cm_b')) // 排队

    expect(started).toEqual(['r1'])
    expect(scheduler.queuedCount).toBe(1)

    expect(scheduler.dequeue('r2')).toBe(true)
    expect(scheduler.queuedCount).toBe(0)
    expect(scheduler.hasQueuedForMember('cm_b')).toBe(false)

    // r1 完成后不会启动 r2（已 dequeue）
    scheduler.release('r1', 'cr_a', 'cm_a')
    expect(started).toEqual(['r1'])
    expect(scheduler.isIdle()).toBe(true)
  })

  test('dequeue 已 running 的 run 返回 false（调用方走 abort + release）', () => {
    const { scheduler } = createScheduler(1)
    scheduler.enqueue(mkEntry('r1', 'cr_a', 'cm_a'))
    expect(scheduler.dequeue('r1')).toBe(false) // 已 running
  })
})

describe('RoomScheduler 跨房间独立', () => {
  test('A 房间满载不阻塞 B 房间启动', () => {
    const { scheduler, started } = createScheduler(1)
    scheduler.enqueue(mkEntry('a1', 'cr_a', 'cm_a'))
    scheduler.enqueue(mkEntry('a2', 'cr_a', 'cm_b')) // cr_a 满，排队
    scheduler.enqueue(mkEntry('b1', 'cr_b', 'cm_c')) // 另一房间，独立容量

    expect(started).toEqual(['a1', 'b1'])
    expect(scheduler.runningCountForRoom('cr_a')).toBe(1)
    expect(scheduler.runningCountForRoom('cr_b')).toBe(1)
    expect(scheduler.queuedCount).toBe(1)

    scheduler.release('a1', 'cr_a', 'cm_a')
    expect(started).toEqual(['a1', 'b1', 'a2'])
    scheduler.release('b1', 'cr_b', 'cm_c')
    scheduler.release('a2', 'cr_a', 'cm_b')
    expect(scheduler.isIdle()).toBe(true)
  })
})

describe('RoomScheduler 边界', () => {
  test('max 下限 1：getMaxConcurrentRuns 返回 0 也不会死锁（按 1 处理）', () => {
    const started: string[] = []
    const scheduler = new RoomScheduler({
      getMaxConcurrentRuns: () => 0, // 异常值
      start: (e) => started.push(e.runId),
    })
    scheduler.enqueue(mkEntry('r1', 'cr_a', 'cm_a'))
    expect(started).toEqual(['r1']) // 按 1 处理，不死锁
  })

  test('release 未知 runId 安全（不抛错）', () => {
    const { scheduler } = createScheduler(2)
    expect(() => scheduler.release('nope', 'cr_a', 'cm_a')).not.toThrow()
  })

  test('isIdle 初始为 true', () => {
    const { scheduler } = createScheduler(2)
    expect(scheduler.isIdle()).toBe(true)
  })
})
