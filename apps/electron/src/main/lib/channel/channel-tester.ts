import type {
  Channel,
  ChannelModel,
  ChannelTestResult,
  ChannelModelValidateInput,
  FetchModelsInput,
  FetchModelsResult,
  ModelSpeedTestResult,
  ChannelApiProtocol,
  ProviderType,
} from '@tagent/shared'
import {
  resolveChannelCustomHeaders,
  resolveChannelRequestHeaders,
} from '@tagent/shared'

const ANTHROPIC_PROTOCOL_PROVIDERS = new Set<ProviderType>([
  'anthropic',
  'anthropic-compatible',
  'deepseek',
  'kimi-api',
  'kimi-coding',
  'zhipu-coding',
  'minimax',
  'xiaomi',
  'xiaomi-token-plan',
  'qwen-anthropic',
])

const OPENAI_COMPATIBLE_PROVIDERS = new Set<ProviderType>([
  'openai',
  'zhipu',
  'doubao',
  'qwen',
  'custom',
])

function isAnthropicProtocol(provider: ProviderType): boolean {
  return ANTHROPIC_PROTOCOL_PROVIDERS.has(provider)
}

function isOpenAICompatible(provider: ProviderType): boolean {
  return OPENAI_COMPATIBLE_PROVIDERS.has(provider)
}

function isGoogle(provider: ProviderType): boolean {
  return provider === 'google'
}

function protocolFor(
  provider: ProviderType,
  explicit?: ChannelApiProtocol,
): ChannelApiProtocol | 'google' | null {
  if (explicit) return explicit
  if (isAnthropicProtocol(provider)) return 'anthropic-messages'
  if (isOpenAICompatible(provider)) return 'openai-chat'
  if (isGoogle(provider)) return 'google'
  return null
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * Google generateContent 探测 URL。
 * 与 packages/core google-adapter 对齐：`{base}/v1beta/models/{model}:generateContent`。
 * base 已带 /v1beta 或 /v1 时不再重复追加。
 */
function buildGoogleGenerateContentUrl(baseUrl: string, modelId: string): string {
  const url = normalizeBaseUrl(baseUrl)
  const model = modelId.replace(/^models\//, '') || 'gemini-2.0-flash'
  if (/\/v1beta$/i.test(url) || /\/v1$/i.test(url)) {
    return `${url}/models/${model}:generateContent`
  }
  return `${url}/v1beta/models/${model}:generateContent`
}

function buildTestUrl(
  baseUrl: string,
  provider: ProviderType,
  modelId?: string,
  apiProtocol?: ChannelApiProtocol,
): string | null {
  const url = normalizeBaseUrl(baseUrl)
  if (!url) return null
  const protocol = protocolFor(provider, apiProtocol)
  if (protocol === 'anthropic-messages') {
    return /\/v1$/i.test(url) ? `${url}/messages` : `${url}/v1/messages`
  }
  if (protocol === 'openai-responses') return `${url}/responses`
  if (protocol === 'openai-chat') return `${url}/chat/completions`
  if (protocol === 'google') {
    return buildGoogleGenerateContentUrl(url, modelId ?? 'gemini-2.0-flash')
  }
  return null
}

function buildModelsUrl(
  baseUrl: string,
  provider: ProviderType,
  apiProtocol?: ChannelApiProtocol,
): string | null {
  const url = normalizeBaseUrl(baseUrl)
  if (!url) return null
  const protocol = protocolFor(provider, apiProtocol)
  if (protocol === 'anthropic-messages') {
    return /\/v1$/i.test(url) ? `${url}/models` : `${url}/v1/models`
  }
  if (protocol === 'openai-responses' || protocol === 'openai-chat') return `${url}/models`
  if (protocol === 'google') return `${url}/models`
  return null
}

function buildHeaders(
  apiKey: string,
  provider: ProviderType,
  apiProtocol?: ChannelApiProtocol,
): Record<string, string> {
  const protocol = protocolFor(provider, apiProtocol)
  if (protocol === 'google') {
    return { 'Content-Type': 'application/json' }
  }
  if (protocol === 'anthropic-messages') {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
      // 网关渠道必须带 Bearer（单发 x-api-key 会被网关拒为 ApiKeyForbidden）
      ...resolveChannelRequestHeaders(provider, apiKey),
    }
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...resolveChannelCustomHeaders(provider),
  }
}

function pickTestModel(channel: Channel): string | undefined {
  if (channel.defaultModelId) return channel.defaultModelId
  const enabled = channel.models.filter((m) => m.enabled)
  const m0 = enabled[0] ?? channel.models[0]
  if (m0) return m0.id
  return undefined
}

function buildTestBody(
  modelId: string | undefined,
  provider: ProviderType,
  apiProtocol?: ChannelApiProtocol,
): unknown {
  const model = modelId ?? 'test'
  const protocol = protocolFor(provider, apiProtocol)
  if (protocol === 'anthropic-messages') {
    return {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }
  }
  if (protocol === 'openai-chat') {
    return {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }
  }
  if (protocol === 'openai-responses') {
    return {
      model,
      max_output_tokens: 64,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: false,
    }
  }
  if (protocol === 'google') {
    // 最小 generateContent 探测：与 google-adapter TitleRequest 同形
    return {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 1 },
    }
  }
  return null
}

function parseAnthropicModelsResponse(body: unknown): ChannelModel[] {
  if (!body || typeof body !== 'object') return []
  const data = (body as Record<string, unknown>).data
  if (!Array.isArray(data)) return []
  return data
    .map((item: unknown) => {
      if (!item || typeof item !== 'object') return null
      const rec = item as Record<string, unknown>
      const id = String(rec.id ?? '')
      if (!id) return null
      return { id, name: String(rec.display_name ?? id), enabled: true }
    })
    .filter((m): m is ChannelModel => m !== null)
}

function parseOpenAIModelsResponse(body: unknown): ChannelModel[] {
  if (!body || typeof body !== 'object') return []
  const data = (body as Record<string, unknown>).data
  if (!Array.isArray(data)) return []
  return data
    .map((item: unknown) => {
      if (!item || typeof item !== 'object') return null
      const rec = item as Record<string, unknown>
      const id = String(rec.id ?? '')
      if (!id) return null
      return { id, name: String(rec.id ?? id), enabled: true }
    })
    .filter((m): m is ChannelModel => m !== null)
}

function parseGoogleModelsResponse(body: unknown): ChannelModel[] {
  if (!body || typeof body !== 'object') return []
  const models = (body as Record<string, unknown>).models
  if (!Array.isArray(models)) return []
  return models
    .map((item: unknown) => {
      if (!item || typeof item !== 'object') return null
      const rec = item as Record<string, unknown>
      const fullName = String(rec.name ?? '')
      const id = fullName.replace(/^models\//, '')
      if (!id) return null
      return { id, name: String(rec.displayName ?? id), enabled: true }
    })
    .filter((m): m is ChannelModel => m !== null)
}

export async function testChannelConnection(
  channel: Channel,
  decryptedApiKey: string,
): Promise<ChannelTestResult> {
  if (channel.provider === 'codex-internal') {
    const { resolveCodexRuntimeAsync } = await import(
      '../adapters/codex/codex-runtime-resolver'
    )
    const runtime = await resolveCodexRuntimeAsync()
    return runtime.available
      ? {
          success: true,
          message: `Codex App Server 就绪：${runtime.version ?? 'unknown'}`,
        }
      : {
          success: false,
          message:
            runtime.diagnostics[0]?.reason ??
            '未检测到支持 App Server 的 Codex Runtime',
        }
  }
  if (channel.provider === 'kscc-internal') {
    return {
      success: false,
      message: '该渠道已停用（历史 kscc CLI 通路已移除），请改用内置网关渠道',
    }
  }

  if (!decryptedApiKey) {
    return { success: false, message: 'API Key 未设置' }
  }

  const modelId = pickTestModel(channel)
  const url = buildTestUrl(channel.baseUrl, channel.provider, modelId, channel.apiProtocol)
  if (!url) {
    return { success: false, message: `不支持的 Provider 类型: ${channel.provider}` }
  }

  const headers = buildHeaders(decryptedApiKey, channel.provider, channel.apiProtocol)
  const body = buildTestBody(modelId, channel.provider, channel.apiProtocol)
  // Google 鉴权走 query key；其余走 header
  const requestUrl = protocolFor(channel.provider, channel.apiProtocol) === 'google'
    ? `${url}?key=${encodeURIComponent(decryptedApiKey)}`
    : url

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    const resp = await fetch(requestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (resp.ok) {
      return { success: true, message: `连接成功（${resp.status}）` }
    }

    // 400/404：服务可达但模型/请求体问题（与 OpenAI/Anthropic 探测一致）
    if (resp.status === 400 || resp.status === 404) {
      const errText = await resp.text().catch(() => '')
      let msg = `模型不可用（${resp.status}）`
      if (errText) msg += `: ${errText.slice(0, 200)}`
      msg += '。连接本身正常，建议检查模型列表。'
      return { success: true, message: msg }
    }

    const errText = await resp.text().catch(() => '')
    return {
      success: false,
      message: `连接失败（${resp.status}）${errText ? `: ${errText.slice(0, 200)}` : ''}`,
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { success: false, message: '连接超时（15 秒）' }
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('EAI_AGAIN')) {
      return { success: false, message: `无法连接到服务器：${msg}` }
    }
    return { success: false, message: `连接异常：${msg}` }
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchModelsFromProvider(
  input: FetchModelsInput,
): Promise<FetchModelsResult> {
  const { provider, baseUrl, apiKey } = input

  if (!apiKey) {
    return { success: false, message: 'API Key 为空', models: [] }
  }

  const url = buildModelsUrl(baseUrl, provider, input.apiProtocol)
  if (!url) {
    return { success: false, message: '不支持的 Provider 类型', models: [] }
  }

  const headers = protocolFor(provider, input.apiProtocol) === 'google'
    ? {}
    : buildHeaders(apiKey, provider, input.apiProtocol)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    let resp: Response
    if (protocolFor(provider, input.apiProtocol) === 'google') {
      resp = await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      })
    } else {
      resp = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return {
        success: false,
        message: `拉取模型列表失败（${resp.status}）${text ? `: ${text.slice(0, 200)}` : ''}`,
        models: [],
      }
    }

    const body = await resp.json().catch(() => null)
    if (!body) {
      return { success: false, message: '响应不是有效 JSON', models: [] }
    }

    let models: ChannelModel[]
    const protocol = protocolFor(provider, input.apiProtocol)
    if (protocol === 'anthropic-messages') {
      models = parseAnthropicModelsResponse(body)
    } else if (protocol === 'openai-chat' || protocol === 'openai-responses') {
      models = parseOpenAIModelsResponse(body)
    } else if (isGoogle(provider)) {
      models = parseGoogleModelsResponse(body)
    } else {
      models = parseOpenAIModelsResponse(body)
    }

    if (models.length === 0) {
      return { success: false, message: '未解析到模型列表', models: [] }
    }

    const { getDefaultModelsForProvider } = await import('./default-models')
    const defaults = getDefaultModelsForProvider(provider)
    const defaultModelId = models[0]?.id ?? defaults[0]?.id

    return {
      success: true,
      message: `成功拉取 ${models.length} 个模型`,
      models,
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { success: false, message: '请求超时（15 秒）', models: [] }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, message: `拉取失败：${msg}`, models: [] }
  } finally {
    clearTimeout(timeout)
  }
}

export async function validateChannelModel(
  input: ChannelModelValidateInput,
): Promise<ChannelTestResult> {
  const result = await testChannelConnection(
    {
      id: 'direct-validation',
      name: 'Direct validation',
      provider: input.provider,
      apiProtocol: input.apiProtocol,
      baseUrl: input.baseUrl,
      apiKey: '',
      models: [{ id: input.model, name: input.model, enabled: true }],
      defaultModelId: input.model,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    input.apiKey,
  )
  // Connection probing treats 400/404 as reachable, but model validation must
  // report those statuses as a rejected model rather than a successful check.
  if (result.success && result.message.startsWith('模型不可用')) {
    return { success: false, message: result.message }
  }
  return result
}

export async function speedTestChannel(
  channel: Channel,
  decryptedApiKey: string,
  modelId: string,
): Promise<ModelSpeedTestResult> {
  const startedAt = Date.now()
  const resultBase = { channelId: channel.id, modelId }
  if (!decryptedApiKey) {
    return { ...resultBase, success: false, ttfbMs: null, totalTimeMs: null, message: 'API Key 未设置' }
  }
  const url = buildTestUrl(channel.baseUrl, channel.provider, modelId, channel.apiProtocol)
  if (!url) {
    return { ...resultBase, success: false, ttfbMs: null, totalTimeMs: null, message: '不支持的 Provider 类型' }
  }
  const protocol = protocolFor(channel.provider, channel.apiProtocol)
  const requestUrl = protocol === 'google' ? `${url}?key=${encodeURIComponent(decryptedApiKey)}` : url
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const resp = await fetch(requestUrl, {
      method: 'POST',
      headers: buildHeaders(decryptedApiKey, channel.provider, channel.apiProtocol),
      body: JSON.stringify(buildTestBody(modelId, channel.provider, channel.apiProtocol)),
      signal: controller.signal,
    })
    const ttfbMs = Date.now() - startedAt
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return { ...resultBase, success: false, ttfbMs, totalTimeMs: Date.now() - startedAt, message: `测速失败（${resp.status}）${text ? `: ${text.slice(0, 200)}` : ''}` }
    }
    await resp.arrayBuffer().catch(() => undefined)
    return { ...resultBase, success: true, ttfbMs, totalTimeMs: Date.now() - startedAt, message: '测速成功' }
  } catch (err) {
    const message = (err as Error).name === 'AbortError' ? '请求超时（15 秒）' : `测速异常：${err instanceof Error ? err.message : String(err)}`
    return { ...resultBase, success: false, ttfbMs: null, totalTimeMs: null, message }
  } finally {
    clearTimeout(timeout)
  }
}
