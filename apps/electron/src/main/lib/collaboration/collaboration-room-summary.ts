/**
 * S3.5-b 房间共享摘要 Runner（H4，04-HERMES-BORROW-SPEC §6.4/§6.6）
 *
 * 独立总结者调度：达到有效发言阈值 → 抢占租约（CAS）→ 复用协调者 channel/model
 * 调模型 → CAS commit 推进锚点。全程 fail-closed：
 * - 无渠道 / 模型失败 / 输入超预算 → status='failed'，不抛错、不阻塞成员发言（S6/S8）
 * - 租约未过期 → 等下一次阈值，不双跑（S4）
 * - commit 时 generation/version/锚点已变 → 留旧摘要（S5）
 * - 房间 paused / archived / completed 时不启动新摘要（§6.6）
 *
 * 摘要 run **不占** RoomScheduler 槽位、不进 maxConcurrentRuns，由 service 在成员
 * turn / 用户消息落盘后 fire-and-forget 触发。
 *
 * 测试可注入假 modelCaller（§6.7「首版可用假 adapter 注入 SummaryRunner」，不必真打模型）。
 */
import { randomUUID } from 'node:crypto'
import {
  COLLABORATION_SUMMARY_BATCH_SIZE,
  COLLABORATION_SUMMARY_LEASE_MS,
  COLLABORATION_SUMMARY_MAX_EVERY_UTTERANCES,
  COLLABORATION_SUMMARY_MAX_INPUT_CHARS,
  COLLABORATION_SUMMARY_MIN_EVERY_UTTERANCES,
  buildCollaborationSummaryModelRequest,
  countCollaborationEffectiveUtterances,
  extractCollaborationSummaryBatch,
  latestCollaborationRoomSummaryText,
  type CollaborationRoom,
  type CollaborationRoomSummary,
} from '@tagent/shared'
import { createKsccSeatRunner, createPiHttpSeatRunner, type MoASeatRunner } from '@tagent/pi-core'
import {
  claimCollaborationSummary,
  commitCollaborationSummary,
  getCollaborationSummary,
  getRoom,
  listMessagesByRoom,
  loadMembers,
  saveCollaborationSummaryIfCurrent,
} from './collaboration-room-repository'
import { resolveChannelBackendConfig } from './member-backend-adapter'

/** 单次总结模型调用超时（ms） */
const SUMMARY_MODEL_TIMEOUT_MS = 120_000

/** 总结者模型调用（注入点）。测试传假实现即可覆盖 S1–S8，不必真打模型。 */
export type CollaborationSummaryModelCaller = (input: {
  channelId?: string
  modelId?: string
  systemPrompt: string
  userPrompt: string
}) => Promise<string>

/** 一次总结的返回（供测试断言；服务侧 fire-and-forget，不看返回） */
export type CollaborationSummaryRunOutcome =
  | {
      kind: 'ran'
      summary: string
      throughMessageId: string
      summarizedUtteranceCount: number
    }
  | { kind: 'skipped-inactive' }
  | { kind: 'skip-below-threshold' }
  | { kind: 'skip-empty-batch' }
  | { kind: 'skip-lease-active' }
  | { kind: 'fail-closed'; reason: 'over-budget' | 'model-failed' | 'cas-mismatch' }

/** Runner 构造选项（全部可注入，便于测试） */
export interface CollaborationSummaryRunnerOptions {
  /** 模型调用（默认走协调者 channel/model 的真实 seat runner） */
  modelCaller?: CollaborationSummaryModelCaller
  leaseMs?: number
  /** 预估输入超预算则 fail-closed（§6.4） */
  maxInputChars?: number
  /** 测试注入时间（fake timers） */
  now?: () => number
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export class CollaborationSummaryRunner {
  private readonly modelCaller: CollaborationSummaryModelCaller
  private readonly leaseMs: number
  private readonly maxInputChars: number
  private readonly now: () => number

  constructor(opts: CollaborationSummaryRunnerOptions = {}) {
    this.modelCaller = opts.modelCaller ?? defaultSummaryModelCaller
    this.leaseMs = opts.leaseMs ?? COLLABORATION_SUMMARY_LEASE_MS
    this.maxInputChars = opts.maxInputChars ?? COLLABORATION_SUMMARY_MAX_INPUT_CHARS
    this.now = opts.now ?? Date.now
  }

  /**
   * 尝试为房间产出一份摘要。非阻塞：返回 outcome，绝不抛错。
   * service 在成员 turn / 用户发言落盘后 fire-and-forget 调用。
   */
  async run(roomId: string): Promise<CollaborationSummaryRunOutcome> {
    const room = getRoom(roomId)
    if (!room || room.status !== 'active') return { kind: 'skipped-inactive' }

    const nowTs = this.now()
    const messages = listMessagesByRoom(roomId)
    const members = loadMembers(roomId)
    const current = getCollaborationSummary(roomId)

    // 阈值（§6.3：默认 8，房间可配 4–20）
    const threshold = clamp(
      room.summaryEveryUtterances ?? 8,
      COLLABORATION_SUMMARY_MIN_EVERY_UTTERANCES,
      COLLABORATION_SUMMARY_MAX_EVERY_UTTERANCES,
    )
    const anchor = current ? current.summaryThroughMessageId : ''
    const effectiveCount = countCollaborationEffectiveUtterances(messages, anchor)
    if (effectiveCount < threshold) return { kind: 'skip-below-threshold' }

    // 认领租约（CAS）；租约未过期 → 等下一次阈值（S4）
    const runToken = randomUUID()
    const claim = claimCollaborationSummary(roomId, runToken, this.leaseMs, nowTs)
    if (!claim.ok) return { kind: 'skip-lease-active' }
    const baseline = claim.baseline

    // 锚点之后按时间取一批（最多 20 条，S3.5-b §6.3）
    const batch = extractCollaborationSummaryBatch(messages, anchor, COLLABORATION_SUMMARY_BATCH_SIZE)
    if (batch.length === 0) {
      this.markFailed(roomId, baseline, '没有可汇总的有效发言', nowTs)
      return { kind: 'skip-empty-batch' }
    }

    // 装配（§6.5 六段契约 system prompt 由 buildCollaborationSummaryModelRequest 原文落地）
    const { systemPrompt, userPrompt } = buildCollaborationSummaryModelRequest({
      room,
      members,
      previousSummary: latestCollaborationRoomSummaryText(current),
      batchMessages: batch,
    })

    // 输入超预算 → fail-closed（不调用模型，status=failed）
    if (systemPrompt.length + userPrompt.length > this.maxInputChars) {
      this.markFailed(roomId, baseline, `输入超预算（>${this.maxInputChars} 字符）`, nowTs)
      return { kind: 'fail-closed', reason: 'over-budget' }
    }

    // 复用协调者 channel/model；无渠道 / 模型失败 → fail-closed，不阻塞成员发言（S8/S6）
    const coordinator = members.find((m) => m.id === room.coordinatorMemberId) ?? members[0]
    let text: string
    try {
      text = (
        await this.modelCaller({
          channelId: coordinator?.channelId,
          modelId: coordinator?.modelId,
          systemPrompt,
          userPrompt,
        })
      ).trim()
    } catch (err) {
      this.markFailed(roomId, baseline, `模型调用失败：${err instanceof Error ? err.message : String(err)}`, nowTs)
      return { kind: 'fail-closed', reason: 'model-failed' }
    }
    if (!text) {
      this.markFailed(roomId, baseline, '模型返回空摘要', nowTs)
      return { kind: 'fail-closed', reason: 'model-failed' }
    }

    // CAS 提交（generation/version/锚点仍匹配才写；S5：被抢/失效 → 失败保留旧稿）
    const throughMessageId = batch[batch.length - 1]!.id
    // 批次上限会把积压的有效发言拆到后续 run；计数只能推进本次实际提交的
    // batch，不能把尚未写入摘要的尾部消息提前算进去。
    const summarizedUtteranceCount = (current?.summarizedUtteranceCount ?? 0) + batch.length
    const committed = commitCollaborationSummary(
      roomId,
      runToken,
      baseline,
      text,
      throughMessageId,
      summarizedUtteranceCount,
      this.now(),
    )
    if (!committed) {
      this.markFailed(roomId, baseline, '提交冲突（generation/锚点已变化）', nowTs)
      return { kind: 'fail-closed', reason: 'cas-mismatch' }
    }
    return { kind: 'ran', summary: text, throughMessageId, summarizedUtteranceCount }
  }

  /** fail-closed 落地：仅当现存行仍是本基线才标 failed 并释放租约，避免覆盖他人并发 claim（S5） */
  private markFailed(
    roomId: string,
    baseline: CollaborationRoomSummary,
    error: string,
    now: number,
  ): void {
    const current = getCollaborationSummary(roomId)
    const next: CollaborationRoomSummary = {
      ...(current ?? baseline),
      status: 'failed',
      lastError: error,
      runToken: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    }
    saveCollaborationSummaryIfCurrent(
      roomId,
      {
        generation: baseline.generation,
        version: baseline.version,
        summaryThroughMessageId: baseline.summaryThroughMessageId,
      },
      next,
    )
  }
}

/** 默认模型调用：复用房间协调者的 channel/model（04 §6.4），与成员 turn 同路。 */
export function defaultSummaryModelCaller(input: {
  channelId?: string
  modelId?: string
  systemPrompt: string
  userPrompt: string
}): Promise<string> {
  const cfg = resolveChannelBackendConfig({ channelId: input.channelId, modelId: input.modelId })
  const runner: MoASeatRunner =
    cfg.kind === 'kscc'
      ? createKsccSeatRunner({ ksccPath: cfg.ksccPath })
      : createPiHttpSeatRunner({
          provider: cfg.provider,
          apiKey: cfg.apiKey ?? '',
          baseUrl: cfg.baseUrl,
        })
  return runner.runSeat({
    modelId: cfg.modelId,
    prompt: input.userPrompt,
    systemPrompt: input.systemPrompt,
    timeoutMs: SUMMARY_MODEL_TIMEOUT_MS,
  })
}
