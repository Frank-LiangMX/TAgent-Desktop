import type {
  Channel,
  ChannelModel,
  ChannelTestResult,
  FetchModelsInput,
  FetchModelsResult,
  ProviderType,
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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function buildTestUrl(baseUrl: string, provider: ProviderType): string | null {
  const url = normalizeBaseUrl(baseUrl)
  if (!url) return null
  if (isAnthropicProtocol(provider)) {
    return /\/v1$/i.test(url) ? `${url}/messages` : `${url}/v1/messages`
  }
  if (isOpenAICompatible(provider)) return `${url}/chat/completions`
  if (isGoogle(provider)) return `${url}/models`
  return null
}

function buildModelsUrl(baseUrl: string, provider: ProviderType): string | null {
  const url = normalizeBaseUrl(baseUrl)
  if (!url) return null
  if (isAnthropicProtocol(provider)) {
    return /\/v1$/i.test(url) ? `${url}/models` : `${url}/v1/models`
  }
  if (isOpenAICompatible(provider)) return `${url}/models`
  if (isGoogle(provider)) return `${url}/models`
  return null
}

function buildHeaders(apiKey: string, provider: ProviderType): Record<string, string> {
  if (isGoogle(provider)) {
    return { 'Content-Type': 'application/json' }
  }
  if (isAnthropicProtocol(provider)) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

function pickTestModel(channel: Channel): string | undefined {
  if (channel.defaultModelId) return channel.defaultModelId
  const enabled = channel.models.filter((m) => m.enabled)
  const m0 = enabled[0] ?? channel.models[0]
  if (m0) return m0.id
  return undefined
}

function buildTestBody(modelId: string | undefined, provider: ProviderType): unknown {
  const model = modelId ?? 'test'
  if (isAnthropicProtocol(provider)) {
    return {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }
  }
  if (isOpenAICompatible(provider)) {
    return {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }
  }
  if (isGoogle(provider)) {
    return null
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
  if (channel.provider === 'kscc-internal') {
    const { resolveKsccPath } = await import('../adapters/claude/kscc-path')
    const ksccPath = resolveKsccPath()
    if (!ksccPath) {
      return { success: false, message: '未检测到 kscc 命令，请先安装 kscc（内网渠道）' }
    }
    return { success: true, message: `kscc 就绪：${ksccPath}` }
  }

  if (!decryptedApiKey) {
    return { success: false, message: 'API Key 未设置' }
  }

  const url = buildTestUrl(channel.baseUrl, channel.provider)
  if (!url) {
    return { success: false, message: `不支持的 Provider 类型: ${channel.provider}` }
  }

  const modelId = pickTestModel(channel)
  const headers = buildHeaders(decryptedApiKey, channel.provider)
  const body = buildTestBody(modelId, channel.provider)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    if (isGoogle(channel.provider)) {
      const resp = await fetch(`${url}?key=${encodeURIComponent(decryptedApiKey)}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      })
      if (resp.ok) {
        return { success: true, message: `连接成功（${resp.status}）` }
      }
      const errText = await resp.text().catch(() => '')
      return {
        success: false,
        message: `连接失败（${resp.status}）${errText ? `: ${errText.slice(0, 200)}` : ''}`,
      }
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (resp.ok) {
      return { success: true, message: `连接成功（${resp.status}）` }
    }

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

  const url = buildModelsUrl(baseUrl, provider)
  if (!url) {
    return { success: false, message: '不支持的 Provider 类型', models: [] }
  }

  const headers = isGoogle(provider)
    ? {}
    : buildHeaders(apiKey, provider)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    let resp: Response
    if (isGoogle(provider)) {
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
    if (isAnthropicProtocol(provider)) {
      models = parseAnthropicModelsResponse(body)
    } else if (isOpenAICompatible(provider)) {
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
