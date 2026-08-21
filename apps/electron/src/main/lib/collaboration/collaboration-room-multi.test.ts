/**
 * 协作室多成员并行 + 协调者路由集成测试（Stage 3）
 *
 * 通过 TAGENT_CONFIG_DIR 指向临时目录 + 注入 mock MemberBackendAdapter，验证：
 * - 无 @ 只唤醒协调者；@成员名 只唤醒被点名成员；@all 唤醒全部。
 * - 多点名并行扇出（受 maxConcurrentRuns 限制；同成员串行）。
 * - 多目标 trigger 幂等（同消息再触发不双跑）。
 * - 一方 failed 不取消另一方（各 run 独立落盘 member 消息 / 系统警告）。
 * - 并发=1 时排队：一个先跑、一个排队，最终都完成。
 *
 * 与 collaboration-room-run.test.ts 互补：后者覆盖单成员闭环（状态机/取消/恢复）。
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
} from '@tagent/shared'
import { CollaborationRoomService } from './collaboration-room-service'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `tagent-collab-multi-test-`))
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

/** 可变 mock adapter 配置（测试中按 memberId 决定失败 / 延迟） */
interface MockAdapterConfig {
  /** 这些 memberId 的 runTurn 抛错（模拟失败） */
  failMemberIds: string[]
  /** runTurn 前延迟 ms（观察 running/queued 中态） */
  delayMs: number
  /** 抛错消息 */
  throwMsg: string
}

function createMockAdapter(cfg: MockAdapterConfig): {
  adapter: MemberBackendAdapter
  calls: MemberTurnInput[]
} {
  const calls: MemberTurnInput[] = []
  const adapter: MemberBackendAdapter = {
    capabilities: () => MOCK_CAPS,
    runTurn: async (input: MemberTurnInput): Promise<MemberTurnResult> => {
      calls.push(input)
      if (cfg.failMemberIds.includes(input.memberId)) {
        throw new Error(cfg.throwMsg)
      }
      if (cfg.delayMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, cfg.delayMs)
          input.signal.addEventListener('abort', () => {
            clearTimeout(t)
            resolve()
          })
        })
      }
      return { text: `reply-from-${input.memberId.slice(-4)}` }
    },
  }
  return { adapter, calls }
}

function createService(cfg: MockAdapterConfig): {
  svc: CollaborationRoomService
  calls: MemberTurnInput[]
} {
  const { adapter, calls } = createMockAdapter(cfg)
  return { svc: CollaborationRoomService.create({ adapter }), calls }
}

/** 创建带协调者 + 开发两成员的房间 */
function createTwoMemberRoom(svc: CollaborationRoomService, opts?: {
  maxConcurrentRuns?: number
}): { roomId: string; coordId: string; devId: string } {
  const room = svc.createRoom({
    title: '多成员测试',
    maxConcurrentRuns: opts?.maxConcurrentRuns,
    members: [
      { displayName: '协调者', isCoordinator: true },
      { displayName: '开发' },
    ],
  })
  const members = svc.listMembers(room.id)
  const coord = members.find((m) => m.isCoordinator)!
  const dev = members.find((m) => m.displayName === '开发')!
  return { roomId: room.id, coordId: coord.id, devId: dev.id }
}

describe('CollaborationRoomService 路由（Stage 3 mention）', () => {
  test('无 @ → 只协调者 run', async () => {
    const { svc, calls } = createService({ failMemberIds: [], delayMs: 0, throwMsg: 'boom' })
    const { roomId, coordId, devId } = createTwoMemberRoom(svc)

    svc.appendUserMessage({ roomId, content: '你好，帮我看下' })
    await svc.awaitAllRuns()

    const runs = svc.listRuns(roomId)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.memberId).toBe(coordId)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.memberId).toBe(coordId)

    const memberMsgs = svc.listMessages(roomId).filter((m) => m.authorType === 'member')
    expect(memberMsgs).toHaveLength(1)
    expect(memberMsgs[0]!.authorId).toBe(coordId)
    // 开发未被唤醒
    expect(runs.some((r) => r.memberId === devId)).toBe(false)
  })

  test('@开发 → 只开发 run（协调者不回）', async () => {
    const { svc, calls } = createService({ failMemberIds: [], delayMs: 0, throwMsg: 'boom' })
    const { roomId, coordId, devId } = createTwoMemberRoom(svc)

    svc.appendUserMessage({ roomId, content: '@开发 做点事' })
    await svc.awaitAllRuns()

    const runs = svc.listRuns(roomId)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.memberId).toBe(devId)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.memberId).toBe(devId)
    // 协调者未被唤醒
    expect(runs.some((r) => r.memberId === coordId)).toBe(false)
    // 落盘的 user 消息 targetMemberIds 记录了点名
    const userMsg = svc.listMessages(roomId).find((m) => m.authorType === 'user')!
    expect(userMsg.targetMemberIds).toEqual([devId])
  })

  test('@all → 全部成员 run（含协调者）', async () => {
    const { svc, calls } = createService({ failMemberIds: [], delayMs: 0, throwMsg: 'boom' })
    const { roomId, coordId, devId } = createTwoMemberRoom(svc)

    svc.appendUserMessage({ roomId, content: '@all 一起上' })
    await svc.awaitAllRuns()

    const runs = svc.listRuns(roomId)
    expect(runs).toHaveLength(2)
    const memberIds = runs.map((r) => r.memberId).sort()
    expect(memberIds).toEqual([coordId, devId].sort())
    expect(calls).toHaveLength(2)
    const userMsg = svc.listMessages(roomId).find((m) => m.authorType === 'user')!
    expect(userMsg.targetMemberIds!.sort()).toEqual([coordId, devId].sort())
  })
})

describe('CollaborationRoomService 多成员并行（Stage 3）', () => {
  test('@开发 @协调者 → 两个 run done + 两条成员消息（并行扇出）', async () => {
    const { svc, calls } = createService({ failMemberIds: [], delayMs: 0, throwMsg: 'boom' })
    const { roomId, coordId, devId } = createTwoMemberRoom(svc)

    svc.appendUserMessage({ roomId, content: '@开发 @协调者 两人都来' })
    await svc.awaitAllRuns()

    const runs = svc.listRuns(roomId)
    expect(runs).toHaveLength(2)
    expect(runs.every((r) => r.status === 'done')).toBe(true)
    expect(runs.map((r) => r.memberId).sort()).toEqual([coordId, devId].sort())

    // adapter 被调用两次（每成员一次）
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.memberId).sort()).toEqual([coordId, devId].sort())

    // 两条成员消息（各 replyTo 用户消息）
    const msgs = svc.listMessages(roomId)
    const userMsg = msgs.find((m) => m.authorType === 'user')!
    const memberMsgs = msgs.filter((m) => m.authorType === 'member')
    expect(memberMsgs).toHaveLength(2)
    expect(memberMsgs.every((m) => m.replyToMessageId === userMsg.id)).toBe(true)
    expect(memberMsgs.map((m) => m.authorId).sort()).toEqual([coordId, devId].sort())
  })

  test('多目标幂等：同消息再触发不双跑', async () => {
    const { svc, calls } = createService({ failMemberIds: [], delayMs: 0, throwMsg: 'boom' })
    const { roomId } = createTwoMemberRoom(svc)

    const msg = svc.appendUserMessage({ roomId, content: '@开发 @协调者 两人都来' })
    await svc.awaitAllRuns()
    expect(svc.listRuns(roomId)).toHaveLength(2)
    expect(calls).toHaveLength(2)

    // 再次对同一消息触发：两个目标均已存在 run → 全部跳过
    const room = svc.getRoomById(roomId)!
    const second = svc.triggerRunForMessage(room, msg)
    expect(second).toEqual([])
    await svc.awaitAllRuns()
    expect(svc.listRuns(roomId)).toHaveLength(2) // 仍只 2 个
    expect(calls).toHaveLength(2) // adapter 仍只 2 次
  })

  test('一方 failed 不取消另一方：A 抛错 → A failed + 系统警告；B 仍 done + 成员消息', async () => {
    const cfg: MockAdapterConfig = { failMemberIds: [], delayMs: 0, throwMsg: 'boom-A' }
    const { svc, calls } = createService(cfg)
    const { roomId, coordId, devId } = createTwoMemberRoom(svc)
    // 让「开发」失败，协调者正常
    cfg.failMemberIds = [devId]

    svc.appendUserMessage({ roomId, content: '@开发 @协调者 两人都来' })
    await svc.awaitAllRuns()

    const runs = svc.listRuns(roomId)
    expect(runs).toHaveLength(2)
    const devRun = runs.find((r) => r.memberId === devId)!
    const coordRun = runs.find((r) => r.memberId === coordId)!
    expect(devRun.status).toBe('failed')
    expect(devRun.error?.message).toBe('boom-A')
    expect(coordRun.status).toBe('done')

    // 双方 adapter 都被调用（失败不阻止另一方启动）
    expect(calls).toHaveLength(2)

    const msgs = svc.listMessages(roomId)
    // 协调者：成员消息落盘
    const coordMsg = msgs.find((m) => m.authorType === 'member' && m.authorId === coordId)
    expect(coordMsg).toBeDefined()
    // 开发：系统警告（无成员消息）
    const warn = msgs.find(
      (m) => m.authorType === 'system' && m.content.includes('开发') && m.content.includes('boom-A'),
    )
    // 失败详情由 run 卡统一展示，不再重复写系统警告气泡。
    expect(warn).toBeUndefined()
    const devMemberMsg = msgs.find((m) => m.authorType === 'member' && m.authorId === devId)
    expect(devMemberMsg).toBeUndefined()
    // 两成员都回 idle
    expect(svc.listMembers(roomId).every((m) => m.status === 'idle')).toBe(true)
  })
})

describe('CollaborationRoomService 调度（Stage 3 并发/串行）', () => {
  test('并发=1：@开发 @协调者 → 一个先跑、一个排队，最终都 done', async () => {
    const { svc } = createService({ failMemberIds: [], delayMs: 60, throwMsg: 'boom' })
    const { roomId } = createTwoMemberRoom(svc, { maxConcurrentRuns: 1 })

    svc.appendUserMessage({ roomId, content: '@开发 @协调者 两人都来' })

    // 同步观察：maxConcurrent=1 → 恰 1 running + 1 queued
    const runsAfter = svc.listRuns(roomId)
    expect(runsAfter.filter((r) => r.status === 'running')).toHaveLength(1)
    expect(runsAfter.filter((r) => r.status === 'queued')).toHaveLength(1)
    expect(runsAfter).toHaveLength(2)

    await svc.awaitAllRuns()

    const runsDone = svc.listRuns(roomId)
    expect(runsDone).toHaveLength(2)
    expect(runsDone.every((r) => r.status === 'done')).toBe(true)
  })

  test('成员内串行：两条消息各 @开发 → 第二条排队，第一条完成后才跑', async () => {
    const { svc, calls } = createService({ failMemberIds: [], delayMs: 60, throwMsg: 'boom' })
    const { roomId, devId } = createTwoMemberRoom(svc, { maxConcurrentRuns: 3 })

    svc.appendUserMessage({ roomId, content: '@开发 第一件' })
    // 第一条：开发 run 已 running
    const runs1 = svc.listRuns(roomId)
    expect(runs1.filter((r) => r.status === 'running' && r.memberId === devId)).toHaveLength(1)

    svc.appendUserMessage({ roomId, content: '@开发 第二件' })
    // 第二条：同成员串行 → 第二件 queued（开发正在跑第一件）
    const runs2 = svc.listRuns(roomId)
    expect(runs2.filter((r) => r.status === 'running' && r.memberId === devId)).toHaveLength(1)
    expect(runs2.filter((r) => r.status === 'queued' && r.memberId === devId)).toHaveLength(1)

    await svc.awaitAllRuns()

    const runsDone = svc.listRuns(roomId)
    expect(runsDone).toHaveLength(2)
    expect(runsDone.every((r) => r.status === 'done')).toBe(true)
    expect(calls).toHaveLength(2) // 两件各跑一次
    // 开发两件都跑完回 idle（协调者从未被唤醒，保持 offline）
    const dev = svc.listMembers(roomId).find((m) => m.id === devId)!
    expect(dev.status).toBe('idle')
  })

  test('排队中的 run 可取消（不启动、不占 slot）', async () => {
    const { svc } = createService({ failMemberIds: [], delayMs: 200, throwMsg: 'boom' })
    const { roomId } = createTwoMemberRoom(svc, { maxConcurrentRuns: 1 })

    svc.appendUserMessage({ roomId, content: '@开发 @协调者 两人都来' })
    const runs = svc.listRuns(roomId)
    const queued = runs.find((r) => r.status === 'queued')!
    const running = runs.find((r) => r.status === 'running')!
    expect(queued).toBeDefined()

    // 取消排队中的 run
    const cancelled = svc.cancelRun(queued.id)
    expect(cancelled?.status).toBe('cancelled')

    await svc.awaitAllRuns()

    // running 的仍正常完成
    const runsDone = svc.listRuns(roomId)
    expect(runsDone.find((r) => r.id === running.id)!.status).toBe('done')
    expect(runsDone.find((r) => r.id === queued.id)!.status).toBe('cancelled')
    // 取消的 run 无成员消息
    const memberMsgs = svc.listMessages(roomId).filter((m) => m.authorType === 'member')
    expect(memberMsgs).toHaveLength(1)
  })
})
