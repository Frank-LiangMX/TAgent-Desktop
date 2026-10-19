import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildHttpDirectModel, createHttpDirectStreamFn } from './http-direct-stream-fn'

describe('reasoning stays separate through a tool round trip (real pi-ai)', () => {
  it.each([
    { provider: 'kscc-gateway', modelId: 'deepseek-v4.1-flash', signature: '', switchModel: false, replay: true },
    { provider: 'deepseek', modelId: 'deepseek-reasoner', signature: '', switchModel: false, replay: true },
    { provider: 'anthropic', modelId: 'claude-fixture', signature: 'signed-fixture', switchModel: false, replay: true },
    { provider: 'anthropic', modelId: 'claude-fixture', signature: '', switchModel: false, replay: false },
    { provider: 'kscc-gateway', modelId: 'deepseek-v4.1-flash', signature: '', switchModel: true, replay: false },
    { provider: 'anthropic', modelId: 'claude-fixture', signature: 'signed-fixture', switchModel: true, replay: false },
  ])('$provider/$modelId signature=$signature switch=$switchModel', async (scenario) => {
    const requests: Array<{ messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }> = []
    const reasoning = 'Private reasoning fixture: consider candidate A and candidate B.'
    const narrative = scenario.signature ? 'Let me explain the status in English.' : '我先检查当前状态。'
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const events = [
        { type: 'message_start', message: { id: 'msg_roundtrip', type: 'message', role: 'assistant', model: scenario.modelId, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: reasoning } },
        ...(scenario.signature ? [{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: scenario.signature } }] : []),
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: narrative } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_fixture', name: 'inspect', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
        { type: 'message_stop' },
      ]
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const opts = { provider: scenario.provider, modelId: scenario.modelId, apiProtocol: 'anthropic-messages' as const,
        apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${address.port}`, maxRetries: 0, thinkingEnabled: true }
      const user = { role: 'user' as const, content: 'Inspect status', timestamp: 1 }
      const first = await createHttpDirectStreamFn(opts)(buildHttpDirectModel(opts), { messages: [user] })
      const deltas: string[] = []
      for await (const event of first) {
        if (event.type === 'text_delta') deltas.push(event.delta)
      }
      const assistant = await first.result()
      expect(deltas.join('')).toBe(narrative)
      expect(assistant.content[0]).toMatchObject({ type: 'thinking', thinking: reasoning })
      const original = JSON.stringify(assistant)
      const nextOpts = scenario.switchModel ? { ...opts, modelId: 'deepseek-other' } : opts
      const second = await createHttpDirectStreamFn(nextOpts)(buildHttpDirectModel(nextOpts), {
        messages: [user, assistant, { role: 'toolResult', toolCallId: 'call_fixture', toolName: 'inspect',
          content: [{ type: 'text', text: 'status: clean' }], isError: false, timestamp: 2 }],
      })
      for await (const event of second) { expect(event.type).not.toBe('error') }
      expect(requests).toHaveLength(2)
      const blocks = requests[1]!.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content)
      expect(blocks.filter((b) => b.type === 'text')).toEqual([{ type: 'text', text: narrative }])
      expect(blocks.some((b) => b.type === 'tool_use' && b.id === 'call_fixture')).toBe(true)
      expect(requests[1]!.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'call_fixture'))).toBe(true)
      if (scenario.replay) {
        expect(blocks).toContainEqual({ type: 'thinking', thinking: reasoning, signature: scenario.signature })
      } else {
        expect(JSON.stringify(requests[1])).not.toContain(reasoning)
      }
      expect(JSON.stringify(assistant)).toBe(original)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})

describe('Pi Responses wire protocol (real pi-ai, local HTTP fixture)', () => {
  it('preserves image content in Chat Completions requests', async () => {
    const requests: Record<string, unknown>[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const chunk of [
        { id: 'chat-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture-ok' }, finish_reason: null }] },
        { id: 'chat-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const opts = { provider: 'custom', apiProtocol: 'openai-chat' as const, modelId: 'fixture-model',
        apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 }
      const stream = await createHttpDirectStreamFn(opts)(buildHttpDirectModel(opts), {
        messages: [{ role: 'user', timestamp: 1, content: [
          { type: 'text', text: '看图' },
          { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
        ] }],
      })
      const events = []
      for await (const event of stream) events.push(event)
      expect(events.at(-1)?.type).toBe('done')
      expect(requests).toHaveLength(1)
      expect(requests[0]!.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.arrayContaining([
          expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: 'data:image/png;base64,aW1hZ2U=' }) }),
        ]) }),
      ]))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('KSCC defaults to Messages and consumes streaming text with Bearer/client authentication', async () => {
    const requests: Array<{ url: string; authorization?: string; client?: string; body: Record<string, unknown> }> = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      requests.push({ url: req.url!, authorization: req.headers.authorization, client: String(req.headers['ksyun-code-type']), body: JSON.parse(body) })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const event of [
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture-ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const opts = { provider: 'kscc-gateway', modelId: 'fixture-model', apiKey: 'local-fixture-key',
        baseUrl: `http://127.0.0.1:${address.port}`, maxRetries: 0,
        headers: { authorization: 'Bearer local-fixture-key', 'ksyun-code-type': 'code' } }
      const stream = await createHttpDirectStreamFn(opts)(buildHttpDirectModel(opts), {
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'ping' },
          { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
        ], timestamp: 1 }],
      })
      const events = []
      for await (const event of stream) events.push(event)
      expect(events.some((e) => e.type === 'text_delta' && e.delta === 'fixture-ok')).toBe(true)
      expect(events.at(-1)?.type).toBe('done')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ url: '/v1/messages', authorization: 'Bearer local-fixture-key', client: 'code',
        body: { model: 'fixture-model', stream: true } })
      expect(requests[0]!.body.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.arrayContaining([
          expect.objectContaining({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }),
        ]) }),
      ]))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
  it('sends the selected endpoint/key/model and consumes terminal streaming text', async () => {
    const requests: Array<{ url: string; authorization?: string; body: Record<string, unknown> }> = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      requests.push({ url: req.url!, authorization: req.headers.authorization, body: JSON.parse(body) })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture-ok', annotations: [] }] }
      for (const event of [
        { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'fixture-ok' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const opts = { provider: 'anthropic', apiProtocol: 'openai-responses' as const, modelId: 'fixture-model', apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 }
      const stream = await createHttpDirectStreamFn(opts)(buildHttpDirectModel(opts), {
        systemPrompt: 'Fixture only',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'ping' },
          { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
        ], timestamp: 1 }],
      })
      const events = []
      for await (const event of stream) events.push(event)
      expect(events.some((e) => e.type === 'text_delta' && e.delta === 'fixture-ok')).toBe(true)
      expect(events.at(-1)?.type).toBe('done')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ url: '/v1/responses', authorization: 'Bearer local-fixture-key', body: { model: 'fixture-model', stream: true } })
      expect(requests[0]!.body).toHaveProperty('input')
      expect(requests[0]!.body).not.toHaveProperty('messages')
      expect(requests[0]!.body.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.arrayContaining([
          expect.objectContaining({ type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }),
        ]) }),
      ]))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
