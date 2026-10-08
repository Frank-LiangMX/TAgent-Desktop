/**
 * Local-only smoke for the official Claude Code SDK/API path.
 * Run with: bun scripts/official-claude-smoke.ts
 * No KSCC fallback, real gateway, user config, or tools are used.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

const FAKE_KEY = 'tagent-official-claude-smoke-fake-key'
const MODEL = 'claude-smoke-model'
const SESSION_ID = 'official-claude-smoke-session'

function writeMessagesSse(res: ServerResponse, turn: number): void {
  // The SDK may perform a model-validation request before the actual turn.
  // Text must not assume one HTTP request equals one user turn.
  const text = 'local messages stub reply'
  const messageId = `msg_smoke_${turn}`
  const events = [
    ['message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['ping', { type: 'ping' }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as const
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}

async function drain(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function consumeUntilResult(
  iterable: AsyncIterable<unknown>,
  expectedText: string,
): Promise<{ sessionId?: string; resultSeen: boolean }> {
  let sessionId: string | undefined
  let resultSeen = false
  let text = ''
  for await (const message of iterable) {
    const value = message as Record<string, unknown>
    if (typeof value.session_id === 'string') sessionId = value.session_id
    if (value.type === 'assistant') {
      const message = value.message as { content?: unknown } | undefined
      const content = message && Array.isArray(message.content) ? message.content : []
      text += content
        .map((item) => (item as { type?: string; text?: string }).type === 'text' ? (item as { text?: string }).text ?? '' : '')
        .join('')
    }
    if (value.type === 'result' && value.subtype === 'success') {
      resultSeen = true
      break
    }
  }
  if (!resultSeen || !text.includes(expectedText)) {
    throw new Error(`unexpected SDK result: result=${resultSeen} text=${text}`)
  }
  return { sessionId, resultSeen }
}

async function removeTempDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`temporary directory remained locked: ${path}`)
}

async function main(): Promise<void> {
  const configRoot = mkdtempSync(join(tmpdir(), 'tagent-official-claude-smoke-'))
  const cwd = mkdtempSync(join(tmpdir(), 'tagent-official-claude-cwd-'))
  const previousConfigRoot = process.env.TAGENT_CONFIG_DIR
  process.env.TAGENT_CONFIG_DIR = configRoot
  const stderr: string[] = []
  const requestBodies: string[] = []
  const apiKeyHeaders: Array<string | string[] | undefined> = []
  const requestPaths: string[] = []
  let requestCount = 0
  let firstAdapter: { abort(sessionId: string): void; dispose(): void } | undefined
  let resumedAdapter: { abort(sessionId: string): void; dispose(): void } | undefined
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    requestPaths.push(`${req.method} ${pathname}`)
    if (req.method === 'GET' && pathname.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL, type: 'model', display_name: MODEL, created_at: '2026-01-01T00:00:00Z' }], has_more: false }))
      return
    }
    if (req.method === 'POST' && pathname.endsWith('/messages/count_tokens')) {
      await drain(req)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }))
      return
    }
    if (req.method !== 'POST' || !pathname.endsWith('/messages')) {
      res.writeHead(404).end()
      return
    }
    requestBodies.push(await drain(req))
    apiKeyHeaders.push(req.headers['x-api-key'])
    requestCount += 1
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    writeMessagesSse(res, requestCount)
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('stub server did not bind')

  const connection = { channelId: 'official-claude-smoke', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: FAKE_KEY }
  const denyTools = async () => ({ behavior: 'deny' as const, message: 'Smoke denies all tools' })
  const deadline = setTimeout(() => {
    firstAdapter?.abort(SESSION_ID)
    resumedAdapter?.abort(SESSION_ID)
  }, 45_000)

  try {
    const { ClaudeAgentAdapter } = await import('../apps/electron/src/main/lib/adapters/claude/claude-agent-adapter')
    firstAdapter = new ClaudeAgentAdapter({ runtime: 'claude-code' })
    const first = await consumeUntilResult(firstAdapter.query({
      sessionId: SESSION_ID,
      prompt: 'Return the local stub response. Do not use tools.',
      cwd,
      model: MODEL,
      runtime: 'claude-code',
      apiConnection: connection,
      sdkPermissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      canUseTool: denyTools,
      systemPrompt: 'Answer with text only.',
      includePartialMessages: true,
      persistSession: true,
      onStderr: (text) => stderr.push(text),
    }), 'local messages stub reply')
    const nativeSessionId = first.sessionId
    if (!nativeSessionId) throw new Error('official SDK did not report a session_id')

    resumedAdapter = new ClaudeAgentAdapter({ runtime: 'claude-code' })
    await consumeUntilResult(resumedAdapter.query({
      sessionId: SESSION_ID,
      resumeSessionId: nativeSessionId,
      prompt: 'Return the second local stub response. Do not use tools.',
      cwd,
      model: MODEL,
      runtime: 'claude-code',
      apiConnection: connection,
      sdkPermissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      canUseTool: denyTools,
      systemPrompt: 'Answer with text only.',
      includePartialMessages: true,
      persistSession: true,
      onStderr: (text) => stderr.push(text),
    }), 'local messages stub reply')
    const resumedRequest = requestBodies.at(-1) ?? ''
    if (!resumedRequest.includes('Return the local stub response.') || !resumedRequest.includes('Return the second local stub response.')) {
      throw new Error('resumed API request did not contain both user turns')
    }
    if (requestBodies.some((body) => body.includes(FAKE_KEY))) throw new Error('fake key leaked into request body')
    if (apiKeyHeaders.some((value) => value !== FAKE_KEY)) throw new Error('SDK did not use the selected API credential')
    if (requestBodies.some((body) => JSON.parse(body).model !== MODEL)) throw new Error('SDK did not use the selected model')
    console.log(`official Claude smoke passed: start+result, resume+result, requests=${requestCount}`)
  } catch (error) {
    const detail = stderr.join('').slice(-2000)
    throw new Error(`${error instanceof Error ? error.message : error}; requests=${JSON.stringify(requestPaths)}${detail ? ` stderr=${detail}` : ''}`)
  } finally {
    clearTimeout(deadline)
    firstAdapter?.dispose()
    resumedAdapter?.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (previousConfigRoot === undefined) delete process.env.TAGENT_CONFIG_DIR
    else process.env.TAGENT_CONFIG_DIR = previousConfigRoot
    await removeTempDir(configRoot)
    await removeTempDir(cwd)
  }
}

main().catch((error) => {
  console.error('official Claude smoke failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
