import { describe, expect, it } from 'vitest'
import { buildMemoryRecallContext, rankMemoryRecallEntries } from './memory-retrieval'

const record = (overrides: Partial<{
  id: number; session_slug: string; title: string; summary: string; key_facts: string
}> = {}) => ({
  id: 1,
  session_slug: 'older-session',
  title: '修复会话标签留白',
  summary: '移除活跃标签的滑动底板，改为颜色过渡。',
  key_facts: JSON.stringify(['标签上限为 4']),
  tools_used: '[]',
  mode: 'general',
  workspace_slug: 'workspace',
  created_at: 1,
  ended_at: 1,
  ...overrides,
})

describe('buildMemoryRecallContext', () => {
  it('injects cross-session L4 context with title, summary and key facts', () => {
    const context = buildMemoryRecallContext('请继续修复会话标签的留白问题', [record()], 'current-session')
    expect(context).toContain('相关记忆')
    expect(context).toContain('修复会话标签留白')
    expect(context).toContain('标签上限为 4')
  })


describe('rankMemoryRecallEntries', () => {
  it('ranks only entries related to the current query', () => {
    const hits = rankMemoryRecallEntries('请修复 Claude 的协议调用', [
      { source: 'L3', text: '不是 http 协议，而是固定死的 Claude 客户端' },
      { source: 'L5', text: '用户偏好简洁回答' },
    ])

    expect(hits).toHaveLength(1)
    expect(hits[0]?.source).toBe('L3')
  })

  it('does not turn a generic prompt into a memory dump', () => {
    expect(
      rankMemoryRecallEntries('继续处理这个问题', [{ source: 'L3', text: '不要把协议当成 HTTP' }]),
    ).toEqual([])
  })
})
  it('does not recall the current session or trivial prompts', () => {
    expect(buildMemoryRecallContext('继续处理这个问题', [record({ session_slug: 'current-session' })], 'current-session')).toBe('')
    expect(buildMemoryRecallContext('你好', [record()], 'current-session')).toBe('')
  })
})
