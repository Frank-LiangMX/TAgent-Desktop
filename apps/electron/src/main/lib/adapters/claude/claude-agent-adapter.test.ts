import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'

/** 官方 runtime 会在 config dir 下建私有 host home；固定到临时目录避免污染真实 ~/.tagent。 */
const CONFIG_ROOT = mkdtempSync(join(tmpdir(), 'tagent-claude-adapter-test-'))
process.env.TAGENT_CONFIG_DIR = CONFIG_ROOT
afterAll(() => {
  try {
    rmSync(CONFIG_ROOT, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
})

const mocks = vi.hoisted(() => ({
  sdkQuery: vi.fn(),
  spawnOfficial: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.sdkQuery }))
vi.mock('node:child_process', () => ({
  spawn: mocks.spawnOfficial,
  execFileSync: mocks.execFileSync,
}))
import {
  buildOfficialClaudeRuntimeEnv,
  ClaudeAgentAdapter,
  resolveOfficialClaudeCodeExecutable,
  resolveSdkEffort,
  postToolBatchToObservation,
  normalizeResultToPausedNoProgress,
} from './claude-agent-adapter'
import {
  NoProgressGuard,
  buildNoProgressEventFromDecision,
  buildNoProgressAskUserInput,
  buildVerifyOnStopAskUserInput,
  VERIFY_ON_STOP_PAUSE_ERRORS,
} from '../../agent/no-progress-guard'
import type { Options as SdkOptions } from '@anthropic-ai/claude-agent-sdk'
import { REASONING_EFFORT_ORDER, type SDKMessage, type SDKResultMessage } from '@tagent/shared'

describe('Claude official API runtime environment', () => {
  test('resolves the unpacked Windows Claude binary for packaged Electron', () => {
    expect(resolveOfficialClaudeCodeExecutable('D:\\Program Files\\TAgent\\resources', () => true)).toBe(
      'D:\\Program Files\\TAgent\\resources\\app.asar.unpacked\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe',
    )
    expect(resolveOfficialClaudeCodeExecutable('D:\\Program Files\\TAgent\\resources', () => false)).toBeUndefined()
  })

  test('uses only the selected API channel, an isolated host dir, and inherited subagent model', () => {
    const env = buildOfficialClaudeRuntimeEnv(
      {
        model: 'gateway/claude-main',
        env: {
          PATH: 'C:\\Windows\\System32',
          ANTHROPIC_API_KEY: 'global-key-must-not-leak',
          CLAUDE_CONFIG_DIR: 'C:\\Users\\test\\.claude',
          OPENAI_API_KEY: 'another-global-secret',
        },
        apiConnection: {
          channelId: 'claude-channel-a',
          baseUrl: 'https://messages.example.test',
          apiKey: 'selected-key',
          contextWindow: 250_000,
        },
      },
      'C:\\temp\\tagent-claude-private',
    )

    expect(env).toMatchObject({
      PATH: 'C:\\Windows\\System32',
      CLAUDE_CONFIG_DIR: 'C:\\temp\\tagent-claude-private',
      ANTHROPIC_BASE_URL: 'https://messages.example.test',
      ANTHROPIC_API_KEY: 'selected-key',
      ANTHROPIC_MODEL: 'gateway/claude-main',
      CLAUDE_CODE_SUBAGENT_MODEL: 'gateway/claude-main',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '250000',
    })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).not.toBe('global-key-must-not-leak')
  })

  test('rejects incomplete official API connections before launch', () => {
    expect(() =>
      buildOfficialClaudeRuntimeEnv(
        {
          apiConnection: {
            channelId: 'channel',
            baseUrl: 'https://messages.example.test',
            apiKey: '',
          },
        },
        'C:\\temp\\private',
      ),
    ).toThrow(/apiKey/)
  })

  test('keeps PATH for headless launch while filtering inherited credentials', () => {
    const originalPath = process.env.PATH
    const originalKey = process.env.ANTHROPIC_API_KEY
    process.env.PATH = 'C:\\Windows\\System32'
    process.env.ANTHROPIC_API_KEY = 'global-key-must-not-leak'
    try {
      const env = buildOfficialClaudeRuntimeEnv(
        {
          model: 'gateway/claude-main',
          apiConnection: {
            channelId: 'claude-channel-a',
            baseUrl: 'https://messages.example.test',
            apiKey: 'selected-key',
          },
        },
        'C:\\temp\\tagent-claude-private',
      )
      expect(env.PATH).toBe('C:\\Windows\\System32')
      expect(env.ANTHROPIC_API_KEY).toBe('selected-key')
      expect(env.OPENAI_API_KEY).toBeUndefined()
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = originalKey
    }
  })

  test('accepts the factory object discriminator and fails closed without a connection', async () => {
    const iterator = new ClaudeAgentAdapter()
      .query({
        sessionId: 'official-without-channel',
        prompt: 'hello',
        sdkPermissionMode: 'default',
        allowDangerouslySkipPermissions: false,
        systemPrompt: 'test',
      })
      [Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow(/缺少 apiConnection/)
  })

  test('wires official SDK launch, resume, and caller permission handler without KSCC', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'tagent-claude-sdk-test-'))
    const oldConfigDir = process.env.TAGENT_CONFIG_DIR
    process.env.TAGENT_CONFIG_DIR = configRoot
    const captured: Array<Record<string, unknown>> = []
    const permissionHandler = vi.fn()
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    })
    mocks.spawnOfficial.mockReturnValue(child)
    mocks.sdkQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      captured.push(options)
      return (async function* () {
        yield { type: 'result', subtype: 'success', usage: {} }
      })()
    })

    try {
      const input = {
        sessionId: 'claude-resume-session',
        prompt: 'implement',
        model: 'gateway/claude-main',
        sdkPermissionMode: 'default',
        allowDangerouslySkipPermissions: false,
        // 旧调用方即使显式传 enforce，也不能恢复无进展拦截。
        noProgressGuardMode: 'enforce',
        canUseTool: permissionHandler,
        systemPrompt: 'test',
        apiConnection: {
          channelId: 'claude-channel-a',
          baseUrl: 'https://messages.example.test',
          apiKey: 'selected-key',
        },
        agents: {
          reviewer: { description: 'review', prompt: 'review', model: 'haiku' },
        },
        disallowedTools: ['Agent', 'Task'] as string[],
      } as const
      const adapter = new ClaudeAgentAdapter()
      const first = adapter.query(input)[Symbol.asyncIterator]()
      await first.next()
      await first.next()

      const launched = captured[0]!
      expect(launched.pathToClaudeCodeExecutable).toBeUndefined()
      expect(launched.settingSources).toEqual([])
      expect(launched.permissionMode).toBe('default')
      expect(launched.canUseTool).toBe(permissionHandler)
      expect(launched.disallowedTools).toEqual(['Agent', 'Task'])
      expect(launched.hooks).toBeUndefined()
      expect((launched.agents as { reviewer: { model: string } }).reviewer.model).toBe('inherit')
      expect((launched.env as Record<string, string>).CLAUDE_CODE_SUBAGENT_MODEL).toBe('gateway/claude-main')

      const reported = vi.fn()
      // Replace the original callback only after launch capture, then verify
      // the SDK-facing callback itself cannot forward the selected key.
      const stderrInput = { ...input, onStderr: reported }
      const stderrAdapter = new ClaudeAgentAdapter()
      const stderrIterator = stderrAdapter.query(stderrInput)[Symbol.asyncIterator]()
      await stderrIterator.next()
      const stderrOptions = captured[1]!
      const redactedStderr = stderrOptions.stderr as (data: string) => void
      redactedStderr('rejected selec')
      expect(reported.mock.calls.flat().join('')).not.toContain('selec')
      redactedStderr('ted-key')
      expect(reported.mock.calls.flat().join('')).toBe('rejected [REDACTED]')
      stderrAdapter.dispose()

      const spawnOfficial = launched.spawnClaudeCodeProcess as (options: {
        command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal
      }) => unknown
      spawnOfficial({
        command: 'bundled-claude-code', args: ['--sdk'], cwd: 'F:\\repo',
        env: launched.env as NodeJS.ProcessEnv, signal: new AbortController().signal,
      })
      expect(mocks.spawnOfficial).toHaveBeenCalledWith(
        'bundled-claude-code', ['--sdk'], expect.objectContaining({ cwd: 'F:\\repo' }),
      )

      const resumed = new ClaudeAgentAdapter()
        .query({ ...input, resumeSessionId: 'native-session-id' })
        [Symbol.asyncIterator]()
      await resumed.next()
      expect(captured[2]!.resume).toBe('native-session-id')
      expect(captured[2]!.canUseTool).toBe(permissionHandler)
      await resumed.next()
    } finally {
      mocks.sdkQuery.mockReset()
      mocks.spawnOfficial.mockReset()
      if (oldConfigDir === undefined) delete process.env.TAGENT_CONFIG_DIR
      else process.env.TAGENT_CONFIG_DIR = oldConfigDir
      rmSync(configRoot, { recursive: true, force: true })
    }
  })

  test('disposing one runtime adapter leaves another runtime session active', async () => {
    mocks.sdkQuery.mockImplementation(() =>
      (async function* () {
        yield { type: 'result', subtype: 'success', usage: {} }
        await new Promise<void>(() => {})
      })(),
    )
    const a = new ClaudeAgentAdapter()
    const b = new ClaudeAgentAdapter()
    const conn = { channelId: 'channel-a', baseUrl: 'https://example.test', apiKey: 'key-a' }
    const aIterator = a.query({
      sessionId: 'session-a', prompt: 'a', model: 'model-a',
      sdkPermissionMode: 'default', allowDangerouslySkipPermissions: false, systemPrompt: 'test',
      apiConnection: conn,
    })[Symbol.asyncIterator]()
    const bIterator = b.query({
      sessionId: 'session-b', prompt: 'b', model: 'model-a',
      sdkPermissionMode: 'default', allowDangerouslySkipPermissions: false, systemPrompt: 'test',
      apiConnection: conn,
    })[Symbol.asyncIterator]()
    await aIterator.next()
    await bIterator.next()

    a.dispose()

    expect(a.hasActiveChannel('session-a')).toBe(false)
    expect(b.hasActiveChannel('session-b')).toBe(true)
    b.dispose()
    mocks.sdkQuery.mockReset()
  })

  test('breaking a query cleans up only its own active session and closes the SDK query', async () => {
    const close = vi.fn()
    const iterable = Object.assign((async function* () {
      yield { type: 'result', subtype: 'success', usage: {} }
      await new Promise<void>(() => {})
    })(), { close })
    mocks.sdkQuery.mockReturnValue(iterable)
    const adapter = new ClaudeAgentAdapter()
    const iterator = adapter.query({
      sessionId: 'cleanup-session', prompt: 'cleanup', model: 'model-a',
      sdkPermissionMode: 'default', allowDangerouslySkipPermissions: false, systemPrompt: 'test',
      apiConnection: { channelId: 'channel-a', baseUrl: 'https://example.test', apiKey: 'key-a' },
    })[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    expect(close).toHaveBeenCalledOnce()
    expect(adapter.hasActiveChannel('cleanup-session')).toBe(false)
    mocks.sdkQuery.mockReset()
  })
})

/**
 * 证明 session meta.reasoningEffort 真正落到 Claude Agent SDK query options.effort。
 * buildSdkOptions 用 resolveSdkEffort 注入 `effort`；这里直接验其产出即 options.effort 值。
 */
describe('resolveSdkEffort — reasoningEffort → SDK options.effort', () => {
  test('四个档位产出互不相同的 effort（不同 reasoningEffort → 不同 SDK options）', () => {
    const efforts = REASONING_EFFORT_ORDER.map((e) => resolveSdkEffort(e))
    expect(new Set(efforts).size).toBe(REASONING_EFFORT_ORDER.length)
  })

  test('low/medium/high/max 分别直传', () => {
    expect(resolveSdkEffort('low')).toBe('low')
    expect(resolveSdkEffort('medium')).toBe('medium')
    expect(resolveSdkEffort('high')).toBe('high')
    expect(resolveSdkEffort('max')).toBe('max')
  })

  test('产出类型符合 SdkOptions["effort"]（EffortLevel: low|medium|high|xhigh|max）', () => {
    const e: SdkOptions['effort'] = resolveSdkEffort('high')
    expect(e).toBe('high')
  })

  test('max 不被 TAgent 侧降级（交由 SDK 按模型静默降级）', () => {
    expect(resolveSdkEffort('max')).toBe('max')
  })
})

/**
 * No-Progress Guard（Claude Code）接线（§10.2 / §14.2）。
 * 不 spawn SDK，直接验 hook 驱动的纯函数：观察翻译、终态归一化、事件构造、
 * 以及 PostToolBatch→observe→additionalContext（warn）的驱动链路。
 */
describe('No-Progress Guard（Claude Code）接线', () => {
  test('postToolBatchToObservation 翻译 hook 输入为统一观察', () => {
    const obs = postToolBatchToObservation(
      {
        tool_calls: [
          { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tu-1', tool_response: '' },
        ],
      },
      's1',
      't1',
      1000,
    )
    expect(obs.provider).toBe('kscc')
    expect(obs.sessionId).toBe('s1')
    expect(obs.turnId).toBe('t1')
    expect(obs.observedAt).toBe(1000)
    expect(obs.calls).toHaveLength(1)
    expect(obs.calls[0]).toMatchObject({ toolUseId: 'tu-1', toolName: 'Bash', input: { command: 'npm test' } })
  })

  test('normalizeResultToPausedNoProgress 归一化为唯一 paused_no_progress（§20.5）', () => {
    const errMaxTurns: SDKMessage = {
      type: 'result',
      subtype: 'error_max_turns',
      usage: { input_tokens: 0, output_tokens: 0 },
      errors: ['已达最大工具循环轮次'],
    } as SDKResultMessage
    const out = normalizeResultToPausedNoProgress(errMaxTurns) as SDKResultMessage
    expect(out.type).toBe('result')
    expect(out.subtype).toBe('paused_no_progress')
    expect(out.errors?.[0]).toContain('已暂停')
    // 非 result 不改
    const assistant: SDKMessage = { type: 'assistant', message: { content: [] }, parent_tool_use_id: null } as never
    expect(normalizeResultToPausedNoProgress(assistant)).toBe(assistant)
  })

  test('buildNoProgressEventFromDecision: shadow 带 shadow=true；enforce 不带', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0.js'
    g.observe({
      sessionId: 's', turnId: 't', provider: 'kscc', observedAt: 100,
      calls: [{ toolUseId: 'a', toolName: 'Bash', input: { command: cmd }, output: '', error: 'Command timed out after 30s (exit code 124)' }],
    })
    const d = g.observe({
      sessionId: 's', turnId: 't', provider: 'kscc', observedAt: 200,
      calls: [{ toolUseId: 'b', toolName: 'Bash', input: { command: cmd }, output: '', error: 'Command timed out after 30s (exit code 124)' }],
    })
    expect(d.kind).toBe('warn')
    expect(buildNoProgressEventFromDecision(d, 'shadow').shadow).toBe(true)
    expect(buildNoProgressEventFromDecision(d, 'enforce').shadow).toBe(false)
    expect(buildNoProgressEventFromDecision(d, 'enforce').phase).toBe('warning')
    expect(buildNoProgressEventFromDecision(d, 'enforce').reasonCodes).toContain('empty_timeout_repeated')
  })

  test('PostToolBatch 驱动链路：一级提醒只注入上下文，不终止（§14.2）', () => {
    // 模拟 buildNoProgressHooks 的 PostToolBatch 回调逻辑（不 spawn SDK）：
    // 翻译观察 → guard.observe → warn 时返回 additionalContext（非 pause）。
    // SDK Bash tool_response 形如 { stdout, stderr, exitCode }；空输出超时靠 exitCode 识别。
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0.js'
    const emptyTimeoutResponse = { exitCode: 124, stdout: '', stderr: '', interrupted: true }
    const drive = (hookInput: { tool_calls: any[] }, at: number) => {
      const decision = g.observe(postToolBatchToObservation(hookInput, 's', 't', at))
      if (decision.kind === 'pause') return { paused: true }
      if (decision.modelContext) return { additionalContext: decision.modelContext }
      return {}
    }
    const r1 = drive({ tool_calls: [{ tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: '1', tool_response: emptyTimeoutResponse }] }, 100)
    expect(r1).toEqual({}) // 首次 neutral，无注入
    const r2 = drive({ tool_calls: [{ tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: '2', tool_response: emptyTimeoutResponse }] }, 200)
    expect(r2).toHaveProperty('additionalContext') // warn → 注入复盘上下文
    expect((r2 as { additionalContext: string }).additionalContext).toContain('未产生新证据')
    expect(r2).not.toHaveProperty('paused') // 一级提醒不终止
  })

  test('PostToolBatch 驱动链路：暂停时产 AskUserQuestion 输入（brief 2026-08-19 §3）', () => {
    // 模拟 buildNoProgressHooks 的 PostToolBatch 回调：暂停时 buildNoProgressAskUserInput 产结构化澄清
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0, thresholds: { totalNoProgressBatchesPause: 3 } })
    g.resetForNewTurn(0)
    const cmd = 'node tools/a0.js'
    const drive = (hookInput: { tool_calls: any[] }, at: number) => {
      const decision = g.observe(postToolBatchToObservation(hookInput, 's', 't', at))
      if (decision.kind === 'pause') {
        return { paused: true, askInput: buildNoProgressAskUserInput(decision, g.getState()) }
      }
      return {}
    }
    // 3 个无进展批次 → 第 4 个触发暂停
    drive({ tool_calls: [{ tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: '1', tool_response: { exitCode: 1, stdout: 'err' } }] }, 100)
    drive({ tool_calls: [{ tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: '2', tool_response: { exitCode: 1, stdout: 'err' } }] }, 200)
    drive({ tool_calls: [{ tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: '3', tool_response: { exitCode: 1, stdout: 'err' } }] }, 300)
    const r4 = drive({ tool_calls: [{ tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: '4', tool_response: { exitCode: 1, stdout: 'err' } }] }, 400)
    expect(r4).toHaveProperty('paused')
    const askInput = (r4 as { askInput: Record<string, unknown> }).askInput
    const questions = askInput.questions as Array<{ options: Array<{ label: string }> }>
    expect(questions).toHaveLength(1)
    expect(questions[0]!.options).toHaveLength(3) // 三方向选项
  })
})

/**
 * brief 2026-08-19 §4：verify-on-stop 终态收束前判定（KSCC 适配层接线）。
 * 验证 guard.checkVerifyOnStop + normalizeResultToPausedNoProgress（带验证文案）+
 * buildVerifyOnStopAskUserInput 在终态收束前的驱动链路。
 */
describe('verify-on-stop KSCC 终态收束接线（brief 2026-08-19 §4）', () => {
  test('normalizeResultToPausedNoProgress 支持自定义 errors（verify-on-stop 文案）', () => {
    const success: SDKMessage = {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 5 },
    } as SDKResultMessage
    // 默认文案（无进展暂停）
    const out1 = normalizeResultToPausedNoProgress(success) as SDKResultMessage
    expect(out1.subtype).toBe('paused_no_progress')
    expect(out1.errors?.[0]).toContain('连续多次操作未获得新进展')
    // verify-on-stop 文案
    const out2 = normalizeResultToPausedNoProgress(success, VERIFY_ON_STOP_PAUSE_ERRORS) as SDKResultMessage
    expect(out2.subtype).toBe('paused_no_progress')
    expect(out2.errors?.[0]).toContain('验证')
    expect(out2.errors?.[0]).not.toContain('连续多次操作未获得新进展')
  })

  test('终态收束前：本轮有 edit 无 verify → 触发验证提示并归一化为 paused_no_progress', () => {
    // 模拟 query() 循环中的 verify-on-stop 检查（不 spawn SDK）：
    // guard 跑完 observe → result 到达时 checkVerifyOnStop → 命中则归一化终态 + fire AskUser。
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    // 本轮：1 次 Edit 成功，无 Bash
    const editBatch = postToolBatchToObservation(
      { tool_calls: [{ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, tool_use_id: '1', tool_response: { ok: true } }] },
      's', 't', 100,
    )
    g.observe(editBatch)
    // 终态到达：checkVerifyOnStop
    const verifyDecision = g.checkVerifyOnStop()
    expect(verifyDecision).not.toBeNull()
    expect(verifyDecision!.kind).toBe('pause')
    expect(verifyDecision!.reasonCodes).toContain('verify_needed')
    // 模拟终态归一化（pendingVerifyOnStop=true → 验证文案）
    const fakeResult: SDKMessage = {
      type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0 },
    } as SDKResultMessage
    const out = normalizeResultToPausedNoProgress(fakeResult, VERIFY_ON_STOP_PAUSE_ERRORS) as SDKResultMessage
    expect(out.subtype).toBe('paused_no_progress')
    expect(out.errors?.[0]).toContain('验证')
    // 模拟 fire verify AskUser
    const askInput = buildVerifyOnStopAskUserInput()
    const questions = askInput.questions as Array<{ header: string; options: Array<{ label: string }> }>
    expect(questions[0]!.header).toBe('验证提示')
    expect(questions[0]!.options).toHaveLength(3)
  })

  test('终态收束前：本轮有 edit + 有 verify 证据 → 放行（不触发验证提示）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    // Edit 成功 + Bash 验证
    g.observe(postToolBatchToObservation(
      { tool_calls: [{ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' }, tool_use_id: '1', tool_response: { ok: true } }] },
      's', 't', 100,
    ))
    g.observe(postToolBatchToObservation(
      { tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: '2', tool_response: { exitCode: 0, stdout: 'all passed' } }] },
      's', 't', 200,
    ))
    // 终态：checkVerifyOnStop → null（有验证证据，放行）
    expect(g.checkVerifyOnStop()).toBeNull()
  })

  test('终态收束前：已提示过 → 放行（防重复）', () => {
    const g = new NoProgressGuard({ mode: 'enforce', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(postToolBatchToObservation(
      { tool_calls: [{ tool_name: 'Write', tool_input: { file_path: 'src/new.ts', content: 'x' }, tool_use_id: '1', tool_response: { ok: true } }] },
      's', 't', 100,
    ))
    const d1 = g.checkVerifyOnStop()
    expect(d1).not.toBeNull()
    // 第二次调用 → null
    expect(g.checkVerifyOnStop()).toBeNull()
  })

  test('shadow 模式：guard 仍判定 verify-on-stop（mode 由适配层施加，§23.1 与无进展一致）', () => {
    // 守卫纯判定器不按 mode 改判定（与无进展 shadow/enforce 一致测试）；
    // 适配层 query() 仅在 mode==='enforce' 时调用 checkVerifyOnStop（见 query 实现）。
    const g = new NoProgressGuard({ mode: 'shadow', now: () => 0 })
    g.resetForNewTurn(0)
    g.observe(postToolBatchToObservation(
      { tool_calls: [{ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' }, tool_use_id: '1', tool_response: { ok: true } }] },
      's', 't', 100,
    ))
    // 守卫本身仍能判定（适配层决定是否施加）
    expect(g.checkVerifyOnStop()).not.toBeNull()
  })
})
