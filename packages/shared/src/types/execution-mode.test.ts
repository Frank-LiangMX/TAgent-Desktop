import { describe, expect, test } from 'vitest'
import {
  DEFAULT_EXECUTION_MODE,
  LEGACY_EXECUTION_MODE,
  buildChatSwitchSuggestion,
  buildWorkSwitchSuggestion,
  isExecutionMode,
  isExecutionModeChangeSource,
  migrateExecutionMode,
} from './execution-mode'

describe('execution-mode', () => {
  test('DEFAULT 为 chat，LEGACY 为 work', () => {
    expect(DEFAULT_EXECUTION_MODE).toBe('chat')
    expect(LEGACY_EXECUTION_MODE).toBe('work')
  })

  test('isExecutionMode', () => {
    expect(isExecutionMode('chat')).toBe(true)
    expect(isExecutionMode('work')).toBe(true)
    expect(isExecutionMode('auto')).toBe(false)
    expect(isExecutionMode(undefined)).toBe(false)
  })

  test('migrate：合法值原样', () => {
    expect(migrateExecutionMode('chat')).toBe('chat')
    expect(migrateExecutionMode('work')).toBe('work')
  })

  test('migrate：缺失/非法 → legacy work（兼容旧会话）', () => {
    expect(migrateExecutionMode(undefined)).toBe('work')
    expect(migrateExecutionMode(null)).toBe('work')
    expect(migrateExecutionMode('')).toBe('work')
    expect(migrateExecutionMode('plan')).toBe('work')
  })

  test('migrate：可指定新建默认 chat', () => {
    expect(migrateExecutionMode(undefined, DEFAULT_EXECUTION_MODE)).toBe('chat')
  })

  test('切换来源仅 user / user-confirm-suggestion', () => {
    expect(isExecutionModeChangeSource('user')).toBe(true)
    expect(isExecutionModeChangeSource('user-confirm-suggestion')).toBe(true)
    expect(isExecutionModeChangeSource('agent-tool')).toBe(false)
    expect(isExecutionModeChangeSource(undefined)).toBe(false)
  })

  test('buildWorkSwitchSuggestion 默认文案与目标', () => {
    const s = buildWorkSwitchSuggestion({
      sessionId: 's1',
      toolName: 'Write',
      trigger: 'chat-block',
    })
    expect(s.targetMode).toBe('work')
    expect(s.fromMode).toBe('chat')
    expect(s.sessionId).toBe('s1')
    expect(s.toolName).toBe('Write')
    expect(s.reason).toMatch(/Chat/)
  })

  test('buildChatSwitchSuggestion', () => {
    const s = buildChatSwitchSuggestion({ sessionId: 's2' })
    expect(s.targetMode).toBe('chat')
    expect(s.fromMode).toBe('work')
  })
})
