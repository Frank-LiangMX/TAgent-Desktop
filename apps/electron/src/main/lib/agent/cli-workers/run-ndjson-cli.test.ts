/**
 * runNdjsonCli 单测：mock spawn（不起真进程），覆盖 finalize 各分支 + helper 纯逻辑。
 *
 * - exit 0 + observer summary → ok:true
 * - exit ≠ 0 且 observer 有 summary → ok:true（容忍尾部告警）
 * - exit ≠ 0 且无 summary → ok:false 含退出码
 * - abort → kill 子进程 + ok:false；已 abort 的 signal → 不 spawn
 * - spawn 抛错 / child error → ok:false
 * - delivery='stdin' → prompt 写进 stdin
 * - delivery='file' → 结束时清理临时文件
 * - resolveCliBin / isLongOrMultiline / writePromptTempFile 纯逻辑
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolveBinOnPath: vi.fn(),
  holder: { child: null as unknown as FakeChild },
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: mocks.spawn }
})

vi.mock('./resolve-bin-on-path', async () => {
  const actual = await vi.importActual<typeof import('./resolve-bin-on-path')>('./resolve-bin-on-path')
  return { ...actual, resolveBinOnPath: mocks.resolveBinOnPath }
})

import {
  isBareName,
  isLongOrMultiline,
  removePromptTempFile,
  resolveCliBin,
  runNdjsonCli,
  writePromptTempFile,
  type CliStreamObserver,
  type NdjsonSpawnPlan,
} from './run-ndjson-cli'

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  stdinText: string
  kill: ReturnType<typeof vi.fn>
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.stdinText = ''
  child.stdin.on('data', (c: Buffer) => {
    child.stdinText += c.toString('utf8')
  })
  child.kill = vi.fn(() => true)
  return child
}

/** 极简 observer：把每行当 text 累积，summary = 全部 text 拼接，工具计数按 type。 */
function fakeObserver(summary: string, toolCalls = 0): CliStreamObserver {
  return {
    onLine: () => ({}),
    getSummary: () => summary,
    getToolCallCount: () => toolCalls,
  }
}

let originalPlatform: string

beforeEach(() => {
  mocks.spawn.mockClear()
  mocks.resolveBinOnPath.mockClear()
  mocks.spawn.mockImplementation(() => {
    const child = makeFakeChild()
    mocks.holder.child = child
    return child
  })
  mocks.resolveBinOnPath.mockReturnValue(null)
  mocks.holder.child = null as unknown as FakeChild
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

function argvPlan(args: string[]): NdjsonSpawnPlan {
  return { command: 'fake.exe', args, delivery: 'argv' }
}

describe('runNdjsonCli · finalize 分支', () => {
  it('exit 0 + observer summary → ok:true，summary 取 observer', async () => {
    const p = runNdjsonCli({
      label: 'grok',
      plan: argvPlan(['--x']),
      prompt: 'hi',
      cwd: process.cwd(),
      observer: fakeObserver('DONE'),
    })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('DONE')
    expect(r.exitCode).toBe(0)
  })

  it('exit 0 且 observer 无 summary 无 stderr → ok:true，兜底文案', async () => {
    const p = runNdjsonCli({
      label: 'codex',
      plan: argvPlan(['--x']),
      prompt: 'hi',
      cwd: process.cwd(),
      observer: fakeObserver(''),
    })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('(codex 无输出)')
  })

  it('exit ≠ 0 但 observer 有 summary → ok:true（容忍尾部告警）', async () => {
    const p = runNdjsonCli({
      label: 'mimo',
      plan: argvPlan(['--x']),
      prompt: 'hi',
      cwd: process.cwd(),
      observer: fakeObserver('TOOL_DONE'),
    })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 1)
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('TOOL_DONE')
    expect(r.exitCode).toBe(1)
  })

  it('exit ≠ 0 且无 summary → ok:false，summary 含退出码与 stderr', async () => {
    const p = runNdjsonCli({
      label: 'grok',
      plan: argvPlan(['--x']),
      prompt: 'hi',
      cwd: process.cwd(),
      observer: fakeObserver(''),
    })
    const child = mocks.holder.child
    child.stderr.write('boom\n')
    child.stderr.end()
    child.stdout.end()
    child.emit('close', 7)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(7)
    expect(r.summary).toContain('7')
    expect(r.summary).toContain('boom')
  })

  it('abort → kill 子进程，ok:false', async () => {
    const ac = new AbortController()
    const p = runNdjsonCli({
      label: 'grok',
      plan: argvPlan(['--x']),
      prompt: 'hi',
      cwd: process.cwd(),
      signal: ac.signal,
      observer: fakeObserver(''),
    })
    const child = mocks.holder.child
    ac.abort()
    child.stdout.end()
    child.emit('close', null)
    const r = await p
    expect(child.kill).toHaveBeenCalled()
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('已停止')
  })

  it('已 abort 的 signal → 不 spawn，直接 stopped', async () => {
    const ac = new AbortController()
    ac.abort()
    mocks.spawn.mockClear()
    const r = await runNdjsonCli({
      label: 'grok',
      plan: argvPlan(['--x']),
      prompt: 'hi',
      cwd: process.cwd(),
      signal: ac.signal,
      observer: fakeObserver(''),
    })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('已停止')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('spawn 抛错 → ok:false，summary 含错误信息', async () => {
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error('ENOENT no grok')
    })
    const r = await runNdjsonCli({
      label: 'grok',
      plan: argvPlan(['--x']),
      prompt: 'hi',
      cwd: process.cwd(),
      observer: fakeObserver(''),
    })
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBeNull()
    expect(r.summary).toContain('ENOENT')
  })

  it('child error 事件 → ok:false，summary 含错误', async () => {
    const p = runNdjsonCli({
      label: 'grok',
      plan: argvPlan(['--x']),
      prompt: 'hi',
      cwd: process.cwd(),
      observer: fakeObserver(''),
    })
    const child = mocks.holder.child
    child.emit('error', new Error('spawned but crashed'))
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('crashed')
  })

  it('delivery=stdin → prompt 写进子进程 stdin', async () => {
    const prompt = 'do something'
    const p = runNdjsonCli({
      label: 'codex',
      plan: { command: 'cmd.exe', args: ['/c', 'codex.cmd', 'exec', '--json'], delivery: 'stdin' },
      prompt,
      cwd: process.cwd(),
      observer: fakeObserver('DONE'),
    })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    expect(child.stdinText).toBe(prompt)
  })

  it('delivery=file → 结束时清理临时 prompt 文件', async () => {
    const file = writePromptTempFile('grok', 'long prompt body')
    expect(existsSync(file)).toBe(true)
    const p = runNdjsonCli({
      label: 'grok',
      plan: { command: 'grok.exe', args: ['--prompt-file', file, '--always-approve'], delivery: 'file', promptFile: file },
      prompt: 'long prompt body',
      cwd: process.cwd(),
      observer: fakeObserver('DONE'),
    })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    expect(existsSync(file)).toBe(false)
  })

  it('行增量分发：observer.onLine 返回的 4 类增量分别回调', async () => {
    const obs: CliStreamObserver = {
      onLine: () => ({
        lastToolName: 'Bash',
        toolUse: { id: 't1', name: 'Bash', input: { cmd: 'ls' } },
        toolResult: { toolUseId: 't1', content: 'out' },
        textChunk: 'hi',
      }),
      getSummary: () => 'S',
      getToolCallCount: () => 1,
    }
    const progress: string[] = []
    const toolUse: string[] = []
    const toolResult: string[] = []
    const text: string[] = []
    const p = runNdjsonCli({
      label: 'grok',
      plan: argvPlan(['--x']),
      prompt: 'hi',
      cwd: process.cwd(),
      observer: obs,
      onProgress: (n) => progress.push(n),
      onToolUse: (t) => toolUse.push(t.name),
      onToolResult: (t) => toolResult.push(t.content),
      onTextChunk: (c) => text.push(c),
    })
    const child = mocks.holder.child
    child.stdout.write('one-line\n')
    child.stdout.end()
    child.emit('close', 0)
    await p
    expect(progress).toEqual(['Bash'])
    expect(toolUse).toEqual(['Bash'])
    expect(toolResult).toEqual(['out'])
    expect(text).toEqual(['hi'])
  })
})

describe('runNdjsonCli · helper 纯逻辑', () => {
  it('isLongOrMultiline：超长或含换行 → true', () => {
    expect(isLongOrMultiline('short')).toBe(false)
    expect(isLongOrMultiline('A'.repeat(4001))).toBe(true)
    expect(isLongOrMultiline('line1\nline2')).toBe(true)
  })

  it('isBareName：含分隔符/盘符 → false', () => {
    expect(isBareName('grok')).toBe(true)
    expect(isBareName('/usr/bin/grok')).toBe(false)
    expect(isBareName('C:\\bin\\grok.exe')).toBe(false)
  })

  it('resolveCliBin：非 Windows → 直跑 bin（argv 安全）', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const r = resolveCliBin('grok')
    expect(r.command).toBe('grok')
    expect(r.cmdPrefix).toEqual([])
    expect(r.directSpawn).toBe(true)
    expect(r.via).toBe('unix')
  })

  it('resolveCliBin：Windows .exe → 直 spawn（argv 安全）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mocks.resolveBinOnPath.mockReturnValueOnce('C:\\grok\\bin\\grok.exe')
    const r = resolveCliBin('grok')
    expect(r.command).toBe('C:\\grok\\bin\\grok.exe')
    expect(r.cmdPrefix).toEqual([])
    expect(r.directSpawn).toBe(true)
    expect(r.via).toBe('win-exe')
  })

  it('resolveCliBin：Windows .cmd → cmd /c，argv 不安全', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mocks.resolveBinOnPath.mockReturnValueOnce('C:\\npm\\codex.cmd')
    const r = resolveCliBin('codex')
    expect(r.command).toBe('cmd.exe')
    expect(r.cmdPrefix).toEqual(['/c', 'C:\\npm\\codex.cmd'])
    expect(r.directSpawn).toBe(false)
    expect(r.via).toBe('win-cmd')
  })

  it('resolveCliBin：Windows bare 解析失败 → cmd /c <bare>，argv 不安全', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mocks.resolveBinOnPath.mockReturnValueOnce(null)
    const r = resolveCliBin('mimo')
    expect(r.command).toBe('cmd.exe')
    expect(r.cmdPrefix).toEqual(['/c', 'mimo'])
    expect(r.directSpawn).toBe(false)
    expect(r.via).toBe('win-cmd-bare')
  })

  it('writePromptTempFile / removePromptTempFile：创建后可删', () => {
    let dir = ''
    try {
      const file = writePromptTempFile('unit', 'hello')
      dir = dirname(file)
      expect(existsSync(file)).toBe(true)
      removePromptTempFile(file)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(dir)).toBe(false)
    } finally {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
  })
})
