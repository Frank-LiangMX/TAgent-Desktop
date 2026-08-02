import { describe, expect, test } from 'vitest'
import { DEFAULT_ROLES } from '@tagent/shared'
import {
  composeRoleSystemPrompt,
  roleToSubagentDef,
  resolveModelForRole,
  toolsForRolePermission,
  getOperationalSubagentRoles,
  OPERATIONAL_TO_ROLE_ID,
} from './role-projection'

describe('role-projection', () => {
  const reviewer = DEFAULT_ROLES.find((r) => r.id === 'reviewer')!

  test('composeRoleSystemPrompt 含角色名与正文', () => {
    const prompt = composeRoleSystemPrompt(reviewer, { purpose: 'subagent' })
    expect(prompt).toContain(reviewer.displayName)
    expect(prompt).toContain('`reviewer`')
    expect(prompt).toContain(reviewer.systemPrompt.slice(0, 40))
    expect(prompt).toMatch(/中文/)
  })

  test('maxRolePromptChars 截断', () => {
    const prompt = composeRoleSystemPrompt(reviewer, {
      purpose: 'moa-seat',
      maxRolePromptChars: 80,
    })
    expect(prompt).toMatch(/截断/)
    expect(prompt.length).toBeLessThan(reviewer.systemPrompt.length)
  })

  test('roleToSubagentDef 投影 description / tools / prompt', () => {
    const def = roleToSubagentDef(reviewer, { claudeAvailable: true })
    expect(def.description).toContain(reviewer.displayName)
    expect(def.prompt).toContain(reviewer.displayName)
    expect(def.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash']) // auto
    expect(def.model).toBe('haiku')
  })

  test('bypass 角色用可写工具集', () => {
    const coder = DEFAULT_ROLES.find((r) => r.id === 'coder')!
    expect(coder.permissionMode).toBe('bypassPermissions')
    const tools = toolsForRolePermission(coder.permissionMode, 'subagent')
    expect(tools).toContain('Edit')
    expect(tools).toContain('Write')
  })

  test('modelPool 优先于 haiku', () => {
    const role = { ...reviewer, modelPool: ['deepseek-v4-flash'] }
    expect(resolveModelForRole(role, { claudeAvailable: true })).toBe('deepseek-v4-flash')
    expect(resolveModelForRole(role, { modelOverride: 'kimi-k2.5' })).toBe('kimi-k2.5')
  })

  test('空 modelPool + 非 Claude → 无 model（继承父）', () => {
    expect(resolveModelForRole(reviewer, { claudeAvailable: false })).toBeUndefined()
  })

  test('操作型 seed 可投影', () => {
    const explorer = getOperationalSubagentRoles().find((r) => r.id === 'explorer')!
    const def = roleToSubagentDef(explorer, { claudeAvailable: true })
    expect(def.prompt).toMatch(/探索/)
    expect(def.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })

  test('code-reviewer 映射 reviewer', () => {
    expect(OPERATIONAL_TO_ROLE_ID['code-reviewer']).toBe('reviewer')
  })
})
