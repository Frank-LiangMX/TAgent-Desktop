import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'

const harness = vi.hoisted(() => {
  type Step = (agent: FakeAgent) => Promise<void>
  class FakeAgent {
    static steps: Step[] = []
    static instances: FakeAgent[] = []
    static onAbort: ((agent: FakeAgent) => void) | undefined
    state: { messages: unknown[] }
    private listener: ((event: unknown) => Promise<void> | void) | undefined
    promptCalls = 0
    continueCalls = 0
    abortCalls = 0
    continueSnapshots: unknown[][] = []

    constructor(options: { initialState: { messages: unknown[] } }) {
      this.state = { messages: options.initialState.messages }
      FakeAgent.instances.push(this)
    }

    subscribe(listener: (event: unknown) => Promise<void> | void): () => void {
      this.listener = listener
      return () => {
        this.listener = undefined
      }
    }

    async emit(event: unknown): Promise<void> {
      await this.listener?.(event)
    }

    async prompt(): Promise<void> {
      this.promptCalls += 1
      const step = FakeAgent.steps.shift()
      if (!step) throw new Error('missing fake prompt step')
      await step(this)
    }

    async continue(): Promise<void> {
      this.continueCalls += 1
      this.continueSnapshots.push([...this.state.messages])
      const step = FakeAgent.steps.shift()
      if (!step) throw new Error('missing fake continue step')
      await step(this)
    }

    abort(): void {
      this.abortCalls += 1
      FakeAgent.onAbort?.(this)
    }
  }

  return { FakeAgent }
})

vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: harness.FakeAgent }))
vi.mock('@tagent/pi-core', () => ({
  defaultToolDescriptors: [],
  defaultTools: [],
  createHttpDirectStreamFn: () => async () => {
    throw new Error('streamFn should not be called by fake Agent')
  },
  createKsccBareStreamFn: () => async () => {
    throw new Error('streamFn should not be called by fake Agent')
  },
  buildTagentCompactionSettings: () => ({ contextWindow: 200_000 }),
  toPiCompactionSettings: () => ({}),
  createCompactionModelsShim: () => ({}),
  getSessionMemoryCoordinator: () => ({ reconcile: async ({ messages }: { messages: unknown[] }) => ({ compacted: false, messages }) }),
  disposeSessionMemoryCoordinator: () => {},
}))
vi.mock('./subagent-task-tool', () => ({ createTaskTool: () => ({ name: 'Task', description: '', parameters: {}, execute: async () => ({}) }), createDelegationModelsTool: () => ({ name: 'list_delegation_models', description: '', parameters: {}, execute: async () => ({}) }) }))
vi.mock('../../memory', () => ({
  memoryLayerService: { readMemorySnapshot: () => ({ l0User: '', l1Project: '', l2Facts: '' }), searchSessions: () => [] },
  buildMemoryPromptSections: () => ({ managementRules: '', memorySnapshotSection: '' }),
  searchLongTermMemory: () => [],
}))
vi.mock('../../agent/session-store', () => ({ getSessionMeta: () => undefined }))
vi.mock('../../agent/session-process-registry', () => ({ bashHooksForSession: () => undefined }))

import { PiAgentAdapter, PI_TURN_MAX_RETRIES, type PiQueryOptions } from './pi-agent-adapter'

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function assistant(stopReason: AssistantMessage['stopReason'], errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant', content: [], api: 'openai-completions', provider: 'openai', model: 'test',
    usage, stopReason, errorMessage, timestamp: Date.now(),
  }
}

function input(sessionId = 'pi-retry'): PiQueryOptions {
  return {
    sessionId,
    prompt: 'do the task once',
    channelConfig: { type: 'external', provider: 'openai', apiKey: 'test-key', modelId: 'test' },
  }
}

async function collect(adapter: PiAgentAdapter, options: PiQueryOptions): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const payload of adapter.query(options)) out.push(payload)
  return out
}

function transientFailure(agent: InstanceType<typeof harness.FakeAgent>): Promise<void> {
  const failed = assistant('error', 'Upstream response stream was interrupted')
  agent.state.messages = [
    { role: 'user', content: 'do the task once', timestamp: 1 },
    assistant('toolUse'),
    { role: 'toolResult', toolCallId: 'read-1', toolName: 'Read', content: [], isError: false, timestamp: 2 },
    failed,
  ]
  return (async () => {
    await agent.emit({ type: 'turn_end', message: assistant('toolUse'), toolResults: [{ role: 'toolResult', toolCallId: 'read-1', toolName: 'Read', content: [], isError: false, timestamp: 2 }] })
    await agent.emit({ type: 'turn_end', message: failed, toolResults: [] })
    await agent.emit({ type: 'message_end', message: failed })
    await agent.emit({ type: 'agent_end', messages: agent.state.messages })
  })()
}

function success(agent: InstanceType<typeof harness.FakeAgent>): Promise<void> {
  const done = assistant('stop')
  return (async () => {
    agent.state.messages = [...agent.state.messages, done]
    await agent.emit({ type: 'turn_end', message: done, toolResults: [] })
    await agent.emit({ type: 'agent_end', messages: agent.state.messages })
  })()
}

afterEach(() => {
  vi.useRealTimers()
  harness.FakeAgent.steps = []
  harness.FakeAgent.instances = []
  harness.FakeAgent.onAbort = undefined
})

describe('Pi transient stream reconnect', () => {
  it('continues one user turn after a transient stream error, retains completed tools, and suppresses retry error IR', async () => {
    vi.useFakeTimers()
    harness.FakeAgent.steps = [transientFailure, success]
    const adapter = new PiAgentAdapter()
    const consuming = collect(adapter, input())

    await vi.waitFor(() => expect(harness.FakeAgent.instances[0]?.promptCalls).toBe(1))
    await vi.advanceTimersByTimeAsync(1_000)
    const out = await consuming
    const fake = harness.FakeAgent.instances[0]!

    expect(fake.promptCalls).toBe(1)
    expect(fake.continueCalls).toBe(1)
    expect(fake.continueSnapshots[0]?.map((m) => (m as { role?: string }).role)).toEqual(['user', 'assistant', 'toolResult'])
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'tagent_event',
      event: expect.objectContaining({ type: 'model_reconnecting', attempt: 1, maxAttempts: 5, delayMs: 1000 }),
    }))
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'tagent_event',
      event: expect.objectContaining({ type: 'model_reconnect_cleared' }),
    }))
    expect(out.filter((p) => (p as { kind?: string }).kind === 'result')).toEqual([
      expect.objectContaining({ subtype: 'success' }),
    ])
    expect(out.some((p) => (p as { kind?: string; message?: { error?: unknown } }).message?.error)).toBe(false)
  })

  it('exhausts the per-turn budget with one final terminal and no prompt replay', async () => {
    vi.useFakeTimers()
    harness.FakeAgent.steps = Array.from({ length: PI_TURN_MAX_RETRIES + 1 }, () => transientFailure)
    const adapter = new PiAgentAdapter()
    const consuming = collect(adapter, input('pi-exhaust'))

    await vi.waitFor(() => expect(harness.FakeAgent.instances[0]?.promptCalls).toBe(1))
    await vi.runAllTimersAsync()
    const out = await consuming
    const fake = harness.FakeAgent.instances[0]!

    expect(fake.promptCalls).toBe(1)
    expect(fake.continueCalls).toBe(PI_TURN_MAX_RETRIES)
    expect(out.filter((p) => (p as { kind?: string }).kind === 'result')).toHaveLength(1)
    expect(out.find((p) => (p as { kind?: string }).kind === 'result')).toMatchObject({
      subtype: 'error_during_execution',
      errors: [expect.stringContaining('自动重连 5 次仍未恢复')],
    })
    expect(out.some((p) => (p as { message?: { error?: unknown } }).message?.error)).toBe(false)
    expect(out.filter((p) => (p as { kind?: string; event?: { type?: string } }).event?.type === 'model_reconnecting')).toHaveLength(PI_TURN_MAX_RETRIES)
  })

  it('does not retry auth failures', async () => {
    harness.FakeAgent.steps = [async () => { throw new Error('401 Unauthorized') }]
    const adapter = new PiAgentAdapter()
    const out = await collect(adapter, input('pi-auth'))
    const fake = harness.FakeAgent.instances[0]!

    expect(fake.promptCalls).toBe(1)
    expect(fake.continueCalls).toBe(0)
    expect(out.some((p) => (p as { kind?: string; event?: { type?: string } }).event?.type === 'model_reconnecting')).toBe(false)
    expect(out.filter((p) => (p as { kind?: string }).kind === 'result')).toHaveLength(1)
  })

  it('pre-aborted external signal starts no prompt and emits one interrupted terminal', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapter = new PiAgentAdapter()
    const out = await collect(adapter, { ...input('pi-external-preaborted'), abortSignal: controller.signal })

    expect(harness.FakeAgent.instances[0]?.promptCalls).toBe(0)
    expect(out.filter((p) => (p as { kind?: string }).kind === 'result')).toEqual([
      expect.objectContaining({ subtype: 'interrupted' }),
    ])
  })

  it('STOP cancels a reconnect backoff through interruptQuery and emits one interrupted terminal', async () => {
    vi.useFakeTimers()
    harness.FakeAgent.steps = [transientFailure]
    const adapter = new PiAgentAdapter()
    const consuming = collect(adapter, input('pi-stop'))

    await vi.waitFor(() => expect(harness.FakeAgent.instances[0]?.promptCalls).toBe(1))
    await adapter.interruptQuery('pi-stop')
    const out = await consuming
    const fake = harness.FakeAgent.instances[0]!

    expect(fake.abortCalls).toBe(1)
    expect(fake.continueCalls).toBe(0)
    expect(out.filter((p) => (p as { kind?: string }).kind === 'result')).toEqual([
      expect.objectContaining({ subtype: 'interrupted' }),
    ])
    expect(out.some((p) => (p as { kind?: string; message?: { error?: unknown } }).message?.error)).toBe(false)
  })

  it('STOP during an in-flight stream suppresses late turn_end error and emits interrupted once', async () => {
    let releasePrompt!: () => void
    harness.FakeAgent.steps = [async () => new Promise<void>((resolve) => { releasePrompt = resolve })]
    const adapter = new PiAgentAdapter()
    const consuming = collect(adapter, input('pi-stop-inflight'))

    await vi.waitFor(() => expect(harness.FakeAgent.instances[0]?.promptCalls).toBe(1))
    harness.FakeAgent.onAbort = (agent) => {
      void (async () => {
        const failed = assistant('error', 'Upstream response stream was interrupted')
        await agent.emit({ type: 'turn_end', message: failed, toolResults: [] })
        await agent.emit({ type: 'message_end', message: failed })
        await agent.emit({ type: 'agent_end', messages: [failed] })
        releasePrompt()
      })()
    }
    await adapter.interruptQuery('pi-stop-inflight')
    const out = await consuming

    expect(out.filter((p) => (p as { kind?: string }).kind === 'result')).toEqual([
      expect.objectContaining({ subtype: 'interrupted' }),
    ])
    expect(out.some((p) => (p as { kind?: string; message?: { error?: unknown } }).message?.error)).toBe(false)
  })
})
