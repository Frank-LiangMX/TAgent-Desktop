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
    // 动态触发：多轮未决时主动建议会诊/圆桌（回归守护）
    expect(p).toMatch(/多轮/)
  })

  it('work：含「接着干 / Plan / AskUser 边界」调度策略', () => {
    const p = buildExecutionModePrompt('work')
    // 默认直接实现：用户说接着开发/开干 → 禁止 EnterPlanMode
    expect(p).toMatch(/接着开发|接着干|开干/)
    expect(p).toMatch(/EnterPlanMode/)
    expect(p).toMatch(/禁止.*EnterPlanMode/)
    // EnterPlanMode 门槛：≥3 模块 / 合 main
    expect(p).toMatch(/≥3|3 个独立模块/)
    expect(p).toMatch(/合 main/)
    // ExitPlanMode 须审批 UI，禁止贴完计划即动手
    expect(p).toMatch(/ExitPlanMode/)
    expect(p).toMatch(/禁止.*贴完计划|贴完计划.*禁止/)
    // Plan 内 Explore ≤1 次/用户回合
    expect(p).toMatch(/≤1|1 次\/用户回合/)
    // AskUser 白话、第一刀最多一次、关窗默认按 HANDOFF 开干
    expect(p).toMatch(/白话/)
    expect(p).toMatch(/第一刀/)
    expect(p).toMatch(/HANDOFF/)
    // 选项 label 禁止 §/ADR 编号 / 裸术语做主标题
    expect(p).toMatch(/禁止.*§|ADR/)
  })

  it('chat：不含 Work 调度策略段（接着干/Plan 边界仅 Work 注入）', () => {
    const p = buildExecutionModePrompt('chat')
    expect(p).not.toMatch(/接着干 \/ Plan \/ AskUser 边界/)
    expect(p).not.toMatch(/HANDOFF/)
  })
})
