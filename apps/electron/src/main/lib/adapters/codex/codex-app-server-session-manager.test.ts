import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerIncomingRequest,
  CodexAppServerNotification,
} from './codex-app-server-client'
import {
  CodexAppServerSessionManager,
  type CodexAppServerClientLike,
} from './codex-app-server-session-manager'

class FakeClient implements CodexAppServerClientLike {
  initialize = vi.fn(async () => ({
    userAgent: 'codex-cli/0.151.0',
    codexHome: 'C:\\Users\\test\\.codex',
    platformFamily: 'windows',
    platformOs: 'windows',
  }))
  request = vi.fn()
  private notificationListener:
    | ((notification: CodexAppServerNotification) => void)
    | undefined
  serverRequestHandler:
    | ((
        request: CodexAppServerIncomingRequest,
      ) => unknown | Promise<unknown>)
    | undefined

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

  emit(notification: CodexAppServerNotification): void {
    this.notificationListener?.(notification)
  }
}

let client: FakeClient
let bindings: Array<{ sessionId: string; threadId: string }>
let manager: CodexAppServerSessionManager

beforeEach(() => {
  client = new FakeClient()
  bindings = []
  manager = new CodexAppServerSessionManager({
    client,
    onThreadBindingChanged: (sessionId, threadId) =>
      bindings.push({ sessionId, threadId }),
  })
})

describe('CodexAppServerSessionManager', () => {
  it('account/read 只读取账号状态，不接触 token', async () => {
    client.request.mockResolvedValueOnce({
      account: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'pro',
      },
      requiresOpenaiAuth: true,
    })
    const status = await manager.readAccount()
    expect(client.initialize).toHaveBeenCalledTimes(1)
    expect(client.request).toHaveBeenCalledWith('account/read', {
      refreshToken: false,
    })
    expect(status.account?.type).toBe('chatgpt')
  })

  it('thread/start 建立并持久化 TAgent session 绑定', async () => {
    client.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_1',
        sessionId: 'native-session-1',
        ephemeral: false,
        status: { type: 'idle' },
        cwd: 'C:\\repo',
      },
    })
    const thread = await manager.startThread('sess_1', {
      cwd: 'C:\\repo',
      model: 'gpt-5.6-codex',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        mcp_servers: {
          demo: { command: 'npx', args: ['-y', 'demo-mcp'] },
        },
      },
      developerInstructions: 'Follow repository conventions.',
      dynamicTools: [
        {
          type: 'function',
          name: 'tagent_echo',
          description: 'Echo a value.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
    })
    expect(thread.id).toBe('thr_1')
    expect(client.request).toHaveBeenCalledWith('thread/start', {
      cwd: 'C:\\repo',
      model: 'gpt-5.6-codex',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        mcp_servers: {
          demo: { command: 'npx', args: ['-y', 'demo-mcp'] },
        },
      },
      developerInstructions: 'Follow repository conventions.',
      dynamicTools: [
        {
          type: 'function',
          name: 'tagent_echo',
          description: 'Echo a value.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
      ephemeral: false,
    })
    expect(manager.getBinding('sess_1')).toEqual({
      tagentSessionId: 'sess_1',
      threadId: 'thr_1',
    })
    expect(bindings).toEqual([{ sessionId: 'sess_1', threadId: 'thr_1' }])
  })

  it('thread/resume 使用已持久化 threadId 并要求轻量返回', async () => {
    client.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_resume',
        sessionId: 'native-session-2',
        ephemeral: false,
        status: { type: 'idle' },
        cwd: 'C:\\repo',
      },
    })
    await manager.resumeThread('sess_2', {
      threadId: 'thr_resume',
      cwd: 'C:\\repo',
    })
    expect(client.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thr_resume',
      cwd: 'C:\\repo',
      excludeTurns: true,
    })
    expect(manager.getBinding('sess_2')?.threadId).toBe('thr_resume')
  })

  it('turn/start 生成文本和本地图片输入并记录 active turn', async () => {
    manager.restoreBinding('sess_1', 'thr_1')
    client.request.mockResolvedValueOnce({
      turn: { id: 'turn_1', status: 'inProgress' },
    })
    await manager.startTurn('sess_1', {
      prompt: '实现登录接口',
      localImagePaths: ['C:\\shots\\spec.png'],
      effort: 'high',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['C:\\repo'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    })
    expect(client.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thr_1',
      input: [
        { type: 'text', text: '实现登录接口', text_elements: [] },
        { type: 'localImage', path: 'C:\\shots\\spec.png' },
      ],
      effort: 'high',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['C:\\repo'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    })
    expect(manager.getBinding('sess_1')?.activeTurnId).toBe('turn_1')
  })

  it('按 threadId 路由通知，并在 turn/completed 清 active turn', () => {
    manager.restoreBinding('sess_1', 'thr_1')
    const received: unknown[] = []
    manager.onNotification((notification) => received.push(notification))
    client.emit({
      method: 'turn/started',
      params: {
        threadId: 'thr_1',
        turn: { id: 'turn_1', status: 'inProgress' },
      },
    })
    expect(manager.getBinding('sess_1')?.activeTurnId).toBe('turn_1')
    client.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        delta: '完成',
      },
    })
    client.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thr_1',
        turn: { id: 'turn_1', status: 'completed' },
      },
    })
    expect(manager.getBinding('sess_1')?.activeTurnId).toBeUndefined()
    expect(received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tagentSessionId: 'sess_1',
          threadId: 'thr_1',
          method: 'item/agentMessage/delta',
        }),
      ]),
    )
  })

  it('turn/interrupt 使用当前 active turn；空闲时不发请求', async () => {
    manager.restoreBinding('sess_1', 'thr_1')
    expect(await manager.interruptTurn('sess_1')).toBe(false)
    client.emit({
      method: 'turn/started',
      params: {
        threadId: 'thr_1',
        turn: { id: 'turn_1', status: 'inProgress' },
      },
    })
    client.request.mockResolvedValueOnce({})
    expect(await manager.interruptTurn('sess_1')).toBe(true)
    expect(client.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thr_1',
      turnId: 'turn_1',
    })
    expect(manager.getBinding('sess_1')?.activeTurnId).toBeUndefined()
  })

  it('turn/steer 只引导当前 active turn，且 removeSession 清理绑定', async () => {
    manager.restoreBinding('sess_1', 'thr_1')
    client.emit({
      method: 'turn/started',
      params: {
        threadId: 'thr_1',
        turn: { id: 'turn_1', status: 'inProgress' },
      },
    })
    client.request.mockResolvedValueOnce({ turnId: 'turn_1' })
    await expect(
      manager.steerTurn('sess_1', {
        prompt: '优先修复测试',
        clientUserMessageId: 'msg_1',
      }),
    ).resolves.toBe('turn_1')
    expect(client.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thr_1',
      input: [
        { type: 'text', text: '优先修复测试', text_elements: [] },
      ],
      clientUserMessageId: 'msg_1',
    })
    manager.removeSession('sess_1')
    expect(manager.getBinding('sess_1')).toBeUndefined()
  })

  it('未知 thread 的通知不会串到其它 TAgent 会话', () => {
    manager.restoreBinding('sess_1', 'thr_1')
    const listener = vi.fn()
    manager.onNotification(listener)
    client.emit({
      method: 'turn/started',
      params: {
        threadId: 'thr_other',
        turn: { id: 'turn_other', status: 'inProgress' },
      },
    })
    expect(listener).not.toHaveBeenCalled()
    expect(manager.getBinding('sess_1')?.activeTurnId).toBeUndefined()
  })
})
