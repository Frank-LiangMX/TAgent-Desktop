/**
 * Local-only control-plane smoke for the official Codex and Claude runtimes.
 *
 * It starts the real locally installed executables through the production
 * adapters, but directs both to loopback SSE stubs with fake credentials.
 * The stubs ask for one read-only fixture command, then complete after the
 * runtime reports the tool outcome. A final hanging request checks interrupt
 * transport cleanup, cancellation outcome, and explicit continuation.
 * No user config or external gateway is read.
 *
 * Run with: node scripts/run-official-runtime-controls.mjs
 * Optional: TAGENT_CONTROLS_RUNTIME=codex|claude;
 * TAGENT_CONTROLS_MODE=tools|interrupt (default: both).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'

import { CodexAppServerAdapter } from '../apps/electron/src/main/lib/adapters/codex/codex-app-server-adapter'
import { ClaudeAgentAdapter } from '../apps/electron/src/main/lib/adapters/claude/claude-agent-adapter'
import type { CodexAppServerIncomingRequest } from '../apps/electron/src/main/lib/adapters/codex/codex-app-server-client'

const CODEX_MODEL = 'gpt-5.6-terra'
// Keep the known loopback-only model identifier from official-claude-smoke.
// Codex uses the existing Terra channel model above; Claude's native CLI
// validates its own model identifiers before it attempts the HTTP request.
const CLAUDE_MODEL = 'claude-smoke-model'
const CODEX_KEY = 'tagent-controls-codex-fake-key'
const CLAUDE_KEY = 'tagent-controls-claude-fake-key'
const FIXTURE_NAME = 'readonly-fixture.txt'
const DEADLINE_MS = 45_000
if ((process.versions as Record<string, string | undefined>).bun) {
  throw new Error('Cancellation observation requires Node: node scripts/run-official-runtime-controls.mjs')
}
const onlyRuntime = process.env.TAGENT_CONTROLS_RUNTIME
if (onlyRuntime && onlyRuntime !== 'codex' && onlyRuntime !== 'claude') {
  throw new Error('TAGENT_CONTROLS_RUNTIME 仅支持 codex 或 claude')
}

type Runtime = 'codex' | 'claude'
const onlyMode = process.env.TAGENT_CONTROLS_MODE
if (onlyMode && onlyMode !== 'tools' && onlyMode !== 'interrupt') throw new Error('Unsupported controls mode')
type Mode = 'deny' | 'allow' | 'interrupt'

interface Scenario {
  runtime: Runtime
  mode: Mode
  requestBodies: string[]
  toolRequests: string[]
  streamClosed: Promise<void>
  resolveStreamClosed: () => void
  requestCount: number
  closed: boolean
  routes: string[]
}

function waitFor(predicate: () => boolean, message: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer)
        reject(new Error(message))
      }
    }, 25)
  })
}

async function removeTempDir(path: string): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw last instanceof Error ? last : new Error(`could not remove ${path}`)
}

function scenarioDiagnostics(scenario: Scenario, stderr: string[], firstMessage = ''): string {
  const nativeStderr = stderr.join('').slice(-2_000) || '(no native stderr)'
  return ` requests=${scenario.requestCount} routes=${JSON.stringify(scenario.routes)} approvals=${JSON.stringify(scenario.toolRequests)} first=${firstMessage || '(no SDK message)'} stderr=${nativeStderr}`
}

async function drain(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const buffer = Buffer.concat(chunks)
  return (req.headers['content-encoding'] === 'gzip' ? gunzipSync(buffer) : req.headers['content-encoding'] === 'br' ? brotliDecompressSync(buffer) : buffer).toString('utf8')
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function codexComplete(res: ServerResponse, text: string): void {
  const responseId = 'resp_controls'
  sse(res, 'response.created', { type: 'response.created', response: { id: responseId, status: 'in_progress' } })
  sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_controls', type: 'message', role: 'assistant', content: [] } })
  sse(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_controls', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })
  sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_controls', output_index: 0, content_index: 0, delta: text })
  sse(res, 'response.completed', { type: 'response.completed', response: { id: responseId, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } })
  res.end()
}

function codexToolCall(res: ServerResponse): void {
  const responseId = 'resp_controls_tool'
  const call = {
    id: 'fc_controls',
    type: 'function_call',
    call_id: 'call_controls',
    name: 'tagent_read_fixture',
    arguments: JSON.stringify({ path: FIXTURE_NAME }),
  }
  sse(res, 'response.created', { type: 'response.created', response: { id: responseId, status: 'in_progress' } })
  sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: call })
  sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: call })
  sse(res, 'response.completed', { type: 'response.completed', response: { id: responseId, status: 'completed', output: [call] } })
  res.end()
}

function claudeMessage(res: ServerResponse, model: string, content: unknown[], stopReason: 'tool_use' | 'end_turn'): void {
  sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_controls', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
  for (const [index, block] of content.entries()) {
    const item = block as { type: string; id?: string; name?: string; text?: string; input?: unknown }
    const start = item.type === 'text' ? { type: 'text', text: '' } : { ...item, input: {} }
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: start })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: item.type === 'text' ? { type: 'text_delta', text: item.text } : { type: 'input_json_delta', partial_json: JSON.stringify(item.input) } })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
  }
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'tagent-official-controls-'))
  const codexHomeRoot = join(root, 'codex-homes')
  // Keep the Claude state root short and separate: its project/session layout
  // nests a sanitized absolute cwd below this directory on Windows.
  const claudeConfigRoot = mkdtempSync(join(tmpdir(), 'tagent-controls-cfg-'))
  writeFileSync(join(root, FIXTURE_NAME), 'read-only fixture\n', 'utf8')
  // The real commands run only in this controlled directory.
  writeFileSync(join(root, '.gitkeep'), '', 'utf8')
  const previousConfigRoot = process.env.TAGENT_CONFIG_DIR
  process.env.TAGENT_CONFIG_DIR = claudeConfigRoot

  let current: Scenario | undefined
  const active = new Set<{ abort(sessionId: string): void; dispose(): void }>()
  const deadline = setTimeout(() => {
    for (const adapter of active) {
      adapter.abort('controls-timeout')
      adapter.dispose()
    }
  }, DEADLINE_MS)

  const server = createServer(async (req, res) => {
    const scenario = current
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    scenario?.routes.push(`${req.method} ${pathname}`)
    if (scenario?.runtime === 'claude' && req.method === 'GET' && pathname.endsWith('/models')) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: CLAUDE_MODEL, type: 'model', display_name: CLAUDE_MODEL, created_at: '2026-01-01T00:00:00Z' }], has_more: false }))
    }
    if (scenario?.runtime === 'claude' && pathname.endsWith('/messages/count_tokens')) {
      await drain(req)
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
    }
    if (!scenario || req.method !== 'POST') return res.writeHead(404).end()
    const expectedPath = scenario.runtime === 'codex' ? '/v1/responses' : '/messages'
    if (!pathname.endsWith(expectedPath)) return res.writeHead(404).end()
    const body = await drain(req)
    scenario.routes.push(`body: ${body.length} chars; fixture=${body.includes('controls fixture')}; encoding=${req.headers['content-encoding'] ?? 'none'}`)
    if (scenario.runtime === 'claude' && !JSON.parse(body).tools?.some((tool: { name?: string }) => tool.name === 'Read')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      claudeMessage(res, CLAUDE_MODEL, [{ type: 'text', text: 'model preflight ok' }], 'end_turn')
      return
    }
    scenario.requestBodies.push(body)
    scenario.requestCount += 1
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    if (scenario.mode === 'interrupt' && scenario.requestCount === 1) {
      sse(res, scenario.runtime === 'codex' ? 'response.created' : 'message_start', scenario.runtime === 'codex'
        ? { type: 'response.created', response: { id: 'resp_interrupt', status: 'in_progress' } }
        : { type: 'message_start', message: { id: 'msg_interrupt', type: 'message', role: 'assistant', model: CLAUDE_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
      // Incoming-request close fires after Node has consumed the body; it is
      // not proof that an interrupt cancelled the native provider stream.
      res.on('close', () => { scenario.closed = true; scenario.resolveStreamClosed() })
      req.socket.on('close', () => { scenario.closed = true; scenario.resolveStreamClosed() })
      return
    }
    if (scenario.requestCount === 1) {
      if (scenario.runtime === 'codex') codexToolCall(res)
      else claudeMessage(res, CLAUDE_MODEL, [{ type: 'tool_use', id: 'toolu_controls', name: 'Read', input: { file_path: join(root, FIXTURE_NAME) } }], 'tool_use')
      return
    }
    if (scenario.runtime === 'codex') codexComplete(res, `codex ${scenario.mode} closed loop`)
    else claudeMessage(res, CLAUDE_MODEL, [{ type: 'text', text: `claude ${scenario.mode} closed loop` }], 'end_turn')
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('controls stub did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const startScenario = (runtime: Runtime, mode: Mode): Scenario => {
    let resolveStreamClosed!: () => void
    const streamClosed = new Promise<void>((resolve) => { resolveStreamClosed = resolve })
    return current = { runtime, mode, requestBodies: [], toolRequests: [], streamClosed, resolveStreamClosed, requestCount: 0, closed: false, routes: [] }
  }

  const runCodex = async (mode: Mode): Promise<void> => {
    const scenario = startScenario('codex', mode)
    const sessionId = `controls-codex-${mode}`
    const adapter = new CodexAppServerAdapter({ officialRuntimeHomeRoot: codexHomeRoot })
    active.add(adapter)
    const stderr: string[] = []
    let nativeThreadId: string | undefined
    const query = adapter.query({
      sessionId, cwd: root, prompt: `Run the ${mode} controls fixture.`, model: CODEX_MODEL,
      approvalPolicy: 'on-request', sandbox: 'read-only',
      dynamicTools: [{
        type: 'function',
        name: 'tagent_read_fixture',
        description: 'Read the controls smoke fixture only.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      }],
      apiConnection: { channelId: 'controls-codex', baseUrl: `${baseUrl}/v1`, apiKey: CODEX_KEY },
      onThreadId: (id) => { nativeThreadId = id },
      onStderr: (text) => stderr.push(text),
      onServerRequest: async (request: CodexAppServerIncomingRequest) => {
        scenario.toolRequests.push(request.method)
        if (request.method !== 'item/tool/call') throw new Error(`unexpected Codex request: ${request.method}`)
        // This is a real App Server Dynamic Tool bridge, not a native shell
        // approval. The host reads only this fixed temp fixture.
        const params = request.params as { tool?: unknown; arguments?: { path?: unknown } } | undefined
        if (params?.tool !== 'tagent_read_fixture' || params.arguments?.path !== FIXTURE_NAME) {
          throw new Error('Codex requested a tool outside the read-only fixture')
        }
        return mode === 'allow'
          ? { success: true, contentItems: [{ type: 'inputText', text: readFileSync(join(root, FIXTURE_NAME), 'utf8').trim() }] }
          : { success: false, contentItems: [{ type: 'inputText', text: 'host denied fixture read' }] }
      },
    })
    const iterator = query[Symbol.asyncIterator]()
    let firstMessage = ''
    let completed = false
    const terminalTypes: string[] = []
    let consumeError: unknown
    const consume = (async () => {
      while (true) {
        const result = await iterator.next()
        if (result.done) return
        if (!firstMessage) firstMessage = JSON.stringify(result.value).slice(0, 2_000)
        if ((result.value as { subtype?: unknown }).subtype === 'completed') completed = true
        if ((result.value as { kind?: string }).kind === 'result') terminalTypes.push(String((result.value as { subtype?: unknown }).subtype))
      }
    })().catch((error) => { consumeError = error })
    try {
      if (mode === 'interrupt') {
        await waitFor(() => scenario.requestCount === 1, 'Codex interrupt case never reached loopback')
        await adapter.interruptQuery(sessionId)
        await Promise.race([scenario.streamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error(`Codex interrupt stream still open; terminals=${JSON.stringify(terminalTypes)}`)), 6_000))])
        await waitFor(() => terminalTypes.includes('interrupted'), 'Codex did not expose the native cancelled terminal')
        await consume
        if (consumeError) throw consumeError
        if (adapter.hasActiveChannel(sessionId)) throw new Error('Cancelled official Codex process remained reusable')
        if (!nativeThreadId || scenario.requestCount !== 1 || scenario.toolRequests.length) throw new Error('Codex cancelled request was replayed or dispatched a tool')
        const newPrompt = 'Explicit new user message after stop. Reply with recovery confirmation.'
        let resumedCompleted = false
        for await (const raw of adapter.query({
          sessionId, cwd: root, prompt: newPrompt, model: CODEX_MODEL,
          resumeThreadId: nativeThreadId, approvalPolicy: 'never', sandbox: 'read-only',
          apiConnection: { channelId: 'controls-codex', baseUrl: `${baseUrl}/v1`, apiKey: CODEX_KEY },
        })) {
          const message = raw as unknown as { kind?: string; subtype?: string }
          if (message.kind === 'result') {
            if (message.subtype !== 'completed') throw new Error('Codex explicit continuation failed')
            resumedCompleted = true
            break
          }
        }
        const body = JSON.parse(scenario.requestBodies[1] ?? '{}')
        if (!resumedCompleted || scenario.requestCount !== 2 || !JSON.stringify(body.input).includes(newPrompt)) throw new Error('Codex continuation did not issue exactly one new user request')
        const originalTurns = (body.input ?? []).filter((item: { role?: string }) => item.role === 'user' && JSON.stringify(item).includes('Run the interrupt controls fixture.'))
        if (originalTurns.length !== 1) throw new Error('Codex native resume lost or replayed the interrupted user turn')
      } else {
        await waitFor(() => scenario.toolRequests.length === 1, `Codex ${mode} never requested host approval`)
        await waitFor(() => scenario.requestCount >= 2, `Codex ${mode} did not return tool result to loopback`)
        const expectedResult = mode === 'allow' ? 'read-only fixture' : 'host denied fixture read'
        await waitFor(() => scenario.requestBodies[1]?.includes(expectedResult) === true, `Codex ${mode} second HTTP request did not contain the host tool result`)
        await waitFor(() => completed, `Codex ${mode} did not emit a completed terminal event`)
      }
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}${scenarioDiagnostics(scenario, stderr, firstMessage)}`)
    } finally {
      adapter.abort(sessionId)
      adapter.dispose()
      active.delete(adapter)
      await iterator.return?.()
    }
    await Promise.race([consume, new Promise((resolve) => setTimeout(resolve, 2_000))])
    if (consumeError) throw consumeError
    if (scenario.requestBodies.some((body) => body.includes(CODEX_KEY))) throw new Error('Codex fake key leaked into HTTP body')
    if (stderr.join('').includes(CODEX_KEY)) throw new Error('Codex fake key leaked into stderr')
    console.log(`controls passed: Codex ${mode}`)
  }

  const runClaude = async (mode: Mode): Promise<void> => {
    const scenario = startScenario('claude', mode)
    const sessionId = `controls-claude-${mode}`
    const adapter = new ClaudeAgentAdapter({ runtime: 'claude-code' })
    active.add(adapter)
    const stderr: string[] = []
    const query = adapter.query({
      sessionId, cwd: root, prompt: `Run the ${mode} controls fixture.`, model: CLAUDE_MODEL,
      runtime: 'claude-code', apiConnection: { channelId: 'controls-claude', baseUrl, apiKey: CLAUDE_KEY },
      sdkPermissionMode: 'default', allowDangerouslySkipPermissions: false, systemPrompt: 'Answer with text only.',
      includePartialMessages: true, persistSession: true,
      canUseTool: async (toolName, input) => {
        if (toolName !== 'Read' || input.file_path !== join(root, FIXTURE_NAME)) {
          throw new Error('Claude requested a tool outside the read-only fixture')
        }
        scenario.toolRequests.push(`${toolName}:${String(input.file_path ?? '')}`)
        return mode === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'controls smoke host denied this tool' }
      },
      onStderr: (text) => stderr.push(text),
    })
    const iterator = query[Symbol.asyncIterator]()
    let firstMessage = ''
    let completed = false
    let consumeError: unknown
    const terminalTypes: string[] = []
    const consume = (async () => {
      while (true) {
        const result = await iterator.next()
        if (result.done) return
        if (!firstMessage) firstMessage = JSON.stringify(result.value).slice(0, 2_000)
        const message = result.value as { type?: unknown; subtype?: unknown; is_error?: boolean; errors?: unknown[] }
        if (message.type === 'result') terminalTypes.push(String(message.subtype))
        if (message.type === 'result' && message.subtype === 'success' && !message.is_error && !message.errors?.length) completed = true
      }
    })().catch((error) => { consumeError = error })
    try {
      if (mode === 'interrupt') {
        await waitFor(() => scenario.requestCount === 1, 'Claude interrupt case never reached loopback')
        await adapter.interruptQuery(sessionId)
        await Promise.race([scenario.streamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error(`Claude interrupt stream still open; terminals=${JSON.stringify(terminalTypes)}`)), 6_000))])
        await waitFor(() => terminalTypes.includes('error_during_execution'), 'Claude did not expose the native cancellation result')
        if (scenario.requestCount !== 1 || scenario.toolRequests.length) throw new Error('Claude cancelled request was replayed or dispatched a tool')
        const newPrompt = 'Explicit new user message after stop. Reply with recovery confirmation.'
        await adapter.sendQueuedMessage(sessionId, {
          type: 'user', session_id: sessionId, parent_tool_use_id: null,
          message: { role: 'user', content: newPrompt },
        })
        await waitFor(() => completed, 'Claude could not continue after cancellation')
        const body = JSON.parse(scenario.requestBodies[1] ?? '{}')
        if (scenario.requestCount !== 2 || !JSON.stringify(body.messages).includes(newPrompt)) throw new Error('Claude continuation did not issue exactly one new user request')
        const originalTurns = (body.messages ?? []).filter((item: { role?: string }) => item.role === 'user' && JSON.stringify(item).includes('Run the interrupt controls fixture.'))
        if (originalTurns.length !== 1) throw new Error('Claude continuation lost or replayed the interrupted user turn')
      } else {
        await waitFor(() => scenario.toolRequests.length === 1, `Claude ${mode} never invoked host tool control`)
        await waitFor(() => scenario.requestCount >= 2, `Claude ${mode} did not return tool result to loopback`)
        const expectedResult = mode === 'allow' ? 'read-only fixture' : 'controls smoke host denied this tool'
        await waitFor(() => scenario.requestBodies[1]?.includes(expectedResult) === true, `Claude ${mode} second HTTP request did not contain the host tool result`)
        await waitFor(() => completed, `Claude ${mode} did not emit a result terminal event`)
      }
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}${scenarioDiagnostics(scenario, stderr, firstMessage)}`)
    } finally {
      adapter.abort(sessionId)
      adapter.dispose()
      active.delete(adapter)
      await iterator.return?.()
    }
    await Promise.race([consume, new Promise((resolve) => setTimeout(resolve, 2_000))])
    if (consumeError) throw consumeError
    if (scenario.requestBodies.some((body) => body.includes(CLAUDE_KEY))) throw new Error('Claude fake key leaked into HTTP body')
    if (stderr.join('').includes(CLAUDE_KEY)) throw new Error('Claude fake key leaked into stderr')
    console.log(`controls passed: Claude ${mode}`)
  }

  let primaryError: unknown
  try {
    // Deny and allow each traverse the official executable -> host approval ->
    // native tool result loop.  The fixture command is read-only and scoped to
    // this script's temporary cwd.
    if (!onlyRuntime || onlyRuntime === 'codex') {
      if (onlyMode !== 'interrupt') { await runCodex('deny'); await runCodex('allow') }
      if (onlyMode !== 'tools') await runCodex('interrupt')
    }
    if (!onlyRuntime || onlyRuntime === 'claude') {
      if (onlyMode !== 'interrupt') { await runClaude('deny'); await runClaude('allow') }
      if (onlyMode !== 'tools') await runClaude('interrupt')
    }
    const scope = onlyRuntime === 'codex'
      ? 'Codex'
      : onlyRuntime === 'claude'
        ? 'Claude'
        : 'Codex+Claude'
    console.log(`official runtime controls smoke passed: ${scope} ${onlyMode ?? 'tools+interrupt'}`)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    clearTimeout(deadline)
    for (const adapter of active) adapter.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (previousConfigRoot === undefined) delete process.env.TAGENT_CONFIG_DIR
    else process.env.TAGENT_CONFIG_DIR = previousConfigRoot
    for (const path of [root, claudeConfigRoot]) {
      try {
        await removeTempDir(path)
      } catch (cleanupError) {
        if (primaryError) {
          console.error('official runtime controls smoke cleanup failed after primary failure:', cleanupError)
        } else {
          throw cleanupError
        }
      }
    }
  }
}

main().catch((error) => {
  console.error('official runtime controls smoke failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
