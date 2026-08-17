/**
 * collaboration-ipc 纯守卫单测（S4.5）。
 *
 * 仅测 resolveCollaborationDepthStopContinue：在委托 service.continueDepthStop 前的跨房间
 * 与可继续性校验。不触 ipcMain / BrowserWindow，但 collaboration-ipc 顶层 import electron，
 * 故用 vi.mock 让模块在 node 测试环境可加载（与仓库内其它 electron 依赖测试同模式）。
 */
import { describe, expect, test, vi } from 'vitest'
import type { CollaborationMailboxEnvelope } from '@tagent/shared'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
}))

import { resolveCollaborationDepthStopContinue } from './collaboration-ipc'

function mkEnvelope(overrides: Partial<CollaborationMailboxEnvelope> = {}): CollaborationMailboxEnvelope {
  return {
    id: 'env_1',
    roomId: 'cr_1',
    fromMemberId: 'cm_a',
    toMemberId: 'cm_b',
    type: 'question',
    payload: '已达深度',
    rootMessageId: 'msg_root',
    causationId: 'run_1',
    depth: 4,
    state: 'cancelled',
    attemptId: '550e8400-e29b-41d4-a716-446655440000',
    stopReason: 'max_depth',
    continueUsed: false,
    sourceMessageId: 'msg_source',
    createdAt: 0,
    ...overrides,
  }
}

describe('resolveCollaborationDepthStopContinue（IPC 跨房间守卫）', () => {
  test('属于该房间且可继续 → ok + envelope', () => {
    const env = mkEnvelope()
    const res = resolveCollaborationDepthStopContinue([env], { roomId: 'cr_1', envelopeId: 'env_1' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.envelope.id).toBe('env_1')
  })

  test('信封属于另一房间 → 拒绝（防跨房间继续）', () => {
    const env = mkEnvelope({ roomId: 'cr_2' })
    const res = resolveCollaborationDepthStopContinue([env], { roomId: 'cr_1', envelopeId: 'env_1' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/不属于|不存在/)
  })

  test('envelopeId 不存在 → 拒绝', () => {
    const res = resolveCollaborationDepthStopContinue([mkEnvelope()], {
      roomId: 'cr_1',
      envelopeId: 'env_ghost',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/不存在|不属于/)
  })

  test('已 continueUsed=true → 拒绝', () => {
    const env = mkEnvelope({ continueUsed: true })
    const res = resolveCollaborationDepthStopContinue([env], { roomId: 'cr_1', envelopeId: 'env_1' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/不可继续|已使用/)
  })

  test('stopReason 非 max_depth → 拒绝', () => {
    const env = mkEnvelope({ stopReason: 'continue_failed' })
    const res = resolveCollaborationDepthStopContinue([env], { roomId: 'cr_1', envelopeId: 'env_1' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/不可继续|已使用/)
  })

  test('缺 attemptId（历史信封）→ 拒绝', () => {
    const env = mkEnvelope({ attemptId: undefined })
    const res = resolveCollaborationDepthStopContinue([env], { roomId: 'cr_1', envelopeId: 'env_1' })
    expect(res.ok).toBe(false)
  })
})
