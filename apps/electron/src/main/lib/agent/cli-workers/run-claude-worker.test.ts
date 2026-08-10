/**
 * runClaudeWorker 单测：mock spawn（不起真进程），覆盖投递决策 + observer 接入 + abort + error。
 *
 * - Windows .exe → 直 spawn，args 含 -p/--bare/--dangerously-skip-permissions/
 *   --output-format stream-json/--verbose，prompt 作 argv 末位
 * - 传 defaultModel → argv 含 --model <model>；不传 → 无 --model
 * - 多行 prompt → stdin（claude -p 支持从 stdin 读 prompt）
 * - 非 Windows → 直跑 bin，prompt 作 argv 末位
 * - observer：assistant text + tool_use → textChunk/toolUse/toolResult，result → summary
 * - abort → kill 子进程 + ok:false
 * - result is_error:true → getError() → runNdjsonCli finalize ok:false（summary 含错误信息）
 *
 * 本机未装 claude，不起真进程；event fixture 按 Claude Code stream-json 文档建模
 * （见 claude-stream-observer.test.ts）。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
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

import { runClaudeWorker } from './run-claude-worker'

/** 单行 JSON 事件 → 字符串 */
function ev(obj: unknown): string {
  return JSON.stringify(obj)
}

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

let originalPlatform: string

beforeEach(() => {
  mocks.spawn.mockClear()
  mocks.resolveBinOnPath.mockClear()
  mocks.spawn.mockImplementation(() => {
    const child = makeFakeChild()
    mocks.holder.child = child
    return child
  })
  // 默认 Windows 解析到 .exe → 直 spawn（claude 本机若装，npm shim 落地多为 .exe）
  mocks.resolveBinOnPath.mockReturnValue('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
  mocks.holder.child = null as unknown as FakeChild
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

function lastSpawnCall(): { command: unknown; args: unknown[] } {
  const call = mocks.spawn.mock.calls[0]!
  return { command: call[0], args: call[1] as unknown[] }
}

const claudeWorker = { id: 'claude', enabled: true, bin: 'claude' }

describe('runClaudeWorker 路 投递决策', () => {
  it('Windows .exe → 直 spawn，flags 齐全，prompt 作 argv 末位', async () => {
    mocks.resolveBinOnPath.mockReturnValue('C:\\claude\\claude.exe')
    const prompt = 'list files'
    const p = runClaudeWorker({ worker: claudeWorker, prompt, cwd: 'C:\\proj' })
    const child = mocks.holder.child
    child.stdout.write(ev({ type: 'result', subtype: 'success', is_error: false, result: 'DONE' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('C:\\claude\\claude.exe')
    expect(args).toContain('-p')
    expect(args).toContain('--bare')
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toContain('--output-format')
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(args).toContain('--verbose')
    expect(args[args.length - 1]).toBe(prompt) // prompt 作 argv 末位
    expect(child.stdinText).toBe('') // 直 spawn 不走 stdin
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('DONE')
  })

  it('多行 prompt 走 stdin（避免 argv 长度上限与换行问题）', async () => {
    const prompt = 'line one\nline two'
    const p = runClaudeWorker({ worker: claudeWorker, prompt, cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect(args[args.length - 1]).not.toBe(prompt) // 不作 argv 末位
    expect(child.stdinText).toBe(prompt) // 走 stdin
  })

  it('非 Windows → 直跑 claude，prompt 作 argv 末位', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const p = runClaudeWorker({ worker: claudeWorker, prompt: 'hi', cwd: '/proj' })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('claude')
    expect(args[args.length - 1]).toBe('hi')
  })

  it('传 defaultModel → argv 含 --model <model>', async () => {
    mocks.resolveBinOnPath.mockReturnValue('C:\\claude\\claude.exe')
    const p = runClaudeWorker({
      worker: { id: 'claude', enabled: true, bin: 'claude', defaultModel: 'sonnet-4-6' },
      prompt: 'hi',
      cwd: process.cwd(),
    })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet-4-6')
  })

  it('不传 defaultModel → 无 --model', async () => {
    mocks.resolveBinOnPath.mockReturnValue('C:\\claude\\claude.exe')
    const p = runClaudeWorker({ worker: claudeWorker, prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect(args).not.toContain('--model')
  })
})

describe('runClaudeWorker 路 observer 接入 + abort + error', () => {
  it('assistant tool_use（Bash）+ text + result → toolUse/toolResult/textChunk/summary', async () => {
    mocks.resolveBinOnPath.mockReturnValue('C:\\claude\\claude.exe')
    const progress: string[] = []
    const toolUse: string[] = []
    let toolResult: { content: string; isError?: boolean } | undefined
    const p = runClaudeWorker({
      worker: claudeWorker,
      prompt: 'list',
      cwd: process.cwd(),
      onProgress: (n) => progress.push(n),
      onToolUse: (t) => toolUse.push(t.name),
      onToolResult: (t) => (toolResult = t),
    })
    const child = mocks.holder.child
    child.stdout.write(
      ev({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }) + '\n',
    )
    child.stdout.write(
      ev({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'entries' }] },
      }) + '\n',
    )
    child.stdout.write(
      ev({ type: 'result', subtype: 'success', is_error: false, result: 'TOOL_DONE' }) + '\n',
    )
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(progress).toEqual(['command'])
    expect(toolUse).toEqual(['command'])
    expect(toolResult).toEqual({ toolUseId: 'toolu_1', content: 'entries' })
    expect(r.toolCalls).toBe(1)
    expect(r.summary).toBe('TOOL_DONE')
  })

  it('abort → kill 子进程，ok:false', async () => {
    mocks.resolveBinOnPath.mockReturnValue('C:\\claude\\claude.exe')
    const ac = new AbortController()
    const p = runClaudeWorker({ worker: claudeWorker, prompt: 'list', cwd: process.cwd(), signal: ac.signal })
    const child = mocks.holder.child
    ac.abort()
    child.stdout.end()
    child.emit('close', null)
    const r = await p
    expect(child.kill).toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })

  it('result is_error:true → ok:false，summary 含 label 前缀 + 错误信息（0 凭据 / 限流路径）', async () => {
    mocks.resolveBinOnPath.mockReturnValue('C:\\claude\\claude.exe')
    const p = runClaudeWorker({ worker: claudeWorker, prompt: 'ping', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(
      ev({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: rate limited', errors: [{ message: 'API Error: rate limited' }] }) + '\n',
    )
    child.stdout.end()
    child.emit('close', 0) // 即便 exit 0，observer 报 is_error → ok:false
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('claude')
    expect(r.summary).toContain('rate limited')
  })
})
