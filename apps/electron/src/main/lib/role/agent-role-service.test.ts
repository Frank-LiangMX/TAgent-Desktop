/**
 * 角色库服务单测
 */
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let rolesPath = ''

vi.mock('../config/config-paths', () => ({
  getAgentRolesPath: () => rolesPath,
}))

vi.mock('../atomic-json', () => ({
  writeJsonAtomic: (path: string, data: unknown) => {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  },
}))

const { loadRoles, resetDefaultRoles, deleteRole, saveRole, resolveRole, isBuiltinRole } =
  await import('./agent-role-service')
const { DEFAULT_ROLES, DEFAULT_KANBAN_ROLE_ID } = await import('@tagent/shared')

describe('agent-role-service', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tagent-role-test-'))
    rolesPath = join(tmpDir, 'agent-roles.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('首次 loadRoles 写入全部内置角色', () => {
    const roles = loadRoles()
    const ids = roles.map((r) => r.id)
    expect(ids).toContain('generalist')
    expect(ids).toContain('coder')
    expect(ids).toContain('reviewer')
    expect(roles.length).toBeGreaterThanOrEqual(8)
    expect(existsSync(rolesPath)).toBe(true)
  })

  test('旧文件仅 4 角色时补齐', () => {
    const oldFour = DEFAULT_ROLES.filter((r) =>
      ['analyst', 'coder', 'reviewer', 'writer'].includes(r.id),
    )
    writeFileSync(rolesPath, JSON.stringify(oldFour, null, 2), 'utf-8')
    const roles = loadRoles()
    const ids = new Set(roles.map((r) => r.id))
    expect(ids.has('generalist')).toBe(true)
    expect(ids.has('doc-writer')).toBe(true)
  })

  test('resetDefaultRoles 恢复内置', () => {
    const roles = resetDefaultRoles()
    expect(roles.map((r) => r.id)).toEqual(DEFAULT_ROLES.map((r) => r.id))
  })

  test('内置角色不可删', () => {
    loadRoles()
    const res = deleteRole('coder')
    expect(res.deleted).toBe(false)
    expect(res.reason).toMatch(/内置/)
  })

  test('自定义角色可增删', () => {
    loadRoles()
    saveRole({
      id: 'custom-foo',
      displayName: '自定义',
      description: '测试',
      systemPrompt: '你是测试角色',
      permissionMode: 'bypassPermissions',
      modelPool: [],
      maxConcurrentPerModel: 2,
      fallbackToChannelDefault: true,
    })
    expect(loadRoles().some((r) => r.id === 'custom-foo')).toBe(true)
    const del = deleteRole('custom-foo')
    expect(del.deleted).toBe(true)
    expect(loadRoles().some((r) => r.id === 'custom-foo')).toBe(false)
  })

  test('resolveRole 缺省 generalist', () => {
    loadRoles()
    expect(resolveRole(undefined).id).toBe(DEFAULT_KANBAN_ROLE_ID)
    expect(resolveRole('no-such').id).toBe(DEFAULT_KANBAN_ROLE_ID)
    expect(resolveRole('coder').id).toBe('coder')
  })

  test('isBuiltinRole', () => {
    expect(isBuiltinRole('coder')).toBe(true)
    expect(isBuiltinRole('custom-x')).toBe(false)
  })

  test('磁盘内容可解析', () => {
    loadRoles()
    const raw = JSON.parse(readFileSync(rolesPath, 'utf-8')) as Array<{ id: string }>
    expect(raw.length).toBeGreaterThanOrEqual(8)
  })

  test('清除内置角色遗留的 glm 模型池', () => {
    const withLegacy = DEFAULT_ROLES.map((r) => ({
      ...r,
      modelPool: ['glm-5.1', 'glm-5.2', 'kimi-k2.5'],
    }))
    writeFileSync(rolesPath, JSON.stringify(withLegacy, null, 2), 'utf-8')
    const roles = loadRoles()
    for (const r of roles) {
      if (isBuiltinRole(r.id)) {
        expect(r.modelPool).toEqual([])
      }
    }
  })
})
