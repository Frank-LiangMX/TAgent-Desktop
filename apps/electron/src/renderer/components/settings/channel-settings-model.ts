import {
  PROVIDER_DEFAULT_URLS,
  type Channel,
  type ChannelCreateInput,
  type ChannelModel,
  type ChannelUpdateInput,
  type ProviderType,
} from '@tagent/shared'

export interface ChannelDraft {
  name: string
  provider: ProviderType
  baseUrl: string
  apiKey: string
  models: ChannelModel[]
  defaultModelId: string
  enabled: boolean
}

export interface ChannelDraftValidation {
  valid: boolean
  errors: Partial<Record<'name' | 'baseUrl' | 'apiKey' | 'models', string>>
}

export const KSCC_PROVIDER: ProviderType = 'kscc-internal'

export function createChannelDraft(): ChannelDraft {
  return {
    name: '',
    provider: 'anthropic',
    baseUrl: PROVIDER_DEFAULT_URLS.anthropic,
    apiKey: '',
    models: [],
    defaultModelId: '',
    enabled: true,
  }
}

export function channelToDraft(channel: Channel): ChannelDraft {
  return {
    name: channel.name,
    provider: channel.provider,
    baseUrl: channel.baseUrl,
    apiKey: '',
    models: channel.models.map((model) => ({ ...model })),
    defaultModelId: channel.defaultModelId ?? '',
    enabled: channel.enabled,
  }
}

export function normalizeModels(
  models: ChannelModel[],
  defaultModelId = '',
): { models: ChannelModel[]; defaultModelId: string } {
  const seen = new Set<string>()
  const normalized = models.flatMap((model) => {
    const id = model.id.trim()
    if (!id || seen.has(id)) return []
    seen.add(id)
    return [{ id, name: model.name.trim() || id, enabled: model.enabled }]
  })
  const enabled = normalized.filter((model) => model.enabled)
  const validDefault = enabled.some((model) => model.id === defaultModelId)
  return {
    models: normalized,
    defaultModelId: validDefault ? defaultModelId : (enabled[0]?.id ?? ''),
  }
}

export function mergeFetchedModels(
  current: ChannelModel[],
  fetched: ChannelModel[],
  defaultModelId = '',
): { models: ChannelModel[]; defaultModelId: string } {
  const currentById = new Map(current.map((model) => [model.id, model]))
  const incomingIds = new Set(fetched.map((model) => model.id.trim()).filter(Boolean))
  const merged = [
    ...fetched.map((model) => {
      const existing = currentById.get(model.id.trim())
      return {
        id: model.id.trim(),
        name: existing?.name || model.name.trim() || model.id.trim(),
        enabled: existing?.enabled ?? model.enabled,
      }
    }),
    ...current.filter((model) => !incomingIds.has(model.id)),
  ]
  return normalizeModels(merged, defaultModelId)
}

export function validateChannelDraft(
  draft: ChannelDraft,
  mode: 'add' | 'edit',
): ChannelDraftValidation {
  const errors: ChannelDraftValidation['errors'] = {}
  if (!draft.name.trim()) errors.name = '请输入渠道名称'

  if (draft.provider !== KSCC_PROVIDER) {
    const baseUrl = draft.baseUrl.trim()
    try {
      const url = new URL(baseUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid')
    } catch {
      errors.baseUrl = '请输入有效的 HTTP(S) 地址'
    }
    if (mode === 'add' && !draft.apiKey.trim()) errors.apiKey = '新渠道需要 API Key'
  }

  if (!draft.models.some((model) => model.enabled && model.id.trim())) {
    errors.models = '至少启用一个模型'
  }
  return { valid: Object.keys(errors).length === 0, errors }
}

export function buildCreateInput(draft: ChannelDraft): ChannelCreateInput {
  const normalized = normalizeModels(draft.models, draft.defaultModelId)
  return {
    name: draft.name.trim(),
    provider: draft.provider,
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey.trim(),
    models: normalized.models,
    defaultModelId: normalized.defaultModelId || undefined,
    enabled: draft.enabled,
  }
}

export function buildUpdateInput(draft: ChannelDraft): ChannelUpdateInput {
  const normalized = normalizeModels(draft.models, draft.defaultModelId)
  const builtin = draft.provider === KSCC_PROVIDER
  return {
    name: draft.name.trim(),
    provider: builtin ? undefined : draft.provider,
    baseUrl: builtin ? undefined : draft.baseUrl.trim(),
    apiKey: builtin || !draft.apiKey.trim() ? undefined : draft.apiKey.trim(),
    models: normalized.models,
    defaultModelId: normalized.defaultModelId || undefined,
    enabled: draft.enabled,
  }
}
