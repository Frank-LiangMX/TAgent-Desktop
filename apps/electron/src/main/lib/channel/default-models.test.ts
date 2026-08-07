import { describe, expect, test } from 'vitest'
import type { Channel, ProviderType } from '@tagent/shared'
import { isClaudeAvailableForChannel } from './default-models'

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
