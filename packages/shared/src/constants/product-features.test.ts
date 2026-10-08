import { describe, expect, it } from 'vitest'
import { CREW_ORCHESTRATION_ENABLED, CREW_PAUSED_MESSAGE } from './product-features'

describe('current product scope', () => {
  it('keeps crew orchestration paused and points users to subagents without deleting history', () => {
    expect(CREW_ORCHESTRATION_ENABLED).toBe(false)
    expect(CREW_PAUSED_MESSAGE).toContain('子代理')
    expect(CREW_PAUSED_MESSAGE).toContain('数据保留')
  })
})
