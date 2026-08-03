import { describe, expect, test } from 'vitest'
import { parseMentions, filterMentionRoles } from './mention'

const roles = [
  { id: 'analyst', displayName: '软件架构师' },
  { id: 'coder', displayName: '务实工程师' },
  { id: 'reviewer', displayName: '严格评审' },
]

describe('parseMentions', () => {
  test('按出现顺序解析 displayName', () => {
    const hits = parseMentions('请 @软件架构师 和 @务实工程师 各说一句', roles)
    expect(hits.map((h) => h.roleId)).toEqual(['analyst', 'coder'])
  })

  test('支持 @id', () => {
    const hits = parseMentions('@reviewer 请把关', roles)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.roleId).toBe('reviewer')
  })

  test('无 @ 返回空', () => {
    expect(parseMentions('普通消息', roles)).toEqual([])
  })
})

describe('filterMentionRoles', () => {
  const withPin = [
    { id: 'analyst', displayName: '软件架构师', pinned: true },
    { id: 'coder', displayName: '务实工程师' },
    { id: 'reviewer', displayName: '严格评审', pinned: true },
  ]

  test('无 query 且有 pin：只显示 pin 子集', () => {
    const ids = filterMentionRoles(withPin, '').map((r) => r.id)
    expect(ids).toEqual(['analyst', 'reviewer'])
  })

  test('无 query 且无 pin：回退全量', () => {
    const ids = filterMentionRoles(roles, '').map((r) => r.id)
    expect(ids).toEqual(['analyst', 'coder', 'reviewer'])
  })

  test('有 query：全库过滤，pin 项排前', () => {
    const ids = filterMentionRoles(withPin, '师').map((r) => r.id)
    // 软件架构师(pin) 与 务实工程师 均含「师」，pin 的 analyst 在前
    expect(ids).toEqual(['analyst', 'coder'])
  })
})
