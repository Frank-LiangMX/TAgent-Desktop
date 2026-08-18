/**
 * AgentExitPlanService vitest — ExitPlanMode 计划审批服务
 *
 * 规格：docs/dev/core-loop/PLAN-MODE-CLOSURE-SPEC.md §2.2 §5
 * 断言：
 * - handleExitPlanMode 同步 sendToRenderer(request) + 返回 pending Promise（未 respond 前不自动 allow）
 * - request.plan 优先 toolInput.plan；空则读 toolInput.planFilePath（UTF-8，限 64KB）；都缺 → ''
 * - respond approve_auto → allow + targetMode=bypassPermissions
 * - respond approve_edit → allow + targetMode=auto
 * - respond deny → deny「用户拒绝了计划」
 * - respond feedback → deny + message 含反馈内容
 * - abort → deny「操作已中止」
 * - respond 未知 requestId → null（幂等）
 * - clearSessionPending → resolve deny「会话已结束」+ 返回清除的 requestId
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AgentExitPlanService } from './agent-exit-plan-service'
import type { ExitPlanModeRequest } from '@tagent/shared'

describe('AgentExitPlanService', () => {
  it('handleExitPlanMode 同步推 request（含 plan / allowedPrompts）+ 未 respond 前 Promise 仍 pending', async () => {
    const svc = new AgentExitPlanService()
    const sent: ExitPlanModeRequest[] = []
    const ctrl = new AbortController()
    const p = svc.handleExitPlanMode(
      's1',
      { plan: '步骤1', allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] },
      ctrl.signal,
      (r) => sent.push(r),
    )

    // 同步发出（早于 resolve）
    expect(sent).toHaveLength(1)
    expect(sent[0]!.sessionId).toBe('s1')
    expect(sent[0]!.plan).toBe('步骤1')
    expect(sent[0]!.allowedPrompts).toEqual([{ tool: 'Bash', prompt: 'run tests' }])

    // 未 respond 前 Promise 仍 pending（bypass 下不会自动 allow）
    let resolved = false
    void p.then(() => {
      resolved = true
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(resolved).toBe(false)

    // approve_auto → allow + targetMode=bypassPermissions
    const res = svc.respondToExitPlanMode({ requestId: sent[0]!.requestId, action: 'approve_auto' })
    expect(res).toEqual({ sessionId: 's1', targetMode: 'bypassPermissions' })
    const result = await p
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') {
      expect(result.targetMode).toBe('bypassPermissions')
      expect(result.updatedInput.plan).toBe('步骤1')
    }
  })

  it('respond approve_edit → allow + targetMode=auto', async () => {
    const svc = new AgentExitPlanService()
    const sent: ExitPlanModeRequest[] = []
    const ctrl = new AbortController()
    const p = svc.handleExitPlanMode('s2', { plan: 'p' }, ctrl.signal, (r) => sent.push(r))
    const res = svc.respondToExitPlanMode({ requestId: sent[0]!.requestId, action: 'approve_edit' })
    expect(res).toEqual({ sessionId: 's2', targetMode: 'auto' })
    const result = await p
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') expect(result.targetMode).toBe('auto')
  })

  it('respond deny → deny「用户拒绝了计划」', async () => {
    const svc = new AgentExitPlanService()
    const sent: ExitPlanModeRequest[] = []
    const ctrl = new AbortController()
    const p = svc.handleExitPlanMode('s3', { plan: 'p' }, ctrl.signal, (r) => sent.push(r))
    const res = svc.respondToExitPlanMode({ requestId: sent[0]!.requestId, action: 'deny' })
    expect(res).toEqual({ sessionId: 's3', targetMode: null })
    const result = await p
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') expect(result.message).toBe('用户拒绝了计划')
  })

  it('respond feedback → deny + message 含反馈内容', async () => {
    const svc = new AgentExitPlanService()
    const sent: ExitPlanModeRequest[] = []
    const ctrl = new AbortController()
    const p = svc.handleExitPlanMode('s4', { plan: 'p' }, ctrl.signal, (r) => sent.push(r))
    svc.respondToExitPlanMode({
      requestId: sent[0]!.requestId,
      action: 'feedback',
      feedback: '请加测试',
    })
    const result = await p
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') expect(result.message).toBe('请加测试')
  })

  it('abort → deny「操作已中止」', async () => {
    const svc = new AgentExitPlanService()
    const sent: ExitPlanModeRequest[] = []
    const ctrl = new AbortController()
    const p = svc.handleExitPlanMode('s5', { plan: 'p' }, ctrl.signal, (r) => sent.push(r))
    ctrl.abort()
    const result = await p
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') expect(result.message).toBe('操作已中止')
  })

  it('respond 未知 requestId → 返回 null（幂等）', () => {
    const svc = new AgentExitPlanService()
    const res = svc.respondToExitPlanMode({ requestId: 'unknown', action: 'approve_auto' })
    expect(res).toBeNull()
  })

  it('plan 正文：空 plan + planFilePath → 读文件回填', () => {
    const svc = new AgentExitPlanService()
    const dir = mkdtempSync(join(tmpdir(), 'tagent-exit-plan-'))
    try {
      const f = join(dir, 'plan.md')
      writeFileSync(f, '从文件读出的计划')
      const sent: ExitPlanModeRequest[] = []
      const ctrl = new AbortController()
      svc.handleExitPlanMode('s6', { planFilePath: f }, ctrl.signal, (r) => sent.push(r))
      expect(sent[0]!.plan).toBe('从文件读出的计划')
      svc.clearSessionPending('s6')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('plan 正文：plan 与 planFilePath 都缺 → 空 string', () => {
    const svc = new AgentExitPlanService()
    const sent: ExitPlanModeRequest[] = []
    const ctrl = new AbortController()
    svc.handleExitPlanMode('s7', {}, ctrl.signal, (r) => sent.push(r))
    expect(sent[0]!.plan).toBe('')
    svc.clearSessionPending('s7')
  })

  it('clearSessionPending → resolve deny「会话已结束」+ 返回清除的 requestId', async () => {
    const svc = new AgentExitPlanService()
    const sent: ExitPlanModeRequest[] = []
    const ctrl = new AbortController()
    const p = svc.handleExitPlanMode('s8', { plan: 'p' }, ctrl.signal, (r) => sent.push(r))
    const cleared = svc.clearSessionPending('s8')
    expect(cleared).toEqual([sent[0]!.requestId])
    const result = await p
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') expect(result.message).toBe('会话已结束')
  })
})
