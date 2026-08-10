/**
 * runGrokWorker 单测：mock spawn（不起真进程），覆盖投递决策 + observer 接入 + abort。
 *
 * - 短 prompt + win .exe → -p <prompt> 作 argv 末段（直 spawn，不写 stdin）
 * - 多行 prompt → --prompt-file（prompt 不入 argv；临时文件结束清理）
 * - Windows .cmd 兜底 → --prompt-file（cmd / c 不碰 prompt）
 * - 非 Windows → -p <prompt> 作 argv
 * - 传 model → argv 含 --model <model>
 * - observer text → onTextChunk + summary；tool_call/tool_call_update → onToolUse/onToolResult
 * - abort → kill 子进程 + ok:false
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync } from 'node:fs'
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

import { runGrokWorker } from './run-grok-worker'

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
  // 默认 Windows 解析到 .exe → 直 spawn（argv 安全）
  mocks.resolveBinOnPath.mockReturnValue('C:\\grok\\bin\\grok.exe')
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

const grokWorker = { id: 'grok', enabled: true, bin: 'grok' }

describe('runGrokWorker · 投递决策', () => {
  it('短 prompt + win .exe → -p <prompt> 作 argv，不写 stdin', async () => {
    const p = runGrokWorker({ worker: grokWorker, prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(JSON.stringify({ type: 'text', data: 'OK' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('C:\\grok\\bin\\grok.exe')
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toBe('hi')
    expect(args).toContain('--always-approve')
    expect(args).toContain('streaming-json')
    expect(mocks.holder.child.stdinText).toBe('')
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('OK')
  })

  it('多行 prompt → --prompt-file（prompt 不入 argv；临时文件结束清理）', async () => {
    const prompt = 'line one\nline two'
    let promptFile = ''
    // 捕获 --prompt-file 路径以校验清理
    const p = runGrokWorker({ worker: grokWorker, prompt, cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(JSON.stringify({ type: 'text', data: 'DONE' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    const { args } = lastSpawnCall()
    expect(args).toContain('--prompt-file')
    const idx = args.indexOf('--prompt-file')
    promptFile = args[idx + 1] as string
    expect(promptFile).toBeTruthy()
    // prompt 文本不在 argv
    expect(args).not.toContain(prompt)
    // 进程结束后临时文件已清理
    expect(existsSync(promptFile)).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('DONE')
  })

  it('Windows .cmd 兜底 → --prompt-file（cmd / c 不碰 prompt）', async () => {
    mocks.resolveBinOnPath.mockReturnValueOnce('C:\\npm\\grok.cmd')
    const prompt = 'do something'
    const p = runGrokWorker({ worker: grokWorker, prompt, cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('cmd.exe')
    expect(args).toContain('/c')
    expect(args).toContain('C:\\npm\\grok.cmd')
    expect(args).toContain('--prompt-file')
    // prompt 不入 argv（走 --prompt-file 临时文件）
    expect(args).not.toContain(prompt)
  })

  it('非 Windows → -p <prompt> 作 argv', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const p = runGrokWorker({ worker: grokWorker, prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('grok')
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toBe('hi')
  })

  it('传 defaultModel → argv 含 --model <model>', async () => {
    const p = runGrokWorker({
      worker: { id: 'grok', enabled: true, bin: 'grok', defaultModel: 'grok-4.5' },
      prompt: 'hi',
      cwd: process.cwd(),
    })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('grok-4.5')
  })
})

describe('runGrokWorker · observer 接入 + abort', () => {
  it('tool_call + tool_call_update → onToolUse/onToolResult，toolCalls 计数', async () => {
    const progress: string[] = []
    const toolUse: string[] = []
    const toolResult: string[] = []
    const p = runGrokWorker({
      worker: grokWorker,
      prompt: 'hi',
      cwd: process.cwd(),
      onProgress: (n) => progress.push(n),
      onToolUse: (t) => toolUse.push(t.name),
      onToolResult: (t) => toolResult.push(t.content),
    })
    const child = mocks.holder.child
    child.stdout.write(
      JSON.stringify({ type: 'tool_call', toolCallId: 'c1', toolName: 'list_dir', rawInput: { target_directory: '.' } }) + '\n',
    )
    child.stdout.write(
      JSON.stringify({ type: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { type: 'ListDir' } }) + '\n',
    )
    child.stdout.write(JSON.stringify({ type: 'text', data: 'TOOL_DONE' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(progress).toEqual(['list_dir'])
    expect(toolUse).toEqual(['list_dir'])
    expect(toolResult.length).toBe(1)
    expect(toolResult[0]).toContain('ListDir')
    expect(r.toolCalls).toBe(1)
    expect(r.summary).toBe('TOOL_DONE')
  })

  it('abort → kill 子进程，ok:false', async () => {
    const ac = new AbortController()
    const p = runGrokWorker({ worker: grokWorker, prompt: 'hi', cwd: process.cwd(), signal: ac.signal })
    const child = mocks.holder.child
    ac.abort()
    child.stdout.end()
    child.emit('close', null)
    const r = await p
    expect(child.kill).toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })
})
