/**
 * Collaboration Room — A2A 纯逻辑（S4）
 *
 * 02-RUNTIME-A2A-SPEC §5–§9 的**无副作用纯函数层**：mailbox 状态迁移、深度/自环守卫、
 * 请求-回复幂等、循环指纹。全部不读 DB、不依赖时间、不触碰 backend，可在 vitest 离线跑。
 *
 * 设计红线（03-IMPLEMENTATION-PHASES §12）：
 * - 不能只靠 prompt 约束代替深度/循环/预算的宿主硬限制 → 本文件提供硬校验函数。
 * - 同一 request 只能有一个有效终态回复（幂等）。
 * - 成员不能给自己发 A2A；A→B→A 近重复问答应被阻断。
 */

import type {
  CollaborationMailboxDelivery,
  CollaborationMailboxEnvelope,
  CollaborationMailboxState,
} from './collaboration-room'

export const COLLABORATION_HARD_MAX_A2A_DEPTH = 10

/** 两人起至少四跳，随活跃成员数增长，但永不越过硬上限。 */
export function recommendedCollaborationHandoffDepth(activeMemberCount: number): number {
  return Math.min(COLLABORATION_HARD_MAX_A2A_DEPTH, Math.max(4, Math.floor(activeMemberCount) + 1))
}

/** attemptId 必须是宿主签发的 UUID；空值/任意哨兵一律拒绝。 */
export function isCollaborationAttemptId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** 同一 attempt 只允许一封信封，防止重试重复唤醒目标成员。 */
export function hasCollaborationAttempt(envelopes: CollaborationMailboxEnvelope[], attemptId: string): boolean {
  return envelopes.some((envelope) => envelope.attemptId === attemptId)
}

/** 只有满足完整宿主元数据的 max-depth 停止，才可以在时间线呈现为「可继续一次」。 */
export function isCollaborationDepthStopPresentable(input: {
  envelope: CollaborationMailboxEnvelope
  maxDepth: number
  handoffEnabled: boolean
}): boolean {
  const { envelope, maxDepth, handoffEnabled } = input
  return (
    handoffEnabled &&
    isCollaborationAttemptId(envelope.attemptId) &&
    envelope.stopReason === 'max_depth' &&
    envelope.depth >= maxDepth &&
    Boolean(envelope.sourceMessageId) &&
    Boolean(envelope.toMemberId)
  )
}

/** 用户继续一次的严格守卫：仅 max-depth 停止且从未继续过才放行。 */
export function canContinueCollaborationDepthStop(envelope: CollaborationMailboxEnvelope): boolean {
  return envelope.stopReason === 'max_depth' && envelope.continueUsed !== true && isCollaborationAttemptId(envelope.attemptId)
}

/** delivery 迁移只前进；未知结果为终态，不能被自动重放覆盖。 */
export function canTransitionCollaborationDelivery(
  from: CollaborationMailboxDelivery | undefined,
  to: CollaborationMailboxDelivery,
): boolean {
  const current = from ?? 'outbox'
  return (
    (current === 'outbox' && (to === 'dispatched' || to === 'failed' || to === 'outcome_unknown')) ||
    (current === 'dispatched' && (to === 'accepted' || to === 'failed' || to === 'outcome_unknown')) ||
    (current === 'accepted' && (to === 'failed' || to === 'outcome_unknown'))
  )
}

// ===== Mailbox 状态机（02-RUNTIME-A2A-SPEC §2.5 / §6） =====

/** 信封状态迁移动作 */
export type CollaborationMailboxTransitionAction = 'deliver' | 'answer' | 'cancel' | 'expire'

/**
 * 行使一次 mailbox 状态迁移。
 *
 * 合法迁移（其余一律拒绝）：
 * - pending  →  deliver → delivered
 * - pending  →  answer  → answered
 * - pending  →  cancel  → cancelled
 * - pending  →  expire  → expired
 * - delivered → answer  → answered
 * - delivered → cancel  → cancelled
 * - delivered → expire  → expired
 * - answered / cancelled / expired 为终态，不再迁移。
 *
 * 返回 `{ ok: true; state }` 或 `{ ok: false; reason }`（判别联合，便于调用方 fail closed）。
 */
export function transitionCollaborationMailboxState(
  state: CollaborationMailboxState,
  action: CollaborationMailboxTransitionAction,
): { ok: true; state: CollaborationMailboxState } | { ok: false; reason: string } {
  switch (action) {
    case 'deliver':
      return state === 'pending'
        ? { ok: true, state: 'delivered' }
        : { ok: false, reason: `deliver 只允许由 pending 发起，当前 ${state}` }
    case 'answer':
      if (state === 'pending' || state === 'delivered') return { ok: true, state: 'answered' }
      return { ok: false, reason: `answer 只允许由 pending/delivered 发起，当前 ${state}` }
    case 'cancel':
      if (state === 'pending' || state === 'delivered') return { ok: true, state: 'cancelled' }
      return { ok: false, reason: `cancel 只允许由 pending/delivered 发起，当前 ${state}` }
    case 'expire':
      if (state === 'pending') return { ok: true, state: 'expired' }
      return { ok: false, reason: `expire 只允许由 pending 发起，当前 ${state}` }
  }
}

/** 信封是否处于可被回复的激活态（可进行 answer 迁移） */
export function isCollaborationMailboxActive(state: CollaborationMailboxState): boolean {
  return state === 'pending' || state === 'delivered'
}

// ===== 深度 / 自环守卫（02-RUNTIME-A2A-SPEC §9） =====

/**
 * 计算子 turn 的 A2A 深度。
 *
 * parentDepth 为父事件深度；maxDepth 为房间上限（默认 4，硬上限 10，Agent 不能自行提高）。
 * 若 childDepth 超过 maxDepth → fail closed 返回 reason。
 */
export function nextCollaborationA2ADepth(
  parentDepth: number,
  maxDepth: number,
): { ok: true; depth: number } | { ok: false; reason: string } {
  if (!Number.isFinite(parentDepth) || parentDepth < 0) {
    return { ok: false, reason: `parentDepth 非法：${parentDepth}` }
  }
  if (!Number.isFinite(maxDepth) || maxDepth < 1) {
    return { ok: false, reason: `maxDepth 非法：${maxDepth}` }
  }
  const next = parentDepth + 1
  if (next > maxDepth) {
    return { ok: false, reason: `A2A 深度超限：${next} > ${maxDepth}` }
  }
  return { ok: true, depth: next }
}

/** 自环守卫：成员不能给自己发 A2A（02-RUNTIME-A2A-SPEC §9） */
export function isCollaborationSelfSend(fromMemberId: string, toMemberId: string): boolean {
  return fromMemberId === toMemberId
}

// ===== 请求-回复幂等（02-RUNTIME-A2A-SPEC §5 / §9） =====

/**
 * 回复幂等键：`{requestId}:{fromMemberId}`。
 *
 * 同一 request 对同一回复者只允许一个终态回复。用来自动识别「同一 request 已被答复」。
 */
export function collaborationReplyIdempotencyKey(requestId: string, fromMemberId: string): string {
  return `${requestId}:${fromMemberId}`
}

/**
 * A2A 信封幂等键：`{fromMemberId}:{toMemberId}:{rootMessageId}:{causationId}`。
 *
 * 用于去重：同一因果链下同一发起者→同一接收者的同等投递只能有一条，避免 A 反复 re-send
 * 同一请求导致 B 被重复唤醒。不含 payload/时间戳，保证跨调用稳定。
 */
export function collaborationEnvelopeIdempotencyKey(input: {
  fromMemberId: string
  toMemberId: string
  rootMessageId: string
  causationId: string
}): string {
  return `${input.fromMemberId}:${input.toMemberId}:${input.rootMessageId}:${input.causationId}`
}

/**
 * 判断一条 reply 是否为「重复回复」。
 *
 * 给定某 request 对应的已存在信封列表，若其中已存在：
 *   - 同 (requestId, fromMemberId) 的 reply，或
 *   - 该 request 的任意 answered 信封（任一有效的已答复）
 * 则该 reply 应被视为重复并被阻断（fail closed）。
 */
export function isCollaborationDuplicateReply(
  requestId: string,
  fromMemberId: string,
  envelopes: CollaborationMailboxEnvelope[],
): boolean {
  if (!requestId) return false
  for (const env of envelopes) {
    if (env.state === 'answered' && env.requestId === requestId) return true
    if (
      env.type === 'reply' &&
      env.requestId === requestId &&
      env.fromMemberId === fromMemberId &&
      isCollaborationMailboxActive(env.state)
    ) {
      return true
    }
  }
  return false
}

// ===== 循环指纹（02-RUNTIME-A2A-SPEC §9） =====

/**
 * 规范化文本（去空白/大小写/标点），用于近重复指纹，不依赖 crypto（Node/browser 通用）。
 */
export function normalizeCollaborationPayload(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.,;:!?，。；！？、》]+$/g, '')
}

/** 简单确定性 FNV-1a 32 位哈希（纯 TS，Node/browser 一致），供指纹去重。 */
export function collaborationHash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * A2A 循环指纹：`hash(from, to, normalizedPayload)`。
 *
 * 用于检测 A→B→A 的**近重复**问答：同一发起→同接收、正文归一化后碰撞即警报。
 * 返回 10 位十六进制字符串（保持定长、便于存储与索引）。
 */
export function collaborationLoopFingerprint(input: {
  fromMemberId: string
  toMemberId: string
  payload: string
}): string {
  const norm = normalizeCollaborationPayload(input.payload)
  const h1 = collaborationHash32(`${input.fromMemberId}:${input.toMemberId}:${norm}`)
  const h2 = collaborationHash32(norm)
  // 拼两个不同基底的 32 位哈希，进一步降碰撞
  return (h1 ^ ((h2 << 5) >>> 0)).toString(16).padStart(10, '0').slice(0, 10)
}
