import { beforeEach, describe, expect, it, vi } from 'vitest'

const { profiles, register, unregister, reserve, validateSelection, channels, enqueue, officialRun } = vi.hoisted(() => ({
  profiles: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  reserve: vi.fn<(...args: unknown[]) => (() => void) | null>(() => vi.fn()),
  validateSelection: vi.fn(),
  channels: vi.fn(),
  enqueue: vi.fn(),
  officialRun: vi.fn(),
}))

vi.mock('../../agent/agent-catalog-service', () => ({ listAgentProfiles: profiles }))
vi.mock('../../agent/delegation-capacity', () => ({ tryReserveDelegationSlot: reserve }))
vi.mock('../../agent/delegation-model-policy', () => ({
  buildDelegationModelPrompt: () => 'models',
  listDelegationModelCandidates: () => [],
  validateDelegationModelSelection: validateSelection,
}))
vi.mock('../../agent/background-delegation-service', () => ({
  registerBackgroundTask: register,
  unregisterBackgroundTask: unregister,
  enqueueParentCallback: enqueue,
  notifyParentBackgroundEvent: vi.fn(),
}))
vi.mock('../../agent/official-delegated-agent', () => ({ runOfficialDelegatedAgent: officialRun }))
vi.mock('../../channel/channel-store', () => ({ listChannels: channels, getDecryptedApiKey: () => 'test-key' }))
vi.mock('../../agent/subagent-definitions', () => ({
  buildBuiltinSubagentDefinitions: () => ({ explorer: { prompt: 'explore', tools: [] } }),
  resolveSubagentDefinition: () => undefined,
}))
vi.mock('../../agent/cli-workers/resolve-backend', () => ({
  listEnabledCliWorkerCards: () => '',
  resolveTaskSubagentBackend: () => ({ kind: 'cli', worker: { id: 'legacy' } }),
}))
vi.mock('../../agent/cli-workers/run-cli-worker', () => ({ runCliWorker: vi.fn() }))
vi.mock('../../agent/session-process-registry', () => ({ bashHooksForSession: () => ({}) }))

import { createDelegationModelsTool, createTaskTool } from './subagent-task-tool'

const parentConfig = {
  type: 'external',
  provider: 'openai',
  apiProtocol: 'openai-responses',
  apiKey: 'test',
  modelId: 'parent-model',
  contextWindow: 1000,
} as never

function fakePiCore() {
  return {
    checkToolPermission: () => ({ block: false }),
    defaultTools: [],
    defaultToolDescriptors: [],
    createBashTool: () => ({}),
    createHttpDirectStreamFn: () => vi.fn(),
    createKsccBareStreamFn: () => vi.fn(),
  } as never
}

function fakePiAgentCore(events: unknown[]) {
  return {
    Agent: class FakeAgent {
      private listeners: Array<(event: unknown) => void> = []
      private resolvePrompt?: () => void
      subscribe(listener: (event: unknown) => void): () => void {
        this.listeners.push(listener)
        return () => { this.listeners = this.listeners.filter((item) => item !== listener) }
      }
      async prompt(): Promise<void> {
        for (const event of events) {
          for (const listener of this.listeners) await listener(event)
        }
      }
      async waitForIdle(): Promise<void> {}
      abort(): void { this.resolvePrompt?.() }
    },
  } as never
}

const externalChannel = (id: string, modelId: string) => ({
  id,
  name: id,
  enabled: true,
  provider: 'openai',
  apiProtocol: 'openai-responses',
  baseUrl: 'https://example.invalid',
  models: [{ id: modelId, name: modelId, enabled: true, contextWindow: 1000 }],
})

function makeTaskTool(piAgentCore: unknown, options: { approval?: (name: string, signal?: AbortSignal) => Promise<boolean> } = {}) {
  return createTaskTool(
    'parent', parentConfig, 'F:/repo', fakePiCore(), piAgentCore as never,
    async () => undefined, undefined, undefined, undefined, () => [], 'parent-channel', options.approval,
  )
}

beforeEach(() => {
  profiles.mockReset().mockReturnValue([])
  channels.mockReset().mockReturnValue([externalChannel('parent-channel', 'parent-model')])
  register.mockReset()
  unregister.mockReset()
  enqueue.mockReset()
  reserve.mockReset().mockReturnValue(vi.fn())
  validateSelection.mockReset()
  officialRun.mockReset().mockResolvedValue({ status: 'completed', text: 'official', toolCalls: 0 })
})

describe('subagent task delegation boundaries', () => {
  it('inherited models still pass live policy and cannot bypass opt-out', async () => {
    validateSelection.mockImplementation(() => { throw new Error('model opted out') })
    const release = vi.fn()
    reserve.mockReturnValue(release)
    const tool = makeTaskTool(fakePiAgentCore([]))
    await expect(tool.execute('optout', { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground' })).rejects.toThrow('model opted out')
    expect(validateSelection).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'parent-channel', modelId: 'parent-model' }))
    expect(release).toHaveBeenCalledOnce()
    expect(officialRun).not.toHaveBeenCalled()
  })

  it('a disabled parent model never falls back to the first available model', async () => {
    const channel = externalChannel('parent-channel', 'parent-model')
    channel.models[0]!.enabled = false
    channel.models.push({ ...channel.models[0]!, id: 'another-model', enabled: true })
    channels.mockReturnValue([channel])
    const tool = makeTaskTool(fakePiAgentCore([]))
    await expect(tool.execute('disabled', { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground' })).rejects.toThrow('未启用指定模型')
    expect(validateSelection).not.toHaveBeenCalled()
  })

  it('background Stop holds its reservation until Pi settles and never wakes the parent', async () => {
    const release = vi.fn()
    reserve.mockReturnValue(release)
    let settle!: () => void
    const pending = new Promise<void>(resolve => { settle = resolve })
    const core = { Agent: class {
      subscribe() { return () => {} }
      async prompt() { await pending }
      async waitForIdle() { await pending }
      abort() {}
    } }
    const tool = makeTaskTool(core)
    await tool.execute('background-stop', { subagent_type: 'explorer', prompt: 'inspect', mode: 'background' })
    const controller = register.mock.calls[0]![0].abort as AbortController
    controller.abort()
    expect(release).not.toHaveBeenCalled()
    settle()
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(enqueue).not.toHaveBeenCalled()
    expect(unregister).toHaveBeenCalledWith('background-stop')
  })

  it('Stop during approval rejects even a late affirmative reply', async () => {
    profiles.mockReturnValue([{ id: 'approve', name: 'approve', runtime: 'pi', enabled: true, allowPiTask: true, allowBackground: true, approvalRequired: true, permissionProfile: 'read-only', workspacePolicy: 'inherit', capabilities: { tags: [] } }])
    let answer!: (allow: boolean) => void
    const tool = makeTaskTool(fakePiAgentCore([]), { approval: () => new Promise(resolve => { answer = resolve }) })
    const pending = tool.execute('approve-stop', { agent: 'approve', prompt: 'inspect', selectionReason: 'review' })
    const rejected = expect(pending).rejects.toThrow('启动前已取消')
    ;(register.mock.calls[0]![0].abort as AbortController).abort()
    answer(true)
    await rejected
    expect(reserve).not.toHaveBeenCalled()
    expect(unregister).toHaveBeenCalledWith('approve-stop')
  })
  it('publishes enabled allowPiTask profiles without credentials', () => {
    profiles.mockReturnValue([
      { id: 'codex-review', runtime: 'codex', enabled: true, allowPiTask: true, channelId: 'c1', modelId: 'm1' },
      { id: 'hidden', runtime: 'pi', enabled: true, allowPiTask: false },
    ])
    const tool = createTaskTool('parent', parentConfig, 'F:/repo', fakePiCore(), {} as never)
    expect(tool.description).toContain('codex-review')
    expect(tool.description).toContain('runtime=codex')
    expect(tool.description).not.toContain('hidden')
    expect(tool.description).not.toContain('apiKey')
  })

  it('requires model for cross-channel dispatch before any child starts', async () => {
    profiles.mockReturnValue([])
    const tool = createTaskTool('parent', parentConfig, 'F:/repo', fakePiCore(), {} as never, async () => undefined, undefined, undefined, undefined, () => [], 'parent-channel')
    await expect(tool.execute('task-1', {
      subagent_type: 'explorer',
      prompt: 'inspect',
      channel: 'other-channel',
      selectionReason: 'cross-channel review',
    } as never, undefined)).rejects.toThrow('跨渠道派发必须同时指定 model')
    expect(register).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(validateSelection).not.toHaveBeenCalled()
  })

  it('fails closed when the parent permission hook is absent', async () => {
    profiles.mockReturnValue([])
    const tool = createTaskTool('parent', parentConfig, 'F:/repo', fakePiCore(), {} as never)
    await expect(tool.execute('task-no-hook', {
      subagent_type: 'explorer',
      prompt: 'inspect',
    } as never, undefined)).rejects.toThrow('缺少父会话权限处理器')
    expect(register).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
  })

  it('exposes credential-free model candidates as a tool', async () => {
    const tool = createDelegationModelsTool()
    const result = await tool.execute('models-1', {} as never, undefined)
    expect(result.content[0]).toMatchObject({ type: 'text', text: '[]' })
  })

  it('只取最后 assistant：user/toolResult/中间 toolUse 后的 stop 算成功', async () => {
    const tool = makeTaskTool(fakePiAgentCore([
      { type: 'message_end', message: { role: 'user', content: [] } },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'Read' }] } },
      { type: 'message_end', message: { role: 'user', content: [{ type: 'toolResult', content: 'ok' }] } },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'final answer' }] } },
    ]))
    const result = await tool.execute('task-final', { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground' } as never, undefined)
    expect(result.details).toMatchObject({ resultLength: 12, toolCalls: 0 })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('final answer') })
    expect((result as never as { status: string }).status).toBe('completed')
  })

  it('中断保留已有文字和原始原因，不被终态校验覆盖', async () => {
    const tool = makeTaskTool(fakePiAgentCore([
      { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: '已确认模块入口。' }] } },
      ...Array.from({ length: 21 }, () => ({ type: 'tool_execution_start', toolName: 'Read' })),
      { type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'Request was aborted', content: [] } },
    ]))
    const result = await tool.execute('task-limit', { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground' })
    expect(result.details).toMatchObject({ toolCalls: 21, failureReason: 'Request was aborted', stopReason: 'aborted' })
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('已确认模块入口。') })
    expect((result as unknown as { summary: string }).summary).toBe('Request was aborted')
  })

  it('原始 HTTP 错误不会被通用终态校验覆盖', async () => {
    const tool = makeTaskTool(fakePiAgentCore([
      { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '429 fixture rate limit', content: [] } },
    ]))
    const result = await tool.execute('task-http-error', { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground' })
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('429 fixture rate limit') })
    expect(result.details).toMatchObject({ failureReason: '429 fixture rate limit' })
  })

  it('超时中止保留超时原因', async () => {
    vi.useFakeTimers()
    try {
      let settle!: () => void
      let listener!: (event: unknown) => void
      const core = { Agent: class {
        subscribe(callback: typeof listener) { listener = callback; return () => {} }
        prompt() { return new Promise<void>((resolve) => { settle = resolve }) }
        async waitForIdle() {}
        abort() {
          listener({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'Request was aborted', content: [] } })
          settle()
        }
      } }
      const pending = makeTaskTool(core).execute('task-timeout', { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground', complexity: 'simple' })
      await vi.advanceTimersByTimeAsync(120_000)
      const result = await pending
      expect(result.details).toMatchObject({ failureReason: '子代理超时（120000ms）', stopReason: 'aborted' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('保留中间文字不把空的最终回复误报成功', async () => {
    const tool = makeTaskTool(fakePiAgentCore([
      { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'checking' }] } },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } },
    ]))
    const result = await tool.execute('task-empty', { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground' })
    expect((result as unknown as { status: string }).status).toBe('failed')
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('最终 assistant 无文本') })
  })

  it.each([
    ['length', '子代理终态不是 stop'],
    ['', '子代理未产生最终 assistant message_end'],
  ])('最终 %s 不得伪报 completed', async (stopReason, expected) => {
    const events = stopReason
      ? [{ type: 'message_end', message: { role: 'assistant', stopReason, content: [{ type: 'text', text: 'partial' }] } }]
      : []
    const tool = makeTaskTool(fakePiAgentCore(events))
    const result = await tool.execute(`task-${stopReason || 'none'}`, { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground' } as never, undefined)
    expect((result as never as { status: string }).status).toBe('failed')
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('[子代理 status=failed]') })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(expected) })
  })

  it('capacity 满时 foreground/background 都不启动且清理登记', async () => {
    reserve.mockReturnValue(null)
    for (const mode of ['foreground', 'background'] as const) {
      const tool = makeTaskTool(fakePiAgentCore([]))
      const result = await tool.execute(`task-cap-${mode}`, { subagent_type: 'explorer', prompt: 'inspect', mode } as never, undefined)
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('并发上限') })
    }
    expect(register).toHaveBeenCalledTimes(2)
    expect(unregister).toHaveBeenCalledTimes(2)
  })

  it('审批拒绝不启动子代理', async () => {
    profiles.mockReturnValue([{ id: 'needs-approval', name: 'Needs approval', runtime: 'pi', enabled: true, allowPiTask: true, allowBackground: true, approvalRequired: true, permissionProfile: 'read-only', workspacePolicy: 'inherit', capabilities: { tags: [] } }])
    const tool = makeTaskTool(fakePiAgentCore([]), { approval: async () => false })
    await expect(tool.execute('task-approval', { agent: 'needs-approval', prompt: 'inspect', selectionReason: 'review' } as never, undefined)).rejects.toThrow('审批未通过')
    expect(reserve).not.toHaveBeenCalled()
  })

  it('rejects an obsolete native profile before reserving a slot or invoking a runtime', async () => {
    profiles.mockReturnValue([{ id: 'old', name: 'Old', runtime: 'codex', enabled: true, allowPiTask: true }])
    const tool = makeTaskTool(fakePiAgentCore([]))
    await expect(tool.execute('old', { agent: 'old', prompt: 'inspect', mode: 'foreground' })).rejects.toThrow('仅支持 Pi')
    expect(officialRun).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
  })

  it('foreground finally 释放 reservation', async () => {
    const release = vi.fn()
    reserve.mockReturnValue(release)
    const tool = makeTaskTool(fakePiAgentCore([{ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } }]))
    await tool.execute('task-release', { subagent_type: 'explorer', prompt: 'inspect', mode: 'foreground' } as never, undefined)
    expect(release).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledWith('task-release')
  })
})
