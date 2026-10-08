/**
 * One-shot live worker for main-line runtime acceptance.
 *
 * Input: one JSON object on stdin:
 * { runtime: 'pi'|'codex'|'claude-code', model, connection,
 *   configRoot, cwd }
 *
 * The caller supplies decrypted connection material. This worker never reads
 * user configuration and never chooses a real gateway. Its stdout is exactly
 * one redacted JSON result; diagnostics, model output, URLs, keys and stderr
 * are not printed.
 */
import { randomUUID } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'

type Runtime = 'pi' | 'codex' | 'claude-code'
type Connection = {
  channelId: string
  baseUrl: string
  apiKey: string
  contextWindow?: number
}
type Input = {
  runtime: Runtime
  model: string
  connection: Connection
  configRoot: string
  cwd: string
}

type Adapter = {
  query(input: Record<string, unknown>): AsyncIterable<unknown>
  abort(sessionId: string): void
  dispose(): void
}

const SESSION_ID = 'official-runtime-live-worker'
const MAX_TURN_MS = 60_000
const MAX_TOTAL_MS = 180_000
const RESULT_PREFIX = 'LIVE_RESULT '

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function readStdinOnce(): Promise<unknown> {
  let input = ''
  for await (const chunk of process.stdin) input += String(chunk)
  return JSON.parse(input)
}

export function validateInput(value: unknown): Input {
  if (!isRecord(value)) throw new Error('input must be an object')
  const runtime = value.runtime
  const model = value.model
  const connection = value.connection
  const configRoot = value.configRoot
  const cwd = value.cwd
  if (runtime !== 'pi' && runtime !== 'codex' && runtime !== 'claude-code') {
    throw new Error('runtime must be pi, codex, or claude-code')
  }
  if (typeof model !== 'string' || !model.trim()) throw new Error('model is required')
  if (!isRecord(connection)) throw new Error('connection is required')
  for (const key of ['channelId', 'baseUrl', 'apiKey']) {
    if (typeof connection[key] !== 'string' || !connection[key]) throw new Error(`${key} is required`)
  }
  if (typeof configRoot !== 'string' || !configRoot.trim()) throw new Error('configRoot is required')
  if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd is required')
  const root = dirname(resolve(configRoot))
  if (!basename(root).startsWith('tagent-api-live-') || resolve(configRoot) !== resolve(root, 'config') || resolve(cwd) !== resolve(root, 'workspace')) {
    throw new Error('isolated launcher-owned config/workspace required')
  }
  return {
    runtime,
    model: model.trim(),
    connection: {
      channelId: connection.channelId as string,
      baseUrl: connection.baseUrl as string,
      apiKey: connection.apiKey as string,
      ...(typeof connection.contextWindow === 'number' ? { contextWindow: connection.contextWindow } : {}),
    },
    configRoot,
    cwd,
  }
}

function errorInfo(error: unknown): { errorType: string; httpStatus?: number } {
  const message = error instanceof Error ? error.message : String(error)
  const status = message.match(/\bHTTP\s+(\d{3})\b|\bstatus(?:Code)?[=: ]+(\d{3})\b/i)
  const errorType = /timeout|timed out|aborted/i.test(message)
    ? 'timeout'
    : /auth|unauthorized|forbidden|api key|401|403/i.test(message)
      ? 'authentication'
      : /network|connect|dns|enotfound|econnrefused|eai_again/i.test(message)
        ? 'network'
        : 'runtime'
  return {
    errorType,
    ...(status ? { httpStatus: Number(status[1] ?? status[2]) } : {}),
  }
}

function baseResult(input: Input, startedAt: number): Record<string, unknown> {
  return {
    ok: false,
    runtime: input.runtime,
    modelConfigured: Boolean(input.model),
    connectionConfigured: Boolean(input.connection.channelId && input.connection.baseUrl && input.connection.apiKey),
    readOnly: true,
    toolPolicy: input.runtime === 'pi' ? 'http-stream-no-tools' : input.runtime === 'codex' ? 'read-only-sandbox-no-dynamic-tools' : 'host-deny-requested-tools',
    markerVerified: false,
    nativeIdPresent: false,
    elapsedMs: Date.now() - startedAt,
  }
}

export async function runTurn(
  adapter: Adapter,
  queryInput: Record<string, unknown>,
  expectedMarker: string,
  deadlineAt: number,
): Promise<{ nativeId?: string; markerSeen: boolean; resultSeen: boolean }> {
  const sessionId = String(queryInput.sessionId)
  const controller = new AbortController()
  const remaining = Math.min(MAX_TURN_MS, Math.max(1, deadlineAt - Date.now()))
  const timer = setTimeout(() => {
    controller.abort()
    adapter.abort(sessionId)
  }, remaining)
  let nativeId: string | undefined
  let markerSeen = false
  let resultSeen = false
  let text = ''
  try {
    const input = { ...queryInput, abortSignal: controller.signal }
    for await (const raw of adapter.query(input)) {
      const value = raw as Record<string, unknown>
      const candidate = value.session_id ?? value.sessionId
      if (typeof candidate === 'string' && candidate) nativeId = candidate
      text += extractAssistantText(value)
      markerSeen = text.includes(expectedMarker) && text.includes('NO_WRITE')
      if (value.type === 'result' || value.kind === 'result') {
        const subtype = value.subtype
        if ((subtype !== 'success' && subtype !== 'completed') || value.is_error === true || value.isError === true || value.error || (Array.isArray(value.errors) && value.errors.length)) {
          throw new Error(`runtime returned non-success result ${JSON.stringify(value.errors ?? value.error ?? subtype)}`)
        }
        resultSeen = true
        break
      }
      if (Date.now() >= deadlineAt) throw new Error('turn deadline exceeded')
    }
    return { ...(nativeId ? { nativeId } : {}), markerSeen, resultSeen }
  } finally {
    clearTimeout(timer)
  }
}

export function extractAssistantText(value: Record<string, unknown>): string {
  if (value.kind === 'stream_text_delta' && typeof value.text === 'string') return value.text
  const message = value.type === 'assistant' ? value.message : value.kind === 'sdk_message' && isRecord(value.message) && value.message.type === 'assistant' ? value.message : undefined
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  return message.content
    .filter((item) => isRecord(item) && item.type === 'text')
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .join('')
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  let input: Input | undefined
  let adapter: Adapter | undefined
  let resumedAdapter: Adapter | undefined
  const priorConfigRoot = process.env.TAGENT_CONFIG_DIR
  const consoleFns = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  Object.assign(console, { log: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined })
  const totalTimer = setTimeout(() => {
    adapter?.abort(SESSION_ID)
    resumedAdapter?.abort(SESSION_ID)
  }, MAX_TOTAL_MS)
  try {
    input = validateInput(await readStdinOnce())
    process.env.TAGENT_CONFIG_DIR = input.configRoot
    const marker = `LUNA-${randomUUID()}`
    const connection = input.connection
    const common = {
      sessionId: SESSION_ID,
      model: input.model,
      cwd: input.cwd,
      prompt: `Remember the project code ${marker} and the constraint code NO_WRITE, meaning never modify files. Do not use tools. Reply with both exact codes only.`,
    }
    const denyClaudeTools = async () => ({ behavior: 'deny' as const, message: 'live worker rejects all tools' })

    let first: { nativeId?: string; markerSeen: boolean; resultSeen: boolean }
    if (input.runtime === 'codex') {
      const mod = await import('../apps/electron/src/main/lib/adapters/codex/codex-app-server-adapter')
      adapter = new mod.CodexAppServerAdapter({ officialRuntimeHomeRoot: input.configRoot }) as unknown as Adapter
      let threadId: string | undefined
      first = await runTurn(adapter, {
        ...common,
        apiConnection: connection,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        dynamicTools: [],
        onThreadId: (id: string) => { threadId = id },
      }, marker, startedAt + MAX_TOTAL_MS)
      if (!threadId || !first.markerSeen || !first.resultSeen) throw new Error('Codex start did not verify marker/result/native id')
      adapter.dispose()
      adapter = undefined
      resumedAdapter = new mod.CodexAppServerAdapter({ officialRuntimeHomeRoot: input.configRoot }) as unknown as Adapter
      const resumed = await runTurn(resumedAdapter, {
        ...common,
        prompt: 'What project code and constraint code did I give you earlier? Reply with both exact codes only. Do not use tools.',
        apiConnection: connection,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        resumeThreadId: threadId,
        dynamicTools: [],
      }, marker, startedAt + MAX_TOTAL_MS)
      if (!resumed.markerSeen || !resumed.resultSeen) throw new Error('Codex resume did not verify prior marker/restriction/result')
    } else if (input.runtime === 'claude-code') {
      const mod = await import('../apps/electron/src/main/lib/adapters/claude/claude-agent-adapter')
      adapter = new mod.ClaudeAgentAdapter({ runtime: 'claude-code' }) as unknown as Adapter
      const claudeCommon = {
        ...common,
        runtime: 'claude-code',
        apiConnection: connection,
        sdkPermissionMode: 'default',
        allowDangerouslySkipPermissions: false,
        canUseTool: denyClaudeTools,
        systemPrompt: 'Return text only. Never use tools.',
        includePartialMessages: true,
        persistSession: true,
      }
      first = await runTurn(adapter, claudeCommon, marker, startedAt + MAX_TOTAL_MS)
      if (!first.nativeId || !first.markerSeen || !first.resultSeen) throw new Error('Claude start did not verify marker/result/native id')
      adapter.dispose()
      adapter = undefined
      resumedAdapter = new mod.ClaudeAgentAdapter({ runtime: 'claude-code' }) as unknown as Adapter
      const resumed = await runTurn(resumedAdapter, {
        ...claudeCommon,
        prompt: 'What project code and constraint code did I give you earlier? Reply with both exact codes only. Do not use tools.',
        resumeSessionId: first.nativeId,
      }, marker, startedAt + MAX_TOTAL_MS)
      if (!resumed.nativeId || !resumed.markerSeen || !resumed.resultSeen) throw new Error('Claude resume did not verify prior marker/restriction/result')
    } else {
      // Pi branch deliberately tests the real HTTP streamFn, not Pi's full
      // Agent loop. The second request carries the actual first assistant
      // message as context; this is explicit HTTP history, not native resume.
      const { createHttpDirectStreamFn } = await import('../packages/pi-core/src/http-direct-stream-fn')
      const streamFn = createHttpDirectStreamFn({
        provider: 'custom',
        apiProtocol: 'openai-chat',
        apiKey: connection.apiKey,
        baseUrl: connection.baseUrl,
        modelId: input.model,
        ...(connection.contextWindow !== undefined ? { contextWindow: connection.contextWindow } : {}),
      })
      const runPiHttp = async (messages: unknown[]): Promise<{ text: string; assistant: Record<string, unknown> }> => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Math.min(MAX_TURN_MS, Math.max(1, startedAt + MAX_TOTAL_MS - Date.now())))
        try {
          const stream = await Promise.resolve(streamFn(undefined as never, {
            systemPrompt: 'Return text only. Tool policy is read-only; all tools are denied.',
            messages,
            tools: [],
          } as never, { signal: controller.signal, timeoutMs: MAX_TURN_MS, maxRetries: 0 } as never))
          let text = ''
          let assistant: Record<string, unknown> | undefined
          let done = false
          for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
            if (event.type === 'text_delta' && typeof event.delta === 'string') text += event.delta
            if (event.type === 'done') { done = true; assistant = event.message as Record<string, unknown> }
            if (event.type === 'error') throw new Error(`Pi HTTP stream returned error ${JSON.stringify(event.error)}`)
          }
          if (!done || !assistant || !text.includes(marker) || !text.includes('NO_WRITE')) throw new Error('Pi assistant output/result verification failed')
          return { text, assistant }
        } finally {
          clearTimeout(timer)
        }
      }
      const firstPi = await runPiHttp([
        { role: 'user', content: common.prompt, timestamp: Date.now() },
      ])
      const resumedPi = await runPiHttp([
        { role: 'user', content: common.prompt, timestamp: Date.now() },
        firstPi.assistant,
        { role: 'user', content: 'What project code and constraint code did I give you earlier? Reply with both exact codes only. Do not use tools.', timestamp: Date.now() },
      ])
      if (!resumedPi.text.includes('NO_WRITE')) throw new Error('Pi did not verify prior tool restriction')
    }

    const result = baseResult(input, startedAt)
    result.ok = true
    result.markerVerified = true
    result.nativeIdPresent = input.runtime !== 'pi'
    result.resumeMode = input.runtime === 'pi' ? 'explicit-history-not-native-loop' : 'native'
    result.elapsedMs = Date.now() - startedAt
    process.stdout.write(RESULT_PREFIX + JSON.stringify(result) + '\n')
  } catch (error) {
    const result = baseResult(input ?? { runtime: 'pi', model: '', connection: { channelId: '', baseUrl: '', apiKey: '' }, configRoot: '', cwd: '' }, startedAt)
    Object.assign(result, errorInfo(error))
    process.stdout.write(RESULT_PREFIX + JSON.stringify(result) + '\n')
    process.exitCode = 1
  } finally {
    clearTimeout(totalTimer)
    adapter?.dispose()
    resumedAdapter?.dispose()
    if (priorConfigRoot === undefined) delete process.env.TAGENT_CONFIG_DIR
    else process.env.TAGENT_CONFIG_DIR = priorConfigRoot
    Object.assign(console, consoleFns)
  }
}

if (import.meta.main) void main()
