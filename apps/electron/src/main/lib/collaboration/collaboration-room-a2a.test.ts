/**
 * 协作室 A2A 信箱 host 侧集成测试（Stage 4-2）
 *
 * 验证 S4-2 边界（不依赖 adapter 工具回路，S4-3 再接）：
 * - roomSend / roomAsk / roomReply 落盘 mailbox.json + a2a 消息
 * - 自环守卫：A→A 阻断
 * - 深度守卫：超 maxA2ADepth fail closed
 * - 重复回复幂等：同 request 第二次 reply 阻断
 * - markRunAwaitingPeer：running → awaiting_peer（CAS）
 * - recoverInterruptedRuns：遗留 awaiting_peer → blocked
 *
 * 通过 TAGENT_CONFIG_DIR 指向临时目录 + mock adapter（delay 让 run 停在 running）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  MemberBackendAdapter,
  MemberTurnInput,
  MemberTurnResult,
  CollaborationMemberCapabilities,
  CollaborationRun,
} from '@tagent/shared'
import { CollaborationRoomService } from './collaboration-room-service'
import { listMailboxByRoom, upsertRun } from './collaboration-room-repository'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `tagent-collab-a2a-test-`))
  process.env.TAGENT_CONFIG_DIR = tmpDir
})

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(tmpDir, { recursive: true, force: true })
})

const MOCK_CAPS: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
}

/** 永不 resolve 的 mock adapter（让 run 一直停在 running，供 A2A 调用） */
function createHangingAdapter(): MemberBackendAdapter {
  return {
    capabilities: () => MOCK_CAPS,
    runTurn: (_input: MemberTurnInput): Promise<MemberTurnResult> => new Promise(() => {}),
  }
}

function createService(adapter?: MemberBackendAdapter): CollaborationRoomService {
  return CollaborationRoomService.create({ adapter: adapter ?? createHangingAdapter() })
}

async function waitForRunStatus(
  svc: CollaborationRoomService,
  runId: string,
  status: CollaborationRun['status'],
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (svc.getRunById(runId)?.status === status) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(
    `timeout waiting for run ${runId} to be ${status}, got ${svc.getRunById(runId)?.status}`,
  )
}

/** 创建带协调者+开发两成员的房间，返回 roomId + 两成员 id */
function createRoomWithTwoMembers(svc: CollaborationRoomService): {
  roomId: string
  coordinatorId: string
  devId: string
} {
  const room = svc.createRoom({
    title: 'A2A 测试',
    members: [
      { displayName: '协调者', isCoordinator: true },
      { displayName: '开发' },
    ],
  })
  const members = svc.listMembers(room.id)
  const coord = members.find((m) => m.isCoordinator)!
  const dev = members.find((m) => !m.isCoordinator)!
  return { roomId: room.id, coordinatorId: coord.id, devId: dev.id }
}

/** 触发一条用户消息让协调者 run 进入 running 态，返回该 run */
function triggerRunningRun(
  svc: CollaborationRoomService,
  roomId: string,
): { runId: string; triggerMessageId: string } {
  const msg = svc.appendUserMessage({ roomId, content: '开始' })
  // appendUserMessage 同步触发 run；hanging adapter 下 run 已 queued→running
  const runs = svc.listRuns(roomId)
  const run = runs.find((r) => r.triggerMessageId === msg.id)!
  return { runId: run.id, triggerMessageId: msg.id }
}

describe('CollaborationRoomService A2A 信箱 host 侧（Stage 4-2）', () => {
  test('roomAsk：落盘 question 信封 + a2a_request 消息', () => {
    const svc = createService()
    const { roomId, coordinatorId, devId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    const res = svc.roomAsk({ roomId, fromRunId: runId, toMemberId: devId, question: '接口定义对吗？' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.requestId).toMatch(/^req_/)

    // 信箱：1 封 question（pending）
    const envs = listMailboxByRoom(roomId)
    expect(envs).toHaveLength(1)
    expect(envs[0]!.type).toBe('question')
    expect(envs[0]!.state).toBe('pending')
    expect(envs[0]!.fromMemberId).toBe(coordinatorId)
    expect(envs[0]!.toMemberId).toBe(devId)
    expect(envs[0]!.requestId).toBe(res.requestId)
    expect(envs[0]!.depth).toBe(1)
  })

  test('roomSend：落盘 message 信封（不递增深度）', () => {
    const svc = createService()
    const { roomId, coordinatorId, devId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    const res = svc.roomSend({ roomId, fromRunId: runId, toMemberId: devId, payload: ' FYI：进度更新' })
    expect(res.ok).toBe(true)

    const envs = listMailboxByRoom(roomId)
    expect(envs).toHaveLength(1)
    expect(envs[0]!.type).toBe('message')
    expect(envs[0]!.state).toBe('pending')
    expect(envs[0]!.fromMemberId).toBe(coordinatorId)
    // send 深度为 0（不递增）
    expect(envs[0]!.depth).toBe(0)
  })

  test('自环守卫：A→A 阻断', () => {
    const svc = createService()
    const { roomId, coordinatorId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    const res = svc.roomAsk({ roomId, fromRunId: runId, toMemberId: coordinatorId, question: '自问' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/自己|自环|self/i)
    // 无信封落盘
    expect(listMailboxByRoom(roomId)).toHaveLength(0)
  })

  test('深度守卫：超 maxA2ADepth fail closed', () => {
    const svc = createService()
    // 创建深度上限 = 1 的房间
    const room = svc.createRoom({
      title: '浅深度',
      members: [{ displayName: '协调者', isCoordinator: true }, { displayName: '开发' }],
      maxA2ADepth: 1,
    })
    const members = svc.listMembers(room.id)
    const coord = members.find((m) => m.isCoordinator)!
    const dev = members.find((m) => !m.isCoordinator)!
    const msg = svc.appendUserMessage({ roomId: room.id, content: '开始' })
    const run = svc.listRuns(room.id).find((r) => r.triggerMessageId === msg.id)!

    // 第一次 ask：parentDepth=0 → child=1，OK（<= maxA2ADepth=1）
    const ok1 = svc.roomAsk({ roomId: room.id, fromRunId: run.id, toMemberId: dev.id, question: 'Q1' })
    expect(ok1.ok).toBe(true)

    // 模拟该 run 已有深度 1 的信封（runDepth 取 max(depth)），再 ask → child=2 > 1 → fail
    // 直接往 mailbox 写一封 depth=1、causationId=run.id 的信封模拟"已有深层投递"
    const envs = listMailboxByRoom(room.id)
    expect(envs.length).toBeGreaterThanOrEqual(1)
    // 把已落盘信封 depth 提到 1（已是 1），runDepth(run.id) 返回 1，下次 ask child=2 超限
    const fail = svc.roomAsk({ roomId: room.id, fromRunId: run.id, toMemberId: dev.id, question: 'Q2' })
    expect(fail.ok).toBe(false)
    if (fail.ok) return
    expect(fail.reason).toMatch(/深度|超限|depth/i)
    void coord
  })

  test('roomReply：幂等，重复回复阻断', () => {
    const svc = createService()
    const { roomId, coordinatorId, devId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    // 协调者 ask 开发
    const ask = svc.roomAsk({ roomId, fromRunId: runId, toMemberId: devId, question: 'Q' })
    expect(ask.ok).toBe(true)
    if (!ask.ok) return

    // 开发需要一个 run 才能 reply（fromRunId）。为开发造一个 running run：
    const devMsg = svc.appendUserMessage({ roomId, content: '开发开始', targetMemberIds: [devId] })
    const devRun = svc.listRuns(roomId).find((r) => r.triggerMessageId === devMsg.id)
    expect(devRun).toBeDefined()

    // 开发 reply
    const reply1 = svc.roomReply({
      roomId,
      fromRunId: devRun!.id,
      requestId: ask.requestId,
      answer: '是的',
    })
    expect(reply1.ok).toBe(true)

    // 原 question 信封 → answered
    const envs = listMailboxByRoom(roomId)
    const question = envs.find((e) => e.type === 'question')!
    expect(question.state).toBe('answered')

    // 重复 reply → 阻断
    const reply2 = svc.roomReply({
      roomId,
      fromRunId: devRun!.id,
      requestId: ask.requestId,
      answer: '再说一遍',
    })
    expect(reply2.ok).toBe(false)
    if (reply2.ok) return
    expect(reply2.reason).toMatch(/重复|已.*回复|duplicate/i)

    // 仍只有 1 封 reply
    const replies = envs.filter((e) => e.type === 'reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]!.state).toBe('answered')
    void coordinatorId
  })

  test('roomReply：回复者与 request 接收者不匹配 → 阻断', () => {
    const svc = createService()
    const { roomId, coordinatorId, devId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    // 协调者 ask 开发
    const ask = svc.roomAsk({ roomId, fromRunId: runId, toMemberId: devId, question: 'Q' })
    expect(ask.ok).toBe(true)
    if (!ask.ok) return

    // 协调者自己试图 reply（不是该 request 的接收者）→ 阻断
    const res = svc.roomReply({
      roomId,
      fromRunId: runId, // 协调者的 run
      requestId: ask.requestId,
      answer: '我自己答',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/不匹配|接收者|mismatch/i)
    void coordinatorId
  })

  test('roomAsk：A↔B 近重复问答循环 → 阻断', () => {
    const svc = createService()
    const { roomId, coordinatorId, devId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    // 协调者先 ask 开发"接口对吗"
    const ask1 = svc.roomAsk({ roomId, fromRunId: runId, toMemberId: devId, question: '接口对吗' })
    expect(ask1.ok).toBe(true)

    // 模拟开发反向 ask 协调者同样问题（A→B→A 循环）
    const devMsg = svc.appendUserMessage({ roomId, content: '开发开始', targetMemberIds: [devId] })
    const devRun = svc.listRuns(roomId).find((r) => r.triggerMessageId === devMsg.id)!
    const ask2 = svc.roomAsk({
      roomId,
      fromRunId: devRun.id,
      toMemberId: coordinatorId,
      question: '接口对吗。',
    })
    expect(ask2.ok).toBe(false)
    if (ask2.ok) return
    expect(ask2.reason).toMatch(/循环|重复|阻断/i)
  })

  test('roomAsk：正向重复投递（同 A→B 同问题）→ 阻断', () => {
    const svc = createService()
    const { roomId, devId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    const ask1 = svc.roomAsk({ roomId, fromRunId: runId, toMemberId: devId, question: '接口对吗' })
    expect(ask1.ok).toBe(true)

    // 协调者再次 ask 开发同样问题 → 阻断
    const ask2 = svc.roomAsk({ roomId, fromRunId: runId, toMemberId: devId, question: '接口对吗！' })
    expect(ask2.ok).toBe(false)
    if (ask2.ok) return
    expect(ask2.reason).toMatch(/循环|重复|阻断/i)
  })

  test('markRunAwaitingPeer：running → awaiting_peer', () => {
    const svc = createService()
    const { roomId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    const before = svc.getRunById(runId)!
    expect(before.status).toBe('running')

    const updated = svc.markRunAwaitingPeer(runId)
    expect(updated?.status).toBe('awaiting_peer')
    expect(svc.getRunById(runId)!.status).toBe('awaiting_peer')
    void roomId
  })

  test('recoverInterruptedRuns：遗留 awaiting_peer → blocked', () => {
    const svc = createService()
    const { roomId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    // 手动把 run 置 awaiting_peer（模拟"上次崩溃前正在等待 peer"）
    const run = svc.getRunById(runId)!
    upsertRun({ ...run, status: 'awaiting_peer' })

    // 新 service（模拟重启）→ recoverInterruptedRuns
    const svc2 = createService()
    const n = svc2.recoverInterruptedRuns()
    expect(n).toBeGreaterThanOrEqual(1)

    const after = svc2.getRunById(runId)!
    expect(after.status).toBe('blocked')
    void roomId
  })

  test('roomAsk：房间非 active → 拒绝', () => {
    const svc = createService()
    const { roomId, devId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    // 暂停房间
    svc.updateRoom({ roomId, status: 'paused' })

    const res = svc.roomAsk({ roomId, fromRunId: runId, toMemberId: devId, question: 'Q' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/active|状态/i)
  })

  test('listMailbox：service.listMailbox 返回房间全部信封', () => {
    const svc = createService()
    const { roomId, devId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    svc.roomSend({ roomId, fromRunId: runId, toMemberId: devId, payload: 'hi' })
    expect(svc.listMailbox(roomId)).toHaveLength(1)
  })

  test('roomReply：asker 非 awaiting_peer → 不入队 continuation', () => {
    const svc = createService()
    const { roomId, coordinatorId, devId } = createRoomWithTwoMembers(svc)
    const { runId } = triggerRunningRun(svc, roomId)

    const ask = svc.roomAsk({ roomId, fromRunId: runId, toMemberId: devId, question: 'Q' })
    expect(ask.ok).toBe(true)
    if (!ask.ok) return

    const devMsg = svc.appendUserMessage({ roomId, content: '开发开始', targetMemberIds: [devId] })
    const devRun = svc.listRuns(roomId).find((r) => r.triggerMessageId === devMsg.id)!
    const reply = svc.roomReply({
      roomId,
      fromRunId: devRun.id,
      requestId: ask.requestId,
      answer: '是的',
    })
    expect(reply.ok).toBe(true)

    const continuations = svc
      .listRuns(roomId)
      .filter((r) => r.idempotencyKey.startsWith('a2a-continue:'))
    expect(continuations).toHaveLength(0)
    expect(svc.getRunById(runId)!.status).toBe('running')
    void coordinatorId
  })

  test('updateMember：改显示名与渠道', () => {
    const svc = createService()
    const { roomId, coordinatorId } = createRoomWithTwoMembers(svc)
    const updated = svc.updateMember({
      roomId,
      memberId: coordinatorId,
      displayName: '主协调',
      channelId: 'ch_test',
      modelId: 'model-x',
    })
    expect(updated.displayName).toBe('主协调')
    expect(updated.channelId).toBe('ch_test')
    expect(updated.modelId).toBe('model-x')
    expect(svc.listMembers(roomId).find((m) => m.id === coordinatorId)?.displayName).toBe('主协调')
  })

  test('updateMember：换渠道未传 modelId → 清空旧模型', () => {
    const svc = createService()
    const { roomId, coordinatorId } = createRoomWithTwoMembers(svc)
    svc.updateMember({ roomId, memberId: coordinatorId, channelId: 'ch_a', modelId: 'old-model' })
    const next = svc.updateMember({ roomId, memberId: coordinatorId, channelId: 'ch_b' })
    expect(next.channelId).toBe('ch_b')
    expect(next.modelId).toBeUndefined()
  })

  test('updateMember：改名后 @旧名 仍路由到该成员', () => {
    const svc = createService()
    const { roomId, devId } = createRoomWithTwoMembers(svc)
    svc.updateMember({ roomId, memberId: devId, displayName: '主程' })
    const updated = svc.listMembers(roomId).find((m) => m.id === devId)!
    expect(updated.displayName).toBe('主程')
    expect(updated.mentionAliases).toContain('开发')

    const msg = svc.appendUserMessage({ roomId, content: '@开发 看下这个' })
    expect(msg.targetMemberIds).toEqual([devId])
    const runs = svc.listRuns(roomId).filter((r) => r.triggerMessageId === msg.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.memberId).toBe(devId)
  })

  test('接收者 turn 的 prompt 含待处理信箱', async () => {
    const calls: MemberTurnInput[] = []
    const adapter: MemberBackendAdapter = {
      capabilities: () => MOCK_CAPS,
      runTurn: async (input: MemberTurnInput): Promise<MemberTurnResult> => {
        calls.push(input)
        if (input.signal.aborted) throw new Error('aborted')
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 15)
          input.signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('aborted'))
          })
        })
        return { text: 'ok' }
      },
    }
    const svc = createService(adapter)
    const { roomId, devId } = createRoomWithTwoMembers(svc)
    const start = svc.appendUserMessage({ roomId, content: '开始' })
    const askerRun = svc.listRuns(roomId).find((r) => r.triggerMessageId === start.id)!
    await waitForRunStatus(svc, askerRun.id, 'running')
    const ask = svc.roomAsk({
      roomId,
      fromRunId: askerRun.id,
      toMemberId: devId,
      question: '接口定义对吗？',
    })
    expect(ask.ok).toBe(true)
    svc.markRunAwaitingPeer(askerRun.id)

    svc.appendUserMessage({ roomId, content: '开发开始', targetMemberIds: [devId] })
    await svc.awaitAllRuns()
    const devCall = calls.find((c) => c.memberId === devId)
    expect(devCall?.prompt).toMatch(/待处理信箱/)
    expect(devCall?.prompt).toMatch(/接口定义对吗/)
  })
})

describe('CollaborationRoomService A2A continuation（S4-3 host 唤醒）', () => {
  test('roomReply：asker awaiting_peer → 入队 continuation，prompt 含回复', async () => {
    const calls: MemberTurnInput[] = []
    const adapter: MemberBackendAdapter = {
      capabilities: () => MOCK_CAPS,
      runTurn: async (input: MemberTurnInput): Promise<MemberTurnResult> => {
        calls.push(input)
        if (input.signal.aborted) throw new Error('aborted')
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 20)
          input.signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('aborted'))
          })
        })
        return { text: `ok:${input.memberId}` }
      },
    }
    const svc = createService(adapter)
    const { roomId, coordinatorId, devId } = createRoomWithTwoMembers(svc)

    const msg = svc.appendUserMessage({ roomId, content: '开始' })
    const askerRun = svc.listRuns(roomId).find((r) => r.triggerMessageId === msg.id)!
    await waitForRunStatus(svc, askerRun.id, 'running')

    const ask = svc.roomAsk({
      roomId,
      fromRunId: askerRun.id,
      toMemberId: devId,
      question: '接口定义对吗？',
    })
    expect(ask.ok).toBe(true)
    if (!ask.ok) return

    const awaiting = svc.markRunAwaitingPeer(askerRun.id)
    expect(awaiting?.status).toBe('awaiting_peer')

    const devMsg = svc.appendUserMessage({ roomId, content: '开发开始', targetMemberIds: [devId] })
    const devRun = svc.listRuns(roomId).find((r) => r.triggerMessageId === devMsg.id)!
    const reply = svc.roomReply({
      roomId,
      fromRunId: devRun.id,
      requestId: ask.requestId,
      answer: '接口没问题，继续实现',
    })
    expect(reply.ok).toBe(true)

    await svc.awaitAllRuns()

    const continuation = svc
      .listRuns(roomId)
      .find((r) => r.idempotencyKey === `a2a-continue:${ask.requestId}:${coordinatorId}`)
    expect(continuation).toBeDefined()
    expect(continuation!.status).toBe('done')
    expect(svc.getRunById(askerRun.id)!.status).toBe('done')

    const contCall = calls.find((c) => c.runId === continuation!.id)
    expect(contCall).toBeDefined()
    expect(contCall!.prompt).toMatch(/接口没问题，继续实现/)
    expect(contCall!.prompt).toMatch(/A2A 恢复/)
    expect(contCall!.systemPrompt).toMatch(/跨成员提问中恢复/)
  })

  test('roomReply：同一 request 只唤醒一次 continuation', async () => {
    const adapter: MemberBackendAdapter = {
      capabilities: () => MOCK_CAPS,
      runTurn: async (input: MemberTurnInput): Promise<MemberTurnResult> => {
        if (input.signal.aborted) throw new Error('aborted')
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 15)
          input.signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('aborted'))
          })
        })
        return { text: 'ok' }
      },
    }
    const svc = createService(adapter)
    const { roomId, coordinatorId, devId } = createRoomWithTwoMembers(svc)
    const msg = svc.appendUserMessage({ roomId, content: '开始' })
    const askerRun = svc.listRuns(roomId).find((r) => r.triggerMessageId === msg.id)!
    await waitForRunStatus(svc, askerRun.id, 'running')
    const ask = svc.roomAsk({ roomId, fromRunId: askerRun.id, toMemberId: devId, question: 'Q' })
    expect(ask.ok).toBe(true)
    if (!ask.ok) return
    svc.markRunAwaitingPeer(askerRun.id)

    const devMsg = svc.appendUserMessage({ roomId, content: '开发开始', targetMemberIds: [devId] })
    const devRun = svc.listRuns(roomId).find((r) => r.triggerMessageId === devMsg.id)!
    const r1 = svc.roomReply({
      roomId,
      fromRunId: devRun.id,
      requestId: ask.requestId,
      answer: 'A1',
    })
    expect(r1.ok).toBe(true)
    const r2 = svc.roomReply({
      roomId,
      fromRunId: devRun.id,
      requestId: ask.requestId,
      answer: 'A2',
    })
    expect(r2.ok).toBe(false)

    await svc.awaitAllRuns()
    const continuations = svc
      .listRuns(roomId)
      .filter((r) => r.idempotencyKey.startsWith('a2a-continue:'))
    expect(continuations).toHaveLength(1)
    void coordinatorId
  })
})