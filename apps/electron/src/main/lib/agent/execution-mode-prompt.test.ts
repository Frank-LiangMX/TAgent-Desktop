import { describe, expect, it } from 'vitest'
import { buildExecutionModePrompt } from './execution-mode-prompt'

describe('buildExecutionModePrompt', () => {
  it('chat：明确禁 Plan / 写 / SubAgent，并要求建议切 Work', () => {
    const p = buildExecutionModePrompt('chat')
    expect(p).toMatch(/Chat/)
    expect(p).toMatch(/最高优先级|只读讨论/)
    expect(p).toMatch(/EnterPlanMode/)
    expect(p).toMatch(/ExitPlanMode/)
    expect(p).toMatch(/建议.*Work|切到 \*\*Work\*\*/)
    expect(p).not.toMatch(/kanban_create_board/)
  })

  it('work：含调度、看板与短答约束', () => {
    const p = buildExecutionModePrompt('work')
    expect(p).toMatch(/Work/)
    expect(p).toMatch(/kanban_create_board/)
    expect(p).toMatch(/短答/)
  })
})
