/**
 * Pi 外部 HTTP 重连的端到端接线回归。
 *
 * 不 mock Pi Agent 或 createHttpDirectStreamFn：真实 Agent 走本地 Node SSE
 * 服务器。仅隔离记忆、子代理和会话配置这些与重连无关的宿主依赖。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../memory', () => ({
  buildMemoryPromptSections: () => ({ managementRules: '', memorySnapshotSection: '' }),
  memoryLayerService: {
    readMemorySnapshot: () => ({ l0User: '', l1Project: '', l2Facts: '' }),
    searchSessions: () => [],
  },
  searchLongTermMemory: () => [],
}))

vi.mock('../../agent/session-store', () => ({ getSessionMeta: () => undefined }))
vi.mock('../../agent/session-process-registry', () => ({ bashHooksForSession: () => undefined }))
vi.mock('./subagent-task-tool', () => ({
  createDelegationModelsTool: () => ({ name: 'list_delegation_models', description: '', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) }),
  createTaskTool: () => ({
    name: 'Task',
    label: 'Task',
    description: 'isolated test task tool',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'unused' }] }),
  }),
}))

import { PiAgentAdapter } from './pi-agent-adapter'

type Protocol = 'openai-chat' | 'openai-responses'
type RequestRecord = { url: string; body: Record<string, unknown> }

function writeSse(res: import('node:http').ServerResponse, event: Record<string, unknown>): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function writeChatSse(res: import('node:http').ServerResponse, chunk: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`)
}

function completedTextResponse(
  protocol: Protocol,
  res: import('node:http').ServerResponse,
  text: string,
): void {
  if (protocol === 'openai-chat') {
    writeChatSse(res, {
      id: 'chat-final',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    })
    writeChatSse(res, {
      id: 'chat-final',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    })
    res.end('data: [DONE]\n\n')
    return
  }
  const item = {
    id: 'msg-final',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  writeSse(res, { type: 'response.created', response: { id: 'resp-final', status: 'in_progress' } })
  writeSse(res, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } })
  writeSse(res, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text })
  writeSse(res, { type: 'response.output_item.done', output_index: 0, item })
  writeSse(res, {
    type: 'response.completed',
    response: {
      id: 'resp-final',
      status: 'completed',
      output: [item],
      usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
    },
  })
  res.end()
}

function completedToolCall(protocol: Protocol, res: import('node:http').ServerResponse): void {
  if (protocol === 'openai-chat') {
    writeChatSse(res, {
      id: 'chat-tool',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: 'fixture_tool', arguments: JSON.stringify({ value: 'once' }) },
          }],
        },
        finish_reason: null,
      }],
    })
    writeChatSse(res, {
      id: 'chat-tool',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    })
    res.end('data: [DONE]\n\n')
    return
  }
  const toolCall = {
    id: 'fc-1',
    type: 'function_call',
    call_id: 'call-1',
    name: 'fixture_tool',
    arguments: JSON.stringify({ value: 'once' }),
    status: 'completed',
  }
  writeSse(res, { type: 'response.created', response: { id: 'resp-tool', status: 'in_progress' } })
  writeSse(res, { type: 'response.output_item.added', output_index: 0, item: toolCall })
  writeSse(res, { type: 'response.output_item.done', output_index: 0, item: toolCall })
  writeSse(res, {
    type: 'response.completed',
    response: { id: 'resp-tool', status: 'completed', output: [toolCall] },
  })
  res.end()
}

function partialToolThenEarlyEof(protocol: Protocol, res: import('node:http').ServerResponse): void {
  if (protocol === 'openai-chat') {
    writeChatSse(res, {
      id: 'chat-partial-tool',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call-partial',
            type: 'function',
            function: { name: 'fixture_tool', arguments: '{"value":' },
          }],
        },
        finish_reason: null,
      }],
    })
  } else {
    const item = {
      id: 'fc-partial',
      type: 'function_call',
      call_id: 'call-partial',
      name: 'fixture_tool',
      arguments: '',
      status: 'in_progress',
    }
    writeSse(res, { type: 'response.created', response: { id: 'resp-partial', status: 'in_progress' } })
    writeSse(res, { type: 'response.output_item.added', output_index: 0, item })
    writeSse(res, {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"value":',
    })
  }
  // Deliberately no finish reason or terminal response: this is the transport
  // EOF that must retry without executing the incomplete tool call.
  res.end()
}

function interruptedStream(protocol: Protocol, res: import('node:http').ServerResponse): void {
  if (protocol === 'openai-chat') {
    // The OpenAI-compatible SSE parser turns this provider error envelope into
    // the same retryable message as Responses does.
    res.end(`data: ${JSON.stringify({ error: { message: 'Upstream response stream was interrupted' } })}\n\n`)
    return
  }
  writeSse(res, {
    type: 'response.failed',
    response: {
      id: 'resp-interrupted',
      status: 'failed',
      error: { message: 'Upstream response stream was interrupted' },
    },
  })
  res.end()
}

function authFailureStream(res: import('node:http').ServerResponse): void {
  // Deliberately non-retryable. Pi records a failed assistant for this request;
  // the next explicit short continuation must strip that tail, not replay the task.
  res.end(`data: ${JSON.stringify({ error: { message: '401 Unauthorized' } })}\n\n`)
}

describe('PiAgentAdapter external HTTP retry wire', () => {
  it.each(['backoff', 'in-flight'] as const)('STOP during %s cancels real Pi HTTP recovery without another request', async (phase) => {
    const tempCwd = mkdtempSync(join(tmpdir(), 'tagent-pi-retry-stop-'))
    const adapter = new PiAgentAdapter()
    let count = 0
    let notifyRetryRequest!: () => void
    const retryRequest = new Promise<void>((resolve) => { notifyRetryRequest = resolve })
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain fixture request */ }
      count++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (count === 1) { interruptedStream('openai-chat', res); return }
      // Keep a real second HTTP stream open until the user's STOP cancels it.
      res.write('data: {"id":"pending","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
      notifyRetryRequest()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const sessionId = `stop-${phase}`
      const { port } = server.address() as { port: number }
      const out: Array<Record<string, unknown>> = []
      const consuming = (async () => {
        for await (const raw of adapter.query({
          sessionId, prompt: 'local cancellation fixture', cwd: tempCwd,
          channelConfig: {
            type: 'external', provider: 'custom', apiProtocol: 'openai-chat',
            apiKey: 'fake-fixture-key', baseUrl: `http://127.0.0.1:${port}/v1`, modelId: 'fixture-model',
          }, tools: [],
        })) {
          const payload = raw as unknown as Record<string, unknown>
          out.push(payload)
          if (phase === 'backoff' && (payload.event as { type?: string })?.type === 'model_reconnecting') {
            await adapter.interruptQuery(sessionId)
          }
        }
      })()
      if (phase === 'in-flight') {
        await retryRequest
        await adapter.interruptQuery(sessionId)
      }
      await consuming
      expect(count).toBe(phase === 'backoff' ? 1 : 2)
      expect(out.filter((p) => p.kind === 'result')).toEqual([
        expect.objectContaining({ subtype: 'interrupted' }),
      ])
      expect(out.some((p) => (p.message as { error?: unknown })?.error)).toBe(false)
      expect(out.some((p) => (p.event as { type?: string })?.type === 'model_reconnect_cleared')).toBe(true)
    } finally {
      adapter.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(tempCwd, { recursive: true, force: true })
    }
  }, 15_000)

  it.each(['openai-chat', 'openai-responses'] as const)(
    '%s：工具轮后 EOF/上游中断会 continue，既不重放用户/工具也不透传临时错误终态',
    async (apiProtocol) => {
    const requests: RequestRecord[] = []
    const tempCwd = mkdtempSync(join(tmpdir(), 'tagent-pi-retry-wire-'))
    let toolExecutions = 0
    let adapter: PiAgentAdapter | undefined
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk.toString()
      requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })

      if (requests.length === 1) {
        completedToolCall(apiProtocol, res)
        return
      }

      if (requests.length === 2) {
        partialToolThenEarlyEof(apiProtocol, res)
        return
      }

      if (requests.length === 3) {
        interruptedStream(apiProtocol, res)
        return
      }

      completedTextResponse(apiProtocol, res, 'reconnected-ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      const address = server.address() as { port: number }
      adapter = new PiAgentAdapter()
      const stream = adapter.query({
        sessionId: 'pi-retry-wire',
        prompt: 'original user prompt',
        cwd: tempCwd,
        channelConfig: {
          type: 'external',
          provider: 'custom',
          apiProtocol,
          apiKey: 'local-fixture-key',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelId: 'fixture-model',
          contextWindow: 128_000,
        },
        tools: [
          {
            name: 'fixture_tool',
            label: 'fixture_tool',
            description: 'returns one durable observation',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
            execute: async () => {
              toolExecutions += 1
              return {
                content: [{ type: 'text', text: 'fixture tool result' }],
                details: {},
              }
            },
          },
        ],
      })

      const payloads: Array<Record<string, unknown>> = []
      for await (const payload of stream) payloads.push(payload as unknown as Record<string, unknown>)

      expect(requests).toHaveLength(4)
      expect(toolExecutions).toBe(1)
      expect(requests.every((request) => request.url === (apiProtocol === 'openai-chat' ? '/v1/chat/completions' : '/v1/responses'))).toBe(true)
      const retryBody = JSON.stringify(requests[3]!.body)
      expect(retryBody.match(/original user prompt/g)).toHaveLength(1)
      expect(retryBody).toContain('fixture tool result')
      const reconnects = payloads.filter(
        (p) => p.kind === 'tagent_event' && (p.event as { type?: string }).type === 'model_reconnecting',
      )
      expect(reconnects.length).toBeGreaterThanOrEqual(2)
      expect(reconnects.some((p) => typeof (p.event as { discardedAssistantUuid?: unknown }).discardedAssistantUuid === 'string')).toBe(true)
      expect(payloads.some((p) => p.kind === 'sdk_message' && (p.message as { type?: string; error?: unknown }).type === 'assistant' && (p.message as { error?: unknown }).error)).toBe(false)
      expect(payloads.filter((p) => p.kind === 'result' && p.subtype === 'success')).toHaveLength(1)
      expect(payloads.some((p) => p.kind === 'result' && p.subtype === 'error_during_execution')).toBe(false)
    } finally {
      adapter?.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      rmSync(tempCwd, { recursive: true, force: true })
    }
    },
    25_000,
  )

  it('explicit short continuation after a non-retryable error preserves completed tool work without replaying the original task', async () => {
    const requests: RequestRecord[] = []
    const tempCwd = mkdtempSync(join(tmpdir(), 'tagent-pi-manual-recovery-wire-'))
    let toolExecutions = 0
    const adapter = new PiAgentAdapter()
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk.toString()
      requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
      if (requests.length === 1) {
        completedToolCall('openai-chat', res)
        return
      }
      if (requests.length === 2) {
        authFailureStream(res)
        return
      }
      completedTextResponse('openai-chat', res, 'manual-continued-ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      const { port } = server.address() as { port: number }
      const sessionId = 'pi-manual-recovery-wire'
      const channelConfig = {
        type: 'external' as const,
        provider: 'custom',
        apiProtocol: 'openai-chat' as const,
        apiKey: 'local-fixture-key',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: 'fixture-model',
      }
      const tools = [{
        name: 'fixture_tool', label: 'fixture_tool', description: 'durable local fixture',
        parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        execute: async () => {
          toolExecutions += 1
          return { content: [{ type: 'text' as const, text: 'fixture tool result' }], details: {} }
        },
      }]
      const first: Array<Record<string, unknown>> = []
      for await (const raw of adapter.query({
        sessionId, prompt: 'original user task', cwd: tempCwd, channelConfig, tools,
      })) first.push(raw as unknown as Record<string, unknown>)
      expect(first.filter((p) => p.kind === 'result')).toEqual([
        expect.objectContaining({ subtype: 'error_during_execution' }),
      ])

      const second: Array<Record<string, unknown>> = []
      for await (const raw of adapter.query({
        sessionId, prompt: 'Please continue from completed work.', cwd: tempCwd, channelConfig, tools,
      })) second.push(raw as unknown as Record<string, unknown>)

      expect(requests).toHaveLength(3)
      expect(toolExecutions).toBe(1)
      const continuationBody = JSON.stringify(requests[2]!.body)
      expect(continuationBody.match(/original user task/g)).toHaveLength(1)
      expect(continuationBody).toContain('fixture tool result')
      expect(continuationBody).toContain('Please continue from completed work.')
      expect(continuationBody).not.toContain('401 Unauthorized')
      expect(second).toContainEqual(expect.objectContaining({
        kind: 'tagent_event',
        event: expect.objectContaining({ type: 'model_manual_recovery', discardedAssistantUuid: expect.any(String) }),
      }))
      expect(second.filter((p) => p.kind === 'result')).toEqual([
        expect.objectContaining({ subtype: 'success' }),
      ])
    } finally {
      adapter.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      rmSync(tempCwd, { recursive: true, force: true })
    }
  }, 20_000)
})
