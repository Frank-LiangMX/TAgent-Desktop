/**
 * No-Progress Guard 已知会话回放测试（SPEC §14.4）
 *
 * 还原 UnrealTagManager 会话 session-1786349874458 的脱敏工具序列：
 * - 围绕 tools/a0-kscc-resume-crash.js 反复编辑 + 同一复现命令重复执行；
 * - 复现结果持续 Exit code 3 / TIMEOUT 且 stdout/stderr 为空；
 * - 实际事故撞到 SDK maxTurns=50 → error_max_turns。
 *
 * 预期（§16.1 / §14.4）：
 * - 第 2 次空输出超时进入一级提醒（warn / reflection_required）；
 * - 不会继续运行到 maxTurns=50；
 * - 最终状态为 paused（adapter 归一化为 paused_no_progress），不是 error_max_turns。
 * - KSCC 与 Pi 用同一序列得到相同 decision（§4.5 / §14.3 双核语义一致）。
 */
import { describe, expect, it } from 'vitest'
import { NoProgressGuard } from './no-progress-guard'
import type { ToolBatchObservation, NoProgressDecision } from '@tagent/shared'

/** 脱敏复现命令（去掉绝对用户路径，保留主干） */
const REPRO_CMD = 'node tools/a0-kscc-resume-crash.js'
/** 脱敏目标文件 */
const TARGET_FILE = 'tools/a0-kscc-resume-crash.js'

/** Bash 复现：Exit code 3 / TIMEOUT，stdout/stderr 均为空 */
function reproEmptyTimeout(at: number, provider: 'kscc' | 'pi'): ToolBatchObservation {
  return {
    sessionId: 'session-replay',
    turnId: 't1',
    provider,
    observedAt: at,
    calls: [
      {
        toolUseId: `repro-${at}`,
        toolName: 'Bash',
        input: { command: REPRO_CMD, cwd: 'F:/UnrealTagManager' },
        output: '',
        error: 'Command timed out after 30s (exit code 124)',
      },
    ],
  }
}

/** 对目标文件的探针编辑（成功，但非目标进展） */
function probeEdit(at: number, provider: 'kscc' | 'pi', n: number): ToolBatchObservation {
  return {
    sessionId: 'session-replay',
    turnId: 't1',
    provider,
    observedAt: at,
    calls: [
      {
        toolUseId: `edit-${at}`,
        toolName: 'Edit',
        input: { file_path: TARGET_FILE, old_string: `probe-old-${n}`, new_string: `probe-new-${n}` },
        output: { ok: true },
      },
    ],
  }
}

/** 跑一遍脱敏序列，返回每步 decision 与终态 */
function replay(provider: 'kscc' | 'pi'): { decisions: NoProgressDecision[]; phase: string; batches: number } {
  const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
  g.resetForNewTurn(0)
  const decisions: NoProgressDecision[] = []
  let t = 100
  const step = (obs: ToolBatchObservation) => {
    obs.observedAt = t
    decisions.push(g.observe(obs))
    t += 100
  }
  // 1. 首次复现（空输出超时）→ 首次 neutral，建基线
  step(reproEmptyTimeout(t, provider))
  // 2. 探针编辑
  step(probeEdit(t, provider, 1))
  // 3. 第 2 次空输出超时 → 命中 §7.1.4（同命令 2 次）→ warn
  step(reproEmptyTimeout(t, provider))
  // 4. 探针编辑
  step(probeEdit(t, provider, 2))
  // 5. 第 3 次空输出超时
  step(reproEmptyTimeout(t, provider))
  // 6. 探针编辑 → reflection_required 后第 3 个无进展批次 → final_response_only
  step(probeEdit(t, provider, 3))
  // 7-8. 强制复盘后仍尝试工具：PreToolUse 拦截，2 次违规 → pause
  const a1 = g.onPreToolUse('Bash', { command: REPRO_CMD })
  if (a1.decision) decisions.push(a1.decision)
  const a2 = g.onPreToolUse('Bash', { command: REPRO_CMD })
  if (a2.decision) decisions.push(a2.decision)

  return { decisions, phase: g.getState().phase, batches: g.getState().batchCount }
}

describe('No-Progress Guard UnrealTagManager 回放（SPEC §14.4）', () => {
  it('第 2 次空输出超时进入一级提醒（warn / reflection_required）', () => {
    const r = replay('kscc')
    // 第 3 步（index 2）= 第 2 次空输出超时
    const warnDecision = r.decisions[2]
    expect(warnDecision.kind).toBe('warn')
    expect(warnDecision.emitPhase).toBe('warning')
    expect(warnDecision.reasonCodes).toContain('empty_timeout_repeated')
    expect(warnDecision.phase).toBe('reflection_required')
  })

  it('不会继续运行到 maxTurns=50（批次远小于 50 即暂停）', () => {
    const r = replay('kscc')
    expect(r.batches).toBeLessThan(50)
    expect(r.batches).toBeLessThanOrEqual(10)
  })

  it('最终状态为 paused（→ adapter 归一化为 paused_no_progress，非 error_max_turns）', () => {
    const r = replay('kscc')
    expect(r.phase).toBe('paused')
    const last = r.decisions[r.decisions.length - 1]
    expect(last.kind).toBe('pause')
    expect(last.emitPhase).toBe('paused')
    expect(last.reasonCodes).toContain('reflection_ignored')
  })

  it('KSCC 与 Pi 用同一序列得到相同 decision（§4.5 / §14.3 双核语义一致）', () => {
    const kscc = replay('kscc')
    const pi = replay('pi')
    expect(pi.decisions.length).toBe(kscc.decisions.length)
    expect(pi.phase).toBe(kscc.phase)
    expect(pi.batches).toBe(kscc.batches)
    for (let i = 0; i < kscc.decisions.length; i++) {
      expect(pi.decisions[i].kind).toBe(kscc.decisions[i].kind)
      expect(pi.decisions[i].emitPhase).toBe(kscc.decisions[i].emitPhase)
      expect(pi.decisions[i].reasonCodes).toEqual(kscc.decisions[i].reasonCodes)
      expect(pi.decisions[i].phase).toBe(kscc.decisions[i].phase)
    }
  })

  it('真正有进展不误杀：失败→成功（结果持续变化）不会暂停', () => {
    // 对照组：复现命令从失败变为成功，且每次成功产出新证据（输出变化）→ 每批都是 progress → 持续 observing
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const mk = (at: number, success: boolean, suffix: string): ToolBatchObservation => ({
      sessionId: 's',
      turnId: 't',
      provider: 'kscc',
      observedAt: at,
      calls: [
        {
          toolUseId: `c-${at}`,
          toolName: 'Bash',
          input: { command: REPRO_CMD },
          output: success ? `ok\n${suffix} tests passed` : '',
          error: success ? undefined : 'Command timed out after 30s (exit code 124)',
        },
      ],
    })
    g.observe(mk(100, false, '')) // 首次失败 neutral
    g.observe(mk(200, false, '')) // 重复失败 → warn（2 次空超时）
    // 第 3 步成功（结果变化）→ progress → cleared 回 observing
    const d3 = g.observe(mk(300, true, '1'))
    expect(d3.kind).toBe('continue')
    expect(d3.emitPhase).toBe('cleared')
    expect(g.getState().phase).toBe('observing')
    expect(g.getState().noProgressBatchCount).toBe(0)
    // 后续每步成功且输出持续变化（新证据）→ 每批 progress，np 恒 0，不暂停
    for (let i = 4; i < 30; i++) {
      const d = g.observe(mk(100 * i, true, `case-${i}`))
      expect(d.kind).toBe('continue')
    }
    expect(g.getState().phase).toBe('observing')
    expect(g.getState().noProgressBatchCount).toBe(0)
  })
})
