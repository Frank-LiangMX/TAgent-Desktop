import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { runtimeProtocolBridge, registerRuntimeProtocolBridgeTarget } from './runtime-protocol-bridge'

let upstream: Server | undefined

afterEach(async () => {
  runtimeProtocolBridge.close()
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.close(() => resolve()))
    upstream = undefined
  }
})

async function startUpstream(handler: (body: any, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<string> {
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    handler(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), req, res)
  })
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('upstream did not start')
  return `http://127.0.0.1:${address.port}/v1`
}

describe('runtime protocol bridge', () => {
  it.each(['openai-chat', 'anthropic-messages'] as const)('restores non-streaming freeform tool calls from %s', async apiProtocol => {
    const baseUrl = await startUpstream((body, _req, res) => {
      const input = 'text(await tools.workbench_search({}))'
      if (apiProtocol === 'openai-chat') {
        expect(body.tools[0].function.parameters.required).toEqual(['input'])
        res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call_exec', function: { name: 'exec', arguments: JSON.stringify({ input }) } }] } }] }))
      } else {
        expect(body.tools[0].input_schema.required).toEqual(['input'])
        res.end(JSON.stringify({ id: 'message_1', content: [{ type: 'tool_use', id: 'call_exec', name: 'exec', input: { input } }], stop_reason: 'tool_use' }))
      }
    })
    const target = await registerRuntimeProtocolBridgeTarget({ runtime: 'codex', provider: 'test', model: 'test', baseUrl, apiKey: 'upstream-key', apiProtocol })
    const response = await fetch(`${target.baseUrl}/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: false, input: [{ role: 'user', content: 'read todos' }], tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description: 'Run JavaScript' }] }] }),
    })
    expect(await response.json()).toMatchObject({ output: [expect.objectContaining({ type: 'custom_tool_call', name: 'exec', namespace: 'functions', input: 'text(await tools.workbench_search({}))' })] })
    target.release()
  })
  it('bridges Codex freeform exec tools and their history through Chat function calling', async () => {
    let requests = 0
    const baseUrl = await startUpstream((body, _req, res) => {
      requests++
      expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'exec', parameters: expect.objectContaining({ required: ['input'] }) }) })]))
      if (requests === 2) {
        expect(body.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ function: { name: 'exec', arguments: JSON.stringify({ input: 'text(await tools.workbench_search({}))' }) } })] }),
          expect.objectContaining({ role: 'tool', content: 'stored todo' }),
        ]))
      }
      res.setHeader('content-type', 'text/event-stream')
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_exec', function: { name: 'exec', arguments: JSON.stringify({ input: 'text(await tools.workbench_search({}))' }) } }] } }] })}\n\ndata: [DONE]\n\n`)
    })
    const target = await registerRuntimeProtocolBridgeTarget({ runtime: 'codex', provider: 'test', model: 'test', baseUrl, apiKey: 'upstream-key', apiProtocol: 'openai-chat' })
    const tool = { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description: 'Run tools through JavaScript' }] }
    const send = (input: unknown[]) => fetch(`${target.baseUrl}/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, input }),
    })
    const text = await (await send([{ type: 'additional_tools', tools: [tool] }, { role: 'user', content: 'read todos' }])).text()
    expect(text).toContain('"type":"custom_tool_call"')
    expect(text).toContain('"namespace":"functions"')
    expect(text).toContain('"input":"text(await tools.workbench_search({}))"')
    expect(text).not.toContain('response.function_call_arguments.delta')
    await (await send([
      { type: 'additional_tools', tools: [tool] }, { role: 'user', content: 'read todos' },
      { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec', input: 'text(await tools.workbench_search({}))' },
      { type: 'custom_tool_call_output', call_id: 'call_exec', output: 'stored todo' },
    ])).text()
    expect(requests).toBe(2)
    target.release()
  })
  it.each([
    ['codex', '\n\n'], ['claude-code', '\n\n'], ['codex', ''], ['claude-code', ''],
  ] as const)('preserves HTTP 200 SSE errors instead of reporting success to %s (separator %j)', async (runtime, separator) => {
    const baseUrl = await startUpstream((_body, _req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
      res.end('data: {"error":{"message":"upstream overloaded"}}' + separator)
    })
    const target = await registerRuntimeProtocolBridgeTarget({
      runtime, provider: 'test', model: 'test', baseUrl, apiKey: 'upstream-key', apiProtocol: 'openai-chat',
    })
    const response = await fetch(`${target.baseUrl}/${runtime === 'codex' ? 'responses' : 'v1/messages'}`, {
      method: 'POST', headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, input: 'hello', messages: [{ role: 'user', content: 'hello' }] }),
    })
    const text = await response.text()
    expect(text).toContain('upstream overloaded')
    expect(text).toContain(runtime === 'codex' ? 'event: response.failed' : 'event: error')
    expect(text).not.toContain('event: response.completed')
    expect(text).not.toContain('event: message_stop')
    target.release()
  })
  it('converts Claude Code Anthropic requests to OpenAI Chat and back', async () => {
    const baseUrl = await startUpstream((body, _req, res) => {
      expect(body.model).toBe('grok-4.6')
      expect(body.messages).toEqual([
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ])
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        id: 'chat-1',
        choices: [{ message: { role: 'assistant', content: 'world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }))
    })
    const target = await registerRuntimeProtocolBridgeTarget({
      runtime: 'claude-code', provider: 'grok', model: 'grok-4.6', baseUrl,
      apiKey: 'upstream-key', apiProtocol: 'openai-chat',
    })
    const response = await fetch(`${target.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': target.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grok-4.6', system: 'system', max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      type: 'message', role: 'assistant', content: [{ type: 'text', text: 'world' }], stop_reason: 'end_turn',
    })
    target.release()
  })

  it('converts Codex Responses requests to OpenAI Chat', async () => {
    const baseUrl = await startUpstream((body, _req, res) => {
      expect(body.model).toBe('grok-4.6')
      expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        id: 'chat-2',
        choices: [{ message: { role: 'assistant', content: 'world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }))
    })
    const target = await registerRuntimeProtocolBridgeTarget({
      runtime: 'codex', provider: 'grok', model: 'grok-4.6', baseUrl,
      apiKey: 'upstream-key', apiProtocol: 'openai-chat',
    })
    const response = await fetch(`${target.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grok-4.6', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], stream: false }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ object: 'response', model: 'grok-4.6', status: 'completed', output: [{ type: 'message' }] })
    target.release()
  })

  it('translates an OpenAI Chat SSE stream back to Claude Messages SSE', async () => {
    const baseUrl = await startUpstream((_body, _req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const target = await registerRuntimeProtocolBridgeTarget({
      runtime: 'claude-code', provider: 'grok', model: 'grok-4.6', baseUrl,
      apiKey: 'upstream-key', apiProtocol: 'openai-chat',
    })
    const response = await fetch(`${target.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': target.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grok-4.6', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).toContain('event: message_start')
    expect(text).toContain('"type":"text_delta"')
    expect(text).toContain('"text":"hello"')
    expect(text).toContain('event: message_stop')
    target.release()
  })
})
