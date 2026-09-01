import { describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerIncomingRequest,
  CodexAppServerNotification,
} from './codex-app-server-client'
import { CodexAppServerClient } from './codex-app-server-client'
import { CodexAppServerAdapter } from './codex-app-server-adapter'

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
      message: { role: 'user', content: '先跑测试' },
    })
    expect(client.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thr_1',
      input: [
        { type: 'text', text: '先跑测试', text_elements: [] },
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
      message: { role: 'user', content: '继续' },
    })
    expect(client.request).toHaveBeenLastCalledWith('turn/start', {
      threadId: 'thr_1',
      input: [{ type: 'text', text: '继续', text_elements: [] }],
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
})
