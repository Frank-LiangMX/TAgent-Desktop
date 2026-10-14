/**
 * Local protocol bridge for official runtimes.
 *
 * Claude Code always speaks Anthropic Messages and Codex always speaks
 * Responses. The selected channel may use any supported upstream wire mode;
 * this loopback bridge keeps the API key in the main process and translates
 * the request/stream at the runtime boundary.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import {
  anthropicToOpenAiChat,
  anthropicToOpenAiResponses,
  openAiToAnthropicMessage,
  openAiResponsesToAnthropicMessage,
  type AnthropicAdapterTarget,
} from './adapters/anthropic'
import {
  anthropicMessageToResponses,
  openAiChatToResponses,
  responsesToAnthropicMessages,
  responsesToOpenAiChat,
} from './adapters/responses'
import {
  openAiChatSseToAnthropicEvents,
  openAiResponsesSseToAnthropicEvents,
} from './adapters/anthropic-stream'
import {
  anthropicMessagesSseToResponsesEvents,
  openAiChatSseToResponsesEvents,
  openAiResponsesSseToResponsesEvents,
  type CanonicalResponsesEvent,
} from './adapters/responses-stream'
import { parseSseFrame, readSseFrameTexts, sseEvent } from './sse'

export type BridgeProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages'
export type BridgeRuntime = 'claude-code' | 'codex'

export interface RuntimeProtocolBridgeTarget {
  runtime: BridgeRuntime
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  apiProtocol: BridgeProtocol
  reasoningEffort?: string
  /** 渠道自定义头（如内网网关客户端标识），随上游请求发出。 */
  headers?: Record<string, string>
}

export interface RegisteredRuntimeProtocolBridgeTarget {
  token: string
  /** Base URL passed to the child runtime. */
  baseUrl: string
  /** Loopback token; never the upstream API key. */
  apiKey: string
  release: () => void
}

type ByteStream = AsyncIterable<Uint8Array>

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new Error('协议桥收到无效 JSON 请求体'))
      }
    })
    req.on('error', reject)
  })
}

function endpoint(baseUrl: string, protocol: BridgeProtocol): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (protocol === 'anthropic-messages') {
    if (/\/messages$/i.test(base)) return base
    return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`
  }
  if (protocol === 'openai-responses') {
    if (/\/responses$/i.test(base)) return base
    return `${base}/responses`
  }
  if (/\/chat\/completions$/i.test(base)) return base
  return `${base}/chat/completions`
}

function targetFor(target: RuntimeProtocolBridgeTarget): AnthropicAdapterTarget {
  return {
    provider: target.provider,
    model: target.model,
    baseUrl: target.baseUrl,
    reasoningEffort: target.reasoningEffort,
  } as AnthropicAdapterTarget
}

function requestBody(target: RuntimeProtocolBridgeTarget, body: any): any {
  const adapterTarget = targetFor(target)
  if (target.runtime === 'claude-code') {
    if (target.apiProtocol === 'openai-chat') return anthropicToOpenAiChat(body, adapterTarget, Boolean(body?.stream))
    if (target.apiProtocol === 'openai-responses') return anthropicToOpenAiResponses(body, adapterTarget, Boolean(body?.stream))
    return body
  }
  if (target.apiProtocol === 'openai-chat') return responsesToOpenAiChat(body, { ...adapterTarget }, Boolean(body?.stream))
  if (target.apiProtocol === 'anthropic-messages') return responsesToAnthropicMessages(body, { ...adapterTarget }, Boolean(body?.stream))
  return body
}

function responseBody(target: RuntimeProtocolBridgeTarget, body: any): any {
  const adapterTarget = targetFor(target)
  if (target.runtime === 'claude-code') {
    if (target.apiProtocol === 'openai-chat') return openAiToAnthropicMessage(body, adapterTarget)
    if (target.apiProtocol === 'openai-responses') return openAiResponsesToAnthropicMessage(body, adapterTarget)
    return body
  }
  if (target.apiProtocol === 'openai-chat') return openAiChatToResponses(body, { ...adapterTarget })
  if (target.apiProtocol === 'anthropic-messages') return anthropicMessageToResponses(body, { ...adapterTarget })
  return body
}

function upstreamHeaders(target: RuntimeProtocolBridgeTarget): Record<string, string> {
  const base: Record<string, string> =
    target.apiProtocol === 'anthropic-messages'
      ? {
          'x-api-key': target.apiKey,
          'anthropic-version': '2023-06-01',
          authorization: `Bearer ${target.apiKey}`,
        }
      : { authorization: `Bearer ${target.apiKey}` }
  // 渠道自定义头最后并入，允许覆盖同名默认头
  return target.headers ? { ...base, ...target.headers } : base
}

async function upstream(target: RuntimeProtocolBridgeTarget, body: any): Promise<Response> {
  return fetch(endpoint(target.baseUrl, target.apiProtocol), {
    method: 'POST',
    headers: { ...upstreamHeaders(target), 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(target, body)),
  })
}

async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { error: { message: text || `上游返回 HTTP ${response.status}` } }
  }
}

async function* streamFromResponse(response: Response): ByteStream {
  if (!response.body) throw new Error('上游没有返回流')
  const decoder = new TextDecoder()
  let buffer = ''
  const checkError = (raw: string): void => {
    const frame = parseSseFrame(raw)
    if (!frame || frame.data === '[DONE]') return
    let data: any
    try { data = JSON.parse(frame.data) } catch { return }
    const error = data?.error ?? (data?.type === 'response.failed' ? data.response?.error : undefined)
    if (error) throw new Error(typeof error === 'string' ? error : error.message || '上游流式请求失败')
  }
  for await (const chunk of response.body as unknown as ByteStream) {
    buffer += decoder.decode(chunk, { stream: true })
    const parsed = readSseFrameTexts(buffer)
    buffer = parsed.rest
    for (const raw of parsed.frames) checkError(raw)
    yield chunk
  }
  buffer += decoder.decode()
  if (buffer.trim()) {
    checkError(buffer)
    // Some compatible providers omit the final SSE separator at EOF.
    yield new TextEncoder().encode('\n\n')
  }
}

async function* translatedStream(target: RuntimeProtocolBridgeTarget, stream: ByteStream): AsyncGenerator<string> {
  if (target.runtime === 'claude-code') {
    const events = target.apiProtocol === 'openai-chat'
      ? openAiChatSseToAnthropicEvents(stream, targetFor(target))
      : openAiResponsesSseToAnthropicEvents(stream, targetFor(target))
    for await (const event of events) yield sseEvent(event.type, event.data)
    return
  }
  const events: AsyncIterable<CanonicalResponsesEvent> = target.apiProtocol === 'openai-chat'
    ? openAiChatSseToResponsesEvents(stream, targetFor(target))
    : anthropicMessagesSseToResponsesEvents(stream, targetFor(target))
  for await (const event of events) yield sseEvent(event.type, event.data)
}

/** Chat/Messages providers need a JSON wrapper for Codex freeform tools. */
function adaptCodexCustomTools(body: any): { body: any; custom: Map<string, string | undefined> } {
  const custom = new Map<string, string | undefined>()
  const tools = (items: any[], namespace?: string): any[] => items.map(tool => {
    if (tool.type === 'namespace') return { ...tool, tools: tools(tool.tools ?? [], tool.name) }
    if (tool.type !== 'custom') return tool
    custom.set(tool.name, namespace)
    return {
      type: 'function', name: tool.name,
      description: `${tool.description}\nPass the complete freeform tool input as the input string.`,
      parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false },
    }
  })
  const input = Array.isArray(body.input) ? body.input.map((item: any) => {
    if (item.type === 'additional_tools') return { ...item, tools: tools(item.tools ?? []) }
    if (item.type === 'custom_tool_call') return { ...item, type: 'function_call', arguments: JSON.stringify({ input: item.input ?? '' }) }
    if (item.type === 'custom_tool_call_output') return { ...item, type: 'function_call_output' }
    return item
  }) : body.input
  return { body: { ...body, input, ...(body.tools ? { tools: tools(body.tools) } : {}) }, custom }
}

function restoreCodexCustomTool(item: any, custom: Map<string, string | undefined>): any {
  if (item?.type !== 'function_call' || !custom.has(item.name)) return item
  let input = ''
  try { input = JSON.parse(item.arguments || '{}').input ?? '' } catch { /* added item has no arguments yet */ }
  const { arguments: _arguments, ...rest } = item
  return { ...rest, type: 'custom_tool_call', input, ...(custom.get(item.name) ? { namespace: custom.get(item.name) } : {}) }
}

async function* codexCustomToolStream(target: RuntimeProtocolBridgeTarget, stream: ByteStream, custom: Map<string, string | undefined>): AsyncGenerator<string> {
  const events = target.apiProtocol === 'openai-chat'
    ? openAiChatSseToResponsesEvents(stream, targetFor(target))
    : anthropicMessagesSseToResponsesEvents(stream, targetFor(target))
  const customIds = new Set<string>()
  const convert = (item: any) => {
    const converted = restoreCodexCustomTool(item, custom)
    if (converted !== item) customIds.add(item.id)
    return converted
  }
  for await (const event of events) {
    if (event.type === 'response.function_call_arguments.delta' && customIds.has(String(event.data.item_id))) continue
    const response = event.data.response as any
    const data = {
      ...event.data,
      ...(event.data.item ? { item: convert(event.data.item) } : {}),
      ...(response ? { response: { ...response, output: response.output?.map(convert) } } : {}),
    }
    yield sseEvent(event.type, data)
  }
}

async function handleTarget(target: RuntimeProtocolBridgeTarget, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const originalBody = await readBody(req)
  const adapted = target.runtime === 'codex' ? adaptCodexCustomTools(originalBody) : undefined
  const body = adapted?.body ?? originalBody
  const response = await upstream(target, body)
  if (!response.ok) {
    json(res, response.status, await readJsonResponse(response))
    return
  }
  if (!body?.stream) {
    const converted = responseBody(target, await readJsonResponse(response))
    if (adapted?.custom.size && Array.isArray(converted.output)) {
      converted.output = converted.output.map((item: any) => restoreCodexCustomTool(item, adapted.custom))
    }
    json(res, response.status, converted)
    return
  }
  res.statusCode = response.status
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('connection', 'keep-alive')
  try {
    const chunks = adapted?.custom.size
      ? codexCustomToolStream(target, streamFromResponse(response), adapted.custom)
      : translatedStream(target, streamFromResponse(response))
    for await (const chunk of chunks) {
      if (!res.destroyed) res.write(chunk)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!res.destroyed) {
      res.write(target.runtime === 'claude-code'
        ? sseEvent('error', { type: 'error', error: { type: 'api_error', message } })
        : sseEvent('response.failed', {
            type: 'response.failed',
            response: { id: `resp_bridge_${Date.now()}`, object: 'response', status: 'failed', error: { code: 'server_error', message } },
          }))
    }
  }
  if (!res.destroyed) res.end()
}

class RuntimeProtocolBridge {
  private server?: Server
  private port?: number
  private readonly targets = new Map<string, RuntimeProtocolBridgeTarget>()

  async register(input: RuntimeProtocolBridgeTarget): Promise<RegisteredRuntimeProtocolBridgeTarget> {
    await this.ensureServer()
    const token = `rt_${randomBytes(24).toString('base64url')}`
    const childApiKey = `tagent_${token}`
    this.targets.set(token, input)
    return {
      token,
      baseUrl: `http://127.0.0.1:${this.port}/runtime/${token}`,
      apiKey: childApiKey,
      release: () => this.targets.delete(token),
    }
  }

  private async ensureServer(): Promise<void> {
    if (this.server && this.port) return
    this.server = createServer(async (req, res) => {
      try {
        if (req.method !== 'POST') {
          json(res, 405, { error: { message: '协议桥只接受 POST' } })
          return
        }
        const match = /^\/runtime\/([^/]+)(?:\/.*)?$/.exec(req.url || '')
        const token = match?.[1]
        const target = token ? this.targets.get(token) : undefined
        const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '')
        if (!target || supplied !== `tagent_${token}`) {
          json(res, 401, { error: { message: '协议桥认证失败' } })
          return
        }
        await handleTarget(target, req, res)
      } catch (error) {
        if (!res.headersSent) json(res, 502, { error: { message: error instanceof Error ? error.message : String(error) } })
        else res.destroy(error instanceof Error ? error : undefined)
      }
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('协议桥未能取得本地端口')
    this.port = address.port
  }

  close(): void {
    this.targets.clear()
    this.server?.close()
    this.server = undefined
    this.port = undefined
  }
}

export const runtimeProtocolBridge = new RuntimeProtocolBridge()

export async function registerRuntimeProtocolBridgeTarget(
  input: RuntimeProtocolBridgeTarget,
): Promise<RegisteredRuntimeProtocolBridgeTarget> {
  return runtimeProtocolBridge.register(input)
}
