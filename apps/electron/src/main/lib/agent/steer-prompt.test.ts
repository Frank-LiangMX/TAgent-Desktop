import { describe, expect, test } from 'vitest'
import {
  extractSdkUserText,
  isSteerPromptEcho,
  wrapSteerPromptForModel,
} from './steer-prompt'

describe('steer-prompt', () => {
  test('包装后仍含原文，并标明是运行中引导', () => {
    const wrapped = wrapSteerPromptForModel('它好像是基于aionui的')
    expect(wrapped).toContain('【用户引导】')
    expect(wrapped).toContain('它好像是基于aionui的')
    expect(wrapped).toContain('不要当成全新问题')
  })

  test('识别原文与包装回声', () => {
    const original = '它好像是基于aionui的'
    expect(isSteerPromptEcho(original, original)).toBe(true)
    expect(isSteerPromptEcho(wrapSteerPromptForModel(original), original)).toBe(true)
    expect(isSteerPromptEcho('另一件事', original)).toBe(false)
  })

  test('从 SDK user 块抽出文本', () => {
    expect(
      extractSdkUserText({
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    ).toBe('hello')
  })
})
