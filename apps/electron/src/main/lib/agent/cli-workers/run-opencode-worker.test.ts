/**
 * runOpencodeWorker 单测：mock spawn（不起真进程），覆盖投递决策 + observer 接入 + abort + error。
 *
 * - Windows .exe → 直 spawn，args 含 run/--format json/--auto/--dir cwd，prompt 作 argv 末位，不含 --share
 * - 传 defaultModel → argv 含 -m <model>；不传 → 无 -m
 * - 非 Windows → 直跑 bin，prompt 作 argv 末位
 * - observer：tool_use completed → toolUse+toolResult；text → summary
 * - abort → kill 子进程 + ok:false
 * - error 事件 → observer.getError() → runNdjsonCli finalize ok:false（summary 含错误信息）
 *
 * 本机 opencode 0 凭据，不起真进程；event fixture 按 untether 文档建模（见 opencode-stream-observer.test.ts）。
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

import { runOpencodeWorker } from './run-opencode-worker'

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
  // 默认 Windows 解析到 .exe → 直 spawn（opencode 本机为 .exe）
  mocks.resolveBinOnPath.mockReturnValue('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe')
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

const opencodeWorker = { id: 'opencode', enabled: true, bin: 'opencode' }

describe('runOpencodeWorker · 投递决策', () => {
  it('Windows .exe → 直 spawn，args 含 run/--format json/--auto/--dir cwd，prompt 作 argv 末位，不含 --share', async () => {
    const prompt = 'list files'
    const p = runOpencodeWorker({ worker: opencodeWorker, prompt, cwd: 'C:\\proj' })
    const child = mocks.holder.child
    child.stdout.write(ev({ type: 'text', part: 'DONE' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe')
    expect(args).toContain('run')
    expect(args).toContain('--format')
    expect(args[args.indexOf('--format') + 1]).toBe('json')
    expect(args).toContain('--auto')
    expect(args).toContain('--dir')
    expect(args[args.indexOf('--dir') + 1]).toBe('C:\\proj')
    expect(args[args.length - 1]).toBe(prompt) // prompt 作 argv 末位
    expect(args).not.toContain('--share') // 不加 --share（默认即不分享）
    expect(child.stdinText).toBe('') // .exe 直 spawn 不走 stdin
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('DONE')
  })

  it('多行 prompt 走 stdin（避开 argv 长度上限与换行问题）', async () => {
    const prompt = 'line one\nline two'
    const p = runOpencodeWorker({ worker: opencodeWorker, prompt, cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect(args[args.length - 1]).not.toBe(prompt) // 不作 argv 末位
    expect(child.stdinText).toBe(prompt) // 走 stdin
  })

  it('非 Windows → 直跑 opencode，prompt 作 argv 末位', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const p = runOpencodeWorker({ worker: opencodeWorker, prompt: 'hi', cwd: '/proj' })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('opencode')
    expect(args[args.length - 1]).toBe('hi')
    expect(args[args.indexOf('--dir') + 1]).toBe('/proj')
  })

  it('传 defaultModel → argv 含 -m <model>', async () => {
    const p = runOpencodeWorker({
      worker: { id: 'opencode', enabled: true, bin: 'opencode', defaultModel: 'anthropic/claude-sonnet-4-6' },
      prompt: 'hi',
      cwd: process.cwd(),
    })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect(args).toContain('-m')
    expect(args[args.indexOf('-m') + 1]).toBe('anthropic/claude-sonnet-4-6')
  })

  it('不传 defaultModel → 无 -m', async () => {
    const p = runOpencodeWorker({ worker: opencodeWorker, prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect(args).not.toContain('-m')
  })
})

describe('runOpencodeWorker · observer 接入 + abort + error', () => {
  it('tool_use completed（bash）→ toolUse+toolResult；text → summary', async () => {
    const progress: string[] = []
    const toolUse: string[] = []
    let toolResult: { content: string; isError?: boolean } | undefined
    const p = runOpencodeWorker({
      worker: opencodeWorker,
      prompt: 'list',
      cwd: process.cwd(),
      onProgress: (n) => progress.push(n),
      onToolUse: (t) => toolUse.push(t.name),
      onToolResult: (t) => (toolResult = t),
    })
    const child = mocks.holder.child
    child.stdout.write(
      ev({
        type: 'tool_use',
        part: { tool: 'bash', id: 'call_1', state: { status: 'completed', input: { command: 'ls' }, output: 'entries' } },
      }) + '\n',
    )
    child.stdout.write(ev({ type: 'text', part: 'TOOL_DONE' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    // bash → 映射为 command
    expect(progress).toEqual(['command'])
    expect(toolUse).toEqual(['command'])
    expect(toolResult).toEqual({ toolUseId: 'call_1', content: 'entries' })
    expect(r.toolCalls).toBe(1)
    expect(r.summary).toBe('TOOL_DONE')
  })

  it('abort → kill 子进程，ok:false', async () => {
    const ac = new AbortController()
    const p = runOpencodeWorker({ worker: opencodeWorker, prompt: 'list', cwd: process.cwd(), signal: ac.signal })
    const child = mocks.holder.child
    ac.abort()
    child.stdout.end()
    child.emit('close', null)
    const r = await p
    expect(child.kill).toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })

  it('error 事件 → ok:false，summary 含 label 前缀 + 错误信息（0 凭据 / 限流路径）', async () => {
    const p = runOpencodeWorker({ worker: opencodeWorker, prompt: 'ping', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(ev({ type: 'text', part: 'partial' }) + '\n')
    child.stdout.write(
      ev({ type: 'error', error: { name: 'APIError', data: { message: 'rate limit exceeded' } } }) + '\n',
    )
    child.stdout.end()
    child.emit('close', 0) // 即便 exit 0，observer 报 error → ok:false
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('opencode')
    expect(r.summary).toContain('APIError')
    expect(r.summary).toContain('rate limit exceeded')
    // observer summary（partial text）不应压过错误信息
    expect(r.summary).not.toBe('partial')
  })
})
