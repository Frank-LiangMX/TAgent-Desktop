/**
 * No-Progress Guard 纯判定器单测（SPEC §14.1）
 *
 * 覆盖：
 * - 相同 Bash 命令与相同错误可稳定归一化；
 * - 时间戳、随机 ID 不导致结果签名变化；
 * - Edit 成功不重置无进展计数；
 * - 验证从失败变成功会重置无进展计数；
 * - 两次空输出超时触发一级提醒；
 * - 复盘后仍重复会进入暂停；
 * - 新用户回合重置状态；
 * 外加：多文件编辑不误杀、同文件 5 次编辑、12 批无进展暂停、4 次空超时暂停、
 * 10 分钟无进展暂停、shadow/enforce 决策一致、PreToolUse 拦截、resolveNoProgressGuardMode。
 */
import { describe, expect, it } from 'vitest'
import {
  NoProgressGuard,
  DEFAULT_NO_PROGRESS_THRESHOLDS,
  actionSignature,
  normalizePath,
  scrubNoise,
} from './no-progress-guard'
import {
  resolveNoProgressGuardMode,
  NO_PROGRESS_GUARD_DEFAULT_MODE,
  type ToolBatchObservation,
} from '@tagent/shared'

// ===== 观察构造助手 =====

interface CallSpec {
  toolName: string
  input: Record<string, unknown>
  output?: unknown
  error?: string
  toolUseId?: string
}

function batch(calls: CallSpec[], opts: { at?: number; provider?: 'kscc' | 'pi'; turnId?: string } = {}): ToolBatchObservation {
  return {
    sessionId: 's1',
    turnId: opts.turnId ?? 't1',
    provider: opts.provider ?? 'kscc',
    observedAt: opts.at ?? 0,
    calls: calls.map((c, i) => ({
      toolUseId: c.toolUseId ?? `tu-${i}`,
      toolName: c.toolName,
      input: c.input,
      output: c.output,
      error: c.error,
    })),
  }
}

function bashFail(command: string, opts: { error?: string; output?: unknown; cwd?: string; at?: number } = {}): ToolBatchObservation {
  return batch(
    [
      {
        toolName: 'Bash',
        input: { command, ...(opts.cwd ? { cwd: opts.cwd } : {}) },
        output: opts.output,
        error: opts.error ?? 'Exit code 1',
      },
    ],
    { at: opts.at },
  )
}

function bashEmptyTimeout(command: string, at?: number): ToolBatchObservation {
  // 还原事故现场：Exit code 3 / TIMEOUT，stdout/stderr 均为空
  return batch(
    [{ toolName: 'Bash', input: { command }, output: '', error: 'Command timed out after 30s (exit code 124)' }],
    { at },
  )
}

function bashSuccess(command: string, at?: number): ToolBatchObservation {
  return batch([{ toolName: 'Bash', input: { command }, output: 'ok\nall tests passed' }], { at })
}

function editCall(file: string, opts: { oldStr?: string; newStr?: string; error?: string; at?: number } = {}): ToolBatchObservation {
  return batch(
    [
      {
        toolName: 'Edit',
        input: {
          file_path: file,
          old_string: opts.oldStr ?? 'old',
          new_string: opts.newStr ?? 'new',
        },
        output: opts.error ? undefined : { ok: true },
        error: opts.error,
      },
    ],
    { at: opts.at },
  )
}

function readCall(file: string, at?: number): ToolBatchObservation {
  return batch([{ toolName: 'Read', input: { file_path: file }, output: 'file content' }], { at })
}

// ===== 归一化与签名稳定性 =====

describe('NoProgressGuard 归一化与签名', () => {
  it('相同 Bash 命令与相同错误 → 相同动作签名与结果签名', () => {
    const a1 = actionSignature('Bash', { command: 'node tools/a0.js', cwd: '/p' })
    const a2 = actionSignature('Bash', { command: 'node tools/a0.js', cwd: '/p' })
    expect(a1).toBe(a2)
    expect(a1).toBe('Bash:/p|node tools/a0.js')
  })

  it('Bash 命令忽略空格与输出重定向差异（同动作）', () => {
    const a1 = actionSignature('Bash', { command: 'node tools/a0.js 2>&1', cwd: '/p' })
    const a2 = actionSignature('Bash', { command: 'node  tools/a0.js', cwd: '/p' })
    expect(a1).toBe(a2)
  })

  it('不同命令 → 不同动作签名', () => {
    expect(actionSignature('Bash', { command: 'node a.js' })).not.toBe(actionSignature('Bash', { command: 'node b.js' }))
  })

  it('时间戳、随机 ID 不导致结果签名变化（去噪稳定）', () => {
    const out1 = {
      stdout: 'Error at 2026-08-11 10:00:00 (id=abc12345-1234-5678-9abc-def012345678)',
      exitCode: 1,
    }
    const out2 = {
      stdout: 'Error at 2026-08-12 11:30:45 (id=ffff9999-3333-2222-1111-000000000000)',
      exitCode: 1,
    }
    // 直接验证去噪等价
    expect(scrubNoise(JSON.stringify(out1))).toBe(scrubNoise(JSON.stringify(out2)))
    // 行为级证明：两次仅时间戳/uuid 不同的失败被视为「同结果」→ 第二次为 noProgress（np 增 1），
    // 而非 progress（progress 会把 np 重置为 0）。
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(bashFail('node tools/a0.js', { error: 'Exit code 1', output: out1, at: 100 })) // 首次 neutral
    const d2 = g.observe(bashFail('node tools/a0.js', { error: 'Exit code 1', output: out2, at: 200 }))
    expect(d2.kind).toBe('continue')
    expect(g.getState().noProgressBatchCount).toBe(1) // 同结果 → noProgress，np 增 1
  })

  it('Edit 区域摘要不把替换文本全文进签名，但不同区域可区分', () => {
    const sameFile = '/repo/src/a.ts'
    const a = actionSignature('Edit', { file_path: sameFile, old_string: 'foo', new_string: 'bar' })
    const b = actionSignature('Edit', { file_path: sameFile, old_string: 'foo', new_string: 'bar' })
    expect(a).toBe(b) // 同区域 → 同签名
    const c = actionSignature('Edit', { file_path: sameFile, old_string: 'completely different', new_string: 'x' })
    expect(c).not.toBe(a) // 不同区域 → 不同签名
    // 不含全文
    expect(a).not.toContain('foo')
    expect(a).not.toContain('bar')
  })

  it('normalizePath：盘符小写 + 反斜杠→正斜杠', () => {
    expect(normalizePath('F:\\repo\\src\\a.ts')).toBe('f:/repo/src/a.ts')
    expect(normalizePath('F:/repo/src/a.ts/')).toBe('f:/repo/src/a.ts')
  })
})

// 内部 parseBashOutcome 不单独导出；结果签名稳定性通过 guard 行为间接断言（见上）。

describe('NoProgressGuard 核心进展判定（SPEC §14.1）', () => {
  it('Edit 成功不重置无进展计数', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0-kscc-resume-crash.js'
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err: spawn ENOENT', at: 100 })) // 首次 neutral
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err: spawn ENOENT', at: 200 })) // 重复 noProgress → np=1
    expect(g.getState().noProgressBatchCount).toBe(1)
    const d = g.observe(editCall('tools/a0-kscc-resume-crash.js', { at: 300 })) // Edit 成功（neutral）
    expect(d.kind).toBe('continue')
    expect(g.getState().noProgressBatchCount).toBe(1) // 未被重置
  })

  it('验证从失败变成功会重置无进展计数', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'npm test'
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: '1 failing', at: 100 })) // 首次 neutral
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: '1 failing', at: 200 })) // np=1
    expect(g.getState().noProgressBatchCount).toBe(1)
    const d = g.observe(bashSuccess(cmd, 300)) // 失败→成功 → progress
    expect(d.kind).toBe('continue')
    expect(g.getState().noProgressBatchCount).toBe(0) // 重置
    expect(g.getState().phase).toBe('observing')
  })

  it('两次空输出超时触发一级提醒（reflection_required / warning）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0-kscc-resume-crash.js'
    const d1 = g.observe(bashEmptyTimeout(cmd, 100)) // 首次 neutral
    expect(d1.kind).toBe('continue')
    const d2 = g.observe(bashEmptyTimeout(cmd, 200)) // 第 2 次 → warn
    expect(d2.kind).toBe('warn')
    expect(d2.emitPhase).toBe('warning')
    expect(d2.reasonCodes).toContain('empty_timeout_repeated')
    expect(d2.phase).toBe('reflection_required')
    expect(d2.modelContext).toBeTruthy()
  })

  it('复盘后仍重复 → 进入暂停（paused）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0-kscc-resume-crash.js'
    // 3 次相同失败 → 第 3 次命中 same_failure_repeated(3) → warn
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 100 })) // neutral
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 200 })) // np=1, rep=1
    const dWarn = g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 300 })) // np=2, rep=2
    expect(dWarn.kind).toBe('warn')
    // reflection_required 后 3 个无进展批次 → final_response_only
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 400 })) // bsR=1
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 500 })) // bsR=2
    const dFinal = g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 600 })) // bsR=3 → final
    expect(dFinal.kind).toBe('require_reflection')
    expect(dFinal.emitPhase).toBe('reflection')
    expect(g.getState().phase).toBe('final_response_only')
    // 强制复盘后仍尝试工具：PreToolUse 拦截，2 次 → pause
    const a1 = g.onPreToolUse('Bash', { command: cmd })
    expect(a1.allow).toBe(false)
    expect(a1.pause).toBeFalsy()
    const a2 = g.onPreToolUse('Bash', { command: cmd })
    expect(a2.allow).toBe(false)
    expect(a2.pause).toBe(true)
    expect(a2.decision?.kind).toBe('pause')
    expect(a2.decision?.reasonCodes).toContain('reflection_ignored')
    expect(g.getState().phase).toBe('paused')
  })

  it('新用户回合重置状态（emitPhase=cleared 当上一轮非 observing）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0-kscc-resume-crash.js'
    // 3 次相同失败 → warn（rep=3）
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 100 }))
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 200 }))
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 300 })) // warn → reflection_required
    // 3 个无进展批次 → final_response_only
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 400 }))
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 500 }))
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 600 })) // final_response_only
    // 2 次 PreToolUse 违规 → paused
    g.onPreToolUse('Bash', { command: cmd })
    g.onPreToolUse('Bash', { command: cmd })
    expect(g.getState().phase).toBe('paused')
    const cleared = g.resetForNewTurn(1000)
    expect(cleared.emitPhase).toBe('cleared')
    expect(g.getState().phase).toBe('observing')
    expect(g.getState().noProgressBatchCount).toBe(0)
    expect(g.getState().batchCount).toBe(0)
  })

  it('新回合从 observing 开始时 reset 不发 cleared', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    const cleared = g.resetForNewTurn(0)
    expect(cleared.emitPhase).toBeNull()
  })
})

describe('NoProgressGuard 误判防护（SPEC §12 / §16.4）', () => {
  it('多文件编辑不触发（8 个不同文件各编辑 1 次）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    for (let i = 0; i < 8; i++) {
      const d = g.observe(editCall(`src/file${i}.ts`, { at: 100 * (i + 1) }))
      expect(d.kind).toBe('continue')
      expect(d.emitPhase).toBeNull()
    }
    expect(g.getState().phase).toBe('observing')
    expect(g.getState().noProgressBatchCount).toBe(0)
  })

  it('同一文件累计 5 次编辑（验证未变）→ 一级提醒 same_target_edited_without_verification_change', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const file = 'tools/a0-kscc-resume-crash.js'
    for (let i = 0; i < 4; i++) {
      const d = g.observe(editCall(file, { oldStr: `o${i}`, newStr: `n${i}`, at: 100 * (i + 1) }))
      expect(d.kind).toBe('continue')
    }
    const d5 = g.observe(editCall(file, { oldStr: 'o4', newStr: 'n4', at: 500 }))
    expect(d5.kind).toBe('warn')
    expect(d5.reasonCodes).toContain('same_target_edited_without_verification_change')
  })

  it('Read/Grep 调查类不增加无进展计数', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0.js'
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 100 }))
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 200 })) // np=1
    expect(g.getState().noProgressBatchCount).toBe(1)
    g.observe(readCall('src/a.ts', 300)) // Read neutral
    g.observe(readCall('src/b.ts', 400))
    expect(g.getState().noProgressBatchCount).toBe(1) // 未增未减
  })

  it('连续读取不同文件不触发（纯调查）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    for (let i = 0; i < 10; i++) {
      const d = g.observe(readCall(`src/file${i}.ts`, 100 * (i + 1)))
      expect(d.kind).toBe('continue')
    }
    expect(g.getState().phase).toBe('observing')
  })
})

describe('NoProgressGuard 三级暂停硬上限（SPEC §7.3）', () => {
  it('累计 12 个无进展批次 → 暂停 no_new_evidence', () => {
    const g = new NoProgressGuard({
      mode: 'enforce',
      now: () => 0,
      thresholds: { sameFailureRepeat: 100, batchesAfterReflection: 100 }, // 关闭 7.1.1 与 7.2，隔离 7.3.2
    })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0.js'
    let last = undefined as unknown as ReturnType<typeof g.observe>
    for (let i = 0; i < 13; i++) {
      last = g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 100 * (i + 1) }))
    }
    // batch1 neutral；batch2..13 共 12 个 noProgress → np=12 → pause
    expect(last.kind).toBe('pause')
    expect(last.emitPhase).toBe('paused')
    expect(last.reasonCodes).toContain('no_new_evidence')
    expect(g.getState().phase).toBe('paused')
  })

  it('相同空输出超时 4 次 → 暂停 empty_timeout_repeated', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0.js'
    g.observe(bashEmptyTimeout(cmd, 100)) // neutral, perCmd=1
    g.observe(bashEmptyTimeout(cmd, 200)) // warn, perCmd=2
    g.observe(bashEmptyTimeout(cmd, 300)) // bsR=1, perCmd=3
    const d4 = g.observe(bashEmptyTimeout(cmd, 400)) // perCmd=4 → pause
    expect(d4.kind).toBe('pause')
    expect(d4.reasonCodes).toContain('empty_timeout_repeated')
    expect(g.getState().phase).toBe('paused')
  })

  it('无进展持续超过时限 → 暂停 time_without_progress', () => {
    const g = new NoProgressGuard({
      mode: 'enforce',
      now: () => 0,
      thresholds: { noProgressDurationMs: 500, sameFailureRepeat: 100, consecutiveNoProgressBatches: 100 },
    })
    g.resetForNewTurn(0) // lastProgressAt=0, lastUserInputAt=0
    const cmd = 'node tools/a0.js'
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 100 })) // neutral
    g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 200 })) // np=1, 200 < 500
    const d3 = g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 600 })) // np=2, 600 >= 500
    expect(d3.kind).toBe('pause')
    expect(d3.reasonCodes).toContain('time_without_progress')
  })
})

describe('NoProgressGuard 模式与拦截', () => {
  it('shadow 与 enforce 产出相同决策（守卫不按 mode 改判定；mode 由适配层施加）', () => {
    const run = (mode: 'shadow' | 'enforce') => {
      const g = new NoProgressGuard({ mode, now: () => 0 })
      g.resetForNewTurn(0)
      const cmd = 'node tools/a0.js'
      g.observe(bashEmptyTimeout(cmd, 100))
      return g.observe(bashEmptyTimeout(cmd, 200))
    }
    const sh = run('shadow')
    const en = run('enforce')
    expect(sh.kind).toBe(en.kind)
    expect(sh.emitPhase).toBe(en.emitPhase)
    expect(sh.reasonCodes).toEqual(en.reasonCodes)
  })

  it('onPreToolUse 非 final_response_only 时放行', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    expect(g.onPreToolUse('Bash', { command: 'x' }).allow).toBe(true)
  })

  it('已暂停后 observe 幂等返回 pause', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0.js'
    g.observe(bashEmptyTimeout(cmd, 100))
    g.observe(bashEmptyTimeout(cmd, 200))
    g.observe(bashEmptyTimeout(cmd, 300))
    g.observe(bashEmptyTimeout(cmd, 400)) // pause
    const d = g.observe(bashEmptyTimeout(cmd, 500))
    expect(d.kind).toBe('pause')
  })

  it('getMode / setMode', () => {
    const g = new NoProgressGuard({ mode: 'shadow' })
    expect(g.getMode()).toBe('shadow')
    g.setMode('enforce')
    expect(g.getMode()).toBe('enforce')
  })
})

describe('resolveNoProgressGuardMode（§23.1 白名单归一）', () => {
  it('合法值直传', () => {
    expect(resolveNoProgressGuardMode({ TAGENT_NO_PROGRESS_GUARD_MODE: 'off' })).toBe('off')
    expect(resolveNoProgressGuardMode({ TAGENT_NO_PROGRESS_GUARD_MODE: 'shadow' })).toBe('shadow')
    expect(resolveNoProgressGuardMode({ TAGENT_NO_PROGRESS_GUARD_MODE: 'enforce' })).toBe('enforce')
  })
  it('非法 / 缺省回落默认 enforce', () => {
    expect(resolveNoProgressGuardMode({ TAGENT_NO_PROGRESS_GUARD_MODE: 'bogus' })).toBe(NO_PROGRESS_GUARD_DEFAULT_MODE)
    expect(resolveNoProgressGuardMode({})).toBe(NO_PROGRESS_GUARD_DEFAULT_MODE)
    expect(resolveNoProgressGuardMode(undefined)).toBe(NO_PROGRESS_GUARD_DEFAULT_MODE)
  })
  it('落盘偏好在无 env 时生效；env 仍优先', () => {
    expect(resolveNoProgressGuardMode({}, 'shadow')).toBe('shadow')
    expect(resolveNoProgressGuardMode({}, 'off')).toBe('off')
    expect(
      resolveNoProgressGuardMode({ TAGENT_NO_PROGRESS_GUARD_MODE: 'enforce' }, 'shadow'),
    ).toBe('enforce')
  })
  it('默认模式为 enforce（产品默认真正防死循环）', () => {
    expect(NO_PROGRESS_GUARD_DEFAULT_MODE).toBe('enforce')
  })
  it('默认阈值与 SPEC §7 一致', () => {
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.sameFailureRepeat).toBe(3)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.sameFileEditsNoVerifyChange).toBe(5)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.consecutiveNoProgressBatches).toBe(8)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.sameCommandEmptyTimeoutWarn).toBe(2)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.batchesAfterReflection).toBe(3)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.finalResponseViolationsPause).toBe(2)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.totalNoProgressBatchesPause).toBe(12)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.totalEmptyTimeoutPause).toBe(4)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.noProgressDurationMs).toBe(10 * 60 * 1000)
  })
})
