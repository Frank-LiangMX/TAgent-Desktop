/** Opt-in: launch installed Claude/Codex binaries against loopback HTTP fixtures.
 * No real model, user credential, repository task, or user runtime home is used.
 * PowerShell: $env:TAGENT_TEST_NATIVE_RUNTIMES='1'; bunx vitest run native-runtime-wire.test.ts
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sdkMessageToIR, type TAgentDesktopStreamPayload } from '@tagent/shared'
import { ClaudeAgentAdapter } from '../claude/claude-agent-adapter'
import { CodexAppServerAdapter } from '../codex/codex-app-server-adapter'
import { applySdkMessageToItems } from '../../../../renderer/components/chat/stream-item-model'
import type { TurnSourceItem } from '../../../../renderer/components/chat/session-turn-model'

describe.skipIf(process.env.TAGENT_TEST_NATIVE_RUNTIMES !== '1')('installed native runtime + loopback provider', () => {
  it.each(['claude', 'codex'] as const)('%s streams two turns through the production adapter without reviving old items', async (kernel) => {
    const root = mkdtempSync(join(tmpdir(), 'tagent-native-wire-'))
    const oldRoot = process.env.TAGENT_CONFIG_DIR
    process.env.TAGENT_CONFIG_DIR = root
    const adapter = kernel === 'claude' ? new ClaudeAgentAdapter() : new CodexAppServerAdapter()
    const routes: string[] = []
    const stderr: string[] = []
    let responses = 0
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* drain only: do not log prompts */ }
      routes.push(req.url ?? '')
      if (req.url?.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":10}'); return
      }
      if (!req.url?.includes('messages') && !req.url?.includes('responses')) {
        res.writeHead(404); res.end('{}'); return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const responseId = ++responses
      const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      if (kernel === 'claude') {
        send({ type: 'message_start', message: { id: `msg_fixture_${responseId}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native-fixture-' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
        send({ type: 'content_block_stop', index: 0 })
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } })
        send({ type: 'message_stop' })
      } else {
        const item = { id: `message_fixture_${responseId}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'native-fixture-ok', annotations: [] }] }
        send({ type: 'response.created', response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } })
        send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
        send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        for (const delta of ['native-fixture-', 'ok']) send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta })
        send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'native-fixture-ok' })
        send({ type: 'response.output_item.done', output_index: 0, item })
        send({ type: 'response.completed', response: { id: 'resp_fixture', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } })
      }
      res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const watchdog = setTimeout(() => adapter.abort(`native-${kernel}`), 35_000)
    try {
      const input = { sessionId: `native-${kernel}`, prompt: 'Return the fixture response. Do not use tools.', cwd: root,
        model: kernel === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.4',
        apiConnection: { channelId: 'loopback-fixture', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'loopback-test-key',
          apiProtocol: kernel === 'claude' ? 'anthropic-messages' as const : 'openai-responses' as const },
        systemPrompt: 'Return text only. Do not use tools.', maxTurns: 1, persistSession: false,
        sdkPermissionMode: 'default' as const, allowDangerouslySkipPermissions: false,
        approvalPolicy: 'never' as const, sandbox: 'read-only' as const,
        onStderr: (line: string) => stderr.push(line),
      }
      let items: TurnSourceItem[] = []
      let seq = 0
      let sawStreaming = false
      let result: TAgentDesktopStreamPayload | undefined
      let turns = 0
      for await (const raw of adapter.query(input)) {
        const converted = kernel === 'claude' ? sdkMessageToIR(raw) : undefined
        const p = kernel === 'codex' ? raw as unknown as TAgentDesktopStreamPayload
          : converted?.message ? { kind: 'sdk_message' as const, message: converted.message } : converted?.event
        if (!p) continue
        if (p.kind === 'stream_text_delta') sawStreaming = true
        if (p.kind === 'sdk_message') {
          if (p.message.type === 'assistant' && p.message._partial) sawStreaming = true
          items = applySdkMessageToItems(items, p.message, () => `native-${seq++}`)
        }
        if (p.kind === 'result') {
          result = p
          expect(p.subtype).toBe(kernel === 'claude' ? 'success' : 'completed')
          if (++turns === 2) break
          await adapter.sendQueuedMessage(input.sessionId, { type: 'user', session_id: input.sessionId,
            parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'Repeat the fixture response. Do not use tools.' }] } })
        }
      }
      expect(result, `routes=${JSON.stringify(routes)} stderr=${stderr.join('').slice(-1600)}`).toMatchObject({ kind: 'result', subtype: kernel === 'claude' ? 'success' : 'completed' })
      expect(sawStreaming).toBe(true)
      const answers = items.filter(i => i.message?.type === 'assistant')
      expect(answers.filter(i => i.message?.content.some(b => b.type === 'text' && b.text === 'native-fixture-ok'))).toHaveLength(2)
      expect(new Set(answers.map(i => i.message?.uuid)).size).toBe(answers.length)
      expect(answers.every(i => !i.streaming)).toBe(true)
      expect(routes.some(r => r.includes(kernel === 'claude' ? 'messages' : 'responses'))).toBe(true)
    } finally {
      clearTimeout(watchdog)
      adapter.dispose()
      server.closeAllConnections()
      await new Promise<void>(r => server.close(() => r()))
      if (oldRoot === undefined) delete process.env.TAGENT_CONFIG_DIR
      else process.env.TAGENT_CONFIG_DIR = oldRoot
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('tagent-native-wire-')) throw new Error('Unexpected fixture directory')
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 45_000)
})
