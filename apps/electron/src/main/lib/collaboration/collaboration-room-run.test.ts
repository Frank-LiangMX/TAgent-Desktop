/**
 * 协作室 run 行为集成测试（Stage 2）
 *
 * 通过 TAGENT_CONFIG_DIR 指向临时目录 + 注入 mock MemberBackendAdapter，验证：
 * - appendUserMessage 触发 run → 成员消息落盘 + run done（mock backend）
 * - run 状态转换 queued → running → done
 * - 幂等：同一 (triggerMessageId, memberId) 不双跑
 * - 取消：cancelRun 置 cancelled，不写成员消息
 * - 失败：adapter 抛错 → run failed + 系统警告
 * - 启动恢复：遗留 running run → failed(INTERRUPTED)，成员回 idle（无假 running）
 *
 * mock adapter 不发真实 HTTP；runTurn 行为可控（正文 / 延迟 / 抛错）。
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
import {
  upsertMember,
  upsertRun,
} from './collaboration-room-repository'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `tagent-collab-run-test-`))
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

interface MockAdapterOptions {
  /** 返回正文（默认 'mock reply'） */
  text?: string
  /** runTurn 前延迟 ms（用于观察 running 中态） */
  delayMs?: number
  /** runTurn 抛此错误（模拟失败） */
  throwErr?: Error
  /** 是否响应 signal.abort 立即拒绝（默认否：延迟后才返回，由 executeRun 判定取消） */
  respectSignal?: boolean
}

function createMockAdapter(opts: MockAdapterOptions = {}): {
  adapter: MemberBackendAdapter
  calls: MemberTurnInput[]
} {
  const calls: MemberTurnInput[] = []
  const adapter: MemberBackendAdapter = {
    capabilities: () => MOCK_CAPS,
    runTurn: async (input: MemberTurnInput): Promise<MemberTurnResult> => {
      calls.push(input)
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs)
          input.signal.addEventListener('abort', () => {
            clearTimeout(t)
            if (opts.respectSignal) reject(new Error('aborted'))
            else resolve()
          })
        })
      }
      if (opts.throwErr) throw opts.throwErr
      const text = opts.text ?? 'mock reply'
      if (input.onTextDelta) {
        const mid = Math.max(1, Math.floor(text.length / 2))
        input.onTextDelta(text.slice(0, mid))
        input.onTextDelta(text.slice(mid))
      }
      return { text }
    },
  }
  return { adapter, calls }
}

/** 创建带 mock adapter 的 service */
function createService(adapter: MemberBackendAdapter): CollaborationRoomService {
  return CollaborationRoomService.create({ adapter })
}

/** 创建一个带协调者的房间 */
function createRoomWithCoordinator(svc: CollaborationRoomService): {
  roomId: string
  coordinatorId: string
} {
  const room = svc.createRoom({
    title: '运行测试',
    members: [{ displayName: '协调者', isCoordinator: true }],
  })
  const coord = svc.listMembers(room.id)[0]!
  return { roomId: room.id, coordinatorId: coord.id }
}

describe('CollaborationRoomService run 行为（Stage 2）', () => {
  test('appendUserMessage 触发 run → 成员消息落盘 + run done', async () => {
    const { adapter, calls } = createMockAdapter({ text: '这是成员回复' })
    const svc = createService(adapter)
    const { roomId } = createRoomWithCoordinator(svc)

    svc.appendUserMessage({ roomId, content: '你好' })
    await svc.awaitAllRuns()

    // run：1 个，done
    const runs = svc.listRuns(roomId)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('done')
    expect(runs[0]!.memberId).toBeDefined()
    expect(runs[0]!.startedAt).toBeTypeOf('number')
    expect(runs[0]!.finishedAt).toBeTypeOf('number')

    // 消息：用户 + 成员
    const msgs = svc.listMessages(roomId)
    expect(msgs.map((m) => m.content)).toEqual(['你好', '这是成员回复'])
    const memberMsg = msgs.find((m) => m.authorType === 'member')!
    expect(memberMsg.authorType).toBe('member')
    expect(memberMsg.runId).toBe(runs[0]!.id)
    expect(memberMsg.replyToMessageId).toBe(msgs[0]!.id)

    // adapter 被调用一次
    expect(calls).toHaveLength(1)
    expect(calls[0]!.prompt).toContain('你好')
    expect(calls[0]!.systemPrompt).toContain('协调者')

    // 成员回 idle
    expect(svc.listMembers(roomId)[0]!.status).toBe('idle')
  })

  test('run 状态转换 queued → running → done（延迟 mock 观察 running 中态）', async () => {
    const { adapter } = createMockAdapter({ text: 'ok', delayMs: 50 })
    const svc = createService(adapter)
    const { roomId } = createRoomWithCoordinator(svc)

    svc.appendUserMessage({ roomId, content: 'q' })

    // 同步执行后 run 已 running（executeRun 在首个 await 前完成 queued→running）
    const runsRunning = svc.listRuns(roomId)
    expect(runsRunning).toHaveLength(1)
    expect(runsRunning[0]!.status).toBe('running')
    expect(svc.listMembers(roomId)[0]!.status).toBe('running')

    await svc.awaitAllRuns()

    const runsDone = svc.listRuns(roomId)
    expect(runsDone[0]!.status).toBe('done')
    expect(svc.listMembers(roomId)[0]!.status).toBe('idle')
  })

  test('幂等：同一 (triggerMessageId, memberId) 不双跑', async () => {
    const { adapter, calls } = createMockAdapter()
    const svc = createService(adapter)
    const { roomId } = createRoomWithCoordinator(svc)

    const msg = svc.appendUserMessage({ roomId, content: '只跑一次' })
    await svc.awaitAllRuns()
    expect(svc.listRuns(roomId)).toHaveLength(1)
    expect(calls).toHaveLength(1)

    // 再次对同一消息触发：应跳过（幂等）
    const room = svc.getRoomById(roomId)!
    const second = svc.triggerRunForMessage(room, msg)
    expect(second).toEqual([])
    await svc.awaitAllRuns()
    expect(svc.listRuns(roomId)).toHaveLength(1)
    expect(calls).toHaveLength(1) // adapter 仍只被调用一次

    // 成员消息仍只有一条
    const memberMsgs = svc.listMessages(roomId).filter((m) => m.authorType === 'member')
    expect(memberMsgs).toHaveLength(1)
  })

  test('取消：cancelRun 置 cancelled，不写成员消息', async () => {
    const { adapter, calls } = createMockAdapter({ delayMs: 200 })
    const svc = createService(adapter)
    const { roomId } = createRoomWithCoordinator(svc)

    svc.appendUserMessage({ roomId, content: '取消我' })
    const run = svc.listRuns(roomId)[0]!
    expect(run.status).toBe('running')

    const cancelled = svc.cancelRun(run.id)
    expect(cancelled?.status).toBe('cancelled')

    await svc.awaitAllRuns()

    // run cancelled，adapter 被调用过一次（turn 已启动），但无成员消息
    expect(svc.listRuns(roomId)[0]!.status).toBe('cancelled')
    expect(calls).toHaveLength(1)
    const memberMsgs = svc.listMessages(roomId).filter((m) => m.authorType === 'member')
    expect(memberMsgs).toHaveLength(0)
    expect(svc.listMembers(roomId)[0]!.status).toBe('idle')
  })

  test('失败：adapter 抛错 → run failed + 系统警告，成员回 idle', async () => {
    const { adapter } = createMockAdapter({ throwErr: new Error('boom') })
    const svc = createService(adapter)
    const { roomId } = createRoomWithCoordinator(svc)

    svc.appendUserMessage({ roomId, content: '会失败' })
    await svc.awaitAllRuns()

    const run = svc.listRuns(roomId)[0]!
    expect(run.status).toBe('failed')
    expect(run.error?.message).toBe('boom')

    const msgs = svc.listMessages(roomId)
    // 用户消息 + 系统警告（无成员消息）
    expect(msgs.map((m) => m.content)).toEqual(['会失败', '成员「协调者」回复失败：boom'])
    expect(msgs[1]!.authorType).toBe('system')
    expect(msgs[1]!.kind).toBe('warning')
    expect(svc.listMembers(roomId)[0]!.status).toBe('idle')
  })

  test('暂停房间：appendUserMessage 只落盘消息，不触发 run', async () => {
    const { adapter, calls } = createMockAdapter()
    const svc = createService(adapter)
    const { roomId } = createRoomWithCoordinator(svc)

    svc.updateRoom({ roomId, status: 'paused' })
    svc.appendUserMessage({ roomId, content: '暂停时不跑' })
    await svc.awaitAllRuns()

    expect(svc.listRuns(roomId)).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(svc.listMessages(roomId).map((m) => m.content)).toEqual(['暂停时不跑'])
  })

  test('启动恢复：遗留 running run → failed(INTERRUPTED)，成员回 idle（无假 running）', () => {
    const { adapter } = createMockAdapter()
    const svc = createService(adapter)
    const { roomId, coordinatorId } = createRoomWithCoordinator(svc)

    // 模拟崩溃：直接落盘一个 running run + running 成员
    const now = Date.now()
    upsertRun({
      id: 'run_leftover',
      roomId,
      memberId: coordinatorId,
      triggerMessageId: 'msg_leftover',
      idempotencyKey: 'msg_leftover:' + coordinatorId,
      status: 'running',
      attempt: 0,
      startedAt: now,
    })
    const coord = svc.listMembers(roomId)[0]!
    upsertMember({ ...coord, status: 'running' })

    // 模拟重启：新 service 实例（无内存状态）+ recoverInterruptedRuns
    const svc2 = createService(adapter)
    const count = svc2.recoverInterruptedRuns()
    expect(count).toBe(1)

    const run = svc2.getRunById('run_leftover')!
    expect(run.status).toBe('failed')
    expect(run.error?.code).toBe('INTERRUPTED')
    expect(run.finishedAt).toBeTypeOf('number')
    expect(svc2.listMembers(roomId)[0]!.status).toBe('idle')
  })

  test('runTurn 流式增量累积转发给 onTextDelta', async () => {
    const deltas: Array<{ runId: string; text: string }> = []
    const { adapter } = createMockAdapter({ text: '你好世界' })
    const svc = CollaborationRoomService.create({
      adapter,
      onTextDelta: (p) => deltas.push({ runId: p.runId, text: p.text }),
    })
    const { roomId } = createRoomWithCoordinator(svc)
    svc.appendUserMessage({ roomId, content: '嗨' })
    await svc.awaitAllRuns()

    expect(deltas.length).toBeGreaterThanOrEqual(2)
    expect(deltas[deltas.length - 1]!.text).toBe('你好世界')
    expect(deltas[0]!.text.length).toBeLessThan(deltas[deltas.length - 1]!.text.length)
  })

  test('上下文投影含成员名册与路由规则', async () => {
    const { adapter, calls } = createMockAdapter({ text: 'ok' })
    const svc = createService(adapter)
    const { roomId } = createRoomWithCoordinator(svc)
    svc.appendUserMessage({ roomId, content: '嗨' })
    await svc.awaitAllRuns()
    expect(calls[0]!.systemPrompt).toMatch(/房间成员/)
    expect(calls[0]!.systemPrompt).toMatch(/不能仅靠输出/)
  })

  test('角色快照 systemPrompt 注入成员系统提示词', async () => {
    const { adapter, calls } = createMockAdapter({ text: 'ok' })
    const svc = createService(adapter)
    const room = svc.createRoom({
      title: '角色测试',
      members: [
        {
          displayName: '分析师',
          isCoordinator: true,
          roleId: 'analyst',
          roleSnapshot: {
            roleId: 'analyst',
            displayName: '分析师',
            description: '做数据分析',
            systemPrompt: '你是资深数据分析师，输出必须包含数据表格。',
          },
        },
      ],
    })
    svc.appendUserMessage({ roomId: room.id, content: '看看数据' })
    await svc.awaitAllRuns()

    expect(calls[0]!.systemPrompt).toContain('### 角色设定')
    expect(calls[0]!.systemPrompt).toContain('资深数据分析师')
    expect(calls[0]!.systemPrompt).toContain('你的职责：做数据分析。')
  })
})
