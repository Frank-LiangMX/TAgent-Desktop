/**
 * runMimoWorker 单测：mock spawn（不起真进程），覆盖投递决策 + observer 接入 + abort。
 *
 * - Windows .exe → 直 spawn，prompt 作 argv 末位（多行亦安全，不经 shell）
 * - 非 Windows → prompt 作 argv 末位
 * - 传 defaultModel → argv 含 -m <model>
 * - observer：tool_use 单条 completed → toolUse+toolResult；text → summary
 * - abort → kill 子进程 + ok:false
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

import { runMimoWorker } from './run-mimo-worker'

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
  // 默认 Windows 解析到 .exe → 直 spawn（mimo 本机为 .exe）
  mocks.resolveBinOnPath.mockReturnValue('C:\\Users\\me\\.mimocode\\bin\\mimo.exe')
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

const mimoWorker = { id: 'mimo', enabled: true, bin: 'mimo' }

describe('runMimoWorker · 投递决策', () => {
  it('Windows .exe → 直 spawn，prompt 作 argv 末位（含 --dir cwd）', async () => {
    const prompt = 'list files'
    const p = runMimoWorker({ worker: mimoWorker, prompt, cwd: 'C:\\proj' })
    const child = mocks.holder.child
    child.stdout.write(
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'DONE' } }) + '\n',
    )
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('C:\\Users\\me\\.mimocode\\bin\\mimo.exe')
    expect(args).toContain('run')
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).toContain('--format')
    expect(args[args.indexOf('--format') + 1]).toBe('json')
    expect(args).toContain('--dir')
    expect(args[args.indexOf('--dir') + 1]).toBe('C:\\proj')
    expect(args[args.length - 1]).toBe(prompt)
    expect(child.stdinText).toBe('')
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('DONE')
  })

  it('多行 prompt 仍作 argv 末位（.exe 直 spawn，不经 shell，多行单 argv 元素安全）', async () => {
    const prompt = 'line one\nline two'
    const p = runMimoWorker({ worker: mimoWorker, prompt, cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect(args[args.length - 1]).toBe(prompt)
    expect(child.stdinText).toBe('') // 不走 stdin
  })

  it('非 Windows → 直跑 mimo，prompt 作 argv 末位', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const p = runMimoWorker({ worker: mimoWorker, prompt: 'hi', cwd: '/proj' })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('mimo')
    expect(args[args.length - 1]).toBe('hi')
    expect(args[args.indexOf('--dir') + 1]).toBe('/proj')
  })

  it('传 defaultModel → argv 含 -m <model>', async () => {
    const p = runMimoWorker({
      worker: { id: 'mimo', enabled: true, bin: 'mimo', defaultModel: 'provider/model-x' },
      prompt: 'hi',
      cwd: process.cwd(),
    })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect(args).toContain('-m')
    expect(args[args.indexOf('-m') + 1]).toBe('provider/model-x')
  })
})

describe('runMimoWorker · observer 接入 + abort', () => {
  it('tool_use 单条 completed → toolUse+toolResult；text → summary', async () => {
    const progress: string[] = []
    const toolUse: string[] = []
    let toolResult: { content: string; isError?: boolean } | undefined
    const p = runMimoWorker({
      worker: mimoWorker,
      prompt: 'list',
      cwd: process.cwd(),
      onProgress: (n) => progress.push(n),
      onToolUse: (t) => toolUse.push(t.name),
      onToolResult: (t) => (toolResult = t),
    })
    const child = mocks.holder.child
    child.stdout.write(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'read',
          callID: 'call_1',
          state: { status: 'completed', input: { file_path: '/a' }, output: 'entries' },
        },
      }) + '\n',
    )
    child.stdout.write(
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'TOOL_DONE' } }) + '\n',
    )
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(progress).toEqual(['read'])
    expect(toolUse).toEqual(['read'])
    expect(toolResult).toEqual({ toolUseId: 'call_1', content: 'entries' })
    expect(r.toolCalls).toBe(1)
    expect(r.summary).toBe('TOOL_DONE')
  })

  it('abort → kill 子进程，ok:false', async () => {
    const ac = new AbortController()
    const p = runMimoWorker({ worker: mimoWorker, prompt: 'list', cwd: process.cwd(), signal: ac.signal })
    const child = mocks.holder.child
    ac.abort()
    child.stdout.end()
    child.emit('close', null)
    const r = await p
    expect(child.kill).toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })
})
