import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'

const harness = vi.hoisted(() => {
  type Step = (agent: FakeAgent) => Promise<void>
  class FakeAgent {
    static steps: Step[] = []
    static instances: FakeAgent[] = []
    state: { messages: unknown[] }
    private listener: ((event: unknown) => Promise<void> | void) | undefined
    prompts: unknown[] = []
    promptSnapshots: unknown[][] = []

    constructor(options: { initialState: { messages: unknown[] } }) {
      this.state = { messages: options.initialState.messages }
      FakeAgent.instances.push(this)
    }

    subscribe(listener: (event: unknown) => Promise<void> | void): () => void {
      this.listener = listener
      return () => { this.listener = undefined }
    }

    async emit(event: unknown): Promise<void> { await this.listener?.(event) }

    async prompt(prompt: unknown): Promise<void> {
      this.prompts.push(prompt)
      this.promptSnapshots.push([...this.state.messages])
      const step = FakeAgent.steps.shift()
      if (!step) throw new Error('missing fake prompt step')
      await step(this)
    }

    async continue(): Promise<void> { throw new Error('manual recovery must prompt the continuation text') }
    abort(): void {}
  }
  return { FakeAgent }
})

vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: harness.FakeAgent }))
vi.mock('@tagent/pi-core', () => ({
  defaultToolDescriptors: [],
  defaultTools: [],
  createHttpDirectStreamFn: () => async () => { throw new Error('unused') },
  createKsccBareStreamFn: () => async () => { throw new Error('unused') },
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
vi.mock('../../attachment-service', () => ({ readAttachmentAsBase64: () => 'aW1hZ2U=' }))

import { PiAgentAdapter, type PiQueryOptions } from './pi-agent-adapter'

const usage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function assistant(stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant', content: [], api: 'openai-completions', provider: 'openai', model: 'test',
    usage, stopReason, timestamp: 123,
  }
}

function options(prompt: string): PiQueryOptions {
  return {
    sessionId: 'manual-recovery', prompt,
    channelConfig: { type: 'external', provider: 'openai', apiKey: 'test', modelId: 'test' },
  }
}

async function collect(adapter: PiAgentAdapter, input: PiQueryOptions): Promise<Array<Record<string, unknown>>> {
  const payloads: Array<Record<string, unknown>> = []
  for await (const payload of adapter.query(input)) payloads.push(payload as unknown as Record<string, unknown>)
  return payloads
}

afterEach(() => {
  harness.FakeAgent.steps = []
  harness.FakeAgent.instances = []
})

describe('Pi explicit manual recovery', () => {
  it('sends attached image bytes to Pi and preserves multimodal queued messages', async () => {
    harness.FakeAgent.steps = [async (agent) => {
      await agent.emit({ type: 'agent_end', messages: [] })
    }]
    const adapter = new PiAgentAdapter()
    await collect(adapter, {
      ...options('看图'),
      attachments: [{ filename: 'shot.png', mediaType: 'image/png', localPath: 's/shot.png' }],
    })
    const fake = harness.FakeAgent.instances[0]!
    expect(fake.prompts[0]).toMatchObject({ role: 'user', content: [
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
      { type: 'text', text: '看图' },
    ] })
    harness.FakeAgent.steps = [async () => {}]
    await adapter.sendQueuedMessage('manual-recovery', {
      type: 'user', session_id: 'manual-recovery', parent_tool_use_id: null,
      message: { role: 'user', content: [
        { type: 'text', text: '再看这张' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'bmV4dA==' } },
      ] },
    })
    expect(fake.prompts[1]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: '再看这张' },
      { type: 'image', mimeType: 'image/jpeg', data: 'bmV4dA==' },
    ] })
  })

  it.each(['error', 'aborted'] as const)(
    'drops only a prior %s assistant before prompting the short continuation',
    async (failedStopReason) => {
      const originalTask = 'original task must not be replayed'
      const continuation = 'Please continue from completed work.'
      const failed = assistant(failedStopReason)
      const completedTool = {
        role: 'toolResult', toolCallId: 'read-1', toolName: 'Read', content: [], isError: false, timestamp: 2,
      }
      harness.FakeAgent.steps = [
        async (agent) => {
          agent.state.messages = [
            { role: 'user', content: originalTask, timestamp: 1 },
            assistant('toolUse'),
            completedTool,
            failed,
          ]
          await agent.emit({ type: 'agent_end', messages: agent.state.messages })
        },
        async (agent) => {
          const done = assistant('stop')
          agent.state.messages = [...agent.state.messages, done]
          await agent.emit({ type: 'agent_end', messages: agent.state.messages })
        },
      ]
      const adapter = new PiAgentAdapter()

      await collect(adapter, options(originalTask))
      const recovered = await collect(adapter, options(continuation))
      const fake = harness.FakeAgent.instances[0]!

      expect(fake.prompts).toEqual([originalTask, continuation])
      expect(fake.promptSnapshots[1]?.map((m) => (m as { role?: string }).role)).toEqual([
        'user', 'assistant', 'toolResult',
      ])
      expect(fake.promptSnapshots[1]).not.toContain(failed)
      expect(fake.promptSnapshots[1]).toContain(completedTool)
      expect(recovered).toContainEqual(expect.objectContaining({
        kind: 'tagent_event',
        event: expect.objectContaining({
          type: 'model_manual_recovery',
          discardedAssistantUuid: 'pi-manual-recovery-123',
        }),
      }))
      expect(recovered.filter((p) => p.kind === 'result')).toEqual([
        expect.objectContaining({ subtype: 'success' }),
      ])
    },
  )
})
