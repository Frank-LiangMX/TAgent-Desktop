import { describe, expect, test } from 'vitest'
import type { Channel, ProviderType } from '@tagent/shared'
import {
  CODEX_DEFAULT_MODEL_ID,
  CODEX_DEFAULT_MODELS,
  KSCC_DEFAULT_MODELS,
  isClaudeAvailableForChannel,
} from './default-models'

describe('isClaudeAvailableForChannel', () => {
  /** 最小 Channel：仅 provider 决定结果（其余字段不影响判定） */
  const mk = (provider: ProviderType): Channel => ({ provider } as unknown as Channel)

  test('Anthropic 系渠道 → true（网关有 Claude 模型，可钉 haiku）', () => {
    expect(isClaudeAvailableForChannel(mk('anthropic'))).toBe(true)
    expect(isClaudeAvailableForChannel(mk('anthropic-compatible'))).toBe(true)
  })

  test('kscc-internal → false（网关只代理 glm/kimi/mimo，继承父会话模型）', () => {
    expect(isClaudeAvailableForChannel(mk('kscc-internal'))).toBe(false)
  })

  test('其余 provider → false（非 Claude 网关，钉 haiku 会首轮失败）', () => {
    const others: ProviderType[] = [
      'openai',
      'deepseek',
      'google',
      'kimi-api',
      'kimi-coding',
      'zhipu',
      'zhipu-coding',
      'minimax',
      'doubao',
      'qwen',
      'qwen-anthropic',
      'xiaomi',
      'xiaomi-token-plan',
      'custom',
    ]
    for (const p of others) {
      expect(isClaudeAvailableForChannel(mk(p))).toBe(false)
    }
  })
})

describe('Codex default models', () => {
  test('uses the three current GPT-5.6 Codex model IDs', () => {
    expect(CODEX_DEFAULT_MODEL_ID).toBe('gpt-5.6-sol')
    expect(CODEX_DEFAULT_MODELS.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
    expect(CODEX_DEFAULT_MODELS.map((model) => model.name)).toEqual([
      'GPT-5.6 Sol',
      'GPT-5.6 Terra',
      'GPT-5.6 Luna',
    ])
  })
})

describe('KSCC default models', () => {
  test('matches the current /cli/models gateway list', () => {
    expect(KSCC_DEFAULT_MODELS.map((model) => model.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4.1-flash',
      'deepseek-v4-pro-0813',
      'glm-5',
      'glm-5.1',
      'glm-5.2',
      'glm-5.3',
      'glm-5.3-flash',
      'kimi-k2.5',
      'kimi-k2.6',
      'kimi-k3',
      'mimo-v2.5',
      'mimo-v2.5-pro',
    ])
  })
})
