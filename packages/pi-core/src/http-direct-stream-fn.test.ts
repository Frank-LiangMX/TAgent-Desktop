import { describe, expect, it } from 'vitest'

import {
  DEFAULT_HTTP_CONTEXT_WINDOW,
  resolveHttpContextWindow,
  buildHttpDirectModel,
} from './http-direct-stream-fn'

describe('HTTP 直连上下文窗口', () => {
  it('保留调用方注入的真实窗口', () => {
    expect(resolveHttpContextWindow(1_000_000)).toBe(1_000_000)
    expect(resolveHttpContextWindow(64_000)).toBe(64_000)
  })

  it('缺失或非法配置回退到 200k，而不是旧的 128k', () => {
    expect(resolveHttpContextWindow()).toBe(DEFAULT_HTTP_CONTEXT_WINDOW)
    expect(resolveHttpContextWindow(0)).toBe(DEFAULT_HTTP_CONTEXT_WINDOW)
    expect(resolveHttpContextWindow(-1)).toBe(DEFAULT_HTTP_CONTEXT_WINDOW)
  })
})

describe('explicit channel wire protocol', () => {
  it('preserves legacy provider defaults when protocol is not set', () => {
    expect(buildHttpDirectModel({ provider: 'custom', apiKey: '', modelId: 'm' }).api).toBe('openai-completions')
    expect(buildHttpDirectModel({ provider: 'deepseek', apiKey: '', modelId: 'm' }).api).toBe('anthropic-messages')
  })
  it.each(['anthropic-messages', 'openai-responses', 'openai-chat'] as const)('honors %s independently of provider', (apiProtocol) => {
    const model = buildHttpDirectModel({ provider: 'custom', apiProtocol, apiKey: 'hidden', modelId: 'm', contextWindow: 500_000 })
    expect(model.api).toBe(apiProtocol === 'openai-chat' ? 'openai-completions' : apiProtocol)
    expect(model.contextWindow).toBe(500_000)
    expect(JSON.stringify(model)).not.toContain('hidden')
  })
})
