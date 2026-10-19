import { describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerIncomingRequest,
  CodexAppServerNotification,
} from './codex-app-server-client'
import { CodexAppServerClient } from './codex-app-server-client'
import {
  CodexAppServerAdapter,
  type CodexClientLaunch,
} from './codex-app-server-adapter'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAttachmentAbsolutePath } from '../../attachment-service'

class FakeClient {
  private notificationListener:
    | ((notification: CodexAppServerNotification) => void)
    | undefined
  serverRequestHandler:
    | ((
        request: CodexAppServerIncomingRequest,
      ) => unknown | Promise<unknown>)
    | undefined
  turn = 0

  initialize = vi.fn(async () => ({
    userAgent: 'codex-cli/0.151.0',
    codexHome: 'C:\\Users\\test\\.codex',
    platformFamily: 'windows',
    platformOs: 'windows',
  }))

  request = vi.fn(async (method: string) => {
    if (method === 'thread/start') {
      return {
        thread: {
          id: 'thr_1',
          sessionId: 'native_1',
          ephemeral: false,
          status: { type: 'idle' },
          cwd: 'F:\\repo',
        },
      }
    }
    if (method === 'thread/resume') {
      return {
        thread: {
          id: 'thr_1',
          sessionId: 'native_1',
          ephemeral: false,
          status: { type: 'idle' },
          cwd: 'F:\\repo',
        },
      }
    }
    if (method === 'turn/start') {
      this.turn += 1
      return { turn: { id: `turn_${this.turn}`, status: 'inProgress' } }
    }
    if (method === 'turn/steer') return { turnId: `turn_${this.turn}` }
    if (method === 'turn/interrupt') return {}
    throw new Error(`unexpected method: ${method}`)
  })

  onNotification(
    listener: (notification: CodexAppServerNotification) => void,
  ): () => void {
    this.notificationListener = listener
    return () => {
      if (this.notificationListener === listener) {
        this.notificationListener = undefined
      }
    }
  }

  setServerRequestHandler(
    handler:
      | ((
          request: CodexAppServerIncomingRequest,
        ) => unknown | Promise<unknown>)
      | undefined,
  ): void {
    this.serverRequestHandler = handler
  }

  onConnectionClosed(_listener: (error: Error) => void): () => void {
    return () => undefined
  }

  close = vi.fn()

  emit(notification: CodexAppServerNotification): void {
    this.notificationListener?.(notification)
  }
}

describe('CodexAppServerAdapter', () => {
  it('建立 thread，流式输出，多轮 enqueue，并原生 steer/interrupt', async () => {
    const client = new FakeClient()
    const onThreadId = vi.fn()
    const adapter = new CodexAppServerAdapter({
      resolveRuntime: () => ({
        available: true,
        source: 'system',
        executablePath: 'C:\\bin\\codex.exe',
        version: '0.151.0',
        diagnostics: [],
      }),
      createClient: () => client as unknown as CodexAppServerClient,
    })
    const iterator = adapter
      .query({
        sessionId: 'sess_1',
        prompt: '实现功能',
        attachments: [{ filename: 'spec.png', mediaType: 'image/png', localPath: 'sess_1/spec.png' }],
        cwd: 'F:\\repo',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        onThreadId,
      })
      [Symbol.asyncIterator]()

    const first = iterator.next()
    await vi.waitFor(() => {
      expect(client.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          threadId: 'thr_1',
          input: [
            { type: 'text', text: '实现功能', text_elements: [] },
            { type: 'localImage', path: getAttachmentAbsolutePath('sess_1/spec.png') },
          ],
        }),
      )
    })
    expect(onThreadId).toHaveBeenCalledWith('thr_1')
    expect(adapter.hasActiveChannel('sess_1')).toBe(true)

    client.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'msg_1',
        delta: '完成',
      },
    })
    await expect(first).resolves.toEqual({
      value: {
        kind: 'stream_text_delta',
        text: '完成',
        uuid: 'msg_1',
      },
      done: false,
    })

    await adapter.steerMessage('sess_1', {
      type: 'user',
      session_id: 'sess_1',
      parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: '先跑测试' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
      ] },
    })
    expect(client.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thr_1',
      input: [
        { type: 'text', text: '先跑测试', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,aW1hZ2U=' },
      ],
    })

    client.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thr_1',
        turn: { id: 'turn_1', status: 'completed', error: null },
      },
    })
    await expect(iterator.next()).resolves.toEqual({
      value: { kind: 'result', subtype: 'completed' },
      done: false,
    })

    await adapter.sendQueuedMessage('sess_1', {
      type: 'user',
      session_id: 'sess_1',
      parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: '继续' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'bmV4dA==' } },
      ] },
    })
    expect(client.request).toHaveBeenLastCalledWith('turn/start', {
      threadId: 'thr_1',
      input: [
        { type: 'text', text: '继续', text_elements: [] },
        { type: 'image', url: 'data:image/jpeg;base64,bmV4dA==' },
      ],
    })

    await adapter.interruptQuery('sess_1')
    expect(client.request).toHaveBeenLastCalledWith('turn/interrupt', {
      threadId: 'thr_1',
      turnId: 'turn_2',
    })

    adapter.abort('sess_1')
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    })
    adapter.dispose()
    expect(client.close).toHaveBeenCalled()
  })

  it('launches API channels with an isolated Responses provider and rebuilds when the session model changes', async () => {
    const runtimeHomeRoot = mkdtempSync(join(tmpdir(), 'tagent-codex-runtime-test-'))
    const launches: CodexClientLaunch[] = []
    const clients: FakeClient[] = []
    const createClient = vi.fn((_runtime: unknown, launch?: CodexClientLaunch) => {
      const client = new FakeClient()
      clients.push(client)
      if (launch) launches.push(launch)
      return client as unknown as CodexAppServerClient
    })
    const adapter = new CodexAppServerAdapter({
      resolveRuntime: () => ({
        available: true,
        source: 'system',
        executablePath: 'C:\\bin\\codex.exe',
        version: '0.151.0',
        diagnostics: [],
      }),
      createClient,
      officialRuntimeHomeRoot: runtimeHomeRoot,
    })
    const connection = {
      channelId: 'responses-a',
      baseUrl: 'https://responses.example.test/v1',
      apiKey: 'selected-responses-key',
      contextWindow: 128_000,
    }
    const stderr: string[] = []

    try {
      const first = adapter
        .query({
          sessionId: 'api-session',
          prompt: 'first',
          cwd: 'F:\\repo',
          model: 'gateway/model-a',
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          apiConnection: connection,
          onStderr: (text) => stderr.push(text),
        })
        [Symbol.asyncIterator]()
      const firstWait = first.next()
      await vi.waitFor(() => expect(launches).toHaveLength(1))

      const launch = launches[0]!
      expect(launch.codexHome).toContain(runtimeHomeRoot)
      expect(launch.env).toMatchObject({
        CODEX_HOME: launch.codexHome,
        CODEX_SQLITE_HOME: launch.codexHome,
        TAGENT_CODEX_API_KEY: 'selected-responses-key',
      })
      expect(launch.env?.CODEX_API_KEY).toBeUndefined()
      launch.onStderr?.('provider rejected selected-res')
      expect(stderr.join('')).not.toContain('selected-res')
      launch.onStderr?.('ponses-key')
      expect(stderr.join('')).toBe('provider rejected [REDACTED]')
      expect(stderr.join('')).not.toContain('selected-responses-key')
      const config = readFileSync(`${launch.codexHome}\\config.toml`, 'utf8')
      expect(config).toContain('wire_api = "responses"')
      expect(config).toContain('env_key = "TAGENT_CODEX_API_KEY"')
      expect(config).toContain('base_url = "https://responses.example.test/v1"')
      expect(config).toContain('model_context_window = 128000')
      expect(config).not.toContain('selected-responses-key')

      const second = adapter
        .query({
          sessionId: 'api-session',
          prompt: 'second',
          cwd: 'F:\\repo',
          model: 'gateway/model-b',
          apiConnection: connection,
        })
        [Symbol.asyncIterator]()
      const secondWait = second.next()
      await vi.waitFor(() => expect(launches).toHaveLength(2))
      expect(clients[0]!.close).toHaveBeenCalled()
      expect(launches[0]!.codexHome).not.toBe(launches[1]!.codexHome)
      expect(launches[1]!.env?.TAGENT_CODEX_API_KEY).toBe('selected-responses-key')

      adapter.abort('api-session')
      await expect(firstWait).resolves.toMatchObject({ done: true })
      await expect(secondWait).resolves.toMatchObject({ done: true })
    } finally {
      adapter.dispose()
      rmSync(runtimeHomeRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when an API channel omits the selected model', async () => {
    const adapter = new CodexAppServerAdapter()
    const iterator = adapter
      .query({
        sessionId: 'missing-model',
        prompt: 'hello',
        apiConnection: {
          channelId: 'responses-a',
          baseUrl: 'https://responses.example.test/v1',
          apiKey: 'secret',
        },
      })
      [Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow(/缺少 model/)
  })

  it('官方 interrupted 先强制关闭独占连接，再透传取消；后续显式 send 从 durable home resume', async () => {
    const runtimeHomeRoot = mkdtempSync(join(tmpdir(), 'tagent-codex-interrupted-test-'))
    const connection = {
      channelId: 'responses-a',
      baseUrl: 'https://responses.example.test/v1',
      apiKey: 'selected-responses-key',
    }
    const launches: CodexClientLaunch[] = []
    const clients: FakeClient[] = []
    const adapter = new CodexAppServerAdapter({
      resolveRuntime: () => ({
        available: true,
        source: 'system',
        executablePath: 'C:\\bin\\codex.exe',
        version: '0.151.0',
        diagnostics: [],
      }),
      officialRuntimeHomeRoot: runtimeHomeRoot,
      createClient: (_runtime, launch) => {
        const client = new FakeClient()
        clients.push(client)
        if (launch) launches.push(launch)
        return client as unknown as CodexAppServerClient
      },
    })

    try {
      const interrupted = adapter
        .query({
          sessionId: 'official-interrupted',
          prompt: 'will be cancelled',
          model: 'gateway/model-a',
          apiConnection: connection,
        })
        [Symbol.asyncIterator]()
      const cancelledResult = interrupted.next()
      await vi.waitFor(() => expect(clients).toHaveLength(1))

      clients[0]!.emit({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: { id: 'turn_1', status: 'interrupted', error: null },
        },
      })
      // The process must be gone before the cancellation result reaches the
      // caller; otherwise an explicit following send could reuse it.
      await vi.waitFor(() =>
        expect(clients[0]!.close).toHaveBeenCalledWith({ force: true }),
      )
      await expect(cancelledResult).resolves.toEqual({
        value: { kind: 'result', subtype: 'interrupted' },
        done: false,
      })
      expect(adapter.hasActiveChannel('official-interrupted')).toBe(false)

      // Notifications from the disposed client cannot leak into the next
      // query (or revive the cancelled generator).
      clients[0]!.emit({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thr_1',
          turnId: 'turn_1',
          itemId: 'late-message',
          delta: 'late',
        },
      })
      await expect(interrupted.next()).resolves.toMatchObject({ done: true })

      const resumed = adapter
        .query({
          sessionId: 'official-interrupted',
          prompt: 'new prompt only',
          model: 'gateway/model-a',
          resumeThreadId: 'thr_1',
          apiConnection: connection,
        })
        [Symbol.asyncIterator]()
      const resumedResult = resumed.next()
      await vi.waitFor(() => expect(clients).toHaveLength(2))
      expect(launches[1]!.codexHome).toBe(launches[0]!.codexHome)
      expect(clients[1]!.request).toHaveBeenCalledWith(
        'thread/resume',
        expect.objectContaining({ threadId: 'thr_1', model: 'gateway/model-a' }),
      )
      expect(clients[1]!.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          threadId: 'thr_1',
          input: [{ type: 'text', text: 'new prompt only', text_elements: [] }],
        }),
      )
      expect(clients[1]!.request).not.toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          input: [{ type: 'text', text: 'will be cancelled', text_elements: [] }],
        }),
      )
      adapter.abort('official-interrupted')
      await resumedResult
    } finally {
      adapter.dispose()
      rmSync(runtimeHomeRoot, { recursive: true, force: true })
    }
  })

  it('legacy interrupted 保留长驻进程和 enqueue 能力', async () => {
    const client = new FakeClient()
    const adapter = new CodexAppServerAdapter({
      resolveRuntime: () => ({
        available: true,
        source: 'system',
        executablePath: 'C:\\bin\\codex.exe',
        version: '0.151.0',
        diagnostics: [],
      }),
      createClient: () => client as unknown as CodexAppServerClient,
    })
    const iterator = adapter
      .query({ sessionId: 'legacy-interrupted', prompt: 'cancel me' })
      [Symbol.asyncIterator]()
    const result = iterator.next()
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith('turn/start', expect.any(Object)),
    )
    client.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thr_1',
        turn: { id: 'turn_1', status: 'interrupted', error: null },
      },
    })
    await expect(result).resolves.toEqual({
      value: { kind: 'result', subtype: 'interrupted' },
      done: false,
    })
    expect(client.close).not.toHaveBeenCalled()
    expect(adapter.hasActiveChannel('legacy-interrupted')).toBe(true)
    await adapter.sendQueuedMessage('legacy-interrupted', {
      type: 'user',
      session_id: 'legacy-interrupted',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'new prompt' },
    })
    expect(client.request).toHaveBeenLastCalledWith('turn/start', {
      threadId: 'thr_1',
      input: [{ type: 'text', text: 'new prompt', text_elements: [] }],
    })
    adapter.abort('legacy-interrupted')
    await iterator.next()
  })

  it('restarts an official API thread from its durable host home when the binding is unchanged', async () => {
    const runtimeHomeRoot = mkdtempSync(join(tmpdir(), 'tagent-codex-resume-test-'))
    const connection = {
      channelId: 'responses-a',
      baseUrl: 'https://responses.example.test/v1',
      apiKey: 'selected-responses-key',
    }
    const launches: CodexClientLaunch[] = []
    const clients: FakeClient[] = []
    const options = {
      resolveRuntime: () => ({
        available: true as const,
        source: 'system' as const,
        executablePath: 'C:\\bin\\codex.exe',
        version: '0.151.0',
        diagnostics: [],
      }),
      officialRuntimeHomeRoot: runtimeHomeRoot,
      createClient: (_runtime: unknown, launch?: CodexClientLaunch) => {
        const client = new FakeClient()
        clients.push(client)
        if (launch) launches.push(launch)
        return client as unknown as CodexAppServerClient
      },
    }

    try {
      const firstAdapter = new CodexAppServerAdapter(options)
      const first = firstAdapter
        .query({
          sessionId: 'resume-session',
          prompt: 'start',
          model: 'gateway/model-a',
          apiConnection: connection,
        })
        [Symbol.asyncIterator]()
      const firstWait = first.next()
      await vi.waitFor(() => expect(launches).toHaveLength(1))
      firstAdapter.abort('resume-session')
      await firstWait

      const resumedAdapter = new CodexAppServerAdapter(options)
      const resumed = resumedAdapter
        .query({
          sessionId: 'resume-session',
          prompt: 'continue',
          model: 'gateway/model-a',
          resumeThreadId: 'thr_1',
          apiConnection: connection,
        })
        [Symbol.asyncIterator]()
      const resumedWait = resumed.next()
      await vi.waitFor(() => expect(launches).toHaveLength(2))
      expect(launches[1]!.codexHome).toBe(launches[0]!.codexHome)
      expect(clients[1]!.request).toHaveBeenCalledWith(
        'thread/resume',
        expect.objectContaining({ threadId: 'thr_1', model: 'gateway/model-a' }),
      )
      resumedAdapter.abort('resume-session')
      await resumedWait
      resumedAdapter.dispose()
    } finally {
      rmSync(runtimeHomeRoot, { recursive: true, force: true })
    }
  })
})
