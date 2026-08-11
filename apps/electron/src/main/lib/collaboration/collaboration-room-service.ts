/**
 * 协作室服务（Stage 3：多成员并行 + 协调者路由）
 *
 * 在 repository 之上做：输入校验、ID 生成、默认值、状态转换、mention 解析、run 触发与调度。
 *
 * Stage 3 新增（在 S2 单成员闭环之上）：
 * - appendUserMessage 落盘用户消息前用 parseCollaborationMentions 把 @displayName 解析为
 *   targetMemberIds（@all → 全部成员；无 @ → []，由 trigger 路由协调者）。
 * - triggerRunForMessage 按解析目标创建多个 run（各幂等键含 memberId+messageId），经
 *   RoomScheduler 启动：房间级 maxConcurrentRuns + 成员内串行 + FIFO 公平队列。
 * - 多目标并行扇出；一方 failed 不取消另一方；结果各自落盘 member 消息。
 * - addMember：向已有房间加成员（displayName + 自动绑默认渠道）。
 *
 * Stage 2 保留：
 * - run 状态机：queued → running → done | failed | cancelled（CAS 转换，race-safe）。
 * - run 完成后落盘成员消息（done）或系统警告（failed），并广播 CHANGED。
 * - cancelRun：排队中→dequeue；running→abort 后端调用；均置 cancelled + 同步成员状态。
 * - recoverInterruptedRuns：启动时把遗留 queued/running run 标为 failed(INTERRUPTED)，
 *   避免重启后「假 running」（02-RUNTIME-A2A-SPEC §14；不自动重放，避免重复副作用）。
 * - 幂等：同一 (triggerMessageId, memberId) 只产生一个 run（collaborationRunIdempotencyKey）。
 *
 * adapter 可注入（测试用 mock；默认 ChannelBackendAdapter 真实调用外部渠道模型）。
 *
 * 设计参考：apps/electron/src/main/lib/ipc/channel-service.ts（class + static create）
 */
import { randomUUID } from 'node:crypto'
import {
  COLLABORATION_LOGICAL_SESSION_ID_PREFIX,
  COLLABORATION_MEMBER_ID_PREFIX,
  COLLABORATION_MESSAGE_ID_PREFIX,
  COLLABORATION_ROOM_DEFAULT_MAX_A2A_DEPTH,
  COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS,
  COLLABORATION_ROOM_ID_PREFIX,
  COLLABORATION_ROOM_MAX_MEMBERS,
  COLLABORATION_RUN_ID_PREFIX,
  collaborationRunIdempotencyKey,
  isCollaborationRoomStatus,
  parseCollaborationMentions,
  validateCreateCollaborationRoomInput,
  type CollaborationMember,
  type CollaborationMemberCapabilities,
  type CollaborationMessage,
  type CollaborationRoom,
  type CollaborationRoomChangedPayload,
  type CollaborationRun,
  type CollaborationRunStatus,
  type CollaborationSerializedRunError,
  type CreateCollaborationMemberInput,
  type CreateCollaborationRoomInput,
  type UpdateCollaborationRoomInput,
  type AppendCollaborationUserMessageInput,
  type MemberBackendAdapter,
  type MemberTurnInput,
} from '@tagent/shared'
import {
  appendMembers,
  appendMessage,
  getMember,
  getRoom,
  getRun,
  listMembersByRoom,
  listMessagesByRoom,
  listRunsByRoom,
  listRunsByStatus,
  loadMembers,
  loadRooms,
  upsertMember,
  upsertRoom,
  upsertRun,
  findRunByIdempotencyKey,
} from './collaboration-room-repository'
import {
  createChannelBackendAdapter,
  MemberBackendResolveError,
  pickDefaultMemberChannelBinding,
} from './member-backend-adapter'
import { RoomScheduler, type RoomSchedulerEntry } from './collaboration-room-scheduler'

/** CHANGED 广播类型（主进程 → renderer） */
export type CollaborationRoomBroadcast = (
  roomId: string,
  kind: CollaborationRoomChangedPayload['kind'],
) => void

/** 服务构造选项（adapter / broadcast 可注入） */
export interface CollaborationRoomServiceOptions {
  /** 成员后端适配器（默认 ChannelBackendAdapter；测试可注入 mock） */
  adapter?: MemberBackendAdapter
  /** CHANGED 广播（默认 noop；IPC 层注入真实广播） */
  broadcast?: CollaborationRoomBroadcast
}

/** Stage 1/2 静态成员的默认能力（全 false，S3+ 由真实 probe 填充） */
const DEFAULT_MEMBER_CAPABILITIES: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
}

/** 上下文投影：近期对话条数上限（避免 token 膨胀） */
const RECENT_CONTEXT_MESSAGES = 12

function genId(prefix: string): string {
  return `${prefix}${randomUUID()}`
}

function noopBroadcast(): void {
  /* noop：测试 / 未注入广播时用 */
}

export class CollaborationRoomService {
  private readonly adapter: MemberBackendAdapter
  private readonly broadcast: CollaborationRoomBroadcast
  /** 房间运行调度器（房间并发 + 成员串行 + FIFO 队列） */
  private readonly scheduler: RoomScheduler
  /** 运行中 run 的 AbortController（cancelRun 用） */
  private readonly abortControllers: Map<string, AbortController> = new Map()
  /** 运行中 run 的执行 Promise（测试可 await；完成后自动清除） */
  private readonly inflight: Map<string, Promise<void>> = new Map()

  private constructor(opts: CollaborationRoomServiceOptions) {
    this.adapter = opts.adapter ?? createChannelBackendAdapter()
    this.broadcast = opts.broadcast ?? noopBroadcast
    this.scheduler = this.createScheduler()
  }

  static create(opts?: CollaborationRoomServiceOptions): CollaborationRoomService {
    return new CollaborationRoomService(opts ?? {})
  }

  /** 构造默认调度器：读 room.maxConcurrentRuns；start 回调 fire-and-forget executeRun + 记 inflight */
  private createScheduler(): RoomScheduler {
    return new RoomScheduler({
      getMaxConcurrentRuns: (roomId) => {
        const room = getRoom(roomId)
        return Math.max(1, room?.maxConcurrentRuns ?? COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS)
      },
      start: (entry: RoomSchedulerEntry) => {
        const exec = this.executeRun(entry.room, entry.member, entry.run, entry.triggerMessage).catch(
          (err) => {
            // executeRun 内部已处理所有终态；此处兜底防止 unhandledRejection
            console.error(`[协作室] executeRun 未捕获错误 run=${entry.run.id}:`, err)
          },
        )
        this.inflight.set(entry.run.id, exec)
      },
    })
  }

  // ===== Room =====

  /** 列出全部房间（默认不含 archived，按 updatedAt 倒序） */
  listRooms(includeArchived = false): CollaborationRoom[] {
    const rooms = loadRooms()
    const filtered = includeArchived ? rooms : rooms.filter((r) => r.status !== 'archived')
    return filtered.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 取单个房间（不存在返回 undefined） */
  getRoomById(roomId: string): CollaborationRoom | undefined {
    return getRoom(roomId)
  }

  /**
   * 创建协作室房间（含可选静态成员）。
   *
   * 协调者解析：取第一个 isCoordinator=true 的成员；若无标记但提供了成员，
   * 指派第一个成员为协调者（满足「一个 room 一个协调者」不变量的骨架版）；
   * 空白团队（无成员）coordinatorMemberId 为空字符串。
   */
  createRoom(input: CreateCollaborationRoomInput): CollaborationRoom {
    const errors = validateCreateCollaborationRoomInput(input)
    if (errors.length > 0) {
      throw new Error(errors.join('；'))
    }

    const now = Date.now()
    const roomId = genId(COLLABORATION_ROOM_ID_PREFIX)

    // 构建静态成员
    const memberSpecs = input.members ?? []
    const members: CollaborationMember[] = memberSpecs.map((spec) => buildMember(roomId, spec, now))

    // 解析协调者
    let coordinatorMemberId = ''
    const markedCoordinator = members.find((m) => m.isCoordinator)
    if (markedCoordinator) {
      coordinatorMemberId = markedCoordinator.id
    } else if (members.length > 0) {
      // 未显式标记但提供了成员：指派第一个为协调者
      members[0]!.isCoordinator = true
      coordinatorMemberId = members[0]!.id
    }

    const room: CollaborationRoom = {
      id: roomId,
      title: input.title.trim(),
      goal: input.goal?.trim() ?? '',
      workspaceId: input.workspaceId,
      coordinatorMemberId,
      status: 'active',
      maxConcurrentRuns: input.maxConcurrentRuns ?? COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS,
      maxA2ADepth: input.maxA2ADepth ?? COLLABORATION_ROOM_DEFAULT_MAX_A2A_DEPTH,
      budget: input.budget ?? {},
      attachedBoardId: input.attachedBoardId,
      createdAt: now,
      updatedAt: now,
    }

    // 先写房间，再写成员；成员写失败时房间已落盘（可接受降级，见文件头注释）
    upsertRoom(room)
    appendMembers(members)

    return room
  }

  /** 更新房间（rename / pause / archive / complete / resume / 调整上限） */
  updateRoom(input: UpdateCollaborationRoomInput): CollaborationRoom {
    const existing = getRoom(input.roomId)
    if (!existing) {
      throw new Error('房间不存在')
    }
    if (input.status !== undefined && !isCollaborationRoomStatus(input.status)) {
      throw new Error(`非法房间状态：${String(input.status)}`)
    }

    const now = Date.now()
    const nextStatus = input.status ?? existing.status
    const updated: CollaborationRoom = {
      ...existing,
      title: input.title !== undefined ? input.title.trim() : existing.title,
      goal: input.goal !== undefined ? input.goal.trim() : existing.goal,
      status: nextStatus,
      maxConcurrentRuns: input.maxConcurrentRuns ?? existing.maxConcurrentRuns,
      maxA2ADepth: input.maxA2ADepth ?? existing.maxA2ADepth,
      budget: input.budget ?? existing.budget,
      updatedAt: now,
      // 归档记时间；从 archived 恢复到 active 清掉归档时间
      archivedAt:
        nextStatus === 'archived'
          ? existing.archivedAt ?? now
          : nextStatus === 'active'
            ? undefined
            : existing.archivedAt,
    }

    upsertRoom(updated)
    return updated
  }

  // ===== Message =====

  /** 列出某房间全部消息（按 createdAt 升序） */
  listMessages(roomId: string): CollaborationMessage[] {
    return listMessagesByRoom(roomId)
  }

  /**
   * 追加用户消息（Stage 3：落盘前解析 @mention → targetMemberIds，落盘后异步触发多成员 run）。
   *
   * - 目标解析：显式 input.targetMemberIds 优先（程序化调用）；否则从文本 @displayName / @all
   *   解析（parseCollaborationMentions）。无 @ 命中 → targetMemberIds=[]，由 trigger 路由协调者。
   * - 房间 active：落盘用户消息 → 异步 triggerRunForMessage（不阻塞 IPC，返回即结束）。
   * - 房间 paused/archived/completed：只落盘消息，不触发 run（pause 后不启动新 run）。
   *
   * authorId 暂用 'user' 占位（S3+ 接真实用户身份）；
   * rootMessageId 暂等于自身（S3+ 接回复链根解析）。
   */
  appendUserMessage(input: AppendCollaborationUserMessageInput): CollaborationMessage {
    const room = getRoom(input.roomId)
    if (!room) {
      throw new Error('房间不存在')
    }
    const text = input.content?.trim() ?? ''
    if (!text) {
      throw new Error('消息内容不能为空')
    }

    // 目标成员解析（S3）：显式 targetMemberIds 优先；否则从文本 @mention 解析（@all → 全部成员）
    const explicitTargets =
      input.targetMemberIds && input.targetMemberIds.length > 0 ? input.targetMemberIds : null
    const targetMemberIds = explicitTargets ?? parseCollaborationMentions(text, loadMembers(input.roomId))

    const now = Date.now()
    const id = genId(COLLABORATION_MESSAGE_ID_PREFIX)
    const message: CollaborationMessage = {
      id,
      roomId: input.roomId,
      authorType: 'user',
      authorId: 'user',
      kind: 'chat',
      content: text,
      visibility: 'room',
      targetMemberIds,
      replyToMessageId: input.replyToMessageId,
      rootMessageId: id,
      depth: 0,
      createdAt: now,
    }

    appendMessage(message)

    // 房间 updatedAt 刷新（便于侧栏按最后活动排序）
    upsertRoom({ ...room, updatedAt: now })

    // active 房间异步触发成员 run（不阻塞 IPC）
    if (room.status === 'active') {
      this.triggerRunForMessage(room, message)
    }

    return message
  }

  // ===== Run（Stage 2） =====

  /** 列出某房间全部 run（按入队顺序） */
  listRuns(roomId: string): CollaborationRun[] {
    return listRunsByRoom(roomId)
  }

  /** 取单个 run（不存在返回 undefined） */
  getRunById(runId: string): CollaborationRun | undefined {
    return getRun(runId)
  }

  /**
   * 取消某 run（Stage 3：区分排队中 / 运行中）。
   * - 排队中（仍在调度器队列、未占 slot）：dequeue 移除 + 置 cancelled + 同步成员状态。
   * - 运行中：abort 后端调用；executeRun 的 finally 负责 release + 同步成员状态。
   * 已终态（done/failed/cancelled）的 run 不再变更，返回其当前状态。
   */
  cancelRun(runId: string): CollaborationRun | undefined {
    const run = getRun(runId)
    if (!run) return undefined
    if (run.status !== 'queued' && run.status !== 'running') return run

    // 置 cancelled（CAS：仅 queued/running 可转）
    const now = Date.now()
    const updated: CollaborationRun = { ...run, status: 'cancelled', finishedAt: now }
    upsertRun(updated)

    if (this.scheduler.dequeue(runId)) {
      // 仍在队列（未占 slot）：移除即可，executeRun 不会被调用，无需 release。
      // 同步成员状态（若仍有其他排队 run → queued，否则 idle）
      this.syncMemberStatus(run.memberId)
    } else {
      // 已 running：abort 后端调用；executeRun finally 会 release + syncMemberStatus
      const ctrl = this.abortControllers.get(runId)
      if (ctrl) ctrl.abort()
    }

    this.broadcast(run.roomId, 'run-cancelled')
    return updated
  }

  /**
   * 启动恢复（02-RUNTIME-A2A-SPEC §14）：把遗留 queued/running run 标为 failed(INTERRUPTED)。
   *
   * 不自动重放（避免重复副作用）；用户可重新发消息触发新 run（新 messageId → 新 run，幂等不冲突）。
   * 成员状态回 idle，避免「假 running」。返回恢复的 run 数。
   */
  recoverInterruptedRuns(): number {
    const stuck = listRunsByStatus(['queued', 'running'])
    if (stuck.length === 0) return 0
    const now = Date.now()
    const error: CollaborationSerializedRunError = {
      message: '应用重启时发现仍在运行的 run，已标记中断（请重新发送消息以重试）',
      code: 'INTERRUPTED',
    }
    for (const run of stuck) {
      upsertRun({ ...run, status: 'failed', finishedAt: now, error })
      this.syncMemberStatus(run.memberId)
    }
    console.log(`[协作室] 启动恢复：${stuck.length} 个遗留 run 标记为 interrupted/failed`)
    return stuck.length
  }

  /**
   * 为一条用户消息触发 run（Stage 3：多目标并行扇出，幂等）。
   *
   * - 解析目标成员：message.targetMemberIds 非空 → 这些成员（按顺序去重，跳过未知 ID）；
   *   否则 → 协调者（无协调者则首成员）；空团队返回 []。
   * - 每个目标创建一个 queued run（幂等键 triggerMessageId:memberId；已存在则跳过）。
   * - 经 scheduler 入队：房间级 maxConcurrentRuns + 成员内串行 + FIFO；超容量则排队。
   * - 一方 failed 不取消其他目标（各 run 独立状态机，结果各自落盘）。
   *
   * 返回本次新建的 run 列表（幂等跳过的不含；空团队返回 []）。
   */
  triggerRunForMessage(
    room: CollaborationRoom,
    triggerMessage: CollaborationMessage,
  ): CollaborationRun[] {
    const members = loadMembers(room.id)
    const targets = resolveTargetMembers(room, triggerMessage, members)
    if (targets.length === 0) {
      // 空白团队：无成员可回复，静默跳过（不创建 run、不写消息）。
      // demo 房间经 newCollaborationRoom 默认带成员，此处仅 S1 风格空白团队命中。
      console.warn(`[协作室] 房间 ${room.id} 无成员可回复，跳过 run 触发`)
      return []
    }

    const created: CollaborationRun[] = []
    for (const target of targets) {
      // 幂等：同一 (trigger, member) 已有 run 则跳过（无论状态）
      const idempotencyKey = collaborationRunIdempotencyKey(triggerMessage.id, target.id)
      if (findRunByIdempotencyKey(idempotencyKey)) continue

      const run: CollaborationRun = {
        id: genId(COLLABORATION_RUN_ID_PREFIX),
        roomId: room.id,
        memberId: target.id,
        triggerMessageId: triggerMessage.id,
        idempotencyKey,
        status: 'queued',
        attempt: 0,
      }
      upsertRun(run)
      created.push(run)

      this.scheduler.enqueue({
        runId: run.id,
        roomId: room.id,
        memberId: target.id,
        room,
        member: target,
        run,
        triggerMessage,
      })

      // 入队后若该成员未在 running，标记 queued（让 UI 看到"排队中"；
      // 若调度器已立即启动，executeRun 同步前缀已置 running，此处跳过不覆盖）
      if (!this.scheduler.isMemberRunning(target.id)) {
        this.setMemberStatus(target.id, 'queued')
      }
    }
    return created
  }

  /**
   * 执行一次 turn（异步，由 scheduler 在容量允许时 fire-and-forget 启动）。
   *
   * 状态机：queued → running → done | failed | cancelled（CAS 转换，race-safe）。
   * 完成后落盘成员消息（done）或系统警告（failed），广播 CHANGED。
   * finally 释放调度器 slot（drain 后续排队 run）并同步成员状态；无论成功/失败/取消/被抢占都执行。
   */
  private async executeRun(
    room: CollaborationRoom,
    member: CollaborationMember,
    run: CollaborationRun,
    triggerMessage: CollaborationMessage,
  ): Promise<void> {
    const controller = new AbortController()
    this.abortControllers.set(run.id, controller)
    const startedAt = Date.now()

    try {
      // queued → running（scheduler 启动后；若已被取消则 CAS 失败 → 退出，finally 仍 release）
      if (!this.casRun(run.id, 'queued', 'running', { startedAt })) {
        return
      }
      this.setMemberStatus(member.id, 'running')
      this.broadcast(room.id, 'run-started')

      // 组装上下文投影 + 调后端
      const allMembers = loadMembers(room.id)
      const messages = listMessagesByRoom(room.id)
      const { systemPrompt, prompt } = buildTurnPrompts(room, member, allMembers, messages)
      const input: MemberTurnInput = {
        roomId: room.id,
        memberId: member.id,
        runId: run.id,
        triggerMessageId: triggerMessage.id,
        channelId: member.channelId,
        modelId: member.modelId,
        systemPrompt,
        prompt,
        signal: controller.signal,
      }
      const result = await this.adapter.runTurn(input)

      // 被取消则不写成员消息（cancelRun 已置 cancelled；此处 CAS 不覆盖，仅兜底）
      if (controller.signal.aborted) {
        this.casRun(run.id, 'running', 'cancelled', { finishedAt: Date.now() })
        this.broadcast(room.id, 'run-cancelled')
        return
      }

      // running → done + 成员消息
      const finishedAt = Date.now()
      this.casRun(run.id, 'running', 'done', {
        finishedAt,
        usage: result.usage ?? { wallTimeMs: finishedAt - startedAt },
      })
      this.appendMemberMessage(room, member, triggerMessage, result.text, run.id)
      this.broadcast(room.id, 'run-finished')
    } catch (err) {
      if (controller.signal.aborted) {
        // 取消（cancelRun 已置 cancelled；此处 CAS 不覆盖，仅兜底）
        this.casRun(run.id, 'running', 'cancelled', { finishedAt: Date.now() })
        this.broadcast(room.id, 'run-cancelled')
        return
      }
      // running → failed + 系统警告（一方失败不影响其他目标 run）
      const error = serializeRunError(err)
      this.casRun(run.id, 'running', 'failed', { finishedAt: Date.now(), error })
      const reason = err instanceof Error ? err.message : String(err)
      this.appendSystemMessage(
        room.id,
        `成员「${member.displayName}」回复失败：${reason}`,
      )
      this.broadcast(room.id, 'run-finished')
    } finally {
      this.abortControllers.delete(run.id)
      this.inflight.delete(run.id)
      // 释放调度器 slot → drain 启动后续排队 run；再同步成员状态（queued/idle）
      this.scheduler.release(run.id, room.id, member.id)
      this.syncMemberStatus(member.id)
    }
  }

  /**
   * 等待所有 run 终态（含排队中 → 启动 → 完成；测试用）。
   *
   * 循环到调度器空闲（无排队、无 running）：每轮 await 当前在飞 run；它们完成时 finally
   * 会 release → drain 启动排队 run（新增 inflight），下一轮继续 await，直到 isIdle。
   */
  async awaitAllRuns(): Promise<void> {
    while (!this.scheduler.isIdle()) {
      const snapshot = [...this.inflight.values()]
      if (snapshot.length === 0) {
        // 仅有排队但无 running（容量被占？理论不应发生；让出避免死循环）
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      } else {
        await Promise.allSettled(snapshot)
      }
    }
  }

  // ===== Member =====

  /** 列出某房间全部成员 */
  listMembers(roomId: string): CollaborationMember[] {
    return listMembersByRoom(roomId)
  }

  /**
   * 向已有房间追加一个成员（Stage 3：「添加成员」最小按钮用）。
   *
   * - displayName 必填非空；房间须存在且未归档。
   * - 成员数含新增不超过 COLLABORATION_ROOM_MAX_MEMBERS。
   * - 未显式绑渠道时自动绑默认渠道（kscc 优先，再外部），与 createRoom 一致。
   * - 不影响协调者；新成员初始 status='offline'，发消息点名后才转入 queued/running。
   */
  addMember(roomId: string, input: CreateCollaborationMemberInput): CollaborationMember {
    const room = getRoom(roomId)
    if (!room) {
      throw new Error('房间不存在')
    }
    if (room.status === 'archived') {
      throw new Error('已归档房间不能添加成员')
    }
    const displayName = input.displayName?.trim()
    if (!displayName) {
      throw new Error('成员显示名不能为空')
    }
    const existing = loadMembers(roomId)
    if (existing.length >= COLLABORATION_ROOM_MAX_MEMBERS) {
      throw new Error(`成员数已达上限 ${COLLABORATION_ROOM_MAX_MEMBERS}`)
    }

    const now = Date.now()
    const member = buildMember(roomId, { ...input, displayName }, now)
    appendMembers([member])

    this.broadcast(roomId, 'updated')
    return member
  }

  // ===== 内部辅助 =====

  /** CAS 转换 run 状态：仅当当前状态 === expectedFrom 时才更新为 to，否则返回 undefined */
  private casRun(
    runId: string,
    expectedFrom: CollaborationRunStatus,
    to: CollaborationRunStatus,
    patch: Partial<CollaborationRun>,
  ): CollaborationRun | undefined {
    const current = getRun(runId)
    if (!current || current.status !== expectedFrom) return undefined
    const updated: CollaborationRun = { ...current, ...patch, status: to }
    upsertRun(updated)
    return updated
  }

  /** 更新成员状态（合并 upsert，保留其他字段） */
  private setMemberStatus(memberId: string, status: CollaborationMember['status']): void {
    const member = getMember(memberId)
    if (!member) return
    upsertMember({ ...member, status, updatedAt: Date.now() })
  }

  /**
   * run 终态后同步成员状态（Stage 3）：
   * - 该成员仍有 running run（被调度器刚启动）→ 保持 running（由对应 executeRun 设置，不覆盖）
   * - 否则有排队 run → queued
   * - 否则 → idle
   * 在 executeRun finally / cancelRun（排队取消）/ recoverInterruptedRuns 中调用。
   */
  private syncMemberStatus(memberId: string): void {
    if (this.scheduler.isMemberRunning(memberId)) return
    const member = getMember(memberId)
    if (!member) return
    const next = this.scheduler.hasQueuedForMember(memberId) ? 'queued' : 'idle'
    if (member.status !== next) {
      upsertMember({ ...member, status: next, updatedAt: Date.now() })
    }
  }

  /** 追加成员消息（done 后） */
  private appendMemberMessage(
    room: CollaborationRoom,
    member: CollaborationMember,
    triggerMessage: CollaborationMessage,
    text: string,
    runId: string,
  ): void {
    const content = text?.trim() || '（成员未返回正文）'
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: 'member',
      authorId: member.id,
      kind: 'chat',
      content,
      visibility: 'room',
      targetMemberIds: [],
      replyToMessageId: triggerMessage.id,
      rootMessageId: triggerMessage.rootMessageId,
      runId,
      depth: triggerMessage.depth,
      createdAt: Date.now(),
    }
    appendMessage(message)
    this.broadcast(room.id, 'member-message-appended')
  }

  /** 追加系统警告消息（failed / 无成员等） */
  private appendSystemMessage(roomId: string, content: string): void {
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId,
      authorType: 'system',
      authorId: 'system',
      kind: 'warning',
      content,
      visibility: 'room',
      targetMemberIds: [],
      rootMessageId: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      depth: 0,
      createdAt: Date.now(),
    }
    appendMessage(message)
  }
}

/**
 * 解析一条用户消息的目标成员列表（Stage 3 路由）。
 *
 * - message.targetMemberIds 非空 → 按顺序解析为成员（去重，跳过未知 ID）。
 *   （targetMemberIds 由 appendUserMessage 从 @mention 解析落盘，或程序化传入）
 * - 否则（无 @ 命中）→ 协调者（无协调者则首成员）；空团队返回 []。
 *
 * 纯函数（不读 DB）；members 由调用方传入。幂等：同输入同输出。
 */
function resolveTargetMembers(
  room: CollaborationRoom,
  triggerMessage: CollaborationMessage,
  members: CollaborationMember[],
): CollaborationMember[] {
  if (members.length === 0) return []
  if (triggerMessage.targetMemberIds.length > 0) {
    const seen = new Set<string>()
    const out: CollaborationMember[] = []
    for (const id of triggerMessage.targetMemberIds) {
      if (seen.has(id)) continue
      const m = members.find((mm) => mm.id === id)
      if (m) {
        seen.add(id)
        out.push(m)
      }
    }
    return out
  }
  // 无点名 → 协调者 → 首成员
  if (room.coordinatorMemberId) {
    const coord = members.find((m) => m.id === room.coordinatorMemberId)
    if (coord) return [coord]
  }
  return members.slice(0, 1)
}

/**
 * 组装一次 turn 的 systemPrompt + prompt（02-RUNTIME-A2A-SPEC §7 简化版）。
 *
 * systemPrompt：角色 + 房间目标 + 角色职责。
 * prompt：近期 chat 消息（用户 + 成员，按成员显示名标注）+ 触发消息 + 回复指令。
 * Stage 2 不实现滚动摘要 / 信箱投影 / 任务投影（留 S3+）。
 */
function buildTurnPrompts(
  room: CollaborationRoom,
  member: CollaborationMember,
  allMembers: CollaborationMember[],
  messages: CollaborationMessage[],
): { systemPrompt: string; prompt: string } {
  const roleDesc = member.roleSnapshot.description
  const systemPrompt = [
    `你是协作室「${room.title}」的成员「${member.displayName}」。`,
    roleDesc ? `你的职责：${roleDesc}。` : '',
    room.goal ? `房间目标：${room.goal}。` : '',
    '请以该身份简洁、直接地回复用户的最新消息。',
  ]
    .filter(Boolean)
    .join('')

  const nameOf = (authorId: string): string =>
    allMembers.find((m) => m.id === authorId)?.displayName ?? '成员'
  const recent = messages.filter((m) => m.kind === 'chat').slice(-RECENT_CONTEXT_MESSAGES)
  const transcript = recent
    .map((m) => `${m.authorType === 'user' ? '用户' : nameOf(m.authorId)}：${m.content}`)
    .join('\n')
  const prompt = `${transcript}\n\n请以「${member.displayName}」的身份回复最后一条消息。`

  return { systemPrompt, prompt }
}

/** 序列化 run 错误（保留 code：MemberBackendResolveError 有 code） */
function serializeRunError(err: unknown): CollaborationSerializedRunError {
  if (err instanceof MemberBackendResolveError) {
    return { message: err.message, code: err.code }
  }
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack }
  }
  return { message: String(err) }
}

/** 根据创建输入 + 房间 ID 构建一个静态成员记录 */
function buildMember(
  roomId: string,
  spec: CreateCollaborationMemberInput,
  now: number,
): CollaborationMember {
  const displayName = spec.displayName.trim()
  // 未显式绑渠道时：自动绑 kscc（可用）或首个可用外部渠道，保证「新建即能聊」
  const autoBind =
    !spec.channelId && (spec.backend === undefined || spec.backend === 'channel')
      ? pickDefaultMemberChannelBinding()
      : null
  return {
    id: genId(COLLABORATION_MEMBER_ID_PREFIX),
    roomId,
    displayName,
    roleId: spec.roleId,
    roleSnapshot: spec.roleSnapshot ?? { roleId: spec.roleId, displayName },
    backend: spec.backend ?? 'channel',
    channelId: spec.channelId ?? autoBind?.channelId,
    modelId: spec.modelId ?? autoBind?.modelId,
    cliWorkerId: spec.cliWorkerId,
    logicalSessionId: genId(COLLABORATION_LOGICAL_SESSION_ID_PREFIX),
    permissionProfile: spec.permissionProfile ?? 'read-only',
    capabilities: { ...DEFAULT_MEMBER_CAPABILITIES, ...(spec.capabilities ?? {}) },
    status: 'offline',
    isCoordinator: spec.isCoordinator ?? false,
    createdAt: now,
    updatedAt: now,
  }
}
