import { describe, expect, test } from 'vitest'
import { judgeGoalComplete, judgeGoalCompleteAsync } from './kanban-goal-judge'

describe('judgeGoalComplete', () => {
  test('非 goal 直接通过', () => {
    const r = judgeGoalComplete({ title: 'x', body: 'y' }, 'ok')
    expect(r.ok).toBe(true)
    expect(r.judgeResult?.verdict).toBe('skipped')
  })

  test('goal 短摘要拒绝', () => {
    const r = judgeGoalComplete(
      { goalMode: true, title: '实现登录', body: 'jwt' },
      '完成了',
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/过短|敷衍/)
    expect(r.judgeResult?.verdict).toBe('continue')
  })

  test('goal 充分摘要通过', () => {
    const r = judgeGoalComplete(
      {
        goalMode: true,
        title: '实现登录',
        body: 'jwt',
        acceptanceCriteria: '登录接口 200 且返回 token',
      },
      '已实现 POST /login：校验用户名密码，签发 JWT；用 curl 测返回 200 且 body 含 accessToken；单元测试 3 个全绿。',
    )
    expect(r.ok).toBe(true)
    expect(r.judgeResult?.verdict).toBe('done')
  })

  test('有验收标准时摘要过短拒绝', () => {
    const r = judgeGoalComplete(
      {
        goalMode: true,
        title: 'x',
        body: 'y',
        acceptanceCriteria: '测试通过',
      },
      '改了几个文件，本地能跑。', // < 50
    )
    expect(r.ok).toBe(false)
  })
})

describe('judgeGoalCompleteAsync', () => {
  const goodSummary =
    '已实现 POST /login：校验用户名密码，签发 JWT；用 curl 测返回 200 且 body 含 accessToken；单元测试 3 个全绿。'

  test('规则失败时 async 也失败', async () => {
    const r = await judgeGoalCompleteAsync(
      { id: 't1', goalMode: true, title: 'x', body: 'y' },
      '完成了',
    )
    expect(r.ok).toBe(false)
  })

  test('preferLlm stub fail-open 且 reason 含 llm_judge_skipped', async () => {
    const r = await judgeGoalCompleteAsync(
      {
        id: 't2',
        goalMode: true,
        title: '实现登录',
        body: 'jwt',
        acceptanceCriteria: '登录接口 200 且返回 token',
      },
      goodSummary,
      { preferLlm: true },
    )
    expect(r.ok).toBe(true)
    expect(r.judgeResult?.reason).toBe('llm_judge_skipped')
    expect(r.judgeResult?.failOpen).toBe(true)
  })

  test('无 preferLlm 时仅规则 verdict', async () => {
    const r = await judgeGoalCompleteAsync(
      { id: 't3', goalMode: true, title: '实现登录', body: 'jwt' },
      goodSummary,
    )
    expect(r.ok).toBe(true)
    expect(r.judgeResult?.reason).toBe('goal 规则验收通过')
  })
})
