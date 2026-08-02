import { describe, expect, test } from 'vitest'
import { parseMentions } from './mention'

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
