#!/usr/bin/env node
/**
 * Probe an intranet Anthropic-compatible gateway (one-api / new-api style).
 *
 *   ANTHROPIC_BASE_URL=http://10.11.203.34:31177 \
 *   ANTHROPIC_AUTH_TOKEN=sk-sg-... \
 *   node scripts/intranet-gateway-probe.mjs
 *
 * Optional: PROBE_MODEL (default claude-sonnet-4-5), PROBE_TIMEOUT_MS (default 8000).
 * Does not persist tokens. Report never prints the token. Does not inherit ANTHROPIC_MODEL.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Socket } from 'node:net'

const CONNECT_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8000)
const MODEL = process.env.PROBE_MODEL || 'claude-sonnet-4-5'
const BUFFERED_GAP_MS = 40

function fail(code, message, extra = {}) {
  const report = { ok: false, code, message, ...extra }
  console.log(JSON.stringify(report, null, 2))
  process.exit(1)
}

function redactUrl(raw) {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '')
  } catch {
    return '<invalid-url>'
  }
}

function parseBase(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    fail('invalid_url', 'ANTHROPIC_BASE_URL is not a valid URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    fail('invalid_url', 'ANTHROPIC_BASE_URL must be http or https')
  }
  const origin = `${u.protocol}//${u.host}`
  const prefix = u.pathname.replace(/\/$/, '')
  return { origin, prefix, url: u }
}

function tcpConnect(hostname, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    const timer = setTimeout(() => {
      socket.destroy()
      const err = new Error(`TCP timeout after ${timeoutMs}ms`)
      err.code = 'ETIMEDOUT'
      reject(err)
    }, timeoutMs)
    socket.once('error', (err) => {
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    })
    socket.connect(port, hostname, () => {
      clearTimeout(timer)
      socket.end()
      resolve()
    })
  })
}

/**
 * POST JSON. When stream=true, records TCP/HTTP chunk arrival times (not SSE events).
 */
function postJson(base, token, path, body, { stream = false, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const url = new URL(`${base.prefix}${path}`, base.origin)
  const payload = Buffer.from(JSON.stringify(body))
  const lib = url.protocol === 'https:' ? httpsRequest : httpRequest
  const started = Date.now()

  return new Promise((resolve, reject) => {
    const req = lib(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          accept: stream ? 'text/event-stream' : 'application/json',
          authorization: `Bearer ${token}`,
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
        },
      },
      (res) => {
        const chunks = []
        const arrivals = []
        let firstByteMs = null
        res.on('data', (buf) => {
          const now = Date.now()
          if (firstByteMs == null) firstByteMs = now - started
          arrivals.push({ t: now - started, bytes: buf.length })
          chunks.push(buf)
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            firstByteMs,
            totalMs: Date.now() - started,
            arrivals,
          })
        })
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      const err = new Error(`HTTP timeout after ${timeoutMs}ms`)
      err.code = 'ETIMEDOUT'
      reject(err)
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function parseSseEvents(raw) {
  const events = []
  const blocks = String(raw).split(/\r?\n\r?\n/)
  for (const block of blocks) {
    if (!block.trim()) continue
    let event = 'message'
    const dataLines = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    const dataRaw = dataLines.join('\n')
    if (!dataRaw || dataRaw === '[DONE]') {
      events.push({ event, data: dataRaw === '[DONE]' ? { type: 'done' } : null })
      continue
    }
    try {
      events.push({ event, data: JSON.parse(dataRaw) })
    } catch {
      events.push({ event, data: { type: 'unparsed' } })
    }
  }
  return events
}

function usageFromEvents(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = events[i]?.data
    if (!d || typeof d !== 'object') continue
    if (d.usage && typeof d.usage === 'object') return d.usage
    if (d.message?.usage && typeof d.message.usage === 'object') return d.message.usage
  }
  return null
}

function classifyUnreachable(err) {
  const code = err?.code || ''
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNREFUSED') {
    return true
  }
  return false
}

function streamVerdict(arrivals) {
  if (!arrivals.length) return { streamed: false, reason: 'no_bytes' }
  if (arrivals.length === 1) {
    return { streamed: false, reason: 'single_chunk', likelyBuffered: true }
  }
  const gaps = []
  for (let i = 1; i < arrivals.length; i++) gaps.push(arrivals[i].t - arrivals[i - 1].t)
  const maxGap = Math.max(...gaps)
  const likelyBuffered = maxGap < BUFFERED_GAP_MS
  return {
    streamed: !likelyBuffered,
    reason: likelyBuffered ? 'chunks_too_close' : 'chunk_gaps_ok',
    likelyBuffered,
    chunkCount: arrivals.length,
    maxGapMs: maxGap,
  }
}

function toolDeltaVerdict(events) {
  let toolUseBlock = false
  let inputJsonDelta = false
  let toolUseCompleteOnly = false
  const eventTypes = []
  const deltaTypes = []

  for (const { event, data } of events) {
    const type = data?.type || event
    eventTypes.push(type)
    if (type === 'content_block_start' && data?.content_block?.type === 'tool_use') toolUseBlock = true
    if (data?.content_block?.type === 'tool_use' && data?.content_block?.input) toolUseCompleteOnly = true
    const deltaType = data?.delta?.type
    if (deltaType) deltaTypes.push(deltaType)
    if (deltaType === 'input_json_delta' || type === 'input_json_delta') inputJsonDelta = true
  }

  return {
    toolUseBlock,
    inputJsonDelta,
    completeToolUseWithoutDeltas: toolUseBlock && !inputJsonDelta && toolUseCompleteOnly,
    eventTypes: [...new Set(eventTypes)].slice(0, 24),
    deltaTypes: [...new Set(deltaTypes)],
  }
}

const CACHE_PADDING = 'Intranet gateway cache probe. '.repeat(80)

async function main() {
  const baseRaw = process.env.ANTHROPIC_BASE_URL?.trim()
  const token = process.env.ANTHROPIC_AUTH_TOKEN?.trim()
  const missing = []
  if (!baseRaw) missing.push('ANTHROPIC_BASE_URL')
  if (!token) missing.push('ANTHROPIC_AUTH_TOKEN')
  if (missing.length) {
    fail('missing_env', `Missing ${missing.join(' and ')}`, { missing })
  }

  const base = parseBase(baseRaw)
  const port = base.url.port ? Number(base.url.port) : base.url.protocol === 'https:' ? 443 : 80
  const report = {
    ok: false,
    baseUrl: redactUrl(baseRaw),
    model: MODEL,
    probes: {},
  }

  try {
    await tcpConnect(base.url.hostname, port, CONNECT_TIMEOUT_MS)
    report.probes.reachability = { ok: true, host: base.url.hostname, port }
  } catch (err) {
    report.probes.reachability = {
      ok: false,
      code: 'unreachable',
      host: base.url.hostname,
      port,
      error: err.code || err.message,
    }
    report.code = 'unreachable'
    report.message = `Cannot reach ${base.url.hostname}:${port}`
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }

  // 1+2: streaming short text via /v1/messages
  const streamBody = {
    model: MODEL,
    max_tokens: 32,
    stream: true,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  }

  let streamRes
  try {
    streamRes = await postJson(base, token, '/v1/messages', streamBody, { stream: true })
  } catch (err) {
    if (classifyUnreachable(err)) {
      report.probes.reachability = {
        ok: false,
        code: 'unreachable',
        host: base.url.hostname,
        port,
        error: err.code || err.message,
      }
      report.code = 'unreachable'
      report.message = `HTTP unreachable: ${err.code || err.message}`
      console.log(JSON.stringify(report, null, 2))
      process.exit(1)
    }
    report.probes.streaming = { ok: false, error: err.code || err.message }
    report.message = 'Streaming request failed'
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }

  if (streamRes.status === 0 || classifyUnreachable({ code: streamRes.status === 0 ? 'ETIMEDOUT' : '' })) {
    report.code = 'unreachable'
    report.message = 'No HTTP response'
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }

  const streamEvents = parseSseEvents(streamRes.body)
  const sv = streamVerdict(streamRes.arrivals)
  report.probes.streaming = {
    ok: streamRes.status >= 200 && streamRes.status < 300,
    httpStatus: streamRes.status,
    firstByteMs: streamRes.firstByteMs,
    totalMs: streamRes.totalMs,
    chunkCount: streamRes.arrivals.length,
    ...sv,
    sseEventCount: streamEvents.length,
  }

  // 3: cache_control
  const cacheBody = {
    model: MODEL,
    max_tokens: 16,
    stream: true,
    system: [
      {
        type: 'text',
        text: CACHE_PADDING,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Say hi in one word.',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  }

  try {
    const cacheRes = await postJson(base, token, '/v1/messages', cacheBody, { stream: true })
    const cacheEvents = parseSseEvents(cacheRes.body)
    const usage = usageFromEvents(cacheEvents)
    let parsedUsage = usage
    if (!parsedUsage && cacheRes.body) {
      try {
        const j = JSON.parse(cacheRes.body)
        parsedUsage = j.usage || j.error || null
      } catch {
        parsedUsage = null
      }
    }
    const cacheCreation = parsedUsage?.cache_creation_input_tokens
    const cacheRead = parsedUsage?.cache_read_input_tokens
    const accepted = cacheRes.status >= 200 && cacheRes.status < 300
    report.probes.cacheControl = {
      ok: accepted,
      httpStatus: cacheRes.status,
      accepted,
      cacheCreationInputTokens: cacheCreation ?? null,
      cacheReadInputTokens: cacheRead ?? null,
      fieldsPresent: cacheCreation != null || cacheRead != null,
      stripped: !accepted || (cacheCreation == null && cacheRead == null),
    }
  } catch (err) {
    report.probes.cacheControl = { ok: false, error: err.code || err.message }
  }

  // 4: tool_use input_json_delta
  const toolBody = {
    model: MODEL,
    max_tokens: 128,
    stream: true,
    tools: [
      {
        name: 'echo_probe',
        description: 'Echo a short token. Always call this tool.',
        input_schema: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Must be ping' },
          },
          required: ['token'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'echo_probe' },
    messages: [{ role: 'user', content: 'Call echo_probe with token ping. Do not reply in text.' }],
  }

  try {
    const toolRes = await postJson(base, token, '/v1/messages', toolBody, { stream: true })
    const toolEvents = parseSseEvents(toolRes.body)
    const tv = toolDeltaVerdict(toolEvents)
    report.probes.toolUse = {
      ok: toolRes.status >= 200 && toolRes.status < 300,
      httpStatus: toolRes.status,
      ...tv,
      incremental: tv.inputJsonDelta,
    }
  } catch (err) {
    report.probes.toolUse = { ok: false, error: err.code || err.message }
  }

  const streamOk = report.probes.streaming?.ok === true
  const cacheOk = report.probes.cacheControl?.ok === true
  const toolOk = report.probes.toolUse?.ok === true
  report.ok = streamOk
  report.message = streamOk
    ? `Gateway reachable. stream=${report.probes.streaming.streamed} cacheFields=${report.probes.cacheControl?.fieldsPresent === true} toolDeltas=${report.probes.toolUse?.incremental === true}`
    : `Gateway answered HTTP ${report.probes.streaming?.httpStatus}`

  console.log(JSON.stringify(report, null, 2))
  process.exit(streamOk && cacheOk && toolOk ? 0 : 2)
}

main().catch((err) => {
  fail('crash', err.message || String(err), { error: err.code || undefined })
})
