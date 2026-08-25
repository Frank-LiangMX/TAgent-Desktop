import { describe, expect, it } from 'vitest'
import { extractPlanStepSignals, parsePlanStepSignals } from './plan-step-signal'

describe('plan step signals', () => {
  it('parses hidden running/completed/failed/paused markers in order', () => {
    expect(
      parsePlanStepSignals(
        '<!-- tagent-plan-step: 1 running -->查找<!--tagent-plan-step:2 completed --> <!-- tagent-plan-step: 3 failed --> <!-- tagent-plan-step: 4 paused -->',
      ),
    ).toEqual([
      { step: 1, status: 'running' },
      { step: 2, status: 'completed' },
      { step: 3, status: 'failed' },
      { step: 4, status: 'paused' },
    ])
  })

  it('reads SDK and IR assistant content but ignores user messages', () => {
    expect(
      extractPlanStepSignals({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '<!-- tagent-plan-step: 2 running -->' }] },
      }),
    ).toEqual([{ step: 2, status: 'running' }])
    expect(
      extractPlanStepSignals({
        type: 'user',
        content: [{ type: 'text', text: '<!-- tagent-plan-step: 2 running -->' }],
      }),
    ).toEqual([])
  })

  it('parses plain-text fallbacks when HTML comments are omitted', () => {
    expect(parsePlanStepSignals('tagent-plan-step: 2 completed')).toEqual([
      { step: 2, status: 'completed' },
    ])
    expect(parsePlanStepSignals('第 3 步：完成，准备联调')).toEqual([
      { step: 3, status: 'completed' },
    ])
    expect(parsePlanStepSignals('Step 1 running — collecting context')).toEqual([
      { step: 1, status: 'running' },
    ])
  })
})
