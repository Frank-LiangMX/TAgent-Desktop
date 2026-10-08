import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildHttpDirectModel, createHttpDirectStreamFn } from './http-direct-stream-fn'

describe('Pi Responses wire protocol (real pi-ai, local HTTP fixture)', () => {
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
        messages: [{ role: 'user', content: 'ping', timestamp: 1 }],
      })
      const events = []
      for await (const event of stream) events.push(event)
      expect(events.some((e) => e.type === 'text_delta' && e.delta === 'fixture-ok')).toBe(true)
      expect(events.at(-1)?.type).toBe('done')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ url: '/v1/responses', authorization: 'Bearer local-fixture-key', body: { model: 'fixture-model', stream: true } })
      expect(requests[0]!.body).toHaveProperty('input')
      expect(requests[0]!.body).not.toHaveProperty('messages')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
