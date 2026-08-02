import { describe, expect, test } from 'vitest'
import { DEFAULT_KANBAN_ROLE_ID, DEFAULT_ROLES } from './agent-role'

describe('DEFAULT_ROLES 非编程角色补齐', () => {
  test('DEFAULT_KANBAN_ROLE_ID 指向 generalist', () => {
    expect(DEFAULT_KANBAN_ROLE_ID).toBe('generalist')
  })

  test('内置角色包含编程向 + 非编程向共 8 个', () => {
    const ids = DEFAULT_ROLES.map((r) => r.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'analyst',
        'coder',
        'reviewer',
        'writer',
        'generalist',
        'data-analyst',
        'chat',
        'doc-writer',
      ])
    )
    expect(ids).toHaveLength(8)
  })

  test('兜底角色 generalist 存在且可写权限', () => {
    const role = DEFAULT_ROLES.find((r) => r.id === 'generalist')
    expect(role).toBeDefined()
    expect(role!.displayName).toBe('通用执行者')
    expect(role!.permissionMode).toBe('bypassPermissions')
    expect(role!.systemPrompt.length).toBeGreaterThan(50)
  })

  test('doc-writer 与 writer 职责区分', () => {
    const writer = DEFAULT_ROLES.find((r) => r.id === 'writer')
    const docWriter = DEFAULT_ROLES.find((r) => r.id === 'doc-writer')
    expect(writer!.displayName).toContain('技术文档')
    expect(docWriter!.displayName).toBe('通用文档撰稿')
    expect(docWriter!.description).toMatch(/PPT|Excel|Markdown/)
  })

  test('内置角色 modelPool 默认为空（不写死渠道模型）', () => {
    for (const role of DEFAULT_ROLES) {
      expect(role.modelPool).toEqual([])
    }
  })
})
