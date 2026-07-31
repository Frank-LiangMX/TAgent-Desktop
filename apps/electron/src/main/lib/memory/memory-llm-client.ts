/**
 * 记忆子系统通用 LLM 客户端（增强：consolidation / reflect / soft-reset 共用）
 *
 * 选渠道：第一个 enabled 且非 kscc-internal、有可解密 apiKey 的外部渠道。
 * 传输：@tagent/core getAdapter + streamSSE（与 General defaultExecutor 对齐）。
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
 * 非流式完成：累积 streamSSE content 返回全文。
 */
export async function completeMemoryLlm(opts: {
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
}): Promise<string> {
  const { channel, apiKey, modelId } = resolveMemoryLlmChannel()
  // 动态 import，避免主进程启动期拉全量 providers
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

/**
 * 简易 embedding：优先 OpenAI 兼容 /embeddings。
 * 无端点或失败时返回 null（调用方跳过向量路径）。
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return []
  try {
    const { channel, apiKey } = resolveMemoryLlmChannel()
    // 仅尝试 OpenAI 兼容类 provider
    const openAiLike = new Set([
      'openai',
      'deepseek',
      'doubao',
      'qwen',
      'zhipu',
      'custom',
      'minimax',
    ])
    if (!openAiLike.has(channel.provider) && !channel.baseUrl?.includes('openai')) {
      return null
    }
    const base = (channel.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
    const url = base.endsWith('/v1') ? `${base}/embeddings` : `${base}/v1/embeddings`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: texts.map((t) => t.slice(0, 8000)),
      }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>
    }
    if (!Array.isArray(json.data)) return null
    const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const vectors = sorted.map((d) => d.embedding).filter((e): e is number[] => Array.isArray(e))
    return vectors.length === texts.length ? vectors : null
  } catch {
    return null
  }
}
