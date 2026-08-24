/**
 * 房间运行调度器（Stage 3）
 *
 * 房间级 maxConcurrentRuns + 成员内串行（同成员同时至多 1 个 running）+ FIFO 公平队列。
 * 仅内存调度（不落盘）；run.status=queued/running 的持久化由 service 负责。
 *
 * - enqueue：service 已落盘 run.status=queued 后入队；drain 立即尝试启动可启动者。
 * - release：executeRun 终态（done/failed/cancelled）后在 finally 调用，释放 slot 并 drain。
 * - dequeue：cancelRun 在 run 仍排队（未占 slot）时移除，避免无谓 start。
 *
 * 重启恢复：scheduler 本身仍是单实例内存态，重启即空；service 只对尚未启动且满足安全条件的 queued run 重新入队，running/awaiting_peer 不自动重放。
 *
 * 设计参考：03-IMPLEMENTATION-PHASES §5「RoomScheduler：房间总并发、成员内串行、公平队列」、
 * 02-RUNTIME-A2A-SPEC §9（并发上限）。
 */
import type {
  CollaborationMember,
  CollaborationMessage,
  CollaborationRoom,
  CollaborationRun,
} from '@tagent/shared'

/** 调度器条目：start 回调启动一个 run 所需的全部上下文（service.executeRun 入参） */
export interface RoomSchedulerEntry {
  runId: string
  roomId: string
  memberId: string
  /** 启动 run 用的上下文；调度器只透传不解读 */
  room: CollaborationRoom
  member: CollaborationMember
  run: CollaborationRun
  triggerMessage: CollaborationMessage
}

export interface RoomSchedulerOptions {
  /** 读取房间并发上限（service 传入，读 room.maxConcurrentRuns；至少 1） */
  getMaxConcurrentRuns: (roomId: string) => number
  /** 房间是否允许启动新的 run；暂停只阻止排队任务，不影响已占用 slot 的 run */
  isRoomRunnable?: (roomId: string) => boolean
  /** 容量允许时启动一个 run（service.executeRun + inflight.set；abort 由 executeRun 自管） */
  start: (entry: RoomSchedulerEntry) => void
}

export class RoomScheduler {
  /** roomId → 正在 running 的 runId 集合（房间级并发计数） */
  private readonly runningByRoom = new Map<string, Set<string>>()
  /** memberId → 正在 running 的 runId（成员内串行：每成员至多 1） */
  private readonly runningByMember = new Map<string, string>()
  /** 排队条目（跨房间 FIFO；按入队顺序启动，同成员不插队） */
  private readonly queue: RoomSchedulerEntry[] = []
  private readonly opts: RoomSchedulerOptions

  constructor(opts: RoomSchedulerOptions) {
    this.opts = opts
  }

  /** 入队一个 run（service 已落盘 queued）。立即 drain 尝试启动；否则排队等容量。 */
  enqueue(entry: RoomSchedulerEntry): void {
    this.queue.push(entry)
    this.drain()
  }

  /** 房间恢复或并发上限变化后唤醒队列。 */
  wake(): void {
    this.drain()
  }

  /**
   * 通知某 run 已终态（done/failed/cancelled）；释放其 slot 并 drain 启动后续。
   * 由 executeRun 的 finally 调用（即便 CAS 失败也调，避免 slot 泄漏）。
   */
  release(runId: string, roomId: string, memberId: string): void {
    const roomSet = this.runningByRoom.get(roomId)
    if (roomSet) {
      roomSet.delete(runId)
      if (roomSet.size === 0) this.runningByRoom.delete(roomId)
    }
    const cur = this.runningByMember.get(memberId)
    if (cur === runId) this.runningByMember.delete(memberId)
    this.drain()
  }

  /**
   * 从队列移除一个尚未启动的 run（cancelRun 在 run 仍排队时调用）。
   * 返回是否在队列中：true=尚未占 slot（无需 release）；false=已 running（走 abort + executeRun finally release）。
   */
  dequeue(runId: string): boolean {
    const idx = this.queue.findIndex((e) => e.runId === runId)
    if (idx === -1) return false
    this.queue.splice(idx, 1)
    return true
  }

  /** 调度器是否空闲（无排队、无 running）；service.awaitAllRuns 用 */
  isIdle(): boolean {
    return this.queue.length === 0 && this.runningByRoom.size === 0
  }

  /** 某成员是否正在 running（成员状态同步用） */
  isMemberRunning(memberId: string): boolean {
    return this.runningByMember.has(memberId)
  }

  /** 某成员是否有排队中的 run（终态后置 queued 而非 idle 用） */
  hasQueuedForMember(memberId: string): boolean {
    return this.queue.some((e) => e.memberId === memberId)
  }

  /** 当前全局 running 数（测试 / UI 用） */
  get runningCount(): number {
    let n = 0
    for (const set of this.runningByRoom.values()) n += set.size
    return n
  }

  /** 当前排队数（测试 / UI 用） */
  get queuedCount(): number {
    return this.queue.length
  }

  /** 某房间当前 running 数（测试 / UI 用） */
  runningCountForRoom(roomId: string): number {
    return this.runningByRoom.get(roomId)?.size ?? 0
  }

  /** 尝按 FIFO 顺序启动可启动的 queued run（房间容量未满 + 成员空闲） */
  private drain(): void {
    // 正向扫描：启动一个 run 只消耗容量、从不释放，故已跳过的较早条目不会因后续启动而变得可启动。
    for (let i = 0; i < this.queue.length; ) {
      const entry = this.queue[i]!
      if (!this.canStart(entry)) {
        i++
        continue
      }
      this.queue.splice(i, 1) // splice 后 i 处滑入新元素，i 不递增继续检查
      this.markRunning(entry)
      this.opts.start(entry)
    }
  }

  private canStart(entry: RoomSchedulerEntry): boolean {
    if (this.opts.isRoomRunnable && !this.opts.isRoomRunnable(entry.roomId)) {
      return false
    }
    const max = Math.max(1, this.opts.getMaxConcurrentRuns(entry.roomId))
    const roomRunning = this.runningByRoom.get(entry.roomId)?.size ?? 0
    if (roomRunning >= max) return false
    if (this.runningByMember.has(entry.memberId)) return false
    return true
  }

  private markRunning(entry: RoomSchedulerEntry): void {
    let set = this.runningByRoom.get(entry.roomId)
    if (!set) {
      set = new Set()
      this.runningByRoom.set(entry.roomId, set)
    }
    set.add(entry.runId)
    this.runningByMember.set(entry.memberId, entry.runId)
  }
}
