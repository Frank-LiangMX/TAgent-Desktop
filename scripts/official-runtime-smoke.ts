/**
 * Local-only smoke for the official Codex App Server API-channel path.
 *
 * This intentionally uses a fake key and a loopback Responses stub. It does
 * not call a real provider, use company networking, or configure tools.
 * Run with: bun scripts/official-runtime-smoke.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

import {
  CodexAppServerAdapter,
} from '../apps/electron/src/main/lib/adapters/codex/codex-app-server-adapter'

const FAKE_KEY = 'tagent-official-runtime-smoke-fake-key'
const MODEL = 'smoke-model'

function jsonRpcSse(res: ServerResponse, turn: number): void {
  const responseId = `resp_smoke_${turn}`
  const payloads = [
    { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: `msg_${turn}`, type: 'message', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', item_id: `msg_${turn}`, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: `msg_${turn}`, output_index: 0, content_index: 0, delta: `stub response ${turn}` },
    { type: 'response.output_text.done', item_id: `msg_${turn}`, output_index: 0, content_index: 0, text: `stub response ${turn}` },
    { type: 'response.content_part.done', item_id: `msg_${turn}`, output_index: 0, content_index: 0, part: { type: 'output_text', text: `stub response ${turn}` } },
    { type: 'response.output_item.done', output_index: 0, item: { id: `msg_${turn}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `stub response ${turn}` }] } },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `stub response ${turn}` }] }],
      },
    },
  ]
  for (const payload of payloads) {
    res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  res.end()
}

async function readRequest(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const runtimeHomeRoot = mkdtempSync(join(tmpdir(), 'tagent-official-runtime-smoke-'))
  const cwd = mkdtempSync(join(tmpdir(), 'tagent-official-runtime-cwd-'))
  const deadlineAt = Date.now() + 45_000
  let requestCount = 0
  const requestBodies: string[] = []
  const authorizationHeaders: Array<string | undefined> = []
  const stderr: string[] = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
      res.writeHead(404).end()
      return
    }
    requestBodies.push(await readRequest(req))
    authorizationHeaders.push(req.headers.authorization)
    requestCount += 1
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    jsonRpcSse(res, requestCount)
  })

  await once(server.listen(0, '127.0.0.1'), 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('stub server did not bind a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const connection = {
    channelId: 'official-runtime-smoke',
    baseUrl,
    apiKey: FAKE_KEY,
  }
  let firstThreadId: string | undefined
  let firstAdapter: CodexAppServerAdapter | undefined
  let resumedAdapter: CodexAppServerAdapter | undefined
  const deadline = setTimeout(() => {
    firstAdapter?.abort('official-runtime-smoke-session')
    resumedAdapter?.abort('official-runtime-smoke-session')
  }, 45_000)

  try {
    const options = { officialRuntimeHomeRoot: runtimeHomeRoot }
    firstAdapter = new CodexAppServerAdapter(options)
    const first = firstAdapter.query({
      sessionId: 'official-runtime-smoke-session',
      prompt: 'Reply with the local stub response only.',
      cwd,
      model: MODEL,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      apiConnection: connection,
      onThreadId: (threadId) => { firstThreadId = threadId },
      onStderr: (text) => { stderr.push(text) },
    })
    let firstText = ''
    try {
      for await (const message of first) {
        if ((message as { kind?: string }).kind === 'stream_text_delta') {
          firstText += (message as { text?: string }).text ?? ''
        }
        if ((message as { subtype?: string }).subtype === 'completed') break
      }
    } catch (error) {
      throw new Error(`start request failed: ${error instanceof Error ? error.message : error} stderr=${stderr.join('').slice(-2000)}`)
    }
    if (!firstThreadId || !firstText.includes('stub response 1')) {
      throw new Error(`start did not complete as expected: thread=${firstThreadId ?? 'missing'} text=${firstText} stderr=${stderr.join('').slice(-2000)}`)
    }

    resumedAdapter = new CodexAppServerAdapter(options)
    const resumed = resumedAdapter.query({
      sessionId: 'official-runtime-smoke-session',
      prompt: 'Continue using the local stub.',
      cwd,
      model: MODEL,
      resumeThreadId: firstThreadId,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      apiConnection: connection,
      onStderr: (text) => { stderr.push(text) },
    })
    let resumedText = ''
    try {
      for await (const message of resumed) {
        if ((message as { kind?: string }).kind === 'stream_text_delta') {
          resumedText += (message as { text?: string }).text ?? ''
        }
        if ((message as { subtype?: string }).subtype === 'completed') break
      }
    } catch (error) {
      throw new Error(`resume request failed: ${error instanceof Error ? error.message : error} stderr=${stderr.join('').slice(-2000)}`)
    }
    if (!resumedText.includes('stub response 2')) {
      throw new Error(`resume did not complete as expected: text=${resumedText} stderr=${stderr.join('').slice(-2000)}`)
    }
    if (requestBodies.some((body) => body.includes(FAKE_KEY))) {
      throw new Error('fake API key leaked into an HTTP request body')
    }
    if (authorizationHeaders.some((value) => value !== `Bearer ${FAKE_KEY}`)) {
      throw new Error('official runtime did not use the selected API credential')
    }
    if (requestBodies.some((body) => JSON.parse(body).model !== MODEL)) {
      throw new Error('official runtime did not use the selected model')
    }
    const resumedBody = requestBodies.at(-1) ?? ''
    if (!resumedBody.includes('Reply with the local stub response only.') || !resumedBody.includes('Continue using the local stub.')) {
      throw new Error('resumed request did not contain both user turns')
    }
    if (Date.now() > deadlineAt) throw new Error('smoke exceeded 45 second deadline')
    console.log(`official runtime smoke passed: start+completed, resume+completed, requests=${requestCount}`)
  } finally {
    clearTimeout(deadline)
    firstAdapter?.dispose()
    resumedAdapter?.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(runtimeHomeRoot, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('official runtime smoke failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
