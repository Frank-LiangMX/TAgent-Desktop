import { describe, expect, test } from 'bun:test'

import { resolveContextUsageColor } from './context-usage-colors'

describe('resolveContextUsageColor', () => {
  test('passes through valid hex', () => {
    expect(resolveContextUsageColor('System prompt', '#ff0000')).toBe('#ff0000')
  })

  test('adds # to bare hex', () => {
    expect(resolveContextUsageColor('System prompt', 'A78BFA')).toBe('#A78BFA')
  })

  test('maps semantic swatch names', () => {
    expect(resolveContextUsageColor('System tools', 'purple')).toBe('#A78BFA')
    expect(resolveContextUsageColor('Skills', 'yellow')).toBe('#FBBF24')
  })

  test('falls back by category name when color missing', () => {
    expect(resolveContextUsageColor('MCP tools', '')).toBe('#F472B6')
    expect(resolveContextUsageColor('Messages', undefined)).toBe('#FB923C')
  })

  test('falls back to gray for unknown category', () => {
    expect(resolveContextUsageColor('Unknown', 'not-a-color')).toBe('#9CA3AF')
  })
})
