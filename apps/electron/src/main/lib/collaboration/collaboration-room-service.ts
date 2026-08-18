/**
 * 协作室服务（Stage 3：多成员并行 + 协调者路由）
 *
 * 在 repository 之上做：输入校验、ID 生成、默认值、状态转换、mention 解析、run 触发与调度。
 *
 * Stage 3 新增（在 S2 单成员闭环之上）：
 * - appendUserMessage 落盘用户消息前用 resolveCollaborationMentions 把结构化 mentions /
 *   @displayName 解析为 targetMemberIds（@all → 全部成员；无 @ → []，由 trigger 路由协调者）。
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
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  COLLABORATION_LOGICAL_SESSION_ID_PREFIX,
  COLLABORATION_MEMBER_ID_PREFIX,
  COLLABORATION_MESSAGE_ID_PREFIX,
  COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS,
  COLLABORATION_ROOM_ID_PREFIX,
  COLLABORATION_ROOM_MAX_MEMBERS,
  COLLABORATION_RUN_ID_PREFIX,
  COLLABORATION_ROOM_TASK_ID_PREFIX,
  COLLABORATION_ROOM_TASK_SUMMARY_MAX_LENGTH,
  COLLABORATION_ARTIFACT_ID_PREFIX,
  collaborationRunIdempotencyKey,
  collaborationContinuationIdempotencyKey,
  collaborationEnvelopeIdempotencyKey,
  canContinueCollaborationDepthStop,
  collaborationLoopFingerprint,
  isCollaborationDuplicateReply,
  isCollaborationSelfSend,
  isCollaborationRoomStatus,
  isCollaborationRoomTaskStatus,
  nextCollaborationA2ADepth,
  nextCollaborationMentionAliases,
  recommendedCollaborationHandoffDepth,
  COLLABORATION_SUMMARY_DEFAULT_EVERY_UTTERANCES,
  latestCollaborationRoomSummaryText,
  projectCollaborationTurnContext,
  resolveCollaborationMentions,
  transitionCollaborationMailboxState,
  transitionCollaborationRoomTaskStatus,
  validateCreateCollaborationRoomInput,
  type CollaborationMailboxEnvelope,
  type CollaborationMember,
  type CollaborationMemberCapabilities,
  type CollaborationMessage,
  type CollaborationRoom,
  type CollaborationRoomChangedPayload,
  type CollaborationRoomTask,
  type CollaborationRoomTaskStatus,
  type CollaborationArtifact,
  type CollaborationTextDeltaPayload,
  type CollaborationRun,
  type CollaborationRunStatus,
  type CollaborationSerializedRunError,
  type CreateCollaborationMemberInput,
  type CreateCollaborationRoomInput,
  type UpdateCollaborationRoomInput,
  type UpdateCollaborationMemberInput,
  type AppendCollaborationUserMessageInput,
  type CreateCollaborationRoomTaskInput,
  type UpdateCollaborationRoomTaskInput,
  type MemberBackendAdapter,
  type MemberTurnInput,
} from '@tagent/shared'
import {
  appendMembers,
  appendMessage,
  appendMailboxEnvelope,
  getCollaborationSummary,
  getMailboxEnvelope,
  getMember,
  getRoom,
  getRun,
  getRoomTask,
  listActiveMailboxForMember,
  listMailboxByRequest,
  listMailboxByRoom,
  listMembersByRoom,
  listMessagesByRoom,
  listRunsByRoom,
  listRunsByStatus,
  listRoomTasksByRoom,
  appendArtifact,
  loadMembers,
  loadRooms,
  upsertMailboxEnvelope,
  upsertMember,
  upsertRoom,
  upsertRun,
  upsertRoomTask,
  saveRoomTaskIfCurrent,
  findRunByIdempotencyKey,
} from './collaboration-room-repository'
import {
  createChannelBackendAdapter,
  channelSupportsRoomToolBridge,
  MemberBackendResolveError,
  pickDefaultMemberChannelBinding,
} from './member-backend-adapter'
import {
  CollaborationSummaryRunner,
  type CollaborationSummaryModelCaller,
} from './collaboration-room-summary'
import { RoomScheduler, type RoomSchedulerEntry } from './collaboration-room-scheduler'
import { getWorkspaceById } from '../workspace/workspace-manager'
import { isPathInsideRoot, normalizeToAbsolute, resolveReal } from '../ipc/workspace-service'

/** CHANGED 广播类型（主进程 → renderer） */
export type CollaborationRoomBroadcast = (
  roomId: string,
  kind: CollaborationRoomChangedPayload['kind'],
) => void

/** 流式正文增量回调（独立于 CHANGED，避免每 token 全量刷新） */
export type CollaborationTextDeltaHandler = (payload: CollaborationTextDeltaPayload) => void

/** 服务构造选项（adapter / broadcast 可注入） */
export interface CollaborationRoomServiceOptions {
  /** 成员后端适配器（默认 ChannelBackendAdapter；测试可注入 mock） */
  adapter?: MemberBackendAdapter
  /** CHANGED 广播（默认 noop；IPC 层注入真实广播） */
  broadcast?: CollaborationRoomBroadcast
  /** 流式正文增量（默认 noop） */
  onTextDelta?: CollaborationTextDeltaHandler
  /** 房间摘要模型调用（注入假实现可测 S1–S8；默认复用协调者 channel/model） */
  summaryModelCaller?: CollaborationSummaryModelCaller
}

/** Stage 1/2 静态成员的默认能力（全 false，S3+ 由真实 probe 填充） */
const DEFAULT_MEMBER_CAPABILITIES: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
}

function genId(prefix: string): string {
  return `${prefix}${randomUUID()}`
}

function noopBroadcast(): void {
  /* noop：测试 / 未注入广播时用 */
}

export class CollaborationRoomService {
  private readonly adapter: MemberBackendAdapter
  private readonly broadcast: CollaborationRoomBroadcast
  private readonly onTextDelta: CollaborationTextDeltaHandler
  /** 房间运行调度器（房间并发 + 成员串行 + FIFO 队列） */
  private readonly scheduler: RoomScheduler
  /** 房间共享摘要 runner（§6.6：不占 maxConcurrentRuns 槽，fail-closed 不阻塞发言） */
  private readonly summaryRunner: CollaborationSummaryRunner
  /** 运行中 run 的 AbortController（cancelRun 用） */
  private readonly abortControllers: Map<string, AbortController> = new Map()
  /** 运行中 run 的执行 Promise（测试可 await；完成后自动清除） */
  private readonly inflight: Map<string, Promise<void>> = new Map()

  private constructor(opts: CollaborationRoomServiceOptions) {
    this.adapter = opts.adapter ?? createChannelBackendAdapter()
    this.broadcast = opts.broadcast ?? noopBroadcast
    this.onTextDelta = opts.onTextDelta ?? (() => undefined)
    this.summaryRunner = new CollaborationSummaryRunner({
      modelCaller: opts.summaryModelCaller,
    })
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
      // 只在新房间未指定时推荐；updateRoom 永远保留既存值，不能静默改写用户策略。
      maxA2ADepth:
        input.maxA2ADepth ?? recommendedCollaborationHandoffDepth(members.length),
      // A2A 交接为协作室核心能力，默认启用；S4.5 深度停止卡据此决定是否呈现。
      a2aHandoffEnabled: true,
      summaryEveryUtterances:
        input.summaryEveryUtterances ?? COLLABORATION_SUMMARY_DEFAULT_EVERY_UTTERANCES,
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
      summaryEveryUtterances: input.summaryEveryUtterances ?? existing.summaryEveryUtterances,
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
   * - 目标解析：显式 input.targetMemberIds 优先（程序化调用）；否则 input.mentions 结构化优先，
   *   未提供时从文本 @displayName / @all 兜底解析（resolveCollaborationMentions）。
   *   无 @ 命中 → targetMemberIds=[]，由 trigger 路由协调者。
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

    // 目标成员解析（S3.5-a）：显式 targetMemberIds 优先（程序化调用）；
    // 否则走 resolveCollaborationMentions（结构化 mentions 优先，未提供时文本兜底）
    const explicitTargets =
      input.targetMemberIds && input.targetMemberIds.length > 0 ? input.targetMemberIds : null
    const targetMemberIds =
      explicitTargets ??
      resolveCollaborationMentions({
        text,
        members: loadMembers(input.roomId),
        structured: input.mentions,
        sender: { type: 'user' },
      }).targetMemberIds

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
      this.kickSummary(room)
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
    const awaiting = listRunsByStatus(['awaiting_peer'])
    const recoverableOutbox = loadRooms().flatMap((room) =>
      listMailboxByRoom(room.id).filter(
        (envelope) => envelope.delivery === 'outbox' && !envelope.deliveryRunId && Boolean(envelope.attemptId),
      ),
    )
    if (stuck.length === 0 && awaiting.length === 0 && recoverableOutbox.length === 0) return 0
    // 在 sweep 前取快照：只有已经 dispatched/accepted 且其目标 run 仍活跃的信封才是
    // 「副作用结果未知」，绝不能因下方把 run 标 failed 后再当作安全重放。
    const interruptedRunIds = new Set(stuck.map((run) => run.id))
    const now = Date.now()
    const error: CollaborationSerializedRunError = {
      message: '应用重启时发现仍在运行的 run，已标记中断（请重新发送消息以重试）',
      code: 'INTERRUPTED',
    }
    for (const run of stuck) {
      upsertRun({ ...run, status: 'failed', finishedAt: now, error })
      this.syncMemberStatus(run.memberId)
    }
    // 遗留 awaiting_peer：continuation 已丢，标 blocked 要求用户决定重试/完成
    // （02-RUNTIME-A2A-SPEC §14：未知副作用不可自动重放）
    for (const run of awaiting) {
      upsertRun({ ...run, status: 'blocked', finishedAt: now, error })
      this.syncMemberStatus(run.memberId)
    }
    for (const room of loadRooms()) {
      for (const envelope of listMailboxByRoom(room.id)) {
        if (
          (envelope.delivery === 'dispatched' || envelope.delivery === 'accepted') &&
          envelope.deliveryRunId &&
          interruptedRunIds.has(envelope.deliveryRunId)
        ) {
          upsertMailboxEnvelope({
            ...envelope,
            delivery: 'outcome_unknown',
            stopReason: 'outcome_unknown',
          })
        }
      }
    }
    // 仅 outbox 且尚未关联 target run 的窗口可安全重放：它尚未启动任何模型调用。
    // 一旦已 dispatched/accepted，就走上面的 outcome_unknown，绝不自动再投递。
    let replayedOutbox = 0
    for (const envelope of recoverableOutbox) {
      const room = getRoom(envelope.roomId)
      const target = getMember(envelope.toMemberId)
      const trigger = room
        ? listMessagesByRoom(room.id).find((message) => message.id === envelope.sourceMessageId)
        : undefined
      if (!room || !target || !trigger) continue
      this.dispatchEnvelope(room, target, envelope, trigger)
      replayedOutbox++
    }
    console.log(
      `[协作室] 启动恢复：${stuck.length} 个遗留 run 标记 interrupted/failed，${awaiting.length} 个 awaiting_peer 标记 blocked，${replayedOutbox} 个 outbox 安全重投`,
    )
    return stuck.length + awaiting.length + replayedOutbox
  }

  // ===== A2A 信箱（S4 host 侧；02-RUNTIME-A2A-SPEC §5–§9） =====
  //
  // 本段实现宿主侧 A2A 协议入口（room_send / room_ask / room_reply）：纯逻辑守卫（S4-1）+
  // mailbox 落盘 + run 状态机迁移到 awaiting_peer + 广播。**adapter 工具回路（把工具暴露给
  // 成员 turn、peer reply 唤醒发送者新 turn）留 S4-3**；S4-2 的边界是「信箱语义 + 状态机」可
  // 独立验证（落盘正确、守卫阻断自环/超深度/重复回复、状态迁移合法）。
  //
  // 红线（02-spec §9 / 03-phases §12）：安全字段（rootMessageId/causationId/depth/fromMemberId）
  // 由宿主补齐，模型不得自行声明；此处 input 由调用方（未来 adapter 工具层）传入 run 上下文，
  // service 强制用 run 的 memberId 作为 fromMemberId，不接受外部伪造。

  /**
   * room_send：异步通知另一成员（不暂停发送者）。
   *
   * 守卫：自环（A→A）阻断；深度超限 fail closed；房间非 active 拒绝。
   * 落盘：pending 信封 + 一条 a2a_request 消息（visibility=participants）。
   * 不迁移 run 状态（send 不阻塞发送者）。
   */
  roomSend(input: {
    roomId: string
    fromRunId: string
    toMemberId: string
    payload: string
  }): { ok: true; envelopeId: string } | { ok: false; reason: string } {
    const room = getRoom(input.roomId)
    if (!room) return { ok: false, reason: '房间不存在' }
    if (room.status !== 'active') return { ok: false, reason: `房间状态非 active：${room.status}` }

    const run = getRun(input.fromRunId)
    if (!run) return { ok: false, reason: 'run 不存在' }
    if (run.status !== 'running' && run.status !== 'awaiting_peer') {
      return { ok: false, reason: `run 非 running/awaiting_peer：${run.status}` }
    }
    const fromMember = getMember(run.memberId)
    if (!fromMember) return { ok: false, reason: '发送成员不存在' }
    if (isCollaborationSelfSend(fromMember.id, input.toMemberId)) {
      return { ok: false, reason: '成员不能给自己发 A2A' }
    }
    const toMember = getMember(input.toMemberId)
    if (!toMember || toMember.roomId !== room.id) {
      return { ok: false, reason: '接收成员不存在或不属于本房间' }
    }

    // send 不递增深度（仅 ask/reply 跨成员计深度），但仍校验发送者 run 自身深度未超房间上限，
    // 避免深层 run 继续向外发散。run 深度未知时按 0 兜底（宿主补齐）。
    const senderDepth = this.runDepth(run.id)
    const depthCheck = nextCollaborationA2ADepth(senderDepth, room.maxA2ADepth)
    if (!depthCheck.ok) {
      this.recordDepthStop(room, run, fromMember, toMember, input.payload, senderDepth, 'message')
      return { ok: false, reason: depthCheck.reason }
    }

    const now = Date.now()
    const rootMessageId = run.triggerMessageId
    const causationId = run.id
    const envelope: CollaborationMailboxEnvelope = {
      id: genId('env_'),
      roomId: room.id,
      fromMemberId: fromMember.id,
      toMemberId: toMember.id,
      type: 'message',
      payload: input.payload,
      rootMessageId,
      causationId,
      depth: senderDepth,
      state: 'pending',
      attemptId: randomUUID(),
      delivery: 'outbox',
      sourceMessageId: run.triggerMessageId,
      createdAt: now,
    }
    appendMailboxEnvelope(envelope)
    const trigger = this.appendA2AMessage(room, fromMember, 'a2a_request', input.payload, rootMessageId, causationId, run.id, [toMember.id], senderDepth)
    this.dispatchEnvelope(room, toMember, envelope, trigger)
    this.broadcast(room.id, 'mailbox-updated')
    return { ok: true, envelopeId: envelope.id }
  }

  /**
   * room_ask：向另一成员提问；当前 run 可结束为 awaiting_peer 释放执行槽。
   *
   * 守卫：自环阻断；深度 = parentDepth+1 超限 fail closed。parentDepth 由宿主从该 run
   * 已有 A2A 链推导（安全字段，不接受外部传入）。
   * 落盘：question 信封（pending）+ a2a_request 消息。
   * 状态机：调用方决定是否把 run 迁移到 awaiting_peer（见 markRunAwaitingPeer）。
   */
  roomAsk(input: {
    roomId: string
    fromRunId: string
    toMemberId: string
    question: string
  }): { ok: true; envelopeId: string; requestId: string } | { ok: false; reason: string } {
    const room = getRoom(input.roomId)
    if (!room) return { ok: false, reason: '房间不存在' }
    if (room.status !== 'active') return { ok: false, reason: `房间状态非 active：${room.status}` }

    const run = getRun(input.fromRunId)
    if (!run) return { ok: false, reason: 'run 不存在' }
    if (run.status !== 'running' && run.status !== 'awaiting_peer') {
      return { ok: false, reason: `run 非 running/awaiting_peer：${run.status}` }
    }
    const fromMember = getMember(run.memberId)
    if (!fromMember) return { ok: false, reason: '发送成员不存在' }
    if (isCollaborationSelfSend(fromMember.id, input.toMemberId)) {
      return { ok: false, reason: '成员不能给自己发 A2A' }
    }
    const toMember = getMember(input.toMemberId)
    if (!toMember || toMember.roomId !== room.id) {
      return { ok: false, reason: '接收成员不存在或不属于本房间' }
    }

    const parentDepth = this.runDepth(run.id)
    const depthRes = nextCollaborationA2ADepth(parentDepth, room.maxA2ADepth)
    if (!depthRes.ok) {
      this.recordDepthStop(room, run, fromMember, toMember, input.question, parentDepth, 'question')
      return { ok: false, reason: depthRes.reason }
    }

    // 循环指纹：检测 A↔B 近重复问答（02-RUNTIME-A2A-SPEC §9）。
    // - 正向：A→B 已问过同样问题（指纹碰撞）→ 阻断重复投递
    // - 反向：B→A 已问过同样问题（A→B→A 循环）→ 阻断
    const fp = collaborationLoopFingerprint({
      fromMemberId: fromMember.id,
      toMemberId: toMember.id,
      payload: input.question,
    })
    const reverseFp = collaborationLoopFingerprint({
      fromMemberId: toMember.id,
      toMemberId: fromMember.id,
      payload: input.question,
    })
    const roomEnvelopes = listMailboxByRoom(room.id)
    const loopHit = roomEnvelopes.some((e) => {
      if (e.type !== 'question') return false
      const eFp = collaborationLoopFingerprint({
        fromMemberId: e.fromMemberId,
        toMemberId: e.toMemberId,
        payload: e.payload,
      })
      // 正向重复（同 A→B 同问题）或反向循环（B→A 同问题）
      if (eFp === fp) return true
      if (eFp === reverseFp && e.fromMemberId === toMember.id && e.toMemberId === fromMember.id) return true
      return false
    })
    if (loopHit) {
      return {
        ok: false,
        reason: '检测到 A↔B 近重复问答循环或重复投递，已阻断（请换一种方式询问或换成员）',
      }
    }

    const now = Date.now()
    const requestId = genId('req_')
    const rootMessageId = run.triggerMessageId
    const causationId = run.id
    const envelope: CollaborationMailboxEnvelope = {
      id: genId('env_'),
      roomId: room.id,
      fromMemberId: fromMember.id,
      toMemberId: toMember.id,
      type: 'question',
      requestId,
      payload: input.question,
      rootMessageId,
      causationId,
      depth: depthRes.depth,
      state: 'pending',
      attemptId: randomUUID(),
      delivery: 'outbox',
      sourceMessageId: run.triggerMessageId,
      createdAt: now,
    }
    appendMailboxEnvelope(envelope)
    const trigger = this.appendA2AMessage(room, fromMember, 'a2a_request', input.question, rootMessageId, causationId, run.id, [toMember.id], depthRes.depth)
    this.dispatchEnvelope(room, toMember, envelope, trigger)
    this.broadcast(room.id, 'mailbox-updated')
    return { ok: true, envelopeId: envelope.id, requestId }
  }

  /**
   * room_reply：回复一个 ask。幂等——同一 request 已有有效终态回复则阻断。
   *
   * 守卫：request 信封必须存在且为激活态（pending/delivered）；重复回复阻断；
   * 回复者必须是 request 的 toMemberId（防伪造）。
   * 落盘：reply 信封（置 answered）+ 原 question 信封置 answered + a2a_reply 消息。
   * 若原提问者 run 处于 awaiting_peer：CAS 为 done，并入队一条 continuation run
   *（幂等键 a2a-continue:{requestId}:{askerMemberId}）。不处于 awaiting_peer 则只落盘回复。
   */
  roomReply(input: {
    roomId: string
    fromRunId: string
    requestId: string
    answer: string
  }): { ok: true; envelopeId: string } | { ok: false; reason: string } {
    const room = getRoom(input.roomId)
    if (!room) return { ok: false, reason: '房间不存在' }

    const run = getRun(input.fromRunId)
    if (!run) return { ok: false, reason: 'run 不存在' }
    const fromMember = getMember(run.memberId)
    if (!fromMember) return { ok: false, reason: '回复成员不存在' }

    // 找到该 request 的 question 信封
    const related = listMailboxByRequest(input.requestId)
    const questionEnv = related.find((e) => e.type === 'question')
    if (!questionEnv) return { ok: false, reason: 'request 不存在' }
    if (questionEnv.toMemberId !== fromMember.id) {
      return { ok: false, reason: '回复者与 request 接收者不匹配' }
    }
    // 幂等先于状态迁移：同 request 已有有效回复时给出更精确的原因
    if (isCollaborationDuplicateReply(input.requestId, fromMember.id, related)) {
      return { ok: false, reason: '重复回复（该 request 已有有效回复）' }
    }
    if (!transitionCollaborationMailboxState(questionEnv.state, 'answer').ok) {
      return { ok: false, reason: `question 信封状态不可回复：${questionEnv.state}` }
    }

    const now = Date.now()
    const replyEnvelope: CollaborationMailboxEnvelope = {
      id: genId('env_'),
      roomId: room.id,
      fromMemberId: fromMember.id,
      toMemberId: questionEnv.fromMemberId,
      type: 'reply',
      requestId: input.requestId,
      payload: input.answer,
      rootMessageId: questionEnv.rootMessageId,
      causationId: run.id,
      depth: questionEnv.depth,
      state: 'answered',
      createdAt: now,
    }
    appendMailboxEnvelope(replyEnvelope)
    // 原 question 信封 → answered
    const t = transitionCollaborationMailboxState(questionEnv.state, 'answer')
    if (t.ok) upsertMailboxEnvelope({ ...questionEnv, state: t.state })

    const replyMessage = this.appendA2AMessage(
      room,
      fromMember,
      'a2a_reply',
      input.answer,
      questionEnv.rootMessageId,
      questionEnv.id,
      run.id,
      [questionEnv.fromMemberId],
      questionEnv.depth,
    )
    this.broadcast(room.id, 'mailbox-updated')
    this.enqueueAskerContinuation(room, questionEnv, input.requestId, replyMessage)
    return { ok: true, envelopeId: replyEnvelope.id }
  }

  /**
   * 把一个 run 标记为 awaiting_peer（执行槽释放，保留 continuation 供 peer reply 唤醒）。
   * 仅 running → awaiting_peer 合法（CAS）；abort 物理 turn（不占槽）；成员回 idle。
   * executeRun 看到 abort 时若 run 已是 awaiting_peer，不得覆盖为 cancelled。
   */
  markRunAwaitingPeer(runId: string): CollaborationRun | undefined {
    const updated = this.casRun(runId, 'running', 'awaiting_peer', {})
    if (updated) {
      const ctrl = this.abortControllers.get(runId)
      if (ctrl) ctrl.abort()
      this.scheduler.release(runId, updated.roomId, updated.memberId)
      this.syncMemberStatus(updated.memberId)
      this.broadcast(updated.roomId, 'run-awaiting-peer')
    }
    return updated
  }

  /**
   * S4-3：peer reply 到达后，若原提问者 run 处于 awaiting_peer，入队 continuation。
   *
   * - 原 run CAS awaiting_peer → done（等待已结束；continuation 是新 turn，因 backend 无 resume）
   * - 幂等键含 requestId，同一 reply 不会二次唤醒
   * - 房间非 active / 原 run 不是 awaiting_peer / 成员缺失 → 静默跳过（reply 已落盘）
   */
  private enqueueAskerContinuation(
    room: CollaborationRoom,
    questionEnv: CollaborationMailboxEnvelope,
    requestId: string,
    replyMessage: CollaborationMessage,
  ): void {
    if (room.status !== 'active') return
    const askerRun = getRun(questionEnv.causationId)
    if (!askerRun || askerRun.status !== 'awaiting_peer') return
    const asker = getMember(askerRun.memberId)
    if (!asker || asker.roomId !== room.id) return

    const idempotencyKey = collaborationContinuationIdempotencyKey(requestId, asker.id)
    if (findRunByIdempotencyKey(idempotencyKey)) return

    this.casRun(askerRun.id, 'awaiting_peer', 'done', { finishedAt: Date.now() })

    const continuation: CollaborationRun = {
      id: genId(COLLABORATION_RUN_ID_PREFIX),
      roomId: room.id,
      memberId: asker.id,
      triggerMessageId: replyMessage.id,
      idempotencyKey,
      status: 'queued',
      attempt: 0,
    }
    upsertRun(continuation)
    this.scheduler.enqueue({
      runId: continuation.id,
      roomId: room.id,
      memberId: asker.id,
      room,
      member: asker,
      run: continuation,
      triggerMessage: replyMessage,
    })
    if (!this.scheduler.isMemberRunning(asker.id)) {
      this.setMemberStatus(asker.id, 'queued')
    }
    this.broadcast(room.id, 'run-continued')
  }

  /** 列出某房间全部信箱信封（renderer 审计视图用） */
  listMailbox(roomId: string): CollaborationMailboxEnvelope[] {
    return listMailboxByRoom(roomId)
  }

  /** 列出某成员仍待处理的信封（pending/delivered） */
  listPendingMailboxForMember(memberId: string): CollaborationMailboxEnvelope[] {
    return listActiveMailboxForMember(memberId)
  }

  /**
   * 推导一个 run 当前的 A2A 深度（安全字段，宿主补齐）。
   *
   * 取该 run 作为 causationId 已落盘信封里的最大 depth；无则 0（首次跨成员调用）。
   * 用于 room_send/room_ask 的深度守卫，避免模型自行声明深度。
   */
  private runDepth(runId: string): number {
    const envelopes = listMailboxByRoom(getRun(runId)?.roomId ?? '')
    let max = 0
    for (const e of envelopes) {
      if (e.causationId === runId && e.depth > max) max = e.depth
    }
    return max
  }

  /** S4.5：仅在真实越过房间深度策略时写入可呈现的停止信封，绝不伪装成普通失败。 */
  private recordDepthStop(
    room: CollaborationRoom,
    run: CollaborationRun,
    fromMember: CollaborationMember,
    toMember: CollaborationMember,
    payload: string,
    currentDepth: number,
    type: 'message' | 'question',
  ): void {
    const envelope: CollaborationMailboxEnvelope = {
      id: genId('env_'),
      roomId: room.id,
      fromMemberId: fromMember.id,
      toMemberId: toMember.id,
      type,
      payload,
      rootMessageId: run.triggerMessageId,
      causationId: run.id,
      depth: Math.max(currentDepth, room.maxA2ADepth),
      state: 'cancelled',
      attemptId: randomUUID(),
      delivery: 'failed',
      stopReason: 'max_depth',
      continueUsed: false,
      sourceMessageId: run.triggerMessageId,
      createdAt: Date.now(),
    }
    appendMailboxEnvelope(envelope)
    this.appendSystemMessage(
      room.id,
      `成员「${fromMember.displayName}」向「${toMember.displayName}」的交接已达深度上限（${envelope.depth}/${room.maxA2ADepth}）。可继续一次或停止。`,
    )
    this.broadcast(room.id, 'mailbox-updated')
  }

  /**
   * S4.5：把已写入的 outbox 信封关联到唯一目标 run。先落盘信封、再创建 queued run、
   * 最后标 dispatched；同一 attemptId 的幂等键确保崩溃重试不会重复唤醒成员。
   */
  private dispatchEnvelope(
    room: CollaborationRoom,
    target: CollaborationMember,
    envelope: CollaborationMailboxEnvelope,
    triggerMessage: CollaborationMessage,
  ): void {
    if (!envelope.attemptId) return
    const idempotencyKey = collaborationEnvelopeIdempotencyKey({
      fromMemberId: envelope.fromMemberId,
      toMemberId: target.id,
      rootMessageId: envelope.rootMessageId,
      causationId: `${envelope.causationId}:${envelope.attemptId}`,
    })
    const existing = findRunByIdempotencyKey(idempotencyKey)
    const run = existing ?? {
      id: genId(COLLABORATION_RUN_ID_PREFIX),
      roomId: room.id,
      memberId: target.id,
      triggerMessageId: triggerMessage.id,
      idempotencyKey,
      status: 'queued' as const,
      attempt: 0,
    }
    if (!existing) {
      upsertRun(run)
      this.scheduler.enqueue({
        runId: run.id,
        roomId: room.id,
        memberId: target.id,
        room,
        member: target,
        run,
        triggerMessage,
      })
      if (!this.scheduler.isMemberRunning(target.id)) this.setMemberStatus(target.id, 'queued')
    }
    upsertMailboxEnvelope({ ...envelope, delivery: 'dispatched', deliveryRunId: run.id })
  }

  /** queued → running 的同一临界点把 delivery 标为 accepted，避免把未启动误报为已执行。 */
  private markEnvelopeAccepted(runId: string, roomId: string): void {
    for (const envelope of listMailboxByRoom(roomId)) {
      if (envelope.deliveryRunId === runId && envelope.delivery === 'dispatched') {
        upsertMailboxEnvelope({ ...envelope, delivery: 'accepted' })
      }
    }
  }

  /** S4.5 最小用户入口：深度停止只可继续一次；新 attempt 仍受硬上限 10 限制。 */
  continueDepthStop(envelopeId: string): { ok: true; envelopeId: string } | { ok: false; reason: string } {
    const stopped = getMailboxEnvelope(envelopeId)
    if (!stopped || !canContinueCollaborationDepthStop(stopped)) {
      return { ok: false, reason: '该深度停止不可继续或已使用过继续机会' }
    }
    const room = getRoom(stopped.roomId)
    const target = getMember(stopped.toMemberId)
    if (!room || !target || stopped.depth >= 10) {
      return { ok: false, reason: '继续条件不满足（房间/成员不存在或已达硬深度上限）' }
    }
    const source = listMessagesByRoom(room.id).find((message) => message.id === stopped.sourceMessageId)
    if (!source) return { ok: false, reason: '继续所需的源消息不存在' }
    const next: CollaborationMailboxEnvelope = {
      ...stopped,
      id: genId('env_'),
      depth: stopped.depth + 1,
      state: 'pending',
      attemptId: randomUUID(),
      delivery: 'outbox',
      deliveryRunId: undefined,
      stopReason: undefined,
      continueUsed: undefined,
      createdAt: Date.now(),
    }
    upsertMailboxEnvelope({ ...stopped, continueUsed: true })
    appendMailboxEnvelope(next)
    this.dispatchEnvelope(room, target, next, source)
    this.broadcast(room.id, 'mailbox-updated')
    return { ok: true, envelopeId: next.id }
  }

  /** 落盘一条 A2A 消息（room transcript 投影；visibility=participants） */
  private appendA2AMessage(
    room: CollaborationRoom,
    member: CollaborationMember,
    kind: 'a2a_request' | 'a2a_reply',
    content: string,
    rootMessageId: string,
    causationId: string,
    runId: string,
    targetMemberIds: string[],
    depth: number,
  ): CollaborationMessage {
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: 'member',
      authorId: member.id,
      kind,
      content,
      visibility: 'participants',
      targetMemberIds,
      replyToMessageId: undefined,
      rootMessageId,
      causationId,
      runId,
      depth,
      createdAt: Date.now(),
    }
    appendMessage(message)
    return message
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
      this.markEnvelopeAccepted(run.id, room.id)
      this.broadcast(room.id, 'run-started')

      // 组装上下文投影 + 调后端
      const allMembers = loadMembers(room.id)
      const messages = listMessagesByRoom(room.id)
      const pendingMailbox = listActiveMailboxForMember(member.id)
      const projected = projectCollaborationTurnContext({
        room,
        member,
        members: allMembers,
        messages,
        trigger: triggerMessage,
        roomSummary: latestCollaborationRoomSummaryText(getCollaborationSummary(room.id)),
        mailboxPreview: pendingMailbox
          .filter(
            (e) =>
              e.toMemberId === member.id &&
              (e.state === 'pending' || e.state === 'delivered'),
          )
          .slice(-6)
          .map((e) => ({
            fromName:
              allMembers.find((m) => m.id === e.fromMemberId)?.displayName ?? '成员',
            type:
              e.type === 'question'
                ? '提问'
                : e.type === 'reply'
                  ? '回复'
                  : '通知',
            payload: e.payload,
          })),
      })
      const prompt = flattenProjectedTurn(projected.messages)
      let streamed = ''
      const input: MemberTurnInput = {
        roomId: room.id,
        memberId: member.id,
        runId: run.id,
        triggerMessageId: triggerMessage.id,
        channelId: member.channelId,
        modelId: member.modelId,
        systemPrompt: projected.systemPrompt,
        prompt,
        signal: controller.signal,
        onTextDelta: (delta: string) => {
          if (!delta) return
          streamed += delta
          this.onTextDelta({
            roomId: room.id,
            runId: run.id,
            memberId: member.id,
            text: streamed,
            at: Date.now(),
          })
        },
        hostToolHandler: async (call) => {
          switch (call.name) {
            case 'room_send': {
              const result = this.roomSend({
                roomId: room.id,
                fromRunId: run.id,
                toMemberId: call.arguments.toMemberId ?? '',
                payload: call.arguments.message ?? '',
              })
              return result.ok
                ? { output: `通知已发送（envelope=${result.envelopeId}）` }
                : { output: `room_send 被拒绝：${result.reason}`, isError: true }
            }
            case 'room_ask': {
              const result = this.roomAsk({
                roomId: room.id,
                fromRunId: run.id,
                toMemberId: call.arguments.toMemberId ?? '',
                question: call.arguments.question ?? '',
              })
              if (!result.ok) return { output: `room_ask 被拒绝：${result.reason}`, isError: true }
              // 先成功落盘 question，再 CAS 释放执行槽；CAS 失败不把半完成 ask 伪装为等待。
              const awaiting = this.markRunAwaitingPeer(run.id)
              return awaiting
                ? { output: `提问已发送（request=${result.requestId}），正在等待对方回复。`, awaitPeer: true }
                : { output: 'room_ask 已落盘但当前 run 未能进入 awaiting_peer，已停止后续执行。', isError: true }
            }
            case 'room_reply': {
              const result = this.roomReply({
                roomId: room.id,
                fromRunId: run.id,
                requestId: call.arguments.requestId ?? '',
                answer: call.arguments.answer ?? '',
              })
              return result.ok
                ? { output: `回复已发送（envelope=${result.envelopeId}）` }
                : { output: `room_reply 被拒绝：${result.reason}`, isError: true }
            }
            case 'room_task_update': {
              // 受控任务更新：宿主校验归属/挂板/负责人/状态机；summary 仅作可审计事件。
              // 成功/失败均回注安全文本；绝不暴露 filesystem/shell/database，也改不了权威字段。
              const result = this.roomTaskUpdate({
                roomId: room.id,
                fromRunId: run.id,
                taskId: call.arguments.taskId ?? '',
                status: call.arguments.status ?? '',
                summary: call.arguments.summary,
              })
              return result.ok
                ? {
                    output: `任务已更新（task=${result.taskId}，状态=${result.status}，version=${result.version}）`,
                  }
                : { output: `room_task_update 被拒绝：${result.reason}`, isError: true }
            }
          }
        },
      }
      const result = await this.adapter.runTurn(input)

      // 被取消则不写成员消息。awaiting_peer / 已被 continuation 收口的 run 不得覆盖为 cancelled。
      if (controller.signal.aborted) {
        const current = getRun(run.id)
        if (
          current?.status === 'awaiting_peer' ||
          current?.status === 'done' ||
          current?.status === 'blocked'
        ) {
          return
        }
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
      this.kickSummary(room)
    } catch (err) {
      if (controller.signal.aborted) {
        const current = getRun(run.id)
        if (
          current?.status === 'awaiting_peer' ||
          current?.status === 'done' ||
          current?.status === 'blocked'
        ) {
          return
        }
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

  /**
   * 更新已有成员（改显示名 / 渠道 / 模型）。
   * 不改 isCoordinator、logicalSessionId、权限档位（安全字段）。
   */
  updateMember(input: UpdateCollaborationMemberInput): CollaborationMember {
    const member = getMember(input.memberId)
    if (!member) {
      throw new Error('成员不存在')
    }
    if (member.roomId !== input.roomId) {
      throw new Error('成员不属于该房间')
    }
    const room = getRoom(input.roomId)
    if (!room) {
      throw new Error('房间不存在')
    }
    if (room.status === 'archived') {
      throw new Error('已归档房间不能修改成员')
    }

    let displayName = member.displayName
    let mentionAliases = member.mentionAliases
    if (input.displayName !== undefined) {
      displayName = input.displayName.trim()
      if (!displayName) {
        throw new Error('成员显示名不能为空')
      }
      mentionAliases = nextCollaborationMentionAliases(
        member.mentionAliases,
        member.displayName,
        displayName,
      )
    }

    const channelChanged = input.channelId !== undefined && input.channelId !== (member.channelId ?? '')
    const nextChannelId =
      input.channelId === undefined ? member.channelId : input.channelId || undefined
    let nextModelId = input.modelId === undefined ? member.modelId : input.modelId || undefined
    // 换渠道且未同时指定模型 → 清掉旧模型，由 adapter 回落新渠道默认
    if (channelChanged && input.modelId === undefined) {
      nextModelId = undefined
    }

    const updated: CollaborationMember = {
      ...member,
      displayName,
      mentionAliases: mentionAliases && mentionAliases.length > 0 ? mentionAliases : undefined,
      channelId: nextChannelId,
      modelId: nextModelId,
      capabilities: {
        ...member.capabilities,
        supportsToolBridge: channelSupportsRoomToolBridge(nextChannelId),
      },
      updatedAt: Date.now(),
    }
    upsertMember(updated)
    this.broadcast(input.roomId, 'updated')
    return updated
  }

  // ===== Room Task（S5：无看板时的轻量任务真值） =====
  //
  // 02-RUNTIME-A2A-SPEC §2.6 / 03-IMPLEMENTATION-PHASES §7：room task 仅在房间未挂载看板
  // （attachedBoardId 为空）时是任务真值。挂载看板后任务真值归看板，room 不再维护另一份
  // 独立任务状态（不变量 §15.7）；此处 create/update 一律 fail closed，list/get 仍开放
  // 供历史追溯。本切片不做看板桥 / 产物 / 模型工具（room_task_update 等）。

  /**
   * 创建轻量 room task（仅未挂载看板时）。
   *
   * - 房间须存在且未挂载看板：挂载后任务真值归看板，不能在房间内创建（不变量 §15.7）。
   * - 标题必填非空；负责人（若指定）须为本房间成员。
   * - 初始 status='todo'、version=1。
   */
  createRoomTask(input: CreateCollaborationRoomTaskInput): CollaborationRoomTask {
    const room = getRoom(input.roomId)
    if (!room) {
      throw new Error('房间不存在')
    }
    if (this.roomHasAttachedBoard(room)) {
      throw new Error('房间已挂载看板，任务真值由看板维护，不能在房间内创建任务')
    }
    const title = input.title?.trim() ?? ''
    if (!title) {
      throw new Error('任务标题不能为空')
    }
    const assigneeMemberId = this.validateAssignee(input.assigneeMemberId, room.id)

    const now = Date.now()
    const task: CollaborationRoomTask = {
      id: genId(COLLABORATION_ROOM_TASK_ID_PREFIX),
      roomId: room.id,
      title,
      description: input.description?.trim() || undefined,
      status: 'todo',
      assigneeMemberId,
      sourceMessageId: input.sourceMessageId || undefined,
      runId: input.runId || undefined,
      dependsOnTaskIds: dedupeDependsOn(input.dependsOnTaskIds),
      acceptanceCriteria: input.acceptanceCriteria?.trim() || undefined,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    upsertRoomTask(task)
    this.broadcast(room.id, 'updated')
    return task
  }

  /** 列出某房间全部 room task（按 createdAt 升序，次按 id 稳定） */
  listRoomTasks(roomId: string): CollaborationRoomTask[] {
    return listRoomTasksByRoom(roomId)
  }

  /** 取单个 room task（不存在返回 undefined） */
  getRoomTaskById(taskId: string): CollaborationRoomTask | undefined {
    return getRoomTask(taskId)
  }

  /**
   * 更新轻量 room task（仅未挂载看板时）。
   *
   * - 任务须存在且属于 input.roomId（拒绝跨房间）。
   * - 房间已挂载看板 → 拒绝（不变量 §15.7）。
   * - status 变化须通过严格状态机（transitionCollaborationRoomTaskStatus）；不变则跳过。
   * - 新负责人（若指定）须为本房间成员；传空字符串解除指派。
   * - expectedVersion（若提供）须与当前 version 一致；写时 CAS 防覆盖。
   * - version 自增；updatedAt 刷新。
   */
  updateRoomTask(input: UpdateCollaborationRoomTaskInput): CollaborationRoomTask {
    const current = getRoomTask(input.taskId)
    if (!current) {
      throw new Error('任务不存在')
    }
    if (current.roomId !== input.roomId) {
      throw new Error('任务不属于该房间')
    }
    const room = getRoom(input.roomId)
    if (!room) {
      throw new Error('房间不存在')
    }
    if (this.roomHasAttachedBoard(room)) {
      throw new Error('房间已挂载看板，任务真值由看板维护，不能在房间内修改任务')
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new Error('任务版本已过期，请刷新后重试')
    }

    // 状态迁移校验（严格状态机）
    const nextStatus =
      input.status !== undefined && input.status !== current.status
        ? this.validateTaskTransition(current.status, input.status)
        : current.status

    // 标题（若改）
    const nextTitle =
      input.title !== undefined ? this.validateTaskTitle(input.title) : current.title

    // 负责人（若改；空字符串解除指派）
    let nextAssignee = current.assigneeMemberId
    if (input.assigneeMemberId !== undefined) {
      nextAssignee = this.validateAssignee(input.assigneeMemberId, room.id)
    }

    const now = Date.now()
    const next: CollaborationRoomTask = {
      ...current,
      title: nextTitle,
      description:
        input.description !== undefined
          ? input.description.trim() || undefined
          : current.description,
      status: nextStatus,
      assigneeMemberId: nextAssignee,
      acceptanceCriteria:
        input.acceptanceCriteria !== undefined
          ? input.acceptanceCriteria.trim() || undefined
          : current.acceptanceCriteria,
      runId: input.runId !== undefined ? input.runId || undefined : current.runId,
      version: current.version + 1,
      updatedAt: now,
    }

    if (!saveRoomTaskIfCurrent(input.taskId, current.version, next)) {
      throw new Error('任务已被其他操作更新，请刷新后重试')
    }
    this.broadcast(room.id, 'updated')
    return next
  }

  /**
   * room_task_update：成员运行时受控更新「分配给自己」的房间任务状态（S5 第二刀模型工具）。
   *
   * 这是模型在房间里能触发的受限副作用之一（02-RUNTIME-A2A-SPEC §2.6 / 03-IMPLEMENTATION-PHASES §7）。
   * 宿主严格校验、绝不就地伪造；安全字段（roomId/memberId）取自 run 上下文，不接受外部传入——
   * 模型无法伪造房间或发起人。
   *
   * 守卫（全部 fail-closed，返回 { ok: false, reason } 由宿主回注安全文本）：
   * - 房间须存在且 active；run 须 running/awaiting_peer；发起成员须存在且属于本房间。
   * - 任务须存在且属于本房间（拒绝跨房间：模型即便知道别房间 taskId 也碰不到）。
   * - 房间未挂载看板（attachedBoardId 为空）；挂板后任务真值归看板，房间内不再改（不变量 §15.7）。
   * - task.assigneeMemberId 恰等于发起成员：未指派 / 指派给别人的任务一律拒绝——模型不能改
   *   别人的任务，也不能把未指派任务据为己有（指派是宿主/用户行为，非模型行为）。
   * - status 须为合法枚举且经严格状态机（transitionCollaborationRoomTaskStatus）；自环拒绝。
   * - summary（可选）仅作为可审计 task_event 消息记录在时间线，绝不写入 title/description/
   *   acceptanceCriteria/assigneeMemberId 等权威字段；超长拒绝。task_event 与成员正文同级
   *   （系统提示已声明其他成员正文非指令），不会被当作指令注入。
   * - 此工具只能改 status + 记录 summary 事件；不能创建任务、改负责人、改验收标准、改标题/描述。
   *
   * 成功后 version 自增（CAS 防并发覆盖）并广播；返回 ok+version 供宿主回注安全文本。
   */
  roomTaskUpdate(input: {
    roomId: string
    fromRunId: string
    taskId: string
    status: string
    summary?: string
  }):
    | { ok: true; taskId: string; status: CollaborationRoomTaskStatus; version: number }
    | { ok: false; reason: string } {
    const room = getRoom(input.roomId)
    if (!room) return { ok: false, reason: '房间不存在' }
    if (room.status !== 'active') return { ok: false, reason: `房间状态非 active：${room.status}` }

    const run = getRun(input.fromRunId)
    if (!run) return { ok: false, reason: 'run 不存在' }
    if (run.status !== 'running' && run.status !== 'awaiting_peer') {
      return { ok: false, reason: `run 非 running/awaiting_peer：${run.status}` }
    }
    const fromMember = getMember(run.memberId)
    if (!fromMember || fromMember.roomId !== room.id) {
      return { ok: false, reason: '发起成员不存在或不属于本房间' }
    }

    const task = getRoomTask(input.taskId)
    if (!task) return { ok: false, reason: '任务不存在' }
    if (task.roomId !== room.id) return { ok: false, reason: '任务不属于该房间' }
    if (this.roomHasAttachedBoard(room)) {
      return { ok: false, reason: '房间已挂载看板，任务真值由看板维护，不能在房间内修改任务' }
    }
    // 恰等于发起成员：未指派 / 别人的任务一律拒绝（模型不能改别人的任务，也不能认领未指派任务）
    if (!task.assigneeMemberId) {
      return { ok: false, reason: '任务未指派给任何成员，无法通过工具更新（指派由宿主/用户完成）' }
    }
    if (task.assigneeMemberId !== fromMember.id) {
      return { ok: false, reason: '你不是该任务的负责人，无法更新' }
    }

    // summary 仅作可审计事件，不进权威字段；超长拒绝
    const summary = input.summary !== undefined ? input.summary.trim() : undefined
    if (summary && summary.length > COLLABORATION_ROOM_TASK_SUMMARY_MAX_LENGTH) {
      return {
        ok: false,
        reason: `说明过长（超过 ${COLLABORATION_ROOM_TASK_SUMMARY_MAX_LENGTH} 字），请精简`,
      }
    }

    // status 合法性 + 严格状态机（自环拒绝）
    if (!isCollaborationRoomTaskStatus(input.status)) {
      return { ok: false, reason: `非法任务状态：${String(input.status)}` }
    }
    // 捕获到 const 局部：避免 input.status（属性访问）的窄化在下方函数调用后被 TS 视作失效
    const targetStatus: CollaborationRoomTaskStatus = input.status
    const transition = transitionCollaborationRoomTaskStatus(task.status, targetStatus)
    if (!transition.ok) {
      return { ok: false, reason: transition.reason }
    }

    const now = Date.now()
    const next: CollaborationRoomTask = {
      ...task,
      status: targetStatus,
      version: task.version + 1,
      updatedAt: now,
    }
    if (!saveRoomTaskIfCurrent(task.id, task.version, next)) {
      return { ok: false, reason: '任务已被其他操作更新，请刷新后重试' }
    }

    // 记录可审计 task_event（summary 仅作时间线事件，非指令，不写入任务权威字段）
    this.appendTaskEventMessage(room, fromMember, task, targetStatus, summary, run)

    this.broadcast(room.id, 'updated')
    return { ok: true, taskId: task.id, status: targetStatus, version: next.version }
  }

  /**
   * 发布产物：宿主代写文件到房间绑定工作区，再登记元数据 + artifact 消息。
   *
   * 偏离 spec 02-RUNTIME-A2A-SPEC §5「只登记」：当前 channel 后端成员无写文件工具，
   * 故由宿主按 content 代写；CLI 后端（backend==='cli'）补齐、成员具备真实写工具后，
   * 回归「只登记」——移除 content 参数与宿主 writeFile，仅校验路径/权限/越界并登记元数据。
   *
   * 守卫顺序（每步 fail-closed）：房间 active → run running/awaiting_peer → 成员归属 →
   * permissionProfile==='workspace-write' → workspaceId 存在 → 解析 projectDirectory →
   * relativePath 安全校验（拒绝对路径/越界/symlink）→ 写文件 → sha256 → 落 artifact + 消息 → 广播。
   */
  async roomPublishArtifact(input: {
    roomId: string
    fromRunId: string
    relativePath: string
    content: string
    summary?: string
    taskId?: string
  }): Promise<
    | { ok: true; artifactId: string; relativePath: string; hash: string; size: number }
    | { ok: false; reason: string }
  > {
    const room = getRoom(input.roomId)
    if (!room) return { ok: false, reason: '房间不存在' }
    if (room.status !== 'active') return { ok: false, reason: `房间状态非 active：${room.status}` }

    const run = getRun(input.fromRunId)
    if (!run) return { ok: false, reason: 'run 不存在' }
    if (run.status !== 'running' && run.status !== 'awaiting_peer') {
      return { ok: false, reason: `run 非 running/awaiting_peer：${run.status}` }
    }
    const fromMember = getMember(run.memberId)
    if (!fromMember || fromMember.roomId !== room.id) {
      return { ok: false, reason: '发起成员不存在或不属于本房间' }
    }
    // permissionProfile 授权：仅 workspace-write 可发布产物（read-only 拒绝）
    if (fromMember.permissionProfile !== 'workspace-write') {
      return { ok: false, reason: '成员为 read-only 权限，禁止发布产物' }
    }
    // workspaceId 存在（无则 fail-closed，无法解析写入根）
    if (!room.workspaceId) return { ok: false, reason: '房间未绑定工作区，无法发布产物' }
    const ws = getWorkspaceById(room.workspaceId)
    if (!ws?.projectDirectory) {
      return { ok: false, reason: '工作区不存在或无 projectDirectory，无法发布产物' }
    }

    // relativePath 安全校验：拒空 / 绝对盘符 / POSIX 绝对 / UNC；.. 越界交 isPathInsideRoot 兜底
    if (!isRelativePathSafe(input.relativePath)) {
      return { ok: false, reason: 'relativePath 不能为空或绝对路径' }
    }
    const rootAbs = normalizeToAbsolute(ws.projectDirectory)
    const fileAbs = normalizeToAbsolute(path.join(rootAbs, input.relativePath))
    // 写前 realpath 根（处理 junction/symlink）；目标文件尚不存在时 resolveReal 回落为自身
    const realRoot = await resolveReal(rootAbs)
    const realFile = await resolveReal(fileAbs)
    if (!isPathInsideRoot(realFile, realRoot)) {
      return { ok: false, reason: '产物路径越出工作区根，已拒绝' }
    }

    // 写文件（mkdir -p 父目录 + 原子写 UTF-8 文本）
    try {
      await mkdir(path.dirname(realFile), { recursive: true })
      await writeFile(realFile, input.content, 'utf8')
    } catch (err) {
      return { ok: false, reason: `写文件失败：${err instanceof Error ? err.message : String(err)}` }
    }

    // sha256（按内容字节计算；append-only，无 CAS）
    const buf = Buffer.from(input.content, 'utf8')
    const hash = createHash('sha256').update(buf).digest('hex')
    const size = buf.byteLength
    const now = Date.now()
    const artifact: CollaborationArtifact = {
      id: genId(COLLABORATION_ARTIFACT_ID_PREFIX),
      roomId: room.id,
      relativePath: input.relativePath.replace(/\\/g, '/'),
      hash,
      size,
      authorMemberId: fromMember.id,
      runId: run.id,
      taskId: input.taskId?.trim() || undefined,
      summary: input.summary?.trim() || undefined,
      createdAt: now,
    }
    appendArtifact(artifact)

    this.appendArtifactMessage(room, fromMember, artifact, run)
    this.broadcast(room.id, 'updated')
    return { ok: true, artifactId: artifact.id, relativePath: artifact.relativePath, hash, size }
  }

  /** relativePath 是否安全可写：拒绝空 / 绝对盘符 / POSIX 绝对 / UNC；.. 越界交 isPathInsideRoot 兜底。 */
  private appendArtifactMessage(
    room: CollaborationRoom,
    member: CollaborationMember,
    artifact: CollaborationArtifact,
    run: CollaborationRun,
  ): void {
    const taskHint = artifact.taskId ? `（关联任务 ${artifact.taskId}）` : ''
    const summaryHint = artifact.summary ? `：${artifact.summary}` : ''
    const content = `产物已发布：${artifact.relativePath} by ${member.displayName}${taskHint}${summaryHint}`
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: 'member',
      authorId: member.id,
      kind: 'artifact',
      content,
      visibility: 'room',
      targetMemberIds: [],
      replyToMessageId: undefined,
      rootMessageId: run.triggerMessageId,
      causationId: run.id,
      runId: run.id,
      taskId: artifact.taskId,
      depth: 0,
      createdAt: Date.now(),
    }
    appendMessage(message)
  }
    from: CollaborationRoomTaskStatus,
    to: CollaborationRoomTaskStatus,
  ): CollaborationRoomTaskStatus {
    if (!isCollaborationRoomTaskStatus(to)) {
      throw new Error(`非法任务状态：${String(to)}`)
    }
    const res = transitionCollaborationRoomTaskStatus(from, to)
    if (!res.ok) {
      throw new Error(res.reason)
    }
    return to
  }

  private validateTaskTitle(title: string): string {
    const t = title.trim()
    if (!t) {
      throw new Error('任务标题不能为空')
    }
    return t
  }

  /**
   * 校验负责人归属：空字符串 → undefined（解除指派）；非空须为本房间成员。
   * create/update 共用，拒绝跨房间成员。
   */
  private validateAssignee(
    assigneeMemberId: string | undefined,
    roomId: string,
  ): string | undefined {
    if (assigneeMemberId === undefined) return undefined
    const id = assigneeMemberId.trim()
    if (!id) return undefined
    const assignee = getMember(id)
    if (!assignee || assignee.roomId !== roomId) {
      throw new Error('负责人不属于该房间')
    }
    return id
  }

  /** 房间是否已挂载看板（true 时 room task 不再是任务真值） */
  private roomHasAttachedBoard(room: CollaborationRoom): boolean {
    return Boolean(room.attachedBoardId)
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

  /**
   * 触发房间共享摘要（§6.6）：不占 maxConcurrentRuns、非阻塞、fail-closed。
   * runner 内部失败/无渠道/超预算都只置 status='failed'，绝不抛错阻塞本方法/发言。
   */
  private kickSummary(room: CollaborationRoom): void {
    if (room.status !== 'active') return
    this.summaryRunner.run(room.id).catch((err) => {
      console.error('[协作室摘要] 后台总结触发失败（不影响成员发言）:', err)
    })
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

  /**
   * 落盘一条 task_event 消息（room_task_update 的可审计事件）。
   *
   * summary 仅作为时间线记录（与成员正文同级，系统提示已声明非指令），绝不写入任务的权威字段。
   * content 形如「任务「标题」状态：todo → in_progress。说明：…」。
   */
  private appendTaskEventMessage(
    room: CollaborationRoom,
    member: CollaborationMember,
    task: CollaborationRoomTask,
    nextStatus: CollaborationRoomTaskStatus,
    summary: string | undefined,
    run: CollaborationRun,
  ): void {
    const content = [`任务「${task.title}」状态：${task.status} → ${nextStatus}`, summary ? `说明：${summary}` : '']
      .filter(Boolean)
      .join('。')
    const message: CollaborationMessage = {
      id: genId(COLLABORATION_MESSAGE_ID_PREFIX),
      roomId: room.id,
      authorType: 'member',
      authorId: member.id,
      kind: 'task_event',
      content,
      visibility: 'room',
      targetMemberIds: [],
      replyToMessageId: undefined,
      rootMessageId: run.triggerMessageId,
      causationId: run.id,
      runId: run.id,
      taskId: task.id,
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
 * S3.5-a：把投影结果 flatten 成现有 adapter 需要的单段 prompt（04 §5.3）。
 * S4-3 升级 tool bridge 时应改为直接传 messages 数组，不再 flatten。
 */
function flattenProjectedTurn(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  return messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
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

/** 依赖任务 ID 去重保序（trim + 跳过空串）；空结果返回 undefined，避免落盘空数组 */
function dedupeDependsOn(ids?: string[]): string[] | undefined {
  if (!ids || ids.length === 0) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const t = id?.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out.length > 0 ? out : undefined
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
  const channelId = spec.channelId ?? autoBind?.channelId
  return {
    id: genId(COLLABORATION_MEMBER_ID_PREFIX),
    roomId,
    displayName,
    roleId: spec.roleId,
    roleSnapshot: spec.roleSnapshot ?? { roleId: spec.roleId, displayName },
    backend: spec.backend ?? 'channel',
    channelId,
    modelId: spec.modelId ?? autoBind?.modelId,
    cliWorkerId: spec.cliWorkerId,
    logicalSessionId: genId(COLLABORATION_LOGICAL_SESSION_ID_PREFIX),
    permissionProfile: spec.permissionProfile ?? 'read-only',
    capabilities: {
      ...DEFAULT_MEMBER_CAPABILITIES,
      ...(spec.capabilities ?? {}),
      // 不能由创建方把外部渠道宣称成有工具回路；只有已接入的 kscc 才可为 true。
      supportsToolBridge:
        channelSupportsRoomToolBridge(channelId) && spec.capabilities?.supportsToolBridge !== false,
    },
    status: 'offline',
    isCoordinator: spec.isCoordinator ?? false,
    createdAt: now,
    updatedAt: now,
  }
}
