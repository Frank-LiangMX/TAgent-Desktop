import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  killCliProcessTree: vi.fn(),
}))

vi.mock('../../agent/cli-workers/kill-cli-process', () => ({
  killCliProcessTree: mocks.killCliProcessTree,
}))

import {
  CodexAppServerClient,
  CodexAppServerRpcError,
} from './codex-app-server-client'

class FakeCodexProcess extends EventEmitter {
  pid = 123
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn(() => true)
}

function createHarness() {
  const process = new FakeCodexProcess()
  const writes: string[] = []
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => writes.push(chunk))
  const client = new CodexAppServerClient({
    executablePath: 'C:\\codex.exe',
    requestTimeoutMs: 1000,
    clientInfo: { version: '2.0.0-dev.6' },
    spawnProcess: () => process,
  })
  return { client, process, writes }
}

function writtenMessages(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

beforeEach(() => {
  mocks.killCliProcessTree.mockReset()
})

describe('CodexAppServerClient', () => {
  it('完成 initialize 响应后发送 initialized 通知', async () => {
    const { client, process, writes } = createHarness()
    const pending = client.initialize()
    const first = writtenMessages(writes)[0]
    expect(first).toMatchObject({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'tagent-desktop',
          title: 'TAgent Desktop',
          version: '2.0.0-dev.6',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    })

    process.stdout.write(
      `${JSON.stringify({
        id: 1,
        result: {
          userAgent: 'codex-cli/0.151.0',
          codexHome: 'C:\\Users\\test\\.codex',
          platformFamily: 'windows',
          platformOs: 'windows',
        },
      })}\n`,
    )

    await expect(pending).resolves.toMatchObject({
      userAgent: 'codex-cli/0.151.0',
      platformOs: 'windows',
    })
    expect(writtenMessages(writes).at(-1)).toEqual({ method: 'initialized' })
    expect(client.isInitialized).toBe(true)
  })

  it('按 id 关联并解析 RPC 错误', async () => {
    const { client, process } = createHarness()
    const pending = client.request('thread/start', { cwd: 'C:\\repo' })
    process.stdout.write(
      `${JSON.stringify({
        id: 1,
        error: { code: -32602, message: 'invalid params', data: { field: 'cwd' } },
      })}\n`,
    )

    await expect(pending).rejects.toMatchObject({
      name: 'CodexAppServerRpcError',
      code: -32602,
      message: 'invalid params',
      data: { field: 'cwd' },
    } satisfies Partial<CodexAppServerRpcError>)
  })

  it('转发服务端通知', () => {
    const { client, process } = createHarness()
    const received: unknown[] = []
    client.onNotification((notification) => received.push(notification))
    client.start()
    process.stdout.write(
      `${JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thr_1', delta: '你好' },
        emittedAtMs: 42,
      })}\n`,
    )
    expect(received).toEqual([
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thr_1', delta: '你好' },
        emittedAtMs: 42,
      },
    ])
  })

  it('未注册审批处理器时对服务端反向请求 fail-closed', async () => {
    const { client, process, writes } = createHarness()
    client.start()
    process.stdout.write(
      `${JSON.stringify({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'npm test' },
      })}\n`,
    )
    await Promise.resolve()
    expect(writtenMessages(writes).at(-1)).toEqual({
      id: 'approval-1',
      error: {
        code: -32601,
        message:
          'TAgent 尚未处理服务端请求：item/commandExecution/requestApproval',
      },
    })
  })

  it('把 permissions/requestApproval 交给处理器并回写授权结果', async () => {
    const { client, process, writes } = createHarness()
    client.setServerRequestHandler((request) => ({
      permissions: request.params
        ? (request.params as { permissions: unknown }).permissions
        : {},
      scope: 'turn',
    }))
    client.start()
    process.stdout.write(
      `${JSON.stringify({
        id: 'permission-1',
        method: 'item/permissions/requestApproval',
        params: {
          permissions: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
      })}\n`,
    )
    await vi.waitFor(() => {
      expect(writtenMessages(writes).at(-1)).toEqual({
        id: 'permission-1',
        result: {
          permissions: {
            network: { enabled: true },
            fileSystem: null,
          },
          scope: 'turn',
        },
      })
    })
  })

  it('进程异常退出会拒绝全部在途请求', async () => {
    const { client, process } = createHarness()
    const closed = vi.fn()
    client.onConnectionClosed(closed)
    const pending = client.request('thread/start', {})
    process.emit('exit', 1, null)
    await expect(pending).rejects.toThrow(/已退出/)
    expect(closed).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/已退出/) }),
    )
    expect(client.isRunning).toBe(false)
  })

  it('close 回收进程树并拒绝在途请求', async () => {
    vi.useFakeTimers()
    const { client, process } = createHarness()
    const pending = client.request('thread/start', {})
    client.close()
    await expect(pending).rejects.toThrow(/客户端已关闭/)
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.killCliProcessTree).toHaveBeenCalledWith(
      process,
      'codex-app-server',
    )
    vi.useRealTimers()
  })
})
