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

  it('chat：含会诊/圆桌场景与发送旁入口建议', () => {
    const p = buildExecutionModePrompt('chat')
    expect(p).toMatch(/会诊/)
    expect(p).toMatch(/圆桌/)
    expect(p).toMatch(/发送.*▾|发送键旁/)
    expect(p).toMatch(/禁止.*会诊|声称.*会诊/)
  })

  it('work：含调度、看板、能力地图与短答约束', () => {
    const p = buildExecutionModePrompt('work')
    expect(p).toMatch(/Work/)
    expect(p).toMatch(/kanban_create_board/)
    expect(p).toMatch(/短答/)
    expect(p).toMatch(/SubAgent/)
    expect(p).toMatch(/班组|看板/)
    expect(p).toMatch(/会诊/)
    expect(p).toMatch(/圆桌/)
    expect(p).toMatch(/发送.*▾|发送键旁/)
    expect(p).toMatch(/不能自己发起|没有.*会诊工具/)
  })
})
