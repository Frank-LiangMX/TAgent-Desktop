import { describe, expect, it } from 'vitest'
import { assessAutoPlan, buildAutoPlanPrompt } from './auto-plan-router'

describe('auto-plan-router', () => {
  it('简单查询直达', () => {
    expect(assessAutoPlan('帮我查一下今天的金价', 'work').shouldPlan).toBe(false)
  })

  it('调查、修改、验证的组合自动规划', () => {
    const result = assessAutoPlan('先分析这个 bug，修改相关模块，最后编译并运行测试', 'work')
    expect(result.shouldPlan).toBe(true)
    expect(buildAutoPlanPrompt('先分析这个 bug，修改相关模块，最后编译并运行测试', 'work')).toMatch(
      /EnterPlanMode|ExitPlanMode/,
    )
  })

  it('Chat 和运行中引导不触发自动规划', () => {
    expect(assessAutoPlan('分析并修复这个问题，然后运行测试', 'chat').shouldPlan).toBe(false)
    expect(assessAutoPlan('分析并修复这个问题，然后运行测试', 'work', true).shouldPlan).toBe(false)
  })
})
