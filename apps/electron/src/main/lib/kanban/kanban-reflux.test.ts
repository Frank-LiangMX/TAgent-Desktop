import { describe, expect, test } from 'vitest'
import { buildBoardCompletionMessage } from './kanban-reflux'

describe('buildBoardCompletionMessage', () => {
  test('普通完成：含计数与任务明细，不要求综合报告', () => {
    const text = buildBoardCompletionMessage(
      { id: 'b1', title: '登录改造', rootGoal: '实现登录', requireSummary: false },
      [
        {
          title: '写 API',
          status: 'done',
          resultSummary: '已实现 POST /login 并返回 token',
        },
        {
          title: '写前端',
          status: 'failed',
          error: '编译失败',
        },
      ],
      { total: 2, done: 1, failed: 1 },
    )
    expect(text).toContain('【班组完成】登录改造')
    expect(text).toContain('合计 2 项：完成 1，失败 1')
    expect(text).toContain('写 API [完成]')
    expect(text).toContain('写前端 [失败]')
    expect(text).toContain('编译失败')
    expect(text).not.toContain('请队长撰写综合报告')
    expect(text).toContain('班组已全部终态')
  })

  test('requireSummary=true：强措辞请队长写综合报告', () => {
    const text = buildBoardCompletionMessage(
      { id: 'b2', title: '审计调研', rootGoal: '审计', requireSummary: true },
      [{ title: '收集证据', status: 'done', resultSummary: '收集了 3 份日志' }],
      { total: 1, done: 1, failed: 0 },
    )
    expect(text).toContain('【请队长撰写综合报告】')
    expect(text).toContain('requireSummary=true')
    expect(text).toContain('合成交付报告')
  })

  test('长摘要截断', () => {
    const long = '字'.repeat(200)
    const text = buildBoardCompletionMessage(
      { id: 'b3', title: 'T', rootGoal: 'T' },
      [{ title: 'A', status: 'done', resultSummary: long }],
      { total: 1, done: 1, failed: 0 },
    )
    expect(text).toMatch(/…/)
    expect(text.length).toBeLessThan(long.length + 200)
  })
})
