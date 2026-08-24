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
  successSignature,
  strategySignature,
  buildNoProgressAskUserInput,
  buildVerifyOnStopAskUserInput,
  VERIFY_ON_STOP_PAUSE_ERRORS,
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

function writeCall(file: string, opts: { content?: string; error?: string; at?: number } = {}): ToolBatchObservation {
  return batch(
    [
      {
        toolName: 'Write',
        input: { file_path: file, content: opts.content ?? 'default content' },
        output: opts.error ? undefined : { ok: true },
        error: opts.error,
      },
    ],
    { at: opts.at },
  )
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

// ===== brief 2026-08-19 §1 / §2：重复成功签名与策略签名稳定性 =====

describe('NoProgressGuard 重复成功与策略签名归一', () => {
  it('successSignature：Write 同内容同文件 → 同签名；不同内容 → 不同签名；不含正文', () => {
    const s1 = successSignature('Write', { file_path: '/a.ts', content: 'hello world body' })
    const s2 = successSignature('Write', { file_path: '/a.ts', content: 'hello world body' })
    expect(s1).toBe(s2)
    const s3 = successSignature('Write', { file_path: '/a.ts', content: 'a completely different body' })
    expect(s3).not.toBe(s1)
    // 不保留正文
    expect(s1).not.toContain('hello world body')
  })

  it('successSignature：Edit 复用 actionSignature（同区域同签名）', () => {
    const a = successSignature('Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' })
    const b = successSignature('Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' })
    expect(a).toBe(b)
    const c = successSignature('Edit', { file_path: '/a.ts', old_string: 'other', new_string: 'z' })
    expect(c).not.toBe(a)
  })

  it('successSignature：非 edit 类返回 undefined（不参与重复成功追踪）', () => {
    expect(successSignature('Bash', { command: 'ls' })).toBeUndefined()
    expect(successSignature('Read', { file_path: '/a.ts' })).toBeUndefined()
  })

  it('strategySignature：Bash 去掉 flag，同主干同策略（仅换相近参数）', () => {
    expect(strategySignature('Bash', { command: 'node tools/a0.js --foo' })).toBe(
      strategySignature('Bash', { command: 'node tools/a0.js --bar' }),
    )
    // 多空格 / 无 flag 等价
    expect(strategySignature('Bash', { command: 'node  tools/a0.js' })).toBe(
      strategySignature('Bash', { command: 'node tools/a0.js --foo' }),
    )
  })

  it('strategySignature：Bash 不同主干 → 不同策略', () => {
    expect(strategySignature('Bash', { command: 'node tools/a0.js' })).not.toBe(
      strategySignature('Bash', { command: 'npm test' }),
    )
  })

  it('strategySignature：同文件 Edit/Write 视为同策略（编辑不同区域不算实质变化）', () => {
    expect(strategySignature('Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' })).toBe(
      strategySignature('Edit', { file_path: '/a.ts', old_string: 'p', new_string: 'q' }),
    )
    expect(strategySignature('Write', { file_path: '/a.ts', content: 'a' })).toBe(
      strategySignature('Write', { file_path: '/a.ts', content: 'b' }),
    )
    expect(strategySignature('Edit', { file_path: '/a.ts' })).not.toBe(
      strategySignature('Edit', { file_path: '/b.ts' }),
    )
  })
})

// ===== brief 2026-08-19 §1：重复成功也视为无效进展 =====

describe('NoProgressGuard 重复成功检测（brief 2026-08-19 §1）', () => {
  it('同一 Write 内容连续重复 3 次 → 一级提醒 same_success_repeated，且计入无进展批次', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const file = 'tools/a0.js'
    const d1 = g.observe(writeCall(file, { content: 'same body', at: 100 }))
    const d2 = g.observe(writeCall(file, { content: 'same body', at: 200 }))
    expect(d1.kind).toBe('continue')
    expect(d2.kind).toBe('continue')
    expect(g.getState().maxSuccessRepeat).toBe(2)
    const d3 = g.observe(writeCall(file, { content: 'same body', at: 300 }))
    expect(d3.kind).toBe('warn')
    expect(d3.emitPhase).toBe('warning')
    expect(d3.reasonCodes).toContain('same_success_repeated')
    expect(d3.phase).toBe('reflection_required')
    // 第 3 次被分类为 noProgress → noProgressBatchCount 计入
    expect(g.getState().noProgressBatchCount).toBe(1)
    expect(g.getState().successRepeatStreak).toBe(3)
  })

  it('同文件不同内容 Write（迭代开发）不触发 same_success_repeated', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const file = 'tools/a0.js'
    g.observe(writeCall(file, { content: 'body v1', at: 100 }))
    g.observe(writeCall(file, { content: 'body v2 different', at: 200 }))
    const d3 = g.observe(writeCall(file, { content: 'body v3 also different', at: 300 }))
    expect(d3.kind).toBe('continue')
    expect(d3.reasonCodes).not.toContain('same_success_repeated')
    expect(g.getState().maxSuccessRepeat).toBe(1)
    expect(g.getState().phase).toBe('observing')
  })

  it('同一 Edit 区域连续重复成功 3 次 → same_success_repeated', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const file = 'tools/a0.js'
    g.observe(editCall(file, { oldStr: 'foo', newStr: 'bar', at: 100 }))
    g.observe(editCall(file, { oldStr: 'foo', newStr: 'bar', at: 200 }))
    const d3 = g.observe(editCall(file, { oldStr: 'foo', newStr: 'bar', at: 300 }))
    expect(d3.kind).toBe('warn')
    expect(d3.reasonCodes).toContain('same_success_repeated')
  })

  it('非相同成功调用打断 streak：Write,Write,Read,Write,Write 不触发', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const file = 'tools/a0.js'
    g.observe(writeCall(file, { content: 'same body', at: 100 })) // streak=1
    g.observe(writeCall(file, { content: 'same body', at: 200 })) // streak=2
    g.observe(readCall(file, 300)) // Read 打断 streak → 0
    g.observe(writeCall(file, { content: 'same body', at: 400 })) // streak=1
    const d = g.observe(writeCall(file, { content: 'same body', at: 500 })) // streak=2
    expect(d.kind).toBe('continue')
    expect(d.reasonCodes).not.toContain('same_success_repeated')
    expect(g.getState().maxSuccessRepeat).toBe(2)
  })

  it('重复成功经现有暂停语义收敛（warn→reflection→final→pause），不立即暂停', () => {
    // 验证不改变现有暂停语义：same_success_repeated 只新增一级入口，收敛仍走既有三级 escalation
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0, thresholds: { batchesAfterReflection: 2 } })
    g.resetForNewTurn(0)
    const file = 'tools/a0.js'
    g.observe(writeCall(file, { content: 'same body', at: 100 })) // streak=1
    g.observe(writeCall(file, { content: 'same body', at: 200 })) // streak=2
    const dWarn = g.observe(writeCall(file, { content: 'same body', at: 300 })) // streak=3 → warn
    expect(dWarn.kind).toBe('warn')
    // reflection_required 后继续重复写（noProgress）→ 推进 batchesSinceReflection
    g.observe(writeCall(file, { content: 'same body', at: 400 })) // bsR=1
    const dFinal = g.observe(writeCall(file, { content: 'same body', at: 500 })) // bsR=2 → final_response_only
    expect(dFinal.kind).toBe('require_reflection')
    expect(g.getState().phase).toBe('final_response_only')
    // 强制复盘后仍尝试工具：PreToolUse 拦截 2 次 → pause（现有语义，reason=reflection_ignored）
    const a1 = g.onPreToolUse('Write', { file_path: file, content: 'same body' })
    expect(a1.allow).toBe(false)
    expect(a1.pause).toBeFalsy()
    const a2 = g.onPreToolUse('Write', { file_path: file, content: 'same body' })
    expect(a2.allow).toBe(false)
    expect(a2.pause).toBe(true)
    expect(a2.decision?.reasonCodes).toContain('reflection_ignored')
    expect(g.getState().phase).toBe('paused')
  })
})

// ===== brief 2026-08-19 §2：只有策略发生实质变化才允许继续 =====

describe('NoProgressGuard 策略未实质变化检测（brief 2026-08-19 §2）', () => {
  it('同一策略下 3 个不同失败动作变体 → strategy_unchanged（same_failure_repeated 不误触发）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(bashFail('node tools/a0.js --foo', { error: 'Exit code 1', output: 'err', at: 100 }))
    g.observe(bashFail('node tools/a0.js --bar', { error: 'Exit code 1', output: 'err', at: 200 }))
    const d3 = g.observe(bashFail('node tools/a0.js --baz', { error: 'Exit code 1', output: 'err', at: 300 }))
    expect(d3.kind).toBe('warn')
    expect(d3.reasonCodes).toContain('strategy_unchanged')
    // 三个动作签名各不相同 → 精确重复未达 sameFailureRepeat(3) 阈值
    expect(d3.reasonCodes).not.toContain('same_failure_repeated')
    expect(g.getState().maxStrategyVariants).toBe(3)
    expect(g.getState().phase).toBe('reflection_required')
  })

  it('每次都换实质策略（不同主干）→ 不触发 strategy_unchanged', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmds = ['node tools/a0.js', 'npm test', 'git status', 'node tools/b0.js']
    let last = undefined as unknown as ReturnType<typeof g.observe>
    for (let i = 0; i < cmds.length; i++) {
      last = g.observe(bashFail(cmds[i]!, { error: 'Exit code 1', output: 'err', at: 100 * (i + 1) }))
      expect(last.kind).toBe('continue')
    }
    expect(last.reasonCodes).not.toContain('strategy_unchanged')
    expect(g.getState().maxStrategyVariants).toBe(1)
    expect(g.getState().phase).toBe('observing')
  })

  it('实质策略变化不被误判：S1 两变体后换 S2 不触发；回到 S1 第三变体才触发', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(bashFail('node tools/a0.js --foo', { error: 'Exit code 1', output: 'err', at: 100 })) // S1 size 1
    g.observe(bashFail('node tools/a0.js --bar', { error: 'Exit code 1', output: 'err', at: 200 })) // S1 size 2
    const dSwitch = g.observe(bashFail('npm test', { error: 'Exit code 1', output: 'err', at: 300 })) // S2 size 1，实质换策略
    expect(dSwitch.kind).toBe('continue')
    expect(dSwitch.reasonCodes).not.toContain('strategy_unchanged') // 实质变化不被误判
    const dBack = g.observe(bashFail('node tools/a0.js --baz', { error: 'Exit code 1', output: 'err', at: 400 })) // S1 size 3
    expect(dBack.kind).toBe('warn')
    expect(dBack.reasonCodes).toContain('strategy_unchanged') // 回到同策略再换相近参数 → 触发
  })

  it('同文件 3 个不同失败 Edit 区域 → strategy_unchanged', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const file = 'tools/a0.js'
    g.observe(editCall(file, { oldStr: 'a1', newStr: 'b1', error: 'old_string not found', at: 100 }))
    g.observe(editCall(file, { oldStr: 'a2', newStr: 'b2', error: 'old_string not found', at: 200 }))
    const d3 = g.observe(editCall(file, { oldStr: 'a3', newStr: 'b3', error: 'old_string not found', at: 300 }))
    expect(d3.kind).toBe('warn')
    expect(d3.reasonCodes).toContain('strategy_unchanged')
  })

  it('有效进展重置策略变体计数', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(bashFail('node tools/a0.js --foo', { error: 'Exit code 1', output: 'err', at: 100 })) // S1 size 1
    g.observe(bashFail('node tools/a0.js --bar', { error: 'Exit code 1', output: 'err', at: 200 })) // S1 size 2
    // 同命令失败→成功（结果实质变化）→ progress → 重置策略变体计数
    g.observe(bashSuccess('node tools/a0.js --foo', 300))
    expect(g.getState().maxStrategyVariants).toBe(0)
    expect(g.getState().phase).toBe('observing')
  })

  it('新阈值默认值：sameSuccessRepeat=3、strategyUnchangedVariants=3', () => {
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.sameSuccessRepeat).toBe(3)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.strategyUnchangedVariants).toBe(3)
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
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.sameSuccessRepeat).toBe(3)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.strategyUnchangedVariants).toBe(3)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.totalNoProgressBatchesPause).toBe(12)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.totalEmptyTimeoutPause).toBe(4)
    expect(DEFAULT_NO_PROGRESS_THRESHOLDS.noProgressDurationMs).toBe(10 * 60 * 1000)
  })
})

// ===== brief 2026-08-19 §3：无进展暂停 → AskUserQuestion 结构化澄清 =====

describe('buildNoProgressAskUserInput（brief 2026-08-19 §3）', () => {
  it('生成含已确认事实、无进展摘要和三方向选项的 AskUserQuestion 输入', () => {
    const g = new NoProgressGuard({
      mode: 'enforce',
      now: () => 0,
      // 关闭 7.1.1 与 7.2，隔离 7.3.2（totalNoProgressBatchesPause=12 → no_new_evidence）
      thresholds: { sameFailureRepeat: 100, batchesAfterReflection: 100 },
    })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0.js'
    // 12 个无进展批次 → 第 13 批触发暂停 no_new_evidence（batch1 neutral，batch2..13 共 12 个 np）
    let pauseDecision = null as null | ReturnType<typeof g.observe>
    for (let i = 0; i < 13; i++) {
      const d = g.observe(bashFail(cmd, { error: 'Exit code 1', output: 'err', at: 100 * (i + 1) }))
      if (d.kind === 'pause') pauseDecision = d
    }
    expect(pauseDecision).not.toBeNull()
    expect(pauseDecision!.reasonCodes).toContain('no_new_evidence')

    const state = g.getState()
    const input = buildNoProgressAskUserInput(pauseDecision!, state)
    const questions = input.questions as Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>
    expect(questions).toHaveLength(1)
    const q = questions[0]!
    // 事实：批次计数
    expect(q.question).toContain('已尝试')
    expect(q.question).toContain('未获得新证据')
    // 摘要：reason code → 人话
    expect(q.question).toContain('无进展摘要')
    expect(q.question).toContain('连续工具批次未获得新证据')
    // 三方向选项
    expect(q.options).toHaveLength(3)
    const labels = q.options.map((o) => o.label)
    expect(labels).toContain('补充信息后继续')
    expect(labels).toContain('换一个方案')
    expect(labels).toContain('继续当前方向')
    expect(q.multiSelect).toBe(false)
    expect(q.header).toBe('无进展澄清')
  })

  it('state 提供 maxSuccessRepeat / maxStrategyVariants 时事实更丰富', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const file = 'tools/a0.js'
    // 连续相同成功 Write 触发 same_success_repeated → warn → ... → 最终 pause
    g.observe(writeCall(file, { content: 'same body', at: 100 }))
    g.observe(writeCall(file, { content: 'same body', at: 200 }))
    g.observe(writeCall(file, { content: 'same body', at: 300 })) // warn (streak=3)
    const state = g.getState()
    expect(state.maxSuccessRepeat).toBe(3)

    const decision = g.getState() // 非 pause decision，但 buildNoProgressAskUserInput 接受任意 decision
    // 用一个 pause decision 测试
    const g2 = new NoProgressGuard({ mode: 'enforce', now: () => 0, thresholds: { totalNoProgressBatchesPause: 2 } })
    g2.resetForNewTurn(0)
    g2.observe(bashFail('node tools/a0.js', { error: 'Exit code 1', output: 'err', at: 100 }))
    g2.observe(bashFail('node tools/a0.js', { error: 'Exit code 1', output: 'err', at: 200 }))
    g2.observe(bashFail('node tools/a0.js', { error: 'Exit code 1', output: 'err', at: 300 }))
    const pauseD = g2.getState()
    const pauseDecision = g2.observe(bashFail('node tools/a0.js', { error: 'Exit code 1', output: 'err', at: 400 }))
    expect(pauseDecision.kind).toBe('pause')

    // 用含 maxSuccessRepeat 的 state
    const input = buildNoProgressAskUserInput(pauseDecision, { ...pauseD, maxSuccessRepeat: 5, maxStrategyVariants: 4 })
    const q = (input.questions as Array<{ question: string }>)[0]!
    expect(q.question).toContain('同一成功操作连续重复 5 次')
    expect(q.question).toContain('同一策略下尝试了 4 个不同变体')
    void decision
  })

  it('缺省 state 时退化为仅用 decision 计数（不崩）', () => {
    const decision = {
      kind: 'pause' as const,
      reasonCodes: ['empty_timeout_repeated' as const],
      phase: 'paused' as const,
      batchCount: 10,
      noProgressBatchCount: 8,
      repeatedFailureCount: 3,
      emptyTimeoutCount: 4,
      emitPhase: 'paused' as const,
      userMessage: '已暂停：连续多次操作未获得新进展',
    }
    const input = buildNoProgressAskUserInput(decision)
    const q = (input.questions as Array<{ question: string; options: Array<{ label: string }> }>)[0]!
    expect(q.question).toContain('已尝试 10 个工具批次')
    expect(q.question).toContain('同一动作重复失败 3 次')
    expect(q.question).toContain('空输出超时 4 次')
    // 缺省 state → 不含重复成功 / 策略变体事实
    expect(q.question).not.toContain('同一成功操作连续重复')
    expect(q.question).not.toContain('同一策略下尝试了')
    // 摘要仍正确
    expect(q.question).toContain('同一命令重复空输出超时')
    // 三方向选项仍存在
    expect(q.options).toHaveLength(3)
  })

  it('reasonCodes 为空时摘要回退为通用文案', () => {
    const decision = {
      kind: 'pause' as const,
      reasonCodes: [],
      phase: 'paused' as const,
      batchCount: 1,
      noProgressBatchCount: 1,
      repeatedFailureCount: 0,
      emptyTimeoutCount: 0,
      emitPhase: 'paused' as const,
      userMessage: undefined,
    }
    const input = buildNoProgressAskUserInput(decision)
    const q = (input.questions as Array<{ question: string }>)[0]!
    expect(q.question).toContain('连续多次操作未获得新进展')
    // userMessage 缺省 → 用 PAUSE_USER_MESSAGE
    expect(q.question).toContain('已暂停')
  })
})

// ===== brief 2026-08-19 §4：verify-on-stop 验证提示 =====

describe('NoProgressGuard verify-on-stop 判定（brief 2026-08-19 §4）', () => {
  it('本轮无 edit → checkVerifyOnStop 返回 null（放行）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    // 只跑 Bash（verify），无 edit
    g.observe(bashSuccess('npm test', 100))
    expect(g.checkVerifyOnStop()).toBeNull()
  })

  it('本轮有 edit 无 verify 证据 → 首次返回 pause decision，reasonCodes 含 verify_needed', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(editCall('src/a.ts', { at: 100 })) // edit 成功
    const d = g.checkVerifyOnStop()
    expect(d).not.toBeNull()
    expect(d!.kind).toBe('pause')
    expect(d!.reasonCodes).toContain('verify_needed')
    expect(d!.emitPhase).toBe('paused')
    expect(d!.userMessage).toContain('验证')
  })

  it('本轮有 Write 无 verify 证据 → 触发（Write 也算 edit 类）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(writeCall('src/new.ts', { content: 'content', at: 100 }))
    const d = g.checkVerifyOnStop()
    expect(d).not.toBeNull()
    expect(d!.reasonCodes).toContain('verify_needed')
  })

  it('本轮有 edit + 有 verify 证据（Bash）→ 返回 null（放行）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(editCall('src/a.ts', { at: 100 })) // edit 成功
    g.observe(bashSuccess('npm test', 200)) // verify 证据
    expect(g.checkVerifyOnStop()).toBeNull()
  })

  it('本轮有 edit + 失败的 Bash（仍是验证证据）→ 返回 null', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(editCall('src/a.ts', { at: 100 }))
    g.observe(bashFail('npm test', { error: 'Exit code 1', output: '1 failing', at: 200 }))
    // 失败的 Bash 也是验证证据（运行过测试）
    expect(g.checkVerifyOnStop()).toBeNull()
  })

  it('常见 shell / 检查类工具也算验证证据，避免误触发提示', () => {
    for (const toolName of ['PowerShell', 'pwsh', 'Terminal', 'mcp__host__run_command', 'ReadPixels']) {
      const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
      g.resetForNewTurn(0)
      g.observe(editCall('src/a.ts', { at: 100 }))
      g.observe(
        batch([{ toolName, input: { command: 'npm test' }, output: 'ok' }], { at: 200 }),
      )
      expect(g.checkVerifyOnStop()).toBeNull()
    }
  })

  it('防重复：同回合第二次调用返回 null（verifyPromptFired）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(editCall('src/a.ts', { at: 100 }))
    const d1 = g.checkVerifyOnStop()
    expect(d1).not.toBeNull()
    const d2 = g.checkVerifyOnStop()
    expect(d2).toBeNull() // 已提示过 → 放行
  })

  it('新回合重置：resetForNewTurn 后可再次触发', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(editCall('src/a.ts', { at: 100 }))
    const d1 = g.checkVerifyOnStop()
    expect(d1).not.toBeNull()
    g.resetForNewTurn(200)
    g.observe(editCall('src/b.ts', { at: 300 }))
    const d2 = g.checkVerifyOnStop()
    expect(d2).not.toBeNull() // 新回合可再触发
  })

  it('有效进展重置 edit/verify 追踪但保留 verifyPromptFired', () => {
    // edit → Bash 首失败后成功（progress）→ edit（无 verify）→ checkVerifyOnStop 应触发
    // 但若同回合已触发过，则不再触发
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(editCall('src/a.ts', { at: 100 }))
    // 首次 Bash 建基线（neutral），第二次结果变化才 progress
    g.observe(bashFail('npm test', { error: 'Exit code 1', output: '1 failing', at: 150 }))
    g.observe(bashSuccess('npm test', 200)) // progress → 重置 hadEditThisTurn/hadVerifyEvidenceThisTurn
    expect(g.getState().hadEditThisTurn).toBe(false)
    expect(g.getState().hadVerifyEvidenceThisTurn).toBe(false)
    // 进展后再次 edit（无 verify）
    g.observe(editCall('src/a.ts', { oldStr: 'x', newStr: 'y', at: 300 }))
    const d = g.checkVerifyOnStop()
    expect(d).not.toBeNull() // 第二次 edit 无 verify → 触发
    expect(d!.reasonCodes).toContain('verify_needed')
  })

  it('有效进展后若同回合已提示过，第二次 edit 仍不重复触发', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(editCall('src/a.ts', { at: 100 }))
    const d1 = g.checkVerifyOnStop()
    expect(d1).not.toBeNull()
    // 进展（首失败后成功 = 结果变化 = progress）后再次 edit
    g.observe(bashFail('npm test', { error: 'Exit code 1', output: 'fail', at: 150 }))
    g.observe(bashSuccess('npm test', 200)) // 真实 progress
    g.observe(editCall('src/b.ts', { at: 300 }))
    const d2 = g.checkVerifyOnStop()
    expect(d2).toBeNull() // verifyPromptFired 仍 true（progress 不复位）→ 防重复
  })

  it('edit 失败不计入 hadEditThisTurn', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(editCall('src/a.ts', { error: 'old_string not found', at: 100 }))
    expect(g.getState().hadEditThisTurn).toBe(false)
    expect(g.checkVerifyOnStop()).toBeNull()
  })

  it('getState 反映 verify-on-stop 追踪字段', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    expect(g.getState().hadEditThisTurn).toBe(false)
    expect(g.getState().hadVerifyEvidenceThisTurn).toBe(false)
    expect(g.getState().verifyPromptFired).toBe(false)
    g.observe(editCall('src/a.ts', { at: 100 }))
    expect(g.getState().hadEditThisTurn).toBe(true)
    // checkVerifyOnStop 命中（无 verify 证据）→ verifyPromptFired 置 true
    g.checkVerifyOnStop()
    expect(g.getState().verifyPromptFired).toBe(true)
    // 有 verify 证据时 hadVerifyEvidenceThisTurn 为 true
    g.observe(bashFail('npm test', { at: 200 }))
    expect(g.getState().hadVerifyEvidenceThisTurn).toBe(true)
  })
})

describe('buildVerifyOnStopAskUserInput（brief 2026-08-19 §4）', () => {
  it('生成含验证提示和三方向选项的 AskUserQuestion 输入', () => {
    const input = buildVerifyOnStopAskUserInput()
    const questions = input.questions as Array<{
      question: string
      header?: string
      options: Array<{ label: string; description?: string }>
      multiSelect?: boolean
    }>
    expect(questions).toHaveLength(1)
    const q = questions[0]!
    expect(q.question).toContain('验证')
    expect(q.question).toContain('修改了文件')
    expect(q.header).toBe('验证提示')
    expect(q.options).toHaveLength(3)
    const labels = q.options.map((o) => o.label)
    expect(labels).toContain('请先验证再结束')
    expect(labels).toContain('我来手动确认')
    expect(labels).toContain('直接结束')
    expect(q.multiSelect).toBe(false)
  })

  it('VERIFY_ON_STOP_PAUSE_ERRORS 含验证提示文案', () => {
    expect(VERIFY_ON_STOP_PAUSE_ERRORS).toHaveLength(1)
    expect(VERIFY_ON_STOP_PAUSE_ERRORS[0]).toContain('验证')
    expect(VERIFY_ON_STOP_PAUSE_ERRORS[0]).toContain('会话与历史保留')
  })
})
