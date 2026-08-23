/**
 * 持久 Outbox Worker（P1-3）。
 *
 * 在 `FusionRoomHost.recoverInterruptedRuns` 之后扫描各房间的可观察 continuation
 *（复用 `listFusionContinuations`），对**无/未启动副作用**的项做安全自动 drain，对存在
 * 未知副作用的项只观察、绝不自动重放。
 *
 * 安全自动 drain（仅两类）：
 * - `approved_awaiting_resume`：用户已批准（`requiresUserConfirm=false`），等价于用户刚
 *   resolve-approval → 以房主 actor 调 `executionBridge.handleAction({type:'resolve-approval'}, approval)`
 *   驱动 execution bridge 拉新 turn（与 P1-1b approval 路径一致）。
 * - `mailbox_outbox` 且 drain 前再读 snapshot 确认 `delivery==='outbox'`（尚未 dispatched，
 *   对齐 legacy「无 deliveryRunId 可安全重投」）：以房主 actor 调
 *   `host.confirmResumeContinuation`（幂等）把 delivery 推进为 dispatched，再让 bridge 处理
 *   `confirm-resume-continuation` 结果以新 turn 唤醒 toMember。
 *
 * 绝不自动（只 observe，不改 snapshot）：`blocked_run`、`pending_approval`、`depth_stop`、
 * `awaiting_peer`，以及任何已 dispatched/accepted 的信封。`blocked_run` 永不写入
 * processed-as-auto。
 *
 * 持久化：已 drain 的 continuation 键（`roomId:kind:continuationId`）原子写入状态文件，
 * 避免重启后重复驱动；authority 层的 idempotencyKey / bridge inflight 去重作为兜底。
 *
 * 设计红线（P1-3 brief）：不默认开短轮询；不自动重放 blocked_run / outcome_unknown；
 * 不动无关未提交 UI 文件。
 */
import { join } from 'node:path'
import type {
  FusionContinuationItem,
  FusionContinuationKind,
  FusionRoomHost,
} from '@tagent/core'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getCollaborationDir } from '../config/config-paths'
import type { FusionRoomExecutionBridge } from './fusion-room-execution-bridge'

export type OutboxDrainAction =
  | {
      kind: 'auto'
      continuationId: string
      continuationKind: FusionContinuationKind
      result: 'drained' | 'skipped' | 'failed'
      detail?: string
    }
  | {
      kind: 'observe'
      continuationId: string
      continuationKind: FusionContinuationKind
      reason: string
    }

export interface FusionRoomOutboxWorkerOptions {
  host: FusionRoomHost
  executionBridge?: FusionRoomExecutionBridge
  /** 状态文件路径；默认 getCollaborationDir()/fusion-outbox-worker.json */
  statePath?: string
  /** 系统 drain 使用的 actor；默认各房间 ownerUserId */
  resolveActorUserId?: (roomId: string) => string
}

interface OutboxWorkerState {
  version: 1
  processedKeys: string[]
}

const STATE_VERSION = 1

/**
 * 分类单条 continuation 是否可安全自动 drain。
 *
 * - `auto`：`approved_awaiting_resume`（用户已批准）或 `mailbox_outbox`（调用方再校验
 *   `delivery==='outbox'`）——这两类要么无副作用、要么尚未启动任何模型调用。
 * - `observe`：其余（`blocked_run` / `pending_approval` / `depth_stop` / `awaiting_peer`），
 *   存在未知副作用或需用户显式确认，绝不自动推进。
 */
export function classifyOutboxDrain(item: FusionContinuationItem): 'auto' | 'observe' {
  if (item.kind === 'approved_awaiting_resume' || item.kind === 'mailbox_outbox') {
    return 'auto'
  }
  return 'observe'
}

export class FusionRoomOutboxWorker {
  private readonly host: FusionRoomHost
  private readonly bridge: FusionRoomExecutionBridge | undefined
  private readonly statePath: string
  private readonly resolveActorUserId: (roomId: string) => string
  private processedKeys: Set<string>

  constructor(options: FusionRoomOutboxWorkerOptions) {
    this.host = options.host
    this.bridge = options.executionBridge
    this.statePath = options.statePath ?? join(getCollaborationDir(), 'fusion-outbox-worker.json')
    this.resolveActorUserId = options.resolveActorUserId ?? ((roomId: string) => {
      // 默认以房主作为系统 drain actor（与 active human 守卫对齐）。
      return this.host.getSnapshot(roomId).ownerUserId
    })
    this.processedKeys = new Set(this.readState().processedKeys)
  }

  /** 只读扫描：某房间可观察 continuation。不触发副作用、不自动推进。 */
  scan(roomId: string): FusionContinuationItem[] {
    return this.host.listContinuations(roomId)
  }

  /** 只读扫描：所有房间可观察 continuation。 */
  scanAll(): Array<{ roomId: string; items: FusionContinuationItem[] }> {
    return this.host.listRoomIds().map((roomId) => ({ roomId, items: this.scan(roomId) }))
  }

  /** 已处理（已自动 drain）的 continuation 键，持久化跨重启。 */
  listProcessedKeys(): string[] {
    return [...this.processedKeys].sort()
  }

  /**
   * 对单房间执行 drain 策略，返回动作日志。
   *
   * observe 项只记日志、不改 snapshot；auto 项若已处理则跳过，否则安全推进并在成功后
   * 记入 processed。blocked_run 永不进入 auto 分支，故永不写入 processed-as-auto。
   */
  drainRoom(roomId: string): OutboxDrainAction[] {
    const actions: OutboxDrainAction[] = []
    let changed = false
    let items: FusionContinuationItem[]
    try {
      items = this.scan(roomId)
    } catch {
      // 房间不存在或已被移除：跳过，不阻断其他房间。
      return actions
    }
    for (const item of items) {
      if (classifyOutboxDrain(item) === 'observe') {
        actions.push({
          kind: 'observe',
          continuationId: item.id,
          continuationKind: item.kind,
          reason: observeReason(item.kind),
        })
        continue
      }
      const key = processedKey(roomId, item)
      if (this.processedKeys.has(key)) {
        actions.push({
          kind: 'auto',
          continuationId: item.id,
          continuationKind: item.kind,
          result: 'skipped',
          detail: 'already processed',
        })
        continue
      }
      const action = this.drainItem(roomId, item)
      actions.push(action)
      if (action.kind === 'auto' && action.result === 'drained') {
        this.processedKeys.add(key)
        changed = true
      }
    }
    if (changed) this.writeState()
    return actions
  }

  /** 对所有房间执行 drain 策略，返回合并动作日志。 */
  drainAll(): OutboxDrainAction[] {
    const actions: OutboxDrainAction[] = []
    for (const roomId of this.host.listRoomIds()) {
      actions.push(...this.drainRoom(roomId))
    }
    return actions
  }

  private drainItem(roomId: string, item: FusionContinuationItem): OutboxDrainAction {
    if (item.kind === 'approved_awaiting_resume') {
      return this.drainApprovedAwaitingResume(roomId, item)
    }
    if (item.kind === 'mailbox_outbox') {
      return this.drainMailboxOutbox(roomId, item)
    }
    // classifyOutboxDrain 仅对上述两类返回 auto；防御性 observe。
    return {
      kind: 'observe',
      continuationId: item.id,
      continuationKind: item.kind,
      reason: '非自动 drain 类型：' + item.kind,
    }
  }

  /**
   * `approved_awaiting_resume`：用户已批准，等价于用户刚 resolve-approval。从 snapshot
   * 取 approval，调 `bridge.handleAction({type:'resolve-approval'}, approval)` 驱动
   * execution bridge 拉新 turn。bridge 未注入则只记 skipped（不写 processed，便于后续
   * 注入 bridge 后再 drain）。
   */
  private drainApprovedAwaitingResume(roomId: string, item: FusionContinuationItem): OutboxDrainAction {
    const approvalId = item.refs?.approvalId
    if (!approvalId) {
      return {
        kind: 'auto', continuationId: item.id, continuationKind: item.kind,
        result: 'skipped', detail: '缺少 approvalId，无法定位 approval',
      }
    }
    if (!this.bridge) {
      return {
        kind: 'auto', continuationId: item.id, continuationKind: item.kind,
        result: 'skipped', detail: '未注入 executionBridge，需用户手动 resume',
      }
    }
    let snapshot
    try {
      snapshot = this.host.getSnapshot(roomId)
    } catch {
      return {
        kind: 'auto', continuationId: item.id, continuationKind: item.kind,
        result: 'failed', detail: '读取快照失败',
      }
    }
    const approval = snapshot.approvals.find((item) => item.id === approvalId)
    if (!approval || approval.status !== 'approved') {
      return {
        kind: 'auto', continuationId: item.id, continuationKind: item.kind,
        result: 'skipped', detail: 'approval 不再为 approved（' + (approval?.status ?? 'missing') + '）',
      }
    }
    try {
      this.bridge.handleAction(roomId, { type: 'resolve-approval' }, approval)
      return {
        kind: 'auto', continuationId: item.id, continuationKind: item.kind,
        result: 'drained',
      }
    } catch (error) {
      return {
        kind: 'auto', continuationId: item.id, continuationKind: item.kind,
        result: 'failed', detail: errMsg(error),
      }
    }
  }

  /**
   * `mailbox_outbox`：drain 前再读 snapshot 确认 `delivery==='outbox'`（对齐 legacy「无
   * deliveryRunId 可安全重投」）。以房主 actor 调 `host.confirmResumeContinuation`（幂等）
   * 推进 delivery → dispatched，再让 bridge 处理 `confirm-resume-continuation` 结果以新
   * turn 唤醒 toMember。bridge 未注入则 skipped（不写 processed）；delivery 已非 outbox
   * 则 observe（不推进，不写 processed）。
   */
  private drainMailboxOutbox(roomId: string, item: FusionContinuationItem): OutboxDrainAction {
    const envelopeId = item.refs?.envelopeId ?? item.id
    if (!this.bridge) {
      return {
        kind: 'auto', continuationId: item.id, continuationKind: item.kind,
        result: 'skipped', detail: '未注入 executionBridge，需用户手动 resume',
      }
    }
    let snapshot
    try {
      snapshot = this.host.getSnapshot(roomId)
    } catch {
      return {
        kind: 'auto', continuationId: item.id, continuationKind: item.kind,
        result: 'failed', detail: '读取快照失败',
      }
    }
    const envelope = snapshot.mailbox.find((item) => item.id === envelopeId)
    if (!envelope || envelope.delivery !== 'outbox') {
      // 已 dispatched/accepted/outcome_unknown 等不可重投：只观察，绝不自动再投递。
      return {
        kind: 'observe', continuationId: item.id, continuationKind: item.kind,
        reason: 'delivery 已非 outbox（' + (envelope?.delivery ?? 'missing') + '），不自动重投',
      }
    }
    const actorUserId = this.resolveActorUserId(roomId)
    try {
      const result = this.host.confirmResumeContinuation({
        roomId,
        actorUserId,
        continuationId: envelopeId,
        kind: 'mailbox_outbox',
        idempotencyKey: 'fusion-outbox-worker:' + envelopeId,
      })
      this.bridge.handleAction(roomId, { type: 'confirm-resume-continuation' }, result)
      return {
        kind: 'auto', continuationId: item.id, continuationKind: item.kind,
        result: 'drained',
        ...(result.status === 'already_confirmed' ? { detail: 'already_confirmed（幂等重投）' } : {}),
      }
    } catch (error) {
      return {
        kind: 'auto', continuationId: item.id, continuationKind: item.kind,
        result: 'failed', detail: errMsg(error),
      }
    }
  }

  private readState(): OutboxWorkerState {
    const parsed = readJsonSafe<Partial<OutboxWorkerState> | null>(this.statePath, null)
    if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.processedKeys)) {
      return { version: STATE_VERSION, processedKeys: [] }
    }
    return {
      version: STATE_VERSION,
      processedKeys: parsed.processedKeys.filter((key): key is string => typeof key === 'string'),
    }
  }

  private writeState(): void {
    try {
      writeJsonAtomic(this.statePath, {
        version: STATE_VERSION,
        processedKeys: [...this.processedKeys].sort(),
      } satisfies OutboxWorkerState)
    } catch {
      // 持久化失败不阻断 drain：authority 层 idempotencyKey 与 bridge inflight 去重兜底，
      // 下次启动会重新评估；最坏情况是重复 confirm（幂等）而非重复副作用。
    }
  }
}

/** 处理键：`roomId:kind:continuationId`（approval 用 approvalId、mailbox 用 envelopeId）。 */
function processedKey(roomId: string, item: FusionContinuationItem): string {
  return roomId + ':' + item.kind + ':' + item.id
}

function observeReason(kind: FusionContinuationKind): string {
  switch (kind) {
    case 'blocked_run':
      return 'blocked_run 存在未知副作用，禁止自动重放（需用户 confirm-resume 以新 turn 推进）'
    case 'pending_approval':
      return 'pending_approval 需用户显式 resolve-approval，不自动推进'
    case 'depth_stop':
      return 'depth_stop 需用户显式 continue-depth-stop，不自动推进'
    case 'awaiting_peer':
      return 'awaiting_peer 等待 peer 回复，无副作用，不需自动 drain'
    default:
      return '非自动 drain 类型：' + kind
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
