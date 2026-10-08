import { describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  messages: [] as unknown[],
  queries: [] as unknown[],
}))

vi.mock('../adapters', () => ({
  getAdapter: () => ({
    abort: vi.fn(),
    async *query(input: unknown) {
      state.queries.push(input)
      for (const message of state.messages) yield message
    },
  }),
}))
vi.mock('../agent/session-store', () => ({
  getSessionMeta: () => undefined,
  createSession: vi.fn(),
  updateSessionMeta: vi.fn(),
}))
vi.mock('../channel/channel-store', () => ({
  getChannel: () => ({
    id: 'api-channel', name: 'API', provider: 'custom', baseUrl: 'https://api.example',
    apiKey: 'key', enabled: true, apiProtocol: 'openai-responses',
    models: [{ id: 'model-a', name: 'Model A', enabled: true }], createdAt: 0, updatedAt: 0,
  }),
  getDecryptedApiKey: () => 'key',
}))
vi.mock('../channel/model-window', () => ({ resolveModelContextWindow: () => 64_000 }))
vi.mock('../mcp/mcp-store', () => ({ getEnabledMcpServers: () => ({}) }))
vi.mock('../workspace/workspace-manager', () => ({ listWorkspaces: () => [] }))
vi.mock('../agent/delegation-model-policy', () => ({
  validateDelegationModelSelection: () => ({ modelId: 'model-a' }),
}))
vi.mock('./kanban-store', () => ({
  getBoard: () => ({ id: 'board-a', status: 'active', paused: false }),
  getTask: () => ({ id: 'task-a', boardId: 'board-a', metadata: {} }),
  previewWorkerResolution: () => ({ modelId: undefined, permissionMode: 'bypassPermissions', systemPrompt: '' }),
  updateTask: vi.fn(),
}))
vi.mock('./kanban-agent-tools', () => ({
  buildPiKanbanTools: () => [],
}))

const { runKanbanWorkerHeadless } = await import('./kanban-worker-runner')

function task() {
  return {
    id: 'task-a', boardId: 'board-a', title: 'Run task', body: 'Do it',
    status: 'running', roleId: 'generalist', channelId: 'api-channel', modelId: 'model-a',
    priority: 0, createdAt: 0, updatedAt: 0,
  } as never
}

describe('runKanbanWorkerHeadless terminal contract', () => {
  test('passes explicit API protocol and maxTurns, and only success completes', async () => {
    state.queries.length = 0
    state.messages = [
      { kind: 'sdk_message', message: { type: 'assistant', content: [{ type: 'text', text: 'fresh summary' }] } },
      { kind: 'result', subtype: 'success' },
    ]
    const result = await runKanbanWorkerHeadless(task())
    expect(result).toMatchObject({ finalStatus: 'done', summary: 'fresh summary' })
    expect(state.queries[0]).toMatchObject({
      maxTurns: 40,
      channelConfig: { apiProtocol: 'openai-responses' },
    })
  })

  test('EOF and error terminals fail without synthetic or stale summaries', async () => {
    state.messages = []
    await expect(runKanbanWorkerHeadless(task())).resolves.toMatchObject({
      finalStatus: 'failed',
    })
    state.messages = [{ kind: 'result', subtype: 'error_max_turns', errors: ['limit'] }]
    await expect(runKanbanWorkerHeadless(task())).resolves.toMatchObject({
      finalStatus: 'failed', error: 'limit',
    })
  })
})
