/** Synthetic, anonymized wire scenarios based on the observed incident shapes.
 * No production prompts/credentials; exercise real Pi -> production IR -> UI reducer. */
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { Agent } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { TAgentMessage } from '@tagent/shared'
import { buildHttpDirectModel, createHttpDirectStreamFn } from '@tagent/pi-core'
import { piAssistantToIR, piEventToIR } from './pi-agent-adapter'
import { applySdkMessageToItems, compactAssistantMessageForDisplay } from '../../../../renderer/components/chat/stream-item-model'
import { buildTurnPresentation, type TurnSourceItem } from '../../../../renderer/components/chat/session-turn-model'

describe('Messages wire → Pi → IR → live/history replay', () => {
  it.each(['complete', 'error'] as const)('%s retains ordered parts and terminal state under replay', async (mode) => {
    let requests = 0
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain the request */ }
      requests++
      if (mode === 'error' && requests === 2) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture rejection' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      send({ type: 'message_start', message: { id: `wire-${requests}`, type: 'message', role: 'assistant', model: 'deepseek-fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
      send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
      for (const thinking of ['reasoning fixture ', 'must stay in its own block']) send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } })
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
      for (const text of requests === 1 ? ['正在', '检查。'] : ['检查完成：', '模块入口正常。']) send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } })
      send({ type: 'content_block_stop', index: 1 })
      if (requests === 1) {
        send({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'inspect-1', name: 'inspect', input: {} } })
        send({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } })
        send({ type: 'content_block_stop', index: 2 })
      }
      send({ type: 'message_delta', delta: { stop_reason: requests === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } })
      send({ type: 'message_stop' })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const opts = { provider: 'kscc-gateway', modelId: 'deepseek-fixture', apiKey: 'loopback-only',
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, maxRetries: 0 }
      const agent = new Agent({ streamFn: createHttpDirectStreamFn(opts), initialState: {
        model: buildHttpDirectModel(opts), tools: [{ name: 'inspect', label: 'inspect', description: 'fixture', parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: 'text', text: 'module present' }], details: {} }) }],
      } })
      const frames: TAgentMessage[] = []
      const persisted: TAgentMessage[] = []
      agent.subscribe((event) => {
        if (event.type === 'message_update' && event.message.role === 'assistant') frames.push(structuredClone(piAssistantToIR(event.message, 'replay', { partial: true })))
        if (event.type === 'turn_end') {
          for (const payload of piEventToIR(event, 'replay')) {
            if (payload.kind !== 'sdk_message') continue
            const snapshot = structuredClone(payload.message)
            frames.push(snapshot)
            persisted.push(snapshot)
          }
        }
      })
      await agent.prompt('Inspect the fixture project.')
      expect(requests).toBe(2)
      expect(frames.length).toBeGreaterThan(persisted.length)
      const replay = (messages: TAgentMessage[]) => {
        let items: TurnSourceItem[] = []
        const keys = new Map<string, string>()
        let counter = 0
        for (const message of messages) {
          items = applySdkMessageToItems(items, message, () => `live-${counter++}`)
          for (const item of items) {
            if (!item.message?.uuid) continue
            const prior = keys.get(item.message.uuid)
            if (prior) expect(item.key).toBe(prior)
            keys.set(item.message.uuid, item.key)
          }
        }
        return items
      }
      const live = replay(frames)
      // Duplicated final snapshots and delayed old partials cannot revive a final.
      const delayed = frames.filter((m) => m.type === 'assistant' && m._partial)
      const repeated = replay([...frames, ...persisted.filter((m) => m.type === 'assistant'), ...delayed])
      expect(repeated.map((i) => i.message)).toEqual(live.map((i) => i.message))
      const jsonl = persisted.map((m) => JSON.stringify(m)).join('\n')
      const history: TurnSourceItem[] = jsonl.split('\n').map((line, index) => ({ key: `history-${index}`, message: compactAssistantMessageForDisplay(JSON.parse(line)) }))
      expect(live.map((i) => i.message)).toEqual(history.map((i) => i.message))
      const present = (items: TurnSourceItem[]) => buildTurnPresentation({ kind: 'assistant-turn', key: 'turn', items, isStreaming: false }, { isLiveTurn: false, displayMode: 'concise' })
      expect(present(live)).toEqual(present(history))
      expect(JSON.stringify(present(live).answerTexts)).not.toContain('reasoning fixture')
      expect(live.filter((i) => i.message?.type === 'assistant')).toHaveLength(2)
      if (mode === 'complete') {
        const full = buildTurnPresentation({ kind: 'assistant-turn', key: 'turn', items: live, isStreaming: false }, { isLiveTurn: false, displayMode: 'full' })
        expect(full.answerTexts.join('')).toContain('模块入口正常')
        expect(full.answerTexts.join('')).not.toContain('reasoning fixture')
        expect(present(live).process.filter((p) => p.type === 'text').map((p) => p.text).join('')).toContain('模块入口正常')
      }
      else expect(live.at(-1)?.message).toMatchObject({ stop_reason: 'error', error: { message: expect.stringContaining('fixture rejection') } })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
