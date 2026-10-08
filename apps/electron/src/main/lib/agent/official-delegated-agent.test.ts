import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  channels: [] as Array<Record<string, unknown>>,
  keys: {} as Record<string, string>,
  codexInputs: [] as Array<Record<string, unknown>>,
  claudeInputs: [] as Array<Record<string, unknown>>,
  codexItems: [] as unknown[],
  claudeItems: [] as unknown[],
  codexInstances: [] as Array<{ abort: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; interrupt: ReturnType<typeof vi.fn> }>,
  claudeInstances: [] as Array<{ abort: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; interrupt: ReturnType<typeof vi.fn> }>,
  onCodexQuery: undefined as ((input: Record<string, unknown>) => Promise<void>) | undefined,
  onClaudeQuery: undefined as ((input: Record<string, unknown>) => Promise<void>) | undefined,
  onCodexAbort: undefined as (() => void) | undefined,
  onClaudeAbort: undefined as (() => void) | undefined,
  codexIterable: undefined as ((input: Record<string, unknown>) => AsyncIterable<unknown>) | undefined,
}))

vi.mock('../channel/channel-store', () => ({
  getChannel: (id: string) => state.channels.find((channel) => channel.id === id),
  getDecryptedApiKey: (id: string) => state.keys[id] ?? '',
}))

vi.mock('../adapters/codex/codex-app-server-adapter', () => ({
  CodexAppServerAdapter: class {
    private readonly instance = {
      abort: vi.fn(),
      dispose: vi.fn(),
      interrupt: vi.fn(async (_sessionId: string) => undefined),
    }

    constructor() {
      state.codexInstances.push(this.instance)
    }

    async *query(input: Record<string, unknown>): AsyncIterable<unknown> {
      state.codexInputs.push(input)
      await state.onCodexQuery?.(input)
      if (state.codexIterable) {
        yield* state.codexIterable(input)
        return
      }
      for (const item of state.codexItems) yield item
    }

    abort(sessionId: string): void {
      this.instance.abort(sessionId)
      state.onCodexAbort?.()
    }

    interruptQuery(sessionId: string): Promise<void> {
      return this.instance.interrupt(sessionId)
    }

    dispose(): void {
      this.instance.dispose()
    }
  },
}))

vi.mock('../adapters/claude/claude-agent-adapter', () => ({
  ClaudeAgentAdapter: class {
    private readonly instance = {
      abort: vi.fn(),
      dispose: vi.fn(),
      interrupt: vi.fn(async (_sessionId: string) => undefined),
    }

    constructor() {
      state.claudeInstances.push(this.instance)
    }

    async *query(input: Record<string, unknown>): AsyncIterable<unknown> {
      state.claudeInputs.push(input)
      await state.onClaudeQuery?.(input)
      for (const item of state.claudeItems) yield item
    }

    abort(sessionId: string): void {
      this.instance.abort(sessionId)
      state.onClaudeAbort?.()
    }

    interruptQuery(sessionId: string): Promise<void> {
      return this.instance.interrupt(sessionId)
    }

    dispose(): void {
      this.instance.dispose()
    }
  },
}))

import { runOfficialDelegatedAgent } from './official-delegated-agent'

const codexChannel = {
  id: 'codex-channel',
  enabled: true,
  baseUrl: 'https://responses.example.test/v1',
  apiProtocol: 'openai-responses',
  models: [{ id: 'gpt-delegate', enabled: true, contextWindow: 128000 }],
}

const claudeChannel = {
  id: 'claude-channel',
  enabled: true,
  baseUrl: 'https://messages.example.test',
  apiProtocol: 'anthropic-messages',
  models: [{ id: 'claude-delegate', enabled: true }],
}

function baseInput(runtime: 'codex' | 'claude-code') {
  return {
    runtime,
    parentSessionId: 'parent-1',
    taskId: 'task-1',
    channelId: runtime === 'codex' ? codexChannel.id : claudeChannel.id,
    modelId: runtime === 'codex' ? 'gpt-delegate' : 'claude-delegate',
    cwd: 'F:\\fixture',
    prompt: 'inspect fixture',
    readOnly: true,
    beforeToolCall: async () => ({ block: false }),
  } as const
}

beforeEach(() => {
  state.channels = [codexChannel, claudeChannel]
  state.keys = { [codexChannel.id]: 'codex-secret', [claudeChannel.id]: 'claude-secret' }
  state.codexInputs = []
  state.claudeInputs = []
  state.codexItems = []
  state.claudeItems = []
  state.codexInstances = []
  state.claudeInstances = []
  state.onCodexQuery = undefined
  state.onClaudeQuery = undefined
  state.onCodexAbort = undefined
  state.onClaudeAbort = undefined
  state.codexIterable = undefined
})

describe('runOfficialDelegatedAgent', () => {
  test.each([
    { kind: 'result', subtype: 'completed', errors: ['upstream failed'] },
    { kind: 'result', subtype: 'completed', is_error: true },
    { kind: 'result', subtype: 'success', error: { message: 'failed' } },
  ])('error evidence overrides native nominal success: %j', async terminal => {
    state.codexItems = [terminal]
    expect((await runOfficialDelegatedAgent(baseInput('codex'))).status).toBe('failed')
  })
  test('Claude success carrying is_error is failed', async () => {
    state.claudeItems = [{ type: 'result', subtype: 'success', is_error: true, result: 'partial' }]
    expect((await runOfficialDelegatedAgent(baseInput('claude-code'))).status).toBe('failed')
  })
  test('launches a fresh official Codex adapter, forwards only task-scoped IR, and disposes it', async () => {
    state.codexItems = [
      {
        kind: 'sdk_message',
        message: {
          type: 'assistant', uuid: 'tool-1', _partial: true,
          content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a.txt' } }],
        },
      },
      {
        kind: 'sdk_message',
        message: {
          type: 'assistant', uuid: 'reply-1', content: [{ type: 'text', text: 'done' }],
        },
      },
      { kind: 'result', subtype: 'completed' },
    ]
    const payloads: unknown[] = []

    const result = await runOfficialDelegatedAgent({
      ...baseInput('codex'),
      onPayload: (payload) => payloads.push(payload),
    })

    expect(result).toEqual({ status: 'completed', text: 'done', toolCalls: 1 })
    expect(payloads).toHaveLength(2)
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'sdk_message',
        message: expect.objectContaining({ parentToolUseId: 'task-1' }),
      }),
    ]))
    expect(state.codexInputs[0]).toMatchObject({
      sessionId: 'official-delegated:parent-1:task-1',
      model: 'gpt-delegate',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      apiConnection: {
        channelId: 'codex-channel',
        baseUrl: 'https://responses.example.test/v1',
        apiKey: 'codex-secret',
        contextWindow: 128000,
      },
    })
    expect(state.codexInputs[0]?.dynamicTools).toBeUndefined()
    expect(state.codexInputs[0]?.config).toEqual({ 'features.multi_agent': false })
    expect(state.codexInputs[0]?.baseInstructions).toContain('不得调用 Task')
    expect(state.codexInstances[0]?.dispose).toHaveBeenCalledOnce()
  })

  test('uses official Claude options and fails closed through the inherited permission hook', async () => {
    const hook = vi.fn(async () => ({ block: true, reason: 'parent denied' }))
    state.claudeItems = [
      {
        type: 'assistant', uuid: 'reply-1', parent_tool_use_id: null,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Claude done' }] },
      },
      { type: 'result', subtype: 'success', result: 'ignored terminal duplicate', usage: {} },
    ]

    const result = await runOfficialDelegatedAgent({
      ...baseInput('claude-code'),
      beforeToolCall: hook,
    })

    expect(result).toMatchObject({ status: 'completed', text: 'ignored terminal duplicate', toolCalls: 0 })
    expect(state.claudeInputs[0]).toMatchObject({
      model: 'claude-delegate',
      sdkPermissionMode: 'plan',
      allowDangerouslySkipPermissions: false,
      apiConnection: {
        channelId: 'claude-channel',
        baseUrl: 'https://messages.example.test',
        apiKey: 'claude-secret',
      },
    })
    expect(state.claudeInputs[0]?.agents).toBeUndefined()
    expect(state.claudeInputs[0]?.disallowedTools).toEqual(['Agent', 'Task'])
    const canUseTool = state.claudeInputs[0]?.canUseTool as (
      name: string, input: Record<string, unknown>, options: unknown,
    ) => Promise<unknown>
    await expect(canUseTool('Task', {}, {})).resolves.toMatchObject({ behavior: 'deny' })
    await expect(canUseTool('Read', { path: 'a.txt' }, {})).resolves.toEqual({
      behavior: 'deny', message: 'parent denied',
    })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(state.claudeInstances[0]?.dispose).toHaveBeenCalledOnce()
  })

  test('accepts an OpenAI Chat channel because the official runtime bridge adapts it', async () => {
    state.channels = [{ ...codexChannel, apiProtocol: 'openai-chat' }]

    const result = await runOfficialDelegatedAgent(baseInput('codex'))

    expect(result).toEqual({ status: 'failed', text: '官方子代理未返回完成终态', toolCalls: 0 })
    expect(state.codexInstances).toHaveLength(1)
    expect(state.claudeInstances).toHaveLength(0)
  })

  test('uses the shared protocol resolver for legacy Anthropic channel records', async () => {
    state.channels = [{ ...claudeChannel, apiProtocol: undefined, provider: 'anthropic' }]
    state.claudeItems = [{ type: 'result', subtype: 'success', result: 'terminal text', usage: {} }]

    await expect(runOfficialDelegatedAgent(baseInput('claude-code'))).resolves.toEqual({
      status: 'completed', text: 'terminal text', toolCalls: 0,
    })
    expect(state.claudeInputs).toHaveLength(1)
  })

  test('requires a parent permission hook before launching', async () => {
    const { beforeToolCall: _hook, ...withoutHook } = baseInput('codex')

    await expect(runOfficialDelegatedAgent(withoutHook)).resolves.toEqual({
      status: 'failed', text: '父权限hook缺失', toolCalls: 0,
    })
    expect(state.codexInstances).toHaveLength(0)
  })

  test('fails on an error or missing terminal rather than treating streamed text as success', async () => {
    state.codexItems = [
      {
        kind: 'sdk_message',
        message: { type: 'assistant', uuid: 'partial', content: [{ type: 'text', text: 'partial' }] },
      },
      { kind: 'result', subtype: 'error' },
    ]
    await expect(runOfficialDelegatedAgent(baseInput('codex'))).resolves.toEqual({
      status: 'failed', text: '官方子代理执行失败', toolCalls: 0,
    })

    state.codexItems = [{
      kind: 'sdk_message',
      message: { type: 'assistant', uuid: 'only-message', content: [{ type: 'text', text: 'not terminal' }] },
    }]
    await expect(runOfficialDelegatedAgent(baseInput('codex'))).resolves.toEqual({
      status: 'failed', text: '官方子代理未返回完成终态', toolCalls: 0,
    })
  })

  test('does not expose an adapter exception in the task result', async () => {
    state.onCodexQuery = async () => {
      throw new Error('upstream key codex-secret must not escape')
    }

    await expect(runOfficialDelegatedAgent(baseInput('codex'))).resolves.toEqual({
      status: 'failed', text: '官方子代理执行失败', toolCalls: 0,
    })
  })

  test('denies read-only Codex native approvals without widening permissions', async () => {
    state.onCodexQuery = async (options) => {
      const handler = options.onServerRequest as (request: unknown) => Promise<unknown>
      const result = await handler({
        id: 'approval-1', method: 'item/commandExecution/requestApproval',
        params: { command: 'echo mutation', cwd: 'F:\\fixture' },
      })
      expect(result).toEqual({ decision: 'decline' })
    }
    state.codexItems = [{ kind: 'result', subtype: 'completed' }]

    await expect(runOfficialDelegatedAgent(baseInput('codex'))).resolves.toMatchObject({
      status: 'completed',
    })
  })

  test('stops the owned adapter when the caller aborts', async () => {
    let release: (() => void) | undefined
    state.onClaudeQuery = async () => {
      await new Promise<void>((resolve) => { release = resolve })
    }
    state.onClaudeAbort = () => release?.()
    state.claudeItems = [{ type: 'result', subtype: 'interrupted', usage: {} }]
    const controller = new AbortController()
    const pending = runOfficialDelegatedAgent({
      ...baseInput('claude-code'), signal: controller.signal,
    })
    await vi.waitFor(() => expect(state.claudeInputs).toHaveLength(1))

    controller.abort()

    await expect(pending).resolves.toEqual({ status: 'stopped', text: '官方子代理已停止', toolCalls: 0 })
    expect(state.claudeInstances[0]?.interrupt).toHaveBeenCalledWith(
      'official-delegated:parent-1:task-1',
    )
    expect(state.claudeInstances[0]?.abort).toHaveBeenCalledWith(
      'official-delegated:parent-1:task-1',
    )
    expect(state.claudeInstances[0]?.dispose).toHaveBeenCalledOnce()
  })

  test('enforces the wall-clock deadline by aborting the owned adapter', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    state.onCodexQuery = async () => {
      await new Promise<void>((resolve) => { release = resolve })
    }
    state.onCodexAbort = () => release?.()
    const pending = runOfficialDelegatedAgent(baseInput('codex'))
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    await expect(pending).resolves.toEqual({ status: 'failed', text: '官方子代理运行超时，已停止', toolCalls: 0 })
    expect(state.codexInstances[0]?.abort).toHaveBeenCalledWith(
      'official-delegated:parent-1:task-1',
    )
    vi.useRealTimers()
  })

  test('awaits the iterator cleanup before disposing its owned adapter', async () => {
    const iteratorFinally = vi.fn()
    state.codexIterable = async function* () {
      try {
        yield { kind: 'result', subtype: 'completed' }
        await new Promise<void>(() => undefined)
      } finally {
        iteratorFinally()
      }
    }

    await expect(runOfficialDelegatedAgent(baseInput('codex'))).resolves.toEqual({
      status: 'completed', text: '', toolCalls: 0,
    })
    expect(iteratorFinally).toHaveBeenCalledOnce()
    expect(state.codexInstances[0]?.dispose).toHaveBeenCalledOnce()
  })

  test('fails closed after the bounded event count instead of accepting a nonterminal stream', async () => {
    state.codexItems = Array.from({ length: 2_001 }, (_, index) => ({
      kind: 'sdk_message',
      message: {
        type: 'assistant', uuid: `stream-${index}`,
        content: [{ type: 'text', text: `part-${index}` }],
      },
    }))

    await expect(runOfficialDelegatedAgent(baseInput('codex'))).resolves.toMatchObject({
      status: 'failed', text: '官方子代理执行失败', toolCalls: 0,
    })
    expect(state.codexInstances[0]?.abort).toHaveBeenCalledOnce()
  })

  test('stops Codex after the delegated tool-turn ceiling', async () => {
    state.codexItems = Array.from({ length: 21 }, (_, index) => ({
      kind: 'sdk_message',
      message: {
        type: 'assistant', uuid: `tool-${index}`,
        content: [{ type: 'tool_use', id: `call-${index}`, name: 'Read', input: {} }],
      },
    }))

    await expect(runOfficialDelegatedAgent(baseInput('codex'))).resolves.toEqual({
      status: 'failed', text: '官方子代理执行失败', toolCalls: 21,
    })
    expect(state.codexInstances[0]?.abort).toHaveBeenCalledOnce()
  })
})
