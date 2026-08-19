import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CollaborationMemberCapabilities,
  MemberBackendAdapter,
  MemberTurnInput,
  MemberTurnResult,
} from '@tagent/shared'
import { CollaborationRoomService } from './collaboration-room-service'

let configDir: string
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'tagent-collab-approval-test-'))
  process.env.TAGENT_CONFIG_DIR = configDir
})
afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR
  rmSync(configDir, { recursive: true, force: true })
})

const caps: CollaborationMemberCapabilities = {
  supportsResume: false,
  supportsLiveInput: false,
  supportsToolBridge: false,
  supportsStructuredEvents: false,
}

const hangingAdapter: MemberBackendAdapter = {
  capabilities: () => caps,
  runTurn: (_input: MemberTurnInput): Promise<MemberTurnResult> => new Promise(() => {}),
}

function runningRun(svc: CollaborationRoomService): { roomId: string; runId: string } {
  const room = svc.createRoom({ title: '审批测试', members: [{ displayName: '协调者', isCoordinator: true }] })
  const message = svc.appendUserMessage({ roomId: room.id, content: '开始' })
  const run = svc.listRuns(room.id).find((item) => item.triggerMessageId === message.id)!
  return { roomId: room.id, runId: run.id }
}

describe('CollaborationRoomService 用户审批闭环', () => {
  test('请求进入 awaiting_user，拒绝后 run failed 且请求幂等', () => {
    const svc = CollaborationRoomService.create({ adapter: hangingAdapter })
    const { roomId, runId } = runningRun(svc)
    const created = svc.requestUserApproval({
      roomId,
      fromRunId: runId,
      question: '是否继续部署？',
      options: JSON.stringify(['继续', '停止']),
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(svc.getRunById(runId)?.status).toBe('awaiting_user')
    expect(svc.listUserApprovals(roomId)[0]?.status).toBe('pending')

    const resolved = svc.resolveUserApproval({
      roomId,
      requestId: created.request.id,
      decision: 'denied',
      response: '先暂停',
    })
    expect(resolved.ok).toBe(true)
    expect(svc.getRunById(runId)?.status).toBe('failed')
    expect(svc.listUserApprovals(roomId)[0]?.status).toBe('denied')
    const retried = svc.resolveUserApproval({ roomId, requestId: created.request.id, decision: 'approved' })
    expect(retried.ok).toBe(true)
    if (retried.ok) expect(retried.request.status).toBe('denied')
  })

  test('批准后生成带审批结果的 continuation run', () => {
    const svc = CollaborationRoomService.create({ adapter: hangingAdapter })
    const { roomId, runId } = runningRun(svc)
    const created = svc.requestUserApproval({ roomId, fromRunId: runId, question: '需要确认' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const resolved = svc.resolveUserApproval({
      roomId,
      requestId: created.request.id,
      decision: 'approved',
      response: '确认继续',
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.runId).toBeTypeOf('string')
    expect(svc.getRunById(runId)?.status).toBe('done')
    expect(svc.listUserApprovals(roomId)[0]?.status).toBe('approved')
  })
})
