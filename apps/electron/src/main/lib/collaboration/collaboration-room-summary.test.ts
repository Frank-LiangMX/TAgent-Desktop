/**
 * 房间共享摘要 Runner 测试（S3.5-b，04-HERMES-BORROW-SPEC §6）
 *
 * 通过 TAGENT_CONFIG_DIR 指向临时目录，注入假 modelCaller，覆盖：
 * - S1 有效发言未达阈值 → skip-below-threshold，不调模型、不推进锚点
 * - S2 达到阈值 → ran，成功后版本 +1、锚点推进到本批最后一条有效发言
 * - S3 计数器忽略 warning/工具轨迹/私有信箱（辅助）+ 一批最多 20 条的锚点
 * - S4 租约未过期 → 第二次调用 skip-lease-active，不双跑
 * - S5 commit CAS 失败（generation 变化）→ fail-closed cas-mismatch，保留旧稿
 * - S6 模型失败/空返回 → fail-closed model-failed，绝不抛错阻塞发言
 * - S7 房间非 active → skipped-inactive，不调模型
 * - S8 输入超预算 → fail-closed over-budget，不调模型
 * - 复用协调者 channel/model（输入断言 caller 收到的 channelId/modelId）
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CollaborationMember,
  CollaborationMessage,
  CollaborationRoom,
} from '@tagent/shared'
import {
  COLLABORATION_SUMMARY_SYSTEM_PROMPT,
  type CollaborationRoomSummary,
} from '@tagent/shared'
import {
  appendMembers,
  appendMessage,
  getCollaborationSummary,
  invalidateCollaborationSummaryGeneration,
  upsertRoom,
} from './collaboration-room-repository'
import {
  CollaborationSummaryRunner,
  type CollaborationSummaryModelCaller,
  type CollaborationSummaryRunOutcome,
} from './collaboration-room-summary'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `tagent-collab-summary-`))
  process.env.TAGENT_CONFIG_DIR = tmpDir
})

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(tmpDir, { recursive: true, force: true })
})

const T0 = 1_700_000_000_000
const SIX_HEADINGS = [
  '## 当前目标与阶段',
  '## 已确认决定',
  '## 硬约束与验收标准',
  '## 已完成工作与验证结果',
  '## 关键上下文、参与者与引用',
  '## 待办、阻塞与未决问题',
]

function mkRoom(roomId: string, overrides: Partial<CollaborationRoom> = {}): CollaborationRoom {
  return {
    id: roomId,
    title: '测试室',
    goal: '完成协作测试',
    coordinatorMemberId: 'cm_coord',
    status: 'active',
    maxConcurrentRuns: 3,
    maxA2ADepth: 4,
    summaryEveryUtterances: 4,
    budget: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function mkCoordinator(roomId: string): CollaborationMember {
  return {
    id: 'cm_coord',
    roomId,
    displayName: '协调者',
    roleSnapshot: { displayName: '协调者' },
    backend: 'channel',
    channelId: 'ch_A',
    modelId: 'm_A',
    logicalSessionId: 'ls_c',
    permissionProfile: 'read-only',
    capabilities: {
      supportsResume: false,
      supportsLiveInput: false,
      supportsToolBridge: false,
      supportsStructuredEvents: false,
    },
    status: 'idle',
    isCoordinator: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

function mkMsg(
  roomId: string,
  id: string,
  content: string,
  overrides: Partial<CollaborationMessage> = {},
): CollaborationMessage {
  return {
    id,
    roomId,
    authorType: 'user',
    authorId: 'user',
    kind: 'chat',
    content,
    visibility: 'room',
    targetMemberIds: [],
    rootMessageId: id,
    depth: 0,
    createdAt: 0,
    ...overrides,
  }
}

/** 建一个房间 + 协调者成员，并追加 n 条用户有效发言（m0..m n-1，createdAt 递增） */
function seed(
  roomId: string,
  effectiveCount: number,
  roomOverrides: Partial<CollaborationRoom> = {},
): void {
  upsertRoom(mkRoom(roomId, roomOverrides))
  appendMembers([mkCoordinator(roomId)])
  for (let i = 0; i < effectiveCount; i++) {
    appendMessage(mkMsg(roomId, `m${i}`, `发言 ${i}`, { createdAt: i }))
  }
}

function runner(opts: {
  modelCaller: CollaborationSummaryModelCaller
  leaseMs?: number
  maxInputChars?: number
}): CollaborationSummaryRunner {
  return new CollaborationSummaryRunner({
    modelCaller: opts.modelCaller,
    leaseMs: opts.leaseMs,
    maxInputChars: opts.maxInputChars,
    now: () => T0,
  })
}

describe('CollaborationSummaryRunner（S3.5-b §6）', () => {
  test('S1 有效发言不足阈值 → skip-below-threshold，不调模型、不落摘要', async () => {
    const roomId = `cr_${randomUUID()}`
    seed(roomId, 2) // 2 < 4
    const calls: unknown[] = []
    const r = runner({ modelCaller: async (input) => (calls.push(input), 'x') })
    const out = await r.run(roomId)
    expect(out.kind).toBe('skip-below-threshold')
    expect(calls).toHaveLength(0)
    expect(getCollaborationSummary(roomId)).toBeUndefined()
  })

  test('S2 达到阈值 → ran，复用协调者 channel/model，版本 +1、锚点推进到本批尾', async () => {
    const roomId = `cr_${randomUUID()}`
    seed(roomId, 4) // m0..m3，恰达阈值
    const seen: Array<{
      channelId?: string
      modelId?: string
      systemPrompt: string
      userPrompt: string
    }> = []
    const out = await runner({
      modelCaller: async (input) => {
        seen.push(input)
        return '六段新摘要'
      },
    }).run(roomId)
    expect(out.kind).toBe('ran')
    if (out.kind === 'ran') {
      expect(out.summary).toBe('六段新摘要')
      expect(out.throughMessageId).toBe('m3')
      expect(out.summarizedUtteranceCount).toBe(4)
    }
    expect(seen).toHaveLength(1)
    // 复用协调者 channel/model（§6.4）
    expect(seen[0]!.channelId).toBe('ch_A')
    expect(seen[0]!.modelId).toBe('m_A')
    // 六段契约 system prompt + <summary_data> user prompt（无指令）
    expect(seen[0]!.systemPrompt).toBe(COLLABORATION_SUMMARY_SYSTEM_PROMPT)
    for (const h of SIX_HEADINGS) expect(seen[0]!.systemPrompt).toContain(h)
    expect(seen[0]!.userPrompt).toContain('<summary_data>')
    // 落盘：success + version 1 + 锚点
    const saved = getCollaborationSummary(roomId)!
    expect(saved.status).toBe('success')
    expect(saved.version).toBe(1)
    expect(saved.summaryThroughMessageId).toBe('m3')
    expect(saved.summary).toBe('六段新摘要')

    // 再跑一轮：锚点从 m3 之后继续
    for (let i = 4; i < 8; i++) appendMessage(mkMsg(roomId, `m${i}`, `发言 ${i}`, { createdAt: i }))
    const out2 = await runner({
      modelCaller: async () => '第二轮摘要',
    }).run(roomId)
    expect(out2.kind).toBe('ran')
    if (out2.kind === 'ran') {
      expect(out2.throughMessageId).toBe('m7')
      expect(out2.summarizedUtteranceCount).toBe(8)
    }
    const saved2 = getCollaborationSummary(roomId)!
    expect(saved2.version).toBe(2)
    expect(saved2.summaryThroughMessageId).toBe('m7')
  })

  test('S3 计数器忽略 warning/工具轨迹/私有信箱，有效发言不足则跳过', async () => {
    const roomId = `cr_${randomUUID()}`
    upsertRoom(mkRoom(roomId))
    appendMembers([mkCoordinator(roomId)])
    // 有效发言 3 条：m0 用户、m3 成员、m4 用户（warning/工具轨迹不计）
    appendMessage(mkMsg(roomId, 'm0', 'a', { createdAt: 0 }))
    appendMessage(mkMsg(roomId, 'm1', 'w', { kind: 'warning', authorType: 'system', createdAt: 1 }))
    appendMessage(mkMsg(roomId, 'm2', 'p', { visibility: 'participants', createdAt: 2 }))
    appendMessage(mkMsg(roomId, 'm3', 'b', { authorType: 'member', authorId: 'cm_coord', createdAt: 3 }))
    appendMessage(mkMsg(roomId, 'm4', '[Tool result: ok]', { createdAt: 4 }))
    const out = await new CollaborationSummaryRunner({
      modelCaller: async () => 'x',
      now: () => T0,
    }).run(roomId)
    // 有效 3 < 阈值 4 → 跳过
    expect(out.kind).toBe('skip-below-threshold')
  })

  test('BATCH 一批最多 20 条 → 锚点与计数只推进本批（m19 / 20 条）', async () => {
    const roomId = `cr_${randomUUID()}`
    seed(roomId, 25)
    const out = await runner({ modelCaller: async () => '批内摘要' }).run(roomId)
    expect(out.kind).toBe('ran')
    if (out.kind === 'ran') {
      expect(out.throughMessageId).toBe('m19')
      expect(out.summarizedUtteranceCount).toBe(20)
    }
    const saved = getCollaborationSummary(roomId)!
    expect(saved.summaryThroughMessageId).toBe('m19')
  })

  test('S4 租约未过期 → 第二份并发调用 skip-lease-active，不双跑', async () => {
    const roomId = `cr_${randomUUID()}`
    seed(roomId, 4)
    let release!: (s: string) => void
    const hang = new Promise<string>((res) => (release = res))
    let calls = 0
    const r = runner({ modelCaller: async () => { calls++; return hang } })
    const first = r.run(roomId) // 先占租约（模型挂起中）
    const second = await r.run(roomId)
    expect(second.kind).toBe('skip-lease-active')
    release('第一份')
    const firstOut = await first
    expect(firstOut.kind).toBe('ran')
    expect(calls).toBe(1)
  })

  test('S5 commit CAS 失败（generation 变化）→ fail-closed cas-mismatch，保留旧稿', async () => {
    const roomId = `cr_${randomUUID()}`
    seed(roomId, 4)
    // 先产出一份成功基线
    const first = await runner({ modelCaller: async () => '旧稿' }).run(roomId)
    expect(first.kind).toBe('ran')
    // 再补 4 条；模型返回前把 generation 失效（模拟房间清空/并发抢占）
    for (let i = 4; i < 8; i++) appendMessage(mkMsg(roomId, `m${i}`, `发言 ${i}`, { createdAt: i }))
    const out = await runner({
      modelCaller: async () => {
        invalidateCollaborationSummaryGeneration(roomId)
        return '新稿（将被拒）'
      },
    }).run(roomId)
    expect(out.kind).toBe('fail-closed')
    if (out.kind === 'fail-closed') expect(out.reason).toBe('cas-mismatch')
    const saved = getCollaborationSummary(roomId)!
    // 旧稿保留（generation 已 bump、version 不变）
    expect(saved.summary).toBe('旧稿')
    expect(saved.status).toBe('idle')
    expect(saved.generation).toBe(1)
    expect(saved.version).toBe(1)
  })

  test('S6 模型失败 → fail-closed model-failed，不抛错、落 failed、不留租约', async () => {
    const roomId = `cr_${randomUUID()}`
    seed(roomId, 4)
    const out = await runner({ modelCaller: async () => { throw new Error('no model') } }).run(roomId)
    expect(out.kind).toBe('fail-closed')
    if (out.kind === 'fail-closed') expect(out.reason).toBe('model-failed')
    const saved = getCollaborationSummary(roomId)!
    expect(saved.status).toBe('failed')
    expect(saved.lastError).toContain('no model')
    expect(saved.runToken).toBeUndefined()
    expect(saved.leaseExpiresAt).toBeUndefined()
  })

  test('S6 模型返回空 → 视作失败 fail-closed，不写成功', async () => {
    const roomId = `cr_${randomUUID()}`
    seed(roomId, 4)
    const out = await runner({ modelCaller: async () => '   ' }).run(roomId)
    expect(out.kind).toBe('fail-closed')
    const saved = getCollaborationSummary(roomId)!
    expect(saved.status).toBe('failed')
    expect(saved.summary).toBe('')
  })

  test('S8 输入超预算 → fail-closed over-budget，不调模型', async () => {
    const roomId = `cr_${randomUUID()}`
    seed(roomId, 4)
    let calls = 0
    const out = await runner({ modelCaller: async () => (calls++, 'x'), maxInputChars: 100 }).run(
      roomId,
    )
    expect(out.kind).toBe('fail-closed')
    if (out.kind === 'fail-closed') expect(out.reason).toBe('over-budget')
    expect(calls).toBe(0)
    const saved = getCollaborationSummary(roomId)!
    expect(saved.status).toBe('failed')
  })

  test('§6.7 房间非 active → skipped-inactive，不调模型', async () => {
    const roomId = `cr_${randomUUID()}`
    seed(roomId, 4, mkRoom(roomId, { status: 'paused' }))
    let calls = 0
    const out = await runner({ modelCaller: async () => (calls++, 'x') }).run(roomId)
    expect(out.kind).toBe('skipped-inactive')
    expect(calls).toBe(0)
  })
})
