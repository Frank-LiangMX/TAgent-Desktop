import { describe, expect, test } from 'vitest'
import {
  collaborationEnvelopeIdempotencyKey,
  collaborationHash32,
  collaborationLoopFingerprint,
  collaborationReplyIdempotencyKey,
  canContinueCollaborationDepthStop,
  canTransitionCollaborationDelivery,
  hasCollaborationAttempt,
  isCollaborationDepthStopPresentable,
  recommendedCollaborationHandoffDepth,
  isCollaborationDuplicateReply,
  isCollaborationSelfSend,
  nextCollaborationA2ADepth,
  normalizeCollaborationPayload,
  transitionCollaborationMailboxState,
} from './collaboration-a2a'
import type {
  CollaborationMailboxEnvelope,
  CollaborationMailboxState,
} from './collaboration-room'

function mkEnvelope(
  overrides: Partial<CollaborationMailboxEnvelope> = {},
): CollaborationMailboxEnvelope {
  return {
    id: 'env_1',
    roomId: 'cr_1',
    fromMemberId: 'cm_a',
    toMemberId: 'cm_b',
    type: 'question',
    requestId: 'req_1',
    rootMessageId: 'msg_root',
    causationId: 'msg_parent',
    depth: 1,
    state: 'pending',
    createdAt: 0,
    ...overrides,
  }
}

describe('collaboration-a2a mailbox state machine', () => {
  test('deliver: pending -> delivered', () => {
    expect(transitionCollaborationMailboxState('pending', 'deliver')).toEqual({
      ok: true,
      state: 'delivered',
    })
  })

  test('deliver: 非 pending 拒绝', () => {
    const r = transitionCollaborationMailboxState('delivered', 'deliver')
    expect(r.ok).toBe(false)
  })

  test('answer: pending/delivered -> answered', () => {
    expect(transitionCollaborationMailboxState('pending', 'answer')).toEqual({
      ok: true,
      state: 'answered',
    })
    expect(transitionCollaborationMailboxState('delivered', 'answer')).toEqual({
      ok: true,
      state: 'answered',
    })
  })

  test('answer: 终态（answered）拒绝', () => {
    const r = transitionCollaborationMailboxState('answered', 'answer')
    expect(r.ok).toBe(false)
  })

  test('cancel: pending/delivered -> cancelled', () => {
    expect(transitionCollaborationMailboxState('pending', 'cancel')).toEqual({
      ok: true,
      state: 'cancelled',
    })
    expect(transitionCollaborationMailboxState('delivered', 'cancel')).toEqual({
      ok: true,
      state: 'cancelled',
    })
  })

  test('expire: pending -> expired', () => {
    expect(transitionCollaborationMailboxState('pending', 'expire')).toEqual({
      ok: true,
      state: 'expired',
    })
  })
})

describe('S4.5 handoff outbox guards', () => {
  const attemptId = '550e8400-e29b-41d4-a716-446655440000'

  test('推荐深度有界：2 成员→4，6 成员→7，20 成员→10', () => {
    expect(recommendedCollaborationHandoffDepth(2)).toBe(4)
    expect(recommendedCollaborationHandoffDepth(6)).toBe(7)
    expect(recommendedCollaborationHandoffDepth(20)).toBe(10)
  })

  test('同一 attempt 不得重复写信封，delivery 不能从未知结果倒退', () => {
    const envelope = mkEnvelope({ attemptId, delivery: 'outbox' })
    expect(hasCollaborationAttempt([envelope], attemptId)).toBe(true)
    expect(canTransitionCollaborationDelivery('outbox', 'dispatched')).toBe(true)
    expect(canTransitionCollaborationDelivery('accepted', 'outcome_unknown')).toBe(true)
    expect(canTransitionCollaborationDelivery('outcome_unknown', 'dispatched')).toBe(false)
  })

  test('仅元数据完整的 max-depth 停止可呈现且可继续一次', () => {
    const stop = mkEnvelope({
      attemptId,
      depth: 4,
      stopReason: 'max_depth',
      sourceMessageId: 'msg_source',
      continueUsed: false,
    })
    expect(isCollaborationDepthStopPresentable({ envelope: stop, maxDepth: 4, handoffEnabled: true })).toBe(true)
    expect(canContinueCollaborationDepthStop(stop)).toBe(true)
    expect(canContinueCollaborationDepthStop({ ...stop, continueUsed: true })).toBe(false)
    expect(isCollaborationDepthStopPresentable({ envelope: { ...stop, attemptId: undefined }, maxDepth: 4, handoffEnabled: true })).toBe(false)
  })
})

describe('collaboration-a2a depth guard', () => {
  test('next depth 在 max 内 -> ok', () => {
    expect(nextCollaborationA2ADepth(0, 4)).toEqual({ ok: true, depth: 1 })
  })

  test('超过 max -> fail closed', () => {
    expect(nextCollaborationA2ADepth(4, 4).ok).toBe(false)
  })

  test('非法 parentDepth 拒绝', () => {
    expect(nextCollaborationA2ADepth(-1, 4).ok).toBe(false)
  })
})

describe('collaboration-a2a self-send guard', () => {
  test('自己发送 -> true', () => {
    expect(isCollaborationSelfSend('cm_a', 'cm_a')).toBe(true)
  })
  test('不同成员 -> false', () => {
    expect(isCollaborationSelfSend('cm_a', 'cm_b')).toBe(false)
  })
})

describe('collaboration-a2a idempotency keys', () => {
  test('reply key', () => {
    expect(collaborationReplyIdempotencyKey('req_1', 'cm_b')).toBe('req_1:cm_b')
  })
  test('envelope key', () => {
    expect(
      collaborationEnvelopeIdempotencyKey({
        fromMemberId: 'cm_a',
        toMemberId: 'cm_b',
        rootMessageId: 'msg_root',
        causationId: 'msg_parent',
      }),
    ).toBe('cm_a:cm_b:msg_root:msg_parent')
  })
  test('hash32 稳定', () => {
    expect(collaborationHash32('hello')).toBe(collaborationHash32('hello'))
    expect(collaborationHash32('hello')).not.toBe(collaborationHash32('world'))
  })
})

describe('collaboration-a2a duplicate reply + loop fingerprint', () => {
  test('duplicate reply: 同 (request, from) 已有活动 reply -> true', () => {
    const dup = isCollaborationDuplicateReply('req_1', 'cm_b', [
      mkEnvelope({ type: 'reply', requestId: 'req_1', fromMemberId: 'cm_b', state: 'delivered' }),
    ])
    expect(dup).toBe(true)
  })

  test('duplicate reply: 无关信封 -> false', () => {
    const no = isCollaborationDuplicateReply('req_2', 'cm_c', [
      mkEnvelope({ type: 'reply', requestId: 'req_9', fromMemberId: 'cm_z' }),
    ])
    expect(no).toBe(false)
  })

  test('normalize payload', () => {
    expect(normalizeCollaborationPayload('  Hello   World! ')).toBe('hello world')
  })

  test('loop fingerprint 稳定且定长', () => {
    const fp = collaborationLoopFingerprint({
      fromMemberId: 'cm_a',
      toMemberId: 'cm_b',
      payload: '请复核接口定义',
    })
    expect(fp).toMatch(/^[0-9a-f]{10}$/)
    // 同输入 → 同指纹（幂等、可存储）
    expect(fp).toBe(
      collaborationLoopFingerprint({
        fromMemberId: 'cm_a',
        toMemberId: 'cm_b',
        payload: '请复核接口定义',
      }),
    )
  })

  test('loop fingerprint: 近重复正文（仅尾部标点/空格差异）命中同一指纹', () => {
    const a = collaborationLoopFingerprint({
      fromMemberId: 'cm_a',
      toMemberId: 'cm_b',
      payload: ' 请复核接口定义！ ',
    })
    const b = collaborationLoopFingerprint({
      fromMemberId: 'cm_a',
      toMemberId: 'cm_b',
      payload: '请复核接口定义。',
    })
    // 两者归一化后均为「请复核接口定义」，指纹应一致
    expect(a).toBe(b)
  })
})

// 类型占位引用，确保 mailbox state 类型可被导入（保持与 runtime 接线一致）
export type _MailboxStateCheck = CollaborationMailboxState
