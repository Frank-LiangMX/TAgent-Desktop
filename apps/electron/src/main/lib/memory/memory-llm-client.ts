/**
 * 记忆子系统通用 LLM 客户端
 *
 * - completeMemoryLlm：优先外部渠道 chat；无外部渠道时回退 kscc 内网 Flash
 * - embedTexts：兼容 OpenAI /embeddings 与 Anthropic 协议渠道的常见网关形态
 *
 * 说明：官方 Anthropic Messages API 本身没有 embedding 端点；
 * 但大量「Anthropic 协议」渠道（anthropic-compatible / deepseek / kimi / minimax / xiaomi /
 * zhipu-coding / qwen-anthropic 等）在同一账号下常另有 OpenAI 兼容 embeddings，
 * 或把 baseUrl 里的 /anthropic 换成 /v1 即可。本文件会多路径探测。
 */
import type { Channel, ProviderType } from '@tagent/shared'
import { listChannels, getDecryptedApiKey } from '../channel/channel-store'
import { resolveChannelDefaultModelId } from '@tagent/shared'

export class MemoryLlmError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MemoryLlmError'
  }
}

export interface MemoryLlmChannel {
  channel: Channel
  apiKey: string
  modelId: string
}

const KSCC_MEMORY_MODEL_ID = 'deepseek-v4-flash'

/** Anthropic 协议族（chat 走 anthropic-messages，embedding 需另探 OpenAI 兼容口） */
const ANTHROPIC_PROTOCOL_PROVIDERS = new Set<string>([
  'anthropic',
  'anthropic-compatible',
  'deepseek',
  'kimi-api',
  'kimi-coding',
  'zhipu-coding',
  'minimax',
  'qwen-anthropic',
  'xiaomi',
  'xiaomi-token-plan',
])

/** 选一个可用外部渠道；无则抛 MemoryLlmError */
export function resolveMemoryLlmChannel(): MemoryLlmChannel {
  const channels = listChannels().filter((c) => c.enabled && c.provider !== 'kscc-internal')
  for (const channel of channels) {
    const apiKey = getDecryptedApiKey(channel.id)
    if (!apiKey) continue
    const modelId =
      resolveChannelDefaultModelId(channel) ||
      channel.models.find((m) => m.enabled)?.id ||
      channel.models[0]?.id
    if (!modelId) continue
    return { channel, apiKey, modelId }
  }
  throw new MemoryLlmError('NO_CHANNEL', '无可用外部渠道（需 enabled + apiKey，非 kscc）')
}

/**
 * 内网渠道不需要 API Key。自动记忆不能因为用户只配置了 kscc 而完全失效，
 * 因此在没有可用外部渠道时，用已启用的 kscc 渠道跑轻量 Flash 整理。
 */
async function completeWithKsccMemoryLlm(opts: {
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
}): Promise<string> {
  const channel = listChannels().find((candidate) =>
    candidate.enabled && candidate.provider === 'kscc-internal',
  )
  if (!channel) {
    throw new MemoryLlmError('NO_CHANNEL', '无可用记忆模型（请启用外部渠道或 kscc 内网渠道）')
  }

  const { resolveKsccPath } = await import('../adapters/claude/kscc-path')
  const ksccPath = resolveKsccPath()
  if (!ksccPath) {
    throw new MemoryLlmError('KSCC_UNAVAILABLE', '未检测到 kscc 命令，无法执行自动记忆整理')
  }

  const modelId = channel.models.some((model) => model.id === KSCC_MEMORY_MODEL_ID && model.enabled)
    ? KSCC_MEMORY_MODEL_ID
    : resolveChannelDefaultModelId(channel) || channel.models.find((model) => model.enabled)?.id
  if (!modelId) {
    throw new MemoryLlmError('NO_MODEL', 'kscc 内网渠道没有可用模型，无法执行自动记忆整理')
  }

  const { createKsccSeatRunner } = await import('@tagent/pi-core')
  const result = await createKsccSeatRunner({ ksccPath }).runSeat({
    modelId,
    prompt: opts.userPrompt,
    systemPrompt: opts.systemPrompt,
    signal: opts.signal,
    timeoutMs: 120_000,
  })
  console.log(`[memory-llm] completed via kscc model=${modelId}`)
  return result
}

/**
 * 非流式完成：累积 streamSSE content 返回全文。
 * Anthropic / OpenAI 协议均走 @tagent/core getAdapter。
 */
export async function completeMemoryLlm(opts: {
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
}): Promise<string> {
  let resolved: MemoryLlmChannel
  try {
    resolved = resolveMemoryLlmChannel()
  } catch (error) {
    if (error instanceof MemoryLlmError && error.code === 'NO_CHANNEL') {
      return completeWithKsccMemoryLlm(opts)
    }
    throw error
  }
  const { channel, apiKey, modelId } = resolved
  const { getAdapter, streamSSE, getTAgentUserAgent } = await import('@tagent/core')

  let adapter
  try {
    adapter = getAdapter(channel.provider as ProviderType)
  } catch {
    throw new MemoryLlmError('UNSUPPORTED_PROVIDER', `供应商不支持 SSE: ${channel.provider}`)
  }

  const request = adapter.buildStreamRequest({
    baseUrl: channel.baseUrl || '',
    apiKey,
    modelId,
    history: [],
    userMessage: opts.userPrompt,
    systemMessage: opts.systemPrompt,
    readImageAttachments: () => [],
  })
  request.headers['User-Agent'] = getTAgentUserAgent()

  const result = await streamSSE({
    request,
    adapter,
    onEvent: () => {},
    signal: opts.signal,
  })
  return (result.content ?? '').trim()
}

/** 去掉尾部斜杠 */
function stripSlash(u: string): string {
  return u.replace(/\/+$/, '')
}

/**
 * 从 chat baseUrl 推导候选 embedding 根路径。
 * Anthropic 协议常见：.../anthropic → 试 .../v1、.../openai/v1、父路径 /v1
 */
export function buildEmbeddingBaseCandidates(baseUrl: string, provider: string): string[] {
  const raw = stripSlash(baseUrl || '')
  const out: string[] = []
  const push = (u: string): void => {
    const s = stripSlash(u)
    if (s && !out.includes(s)) out.push(s)
  }

  if (!raw) {
    // 无 baseUrl 时按 provider 给默认
    if (provider === 'openai') push('https://api.openai.com/v1')
    if (provider === 'deepseek') push('https://api.deepseek.com/v1')
    if (provider === 'kimi-api' || provider === 'kimi-coding') {
      push('https://api.moonshot.cn/v1')
      push('https://api.moonshot.cn/anthropic')
    }
    if (provider === 'zhipu' || provider === 'zhipu-coding') {
      push('https://open.bigmodel.cn/api/paas/v4')
    }
    if (provider === 'minimax') {
      push('https://api.minimax.chat/v1')
    }
    return out
  }

  push(raw)

  // .../anthropic → 剥掉 anthropic 再挂 v1
  if (/\/anthropic$/i.test(raw)) {
    const root = raw.replace(/\/anthropic$/i, '')
    push(`${root}/v1`)
    push(`${root}/openai/v1`)
    push(root)
  }

  // .../coding/v1 等保持；再试同级 openai
  if (!/\/v1$/i.test(raw) && !/\/v4$/i.test(raw)) {
    push(`${raw}/v1`)
  }

  // 已是 /v1 则额外试 embeddings 直接挂在 raw（调用时拼路径）
  return out
}

/** 候选 embedding 模型（按 provider 优先序） */
export function embeddingModelsForProvider(provider: string): string[] {
  switch (provider) {
    case 'openai':
    case 'custom':
    case 'anthropic-compatible':
      return ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002']
    case 'deepseek':
      // DeepSeek 官方 embedding 模型名；网关可能映射成 openai 名
      return ['deepseek-embedding', 'text-embedding-3-small', 'embedding-2']
    case 'kimi-api':
    case 'kimi-coding':
      return ['moonshot-v1-embedding', 'text-embedding-3-small']
    case 'zhipu':
    case 'zhipu-coding':
      return ['embedding-3', 'embedding-2', 'text-embedding-3-small']
    case 'qwen':
    case 'qwen-anthropic':
      return ['text-embedding-v3', 'text-embedding-v2', 'text-embedding-3-small']
    case 'doubao':
      return ['doubao-embedding', 'text-embedding-3-small']
    case 'minimax':
      return ['embo-01', 'text-embedding-3-small']
    case 'xiaomi':
    case 'xiaomi-token-plan':
      return ['text-embedding-3-small', 'embedding']
    case 'anthropic':
      // 官方无 embedding；仍列出 openai 名，便于代理把 anthropic key 转去兼容端
      return ['text-embedding-3-small']
    default:
      return ['text-embedding-3-small', 'embedding-2', 'embedding']
  }
}

/** 一组鉴权头：Bearer + Anthropic x-api-key（网关两种都见） */
function buildAuthHeaderVariants(apiKey: string): Array<Record<string, string>> {
  return [
    {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
  ]
}

function parseEmbeddingResponse(json: unknown, expected: number): number[][] | null {
  if (!json || typeof json !== 'object') return null
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const sorted = [...data].sort(
    (a, b) =>
      Number((a as { index?: number }).index ?? 0) -
      Number((b as { index?: number }).index ?? 0),
  )
  const vectors = sorted
    .map((d) => (d as { embedding?: number[] }).embedding)
    .filter((e): e is number[] => Array.isArray(e) && e.length > 0)
  return vectors.length === expected ? vectors : null
}

/**
 * embedding：兼容
 * 1) OpenAI 协议：POST {base}/embeddings 或 {base}/v1/embeddings
 * 2) Anthropic 协议渠道：同一 key 下探测剥掉 /anthropic 后的 OpenAI 兼容口
 * 3) 鉴权：Bearer 与 x-api-key 双试
 *
 * 全部失败返回 null（调用方跳过向量路径，L4 FTS 仍可用）。
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return []
  try {
    const { channel, apiKey } = resolveMemoryLlmChannel()
    const provider = channel.provider
    if (provider === 'kscc-internal') return null

    const bases = buildEmbeddingBaseCandidates(channel.baseUrl || '', provider)
    if (bases.length === 0) return null

    const models = embeddingModelsForProvider(provider)
    const inputs = texts.map((t) => t.slice(0, 8000))
    const headerVariants = buildAuthHeaderVariants(apiKey)

    // 路径后缀：base 已含 /v1 时用 /embeddings；否则 /v1/embeddings 与 /embeddings 都试
    const pathSuffixesFor = (base: string): string[] => {
      if (/\/v1$/i.test(base) || /\/v4$/i.test(base)) return ['/embeddings']
      return ['/v1/embeddings', '/embeddings']
    }

    for (const base of bases) {
      for (const path of pathSuffixesFor(base)) {
        const url = `${base}${path}`
        for (const model of models) {
          for (const headers of headerVariants) {
            try {
              const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model, input: inputs }),
              })
              if (!res.ok) continue
              const json: unknown = await res.json()
              const vectors = parseEmbeddingResponse(json, texts.length)
              if (vectors) {
                if (ANTHROPIC_PROTOCOL_PROVIDERS.has(provider)) {
                  console.log(
                    `[memory-llm] embedding ok via anthropic-protocol channel provider=${provider} url=${url} model=${model}`,
                  )
                }
                return vectors
              }
            } catch {
              /* try next */
            }
          }
        }
      }
    }

    console.warn(
      `[memory-llm] embedTexts: no working endpoint for provider=${provider} bases=${bases.join(',')}`,
    )
    return null
  } catch (e) {
    console.warn('[memory-llm] embedTexts failed:', e)
    return null
  }
}
