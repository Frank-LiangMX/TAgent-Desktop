import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PiAgentAdapterConfig } from '../adapters/pi/pi-agent-adapter'

const mocks = vi.hoisted(() => ({
  createTaskTool: vi.fn(),
  createDelegationModelsTool: vi.fn(),
  sdkTool: vi.fn(),
  createSdkMcpServer: vi.fn(),
}))

vi.mock('@tagent/pi-core', () => ({}))

vi.mock('@earendil-works/pi-agent-core', () => ({}))

vi.mock('../adapters/pi/subagent-task-tool', () => ({
  createTaskTool: mocks.createTaskTool,
  createDelegationModelsTool: mocks.createDelegationModelsTool,
}))

const configState = vi.hoisted(() => ({ path: '' }))

vi.mock('../config/config-paths', () => ({
  getConfigDir: () => configState.path,
  getChannelsPath: () => join(configState.path, 'channels.json'),
  getAgentCatalogPath: () => join(configState.path, 'agent-catalog.json'),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: mocks.sdkTool,
  createSdkMcpServer: mocks.createSdkMcpServer,
}))

import {
  buildDelegationHostTools,
  CLAUDE_DELEGATION_TASK_TOOL_NAME,
  injectDelegationMcpServer,
} from './delegation-host-tools'

const channelConfig: PiAgentAdapterConfig = {
  type: 'external',
  provider: 'openai',
  apiKey: 'test-only',
  modelId: 'model-test',
}

function makeTool(name: string, execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))) {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        mode: { type: 'string', enum: ['foreground', 'background'] },
      },
      required: name === 'task' ? ['prompt'] : [],
    },
    execute,
  }
}

function setupFactories() {
  const task = makeTool('task')
  const models = makeTool('delegation_models')
  mocks.createTaskTool.mockReturnValue(task)
  mocks.createDelegationModelsTool.mockReturnValue(models)
  return { task, models }
}

function input(overrides: Partial<Parameters<typeof buildDelegationHostTools>[0]> = {}) {
  return {
    sessionId: 'session-test',
    channelConfig,
    cwd: 'F:/workspace-test',
    channelId: 'channel-test',
    ...overrides,
  }
}

beforeEach(() => {
  configState.path = mkdtempSync(join(tmpdir(), 'tagent-delegation-host-tools-'))
  vi.stubEnv('TAGENT_CONFIG_DIR', configState.path)
  vi.clearAllMocks()
  mocks.sdkTool.mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    schema,
    handler,
  }))
  mocks.createSdkMcpServer.mockImplementation((options: unknown) => options)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(configState.path, { recursive: true, force: true })
  configState.path = ''
})

describe('delegation host tools', () => {
  it('透传权限 hook、宿主输入和生命周期 tagent_event', async () => {
    const { task } = setupFactories()
    const beforeToolCall = vi.fn(async () => undefined)
    const emitPayload = vi.fn()
    const requestApproval = vi.fn(async () => true)

    const tools = await buildDelegationHostTools(
      input({ beforeToolCall, emitPayload, requestApproval }),
    )
    const args = mocks.createTaskTool.mock.calls[0]!
    expect(args[0]).toBe('session-test')
    expect(args[1]).toBe(channelConfig)
    expect(args[2]).toBe('F:/workspace-test')
    expect(args[5]).toBe(beforeToolCall)
    expect(args[7]).toBe(emitPayload)
    expect(args[10]).toBe('channel-test')
    expect(args[11]).toBe(requestApproval)

    args[6]({ type: 'task_started', taskId: 'task-1' })
    expect(emitPayload).toHaveBeenCalledWith({
      kind: 'tagent_event',
      event: { type: 'task_started', taskId: 'task-1' },
    })
    expect(tools.map((tool) => tool.name)).toEqual(['task', 'list_delegation_models'])
  })

  it('执行时原样传递取消 signal', async () => {
    const { task } = setupFactories()
    const signal = new AbortController().signal
    const tools = await buildDelegationHostTools(input())

    await tools[0]!.execute('tool-call-1', { prompt: 'test' } as never, signal)

    expect(task.execute).toHaveBeenCalledWith('tool-call-1', { prompt: 'test' }, signal)
  })

  it('factory 失败时向上传递，不吞掉错误', async () => {
    const error = new Error('delegation factory failed')
    mocks.createTaskTool.mockImplementationOnce(() => {
      throw error
    })
    mocks.createDelegationModelsTool.mockReturnValueOnce(makeTool('delegation_models'))

    await expect(buildDelegationHostTools(input())).rejects.toBe(error)
  })

  it('注入 Claude MCP 时使用固定 namespace、名称和 background 默认值', async () => {
    const { task } = setupFactories()
    const servers: Record<string, unknown> = {}

    await injectDelegationMcpServer(servers, input())

    expect(servers['tagent-delegation']).toBeDefined()
    expect(mocks.createSdkMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'tagent-delegation', version: '1.0.0' }),
    )
    const server = mocks.createSdkMcpServer.mock.calls[0]![0]
    expect(server.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'task',
      'list_delegation_models',
    ])
    expect(server.tools[0].description).toContain(CLAUDE_DELEGATION_TASK_TOOL_NAME)

    const signal = new AbortController().signal
    await server.tools[0].handler({ prompt: 'long task' }, { signal, callId: 'real-call-id' })
    expect(task.execute).toHaveBeenCalledWith(
      'real-call-id',
      { prompt: 'long task', mode: 'background' },
      signal,
    )
  })

  it('没有 callId 时每次 MCP task 生成不同执行 id', async () => {
    const { task } = setupFactories()
    const servers: Record<string, unknown> = {}
    await injectDelegationMcpServer(servers, input())

    const server = mocks.createSdkMcpServer.mock.calls[0]![0]
    await server.tools[0].handler({ prompt: 'one' }, {})
    await server.tools[0].handler({ prompt: 'two' }, {})

    const calls = (task.execute as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls[0]![0]).not.toBe(calls[1]![0])
    expect(calls[0]![0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[1]![0]).toMatch(/^[0-9a-f-]{36}$/)
  })
})
