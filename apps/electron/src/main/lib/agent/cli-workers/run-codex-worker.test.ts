/**
 * runCodexWorker 单测：mock spawn（不起真进程），覆盖投递决策 + observer 接入 + abort。
 *
 * - Windows .cmd → cmd /c + stdin（prompt 写进 stdin，不入 argv，避免 cmd 重分词）
 * - 非 Windows → prompt 作 argv 末位
 * - 多行 / 长 prompt → stdin
 * - observer：item.completed agent_message → summary；command_execution → toolUse/toolResult
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

import { runCodexWorker } from './run-codex-worker'

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
  // 默认 Windows 解析到 .cmd → cmd /c + stdin（codex 本机为 npm .cmd）
  mocks.resolveBinOnPath.mockReturnValue('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd')
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

const codexWorker = { id: 'codex', enabled: true, bin: 'codex' }

describe('runCodexWorker · 投递决策', () => {
  it('Windows .cmd → cmd /c + stdin（prompt 写进 stdin，不入 argv）', async () => {
    const prompt = 'list files'
    const p = runCodexWorker({ worker: codexWorker, prompt, cwd: 'C:\\proj' })
    const child = mocks.holder.child
    child.stdout.write(
      JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'DONE' } }) + '\n',
    )
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('cmd.exe')
    expect(args).toContain('/c')
    expect(args).toContain('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd')
    expect(args).toContain('exec')
    expect(args).toContain('--json')
    expect(args).toContain('-C')
    expect(args[args.indexOf('-C') + 1]).toBe('C:\\proj')
    // prompt 不入 argv，走 stdin
    expect(args).not.toContain(prompt)
    expect(child.stdinText).toBe(prompt)
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('DONE')
  })

  it('非 Windows → prompt 作 argv 末位', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const prompt = 'list files'
    const p = runCodexWorker({ worker: codexWorker, prompt, cwd: '/proj' })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('codex')
    expect(args[args.length - 1]).toBe(prompt)
    expect(child.stdinText).toBe('')
  })

  it('多行 prompt → 即便直 spawn 也走 stdin', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const prompt = 'line one\nline two'
    const p = runCodexWorker({ worker: codexWorker, prompt, cwd: '/proj' })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect(args).not.toContain(prompt)
    expect(child.stdinText).toBe(prompt)
  })
})

describe('runCodexWorker · observer 接入 + abort', () => {
  it('item.started/completed command_execution + agent_message → toolUse/toolResult + summary', async () => {
    const progress: string[] = []
    const toolUse: string[] = []
    let toolResult: { content: string; isError?: boolean } | undefined
    const p = runCodexWorker({
      worker: codexWorker,
      prompt: 'list',
      cwd: process.cwd(),
      onProgress: (n) => progress.push(n),
      onToolUse: (t) => toolUse.push(t.name),
      onToolResult: (t) => (toolResult = t),
    })
    const child = mocks.holder.child
    child.stdout.write(
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command: 'ls', status: 'in_progress' },
      }) + '\n',
    )
    child.stdout.write(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'command_execution', aggregated_output: 'a\nb', status: 'completed' },
      }) + '\n',
    )
    child.stdout.write(
      JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'TOOL_DONE' } }) + '\n',
    )
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(progress).toEqual(['command_execution'])
    expect(toolUse).toEqual(['command_execution'])
    expect(toolResult).toEqual({ toolUseId: 'item_1', content: 'a\nb' })
    expect(r.toolCalls).toBe(1)
    expect(r.summary).toBe('TOOL_DONE')
  })

  it('abort → kill 子进程，ok:false', async () => {
    const ac = new AbortController()
    const p = runCodexWorker({ worker: codexWorker, prompt: 'list', cwd: process.cwd(), signal: ac.signal })
    const child = mocks.holder.child
    ac.abort()
    child.stdout.end()
    child.emit('close', null)
    const r = await p
    expect(child.kill).toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })
})
