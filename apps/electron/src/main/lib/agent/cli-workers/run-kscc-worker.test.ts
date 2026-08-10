/**
 * runKsccWorker 单测：mock spawn（不起真进程），覆盖
 * - exit 0 + result 行 → ok:true
 * - exit !== 0 且无 summary → ok:false 含退出码
 * - onProgress 转发 tool_use
 * - abort → kill 子进程 + ok:false
 * - 已 abort 的 signal → 不 spawn
 * - spawn 抛错 / child error → ok:false
 *
 * Windows prompt 投递（本次修复重点）：
 * - planKsccWindowsSpawn 返回 node 计划 → spawn command 是 node.exe，**非 cmd.exe**，prompt 在 argv 末位
 * - planKsccWindowsSpawn 返回 null（cmd 兜底）→ command 是 cmd.exe，prompt 走 stdin、**不**入 argv
 * - 长 prompt（>4000）/ 含换行 → 即便 node 计划也走 stdin
 * - 寒暄开场白 summary + toolCalls===0 → ok:false 并前缀
 *
 * 用 vi.mock 把 resolveBinOnPath / planKsccWindowsSpawn / spawn 替成桩；并强制 process.platform
 * 为 win32（本文件专测 Windows prompt 投递，跨平台确定性）。不真 spawn（live 测另开 RUN_KSCC_LIVE=1）。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted 保证 mock 工厂能引用到（vi.mock 会被提升到文件顶部）
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolveBinOnPath: vi.fn(),
  planKsccWindowsSpawn: vi.fn(),
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

vi.mock('../../adapters/shared/kscc-windows-spawn', async () => {
  const actual =
    await vi.importActual<typeof import('../../adapters/shared/kscc-windows-spawn')>(
      '../../adapters/shared/kscc-windows-spawn',
    )
  return { ...actual, planKsccWindowsSpawn: mocks.planKsccWindowsSpawn }
})

import { runKsccWorker } from './run-kscc-worker'

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  /** 捕获到的 stdin 投递文本（在 mock spawn 内提前挂 'data' 监听，早于 production 写入） */
  stdinText: string
  kill: ReturnType<typeof vi.fn>
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.stdinText = ''
  // 提前挂 'data'：production spawn 后会立刻 stdin.write(prompt)，须先于 write 进入 flowing
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
  mocks.planKsccWindowsSpawn.mockClear()

  mocks.spawn.mockImplementation(() => {
    const child = makeFakeChild()
    mocks.holder.child = child
    return child
  })
  // 默认：Windows 解析到 .cmd + node 直连计划 → argv 投递（prompt 末位），与既有用例一致
  mocks.resolveBinOnPath.mockReturnValue('C:\\fake\\npm\\kscc.cmd')
  mocks.planKsccWindowsSpawn.mockImplementation((_cmd: string, args: string[]) => ({
    command: 'C:\\fake\\node.exe',
    args: ['C:\\fake\\cli-wrapper.js', ...args],
  }))
  mocks.holder.child = null as unknown as FakeChild

  // 强制 Windows 平台（本文件测 Windows prompt 投递；configurable:true 可还原）
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

/** 取本次 spawn 调用参数：(command, args, opts) */
function lastSpawnCall(): { command: unknown; args: unknown[] } {
  const call = mocks.spawn.mock.calls[0]!
  return { command: call[0], args: call[1] as unknown[] }
}

describe('runKsccWorker · mock spawn（既有行为不回归）', () => {
  it('exit 0 + result 行 → ok:true，summary 取 result', async () => {
    const p = runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'X' }] } }) + '\n')
    child.stdout.write(JSON.stringify({ type: 'result', result: 'DONE' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('DONE')
    expect(r.exitCode).toBe(0)
    expect(r.toolCalls).toBe(0)
    expect(mocks.spawn).toHaveBeenCalled()
  })

  it('exit !== 0 且无 summary → ok:false，summary 含退出码与 stderr', async () => {
    const p = runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd() })
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

  it('onProgress 转发 tool_use 名，toolCalls 计数', async () => {
    const seen: string[] = []
    const p = runKsccWorker({
      bin: 'kscc',
      prompt: 'hi',
      cwd: process.cwd(),
      onProgress: (n) => seen.push(n),
    })
    const child = mocks.holder.child
    child.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] },
      }) + '\n',
    )
    child.stdout.write(JSON.stringify({ type: 'result', result: 'OK' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(seen).toEqual(['Bash'])
    expect(r.toolCalls).toBe(1)
    expect(r.ok).toBe(true)
  })

  it('abort → kill 子进程，ok:false', async () => {
    const ac = new AbortController()
    const p = runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd(), signal: ac.signal })
    const child = mocks.holder.child
    ac.abort()
    // 模拟被 kill 后进程关闭
    child.stdout.end()
    child.emit('close', null)
    const r = await p
    expect(child.kill).toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })

  it('已 abort 的 signal → 不 spawn，直接 stopped', async () => {
    const ac = new AbortController()
    ac.abort()
    mocks.spawn.mockClear()
    const r = await runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd(), signal: ac.signal })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('已停止')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('spawn 抛错 → ok:false，summary 含错误信息', async () => {
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error('ENOENT no kscc')
    })
    const r = await runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd() })
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBeNull()
    expect(r.summary).toContain('ENOENT')
  })

  it('child error 事件 → ok:false，summary 含错误', async () => {
    const p = runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.emit('error', new Error('spawned but crashed'))
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('crashed')
  })

  it('传 model → argv 含 --model <model>，prompt 末位（node 直连）', async () => {
    const p = runKsccWorker({ bin: 'kscc', model: 'glm-5.2', prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const argv = lastSpawnCall().args as string[]
    expect(argv).toContain('--model')
    expect(argv).toContain('glm-5.2')
    expect(argv).toContain('stream-json')
    expect(argv).toContain('--dangerously-skip-permissions')
    expect(argv[argv.length - 1]).toBe('hi') // prompt 末位
    // node 直连 → prompt 走 argv，不写 stdin
    expect(mocks.holder.child.stdinText).toBe('')
  })

  it('不传 model → argv 不含 --model', async () => {
    const p = runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const argv = lastSpawnCall().args as string[]
    expect(argv).not.toContain('--model')
  })
})

describe('runKsccWorker · Windows prompt 投递（禁 cmd /c 传 prompt）', () => {
  it('planKsccWindowsSpawn 返回 node 计划 → spawn command 是 node.exe，非 cmd.exe', async () => {
    const p = runKsccWorker({ bin: 'kscc', prompt: 'Reply with exactly: PING_OK', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(JSON.stringify({ type: 'result', result: 'PING_OK' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('C:\\fake\\node.exe')
    expect(command).not.toBe('cmd.exe')
    // prompt 作 argv 末位（node 直连安全，不被 cmd 重分词）
    expect((args as string[])[(args as string[]).length - 1]).toBe('Reply with exactly: PING_OK')
    expect(mocks.holder.child.stdinText).toBe('') // 未走 stdin
  })

  it('planKsccWindowsSpawn 返回 null（cmd 兜底）→ command 是 cmd.exe，prompt 走 stdin、不入 argv', async () => {
    mocks.planKsccWindowsSpawn.mockImplementationOnce(() => null)
    const prompt = 'Reply with exactly: PING_OK'
    const p = runKsccWorker({ bin: 'kscc', prompt, cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(JSON.stringify({ type: 'result', result: 'PING_OK' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { command, args } = lastSpawnCall()
    // 兜底走 cmd.exe /c <abs .cmd> <flags>，但 prompt 不在 argv（避免 cmd 重分词）
    expect(command).toBe('cmd.exe')
    expect((args as string[])).not.toContain(prompt)
    // prompt 经 stdin 投递
    expect(child.stdinText).toBe(prompt)
  })

  it('长 prompt（>4000）→ 即便 node 计划也走 stdin，prompt 不入 argv', async () => {
    const prompt = 'A'.repeat(4001)
    const p = runKsccWorker({ bin: 'kscc', prompt, cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(JSON.stringify({ type: 'result', result: 'DONE' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect((args as string[])).not.toContain(prompt)
    expect(child.stdinText).toBe(prompt)
  })

  it('含换行的 prompt → 走 stdin，prompt 不入 argv', async () => {
    const prompt = 'line one\nline two'
    const p = runKsccWorker({ bin: 'kscc', prompt, cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(JSON.stringify({ type: 'result', result: 'DONE' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { args } = lastSpawnCall()
    expect((args as string[])).not.toContain(prompt)
    expect(child.stdinText).toBe(prompt)
  })

  it('bare 名解析失败 → cmd 兜底 + stdin', async () => {
    mocks.resolveBinOnPath.mockImplementationOnce(() => null)
    const prompt = 'do something'
    const p = runKsccWorker({ bin: 'kscc', prompt, cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(JSON.stringify({ type: 'result', result: 'DONE' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('cmd.exe')
    expect((args as string[])).not.toContain(prompt)
    expect(child.stdinText).toBe(prompt)
  })

  it('解析到 .exe → 直接 spawn .exe，prompt 作 argv 末位（不经 cmd）', async () => {
    mocks.resolveBinOnPath.mockImplementationOnce(() => 'C:\\fake\\bin\\kscc.exe')
    const prompt = 'hi'
    const p = runKsccWorker({ bin: 'kscc', prompt, cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.end()
    child.emit('close', 0)
    await p
    const { command, args } = lastSpawnCall()
    expect(command).toBe('C:\\fake\\bin\\kscc.exe')
    expect(command).not.toBe('cmd.exe')
    expect((args as string[])[(args as string[]).length - 1]).toBe('hi')
    expect(child.stdinText).toBe('') // .exe 直 spawn → argv，不写 stdin
  })
})

describe('runKsccWorker · 寒暄软失败', () => {
  it('summary 命中「请告诉我你需要做什么」+ toolCalls===0 → ok:false 并前缀', async () => {
    const p = runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(JSON.stringify({ type: 'result', result: '请告诉我你需要做什么' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('[cli-worker]')
    expect(r.summary).toContain('疑似 prompt 未送达')
    expect(r.summary).toContain('请告诉我你需要做什么')
    expect(r.exitCode).toBe(0) // 进程本身正常退出，仅业务层判软失败
  })

  it('summary 命中英文 "What would you like" → ok:false', async () => {
    const p = runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'What would you like me to do?' }] } }) + '\n',
    )
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('[cli-worker]')
  })

  it('调用过工具（toolCalls>0）时即便 summary 命中开场白也不判软失败', async () => {
    const p = runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] },
      }) + '\n',
    )
    child.stdout.write(JSON.stringify({ type: 'result', result: '请告诉我你需要做什么' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    // 已实际执行工具 → 不是寒暄空转，保持成功
    expect(r.ok).toBe(true)
    expect(r.toolCalls).toBe(1)
    expect(r.summary).not.toContain('[cli-worker]')
  })

  it('正常 result（非寒暄）→ ok:true，不受寒暄检测影响', async () => {
    const p = runKsccWorker({ bin: 'kscc', prompt: 'hi', cwd: process.cwd() })
    const child = mocks.holder.child
    child.stdout.write(JSON.stringify({ type: 'result', result: 'DONE' }) + '\n')
    child.stdout.end()
    child.emit('close', 0)
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('DONE')
  })
})
