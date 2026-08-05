import { describe, expect, test } from 'vitest'

import {
  classifySessionError,
  classifyUserFacingError,
  buildChatModeBlockUserError,
  isChatModeBlockMessage,
  extractResultErrors,
  formatPromptTooLongError,
  isPromptTooLongMessage,
  isPromptTooLongResult,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  PROMPT_TOO_LONG_ERROR_TITLE,
} from './session-error-classify'
import { CHAT_MODE_BLOCK_REASON } from '../constants/permission-rules'

describe('isPromptTooLongMessage', () => {
  test('matches Anthropic native "prompt is too long"', () => {
    expect(isPromptTooLongMessage('Error: prompt is too long: 250000 > 200000')).toBe(true)
  })

  test('matches context_length_exceeded', () => {
    expect(isPromptTooLongMessage('context_length_exceeded (token count)')).toBe(true)
  })

  test('matches "exceeds ... context window"', () => {
    expect(isPromptTooLongMessage('input size exceeds the maximum context window')).toBe(true)
  })

  test('matches OpenAI-style "reduce the length of the messages"', () => {
    expect(
      isPromptTooLongMessage('Please reduce the length of the messages.'),
    ).toBe(true)
  })

  test('matches Chinese 上下文过长 / 超出上下文', () => {
    expect(isPromptTooLongMessage('当前上下文过长，请开新会话')).toBe(true)
    expect(isPromptTooLongMessage('请求超出上下文限制')).toBe(true)
  })

  test('ignores plain context-window stats (no exceed/long)', () => {
    // 上下文占用统计文案不应误判为错误
    expect(isPromptTooLongMessage('context window: 120000 / 200000')).toBe(false)
    expect(isPromptTooLongMessage('just some too long-ish sentence about nothing')).toBe(false)
  })

  test('empty / nullish inputs → false', () => {
    expect(isPromptTooLongMessage()).toBe(false)
    expect(isPromptTooLongMessage('', null, undefined)).toBe(false)
  })
})

describe('extractResultErrors / isPromptTooLongResult', () => {
  test('extracts errors from a result message', () => {
    expect(
      extractResultErrors({
        type: 'result',
        subtype: 'error',
        errors: ['prompt is too long: 1 > 2', 'other note'],
      }),
    ).toEqual(['prompt is too long: 1 > 2', 'other note'])
  })

  test('non-result message → empty', () => {
    expect(extractResultErrors({ type: 'assistant', message: {} })).toEqual([])
    expect(extractResultErrors(null)).toEqual([])
  })

  test('isPromptTooLongResult true on error result with too-long errors', () => {
    expect(
      isPromptTooLongResult({
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['prompt is too long'],
      }),
    ).toBe(true)
  })

  test('isPromptTooLongResult false on success result (no errors)', () => {
    expect(
      isPromptTooLongResult({ type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0 } }),
    ).toBe(false)
  })

  test('isPromptTooLongResult false on non-result', () => {
    expect(isPromptTooLongResult({ type: 'assistant' })).toBe(false)
  })
})

describe('classifySessionError', () => {
  test('user_stop wins over everything (even prompt too long)', () => {
    expect(
      classifySessionError({
        stoppedByUser: true,
        error: new Error('prompt is too long'),
      }),
    ).toBe('user_stop')
  })

  test('prompt_too_long from thrown error', () => {
    expect(classifySessionError({ error: new Error('prompt is too long') })).toBe('prompt_too_long')
  })

  test('prompt_too_long from stderr', () => {
    expect(classifySessionError({ stderr: '[kscc stderr] context_length_exceeded' })).toBe('prompt_too_long')
  })

  test('prompt_too_long from result errors', () => {
    expect(
      classifySessionError({
        result: { type: 'result', subtype: 'error', errors: ['maximum context length reached'] },
      }),
    ).toBe('prompt_too_long')
  })

  test('crash for a generic thrown error', () => {
    expect(classifySessionError({ error: new Error('child process exited with code 1') })).toBe('crash')
  })

  test('crash for stderr without too-long signal', () => {
    expect(classifySessionError({ stderr: 'EPIPE: broken pipe' })).toBe('crash')
  })

  test('unknown when no signal at all', () => {
    expect(classifySessionError({})).toBe('unknown')
  })
})

describe('formatPromptTooLongError', () => {
  test('produces Chinese title: message', () => {
    const text = formatPromptTooLongError()
    expect(text).toContain(PROMPT_TOO_LONG_ERROR_TITLE)
    expect(text).toContain(PROMPT_TOO_LONG_ERROR_MESSAGE)
    expect(text.startsWith(`${PROMPT_TOO_LONG_ERROR_TITLE}：`)).toBe(true)
  })
})

describe('chat mode block user-facing errors', () => {
  test('isChatModeBlockMessage detects deny reason', () => {
    expect(isChatModeBlockMessage(CHAT_MODE_BLOCK_REASON)).toBe(true)
    expect(isChatModeBlockMessage('random network error')).toBe(false)
  })

  test('buildChatModeBlockUserError includes tool name and switch hint', () => {
    const err = buildChatModeBlockUserError('Write')
    expect(err.code).toBe('chat_mode_blocked')
    expect(err.title).toMatch(/Chat/)
    expect(err.message).toMatch(/切换到 Work/)
    expect(err.message).toMatch(/Write/)
    expect(err.retryable).toBe(false)
    expect(err.action).toBe('switch_to_work')
  })

  test('classifyUserFacingError maps chat block reason', () => {
    const err = classifyUserFacingError(CHAT_MODE_BLOCK_REASON)
    expect(err.code).toBe('chat_mode_blocked')
    expect(err.message).toMatch(/讨论模式（Chat）/)
  })
})
