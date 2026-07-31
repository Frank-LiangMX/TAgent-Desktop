import { describe, expect, it } from 'vitest'
import { contentToText, normalizeToTextMessages } from './history-normalizer'

describe('normalizeToTextMessages', () => {
  it('normalizes SDKMessage shape', () => {
    const raw = [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '嗨' }] },
      },
    ]
    const out = normalizeToTextMessages(raw)
    expect(out).toEqual([
      { role: 'user', contentText: '你好' },
      { role: 'assistant', contentText: '嗨' },
    ])
  })

  it('normalizes IR shape', () => {
    const raw = [
      { type: 'user', content: [{ type: 'text', text: '问' }] },
      { type: 'assistant', content: '答' },
    ]
    const out = normalizeToTextMessages(raw)
    expect(out[0]?.contentText).toBe('问')
    expect(out[1]?.contentText).toBe('答')
  })

  it('skips non user/assistant', () => {
    expect(normalizeToTextMessages([{ type: 'result' }])).toEqual([])
  })
})

describe('contentToText', () => {
  it('joins tool markers', () => {
    const t = contentToText([
      { type: 'text', text: 'a' },
      { type: 'tool_use', name: 'Read' },
    ])
    expect(t).toContain('a')
    expect(t).toContain('tool:Read')
  })
})
