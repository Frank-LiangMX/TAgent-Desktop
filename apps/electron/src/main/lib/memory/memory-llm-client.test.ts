import { describe, expect, it } from 'vitest'
import {
  buildEmbeddingBaseCandidates,
  embeddingModelsForProvider,
} from './memory-llm-client'

describe('buildEmbeddingBaseCandidates', () => {
  it('strips /anthropic for Anthropic-protocol bases', () => {
    const c = buildEmbeddingBaseCandidates('https://api.deepseek.com/anthropic', 'deepseek')
    expect(c.some((u) => u.includes('/v1'))).toBe(true)
    expect(c).toContain('https://api.deepseek.com/anthropic')
    expect(c).toContain('https://api.deepseek.com/v1')
  })

  it('keeps openai v1 base', () => {
    const c = buildEmbeddingBaseCandidates('https://api.openai.com/v1', 'openai')
    expect(c).toContain('https://api.openai.com/v1')
  })

  it('handles moonshot anthropic path', () => {
    const c = buildEmbeddingBaseCandidates('https://api.moonshot.cn/anthropic', 'kimi-api')
    expect(c).toContain('https://api.moonshot.cn/v1')
  })
})

describe('embeddingModelsForProvider', () => {
  it('includes openai models for anthropic-compatible', () => {
    const m = embeddingModelsForProvider('anthropic-compatible')
    expect(m[0]).toBe('text-embedding-3-small')
  })

  it('gives deepseek-specific first', () => {
    expect(embeddingModelsForProvider('deepseek')[0]).toMatch(/deepseek|embedding/i)
  })
})
