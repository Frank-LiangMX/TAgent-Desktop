import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let rolesPath = ''

vi.mock('../config/config-paths', () => ({
  getAgentRolesPath: () => rolesPath,
  getConfigDir: () => join(rolesPath, '..'),
}))

vi.mock('../atomic-json', () => ({
  writeJsonAtomic: (path: string, data: unknown) => {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  },
}))

const { resolveForWorker, assignModelFromPools, buildKanbanWorkerSystemPrompt } =
  await import('./resolve-for-worker')
const { DEFAULT_ROLES } = await import('@tagent/shared')

describe('resolve-for-worker', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tagent-worker-'))
    rolesPath = join(tmpDir, 'agent-roles.json')
    writeFileSync(rolesPath, JSON.stringify(DEFAULT_ROLES, null, 2), 'utf-8')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('缺省 roleId → generalist', () => {
    const r = resolveForWorker({})
    expect(r.role.id).toBe('generalist')
    expect(r.systemPrompt).toMatch(/通用执行者|generalist/i)
    expect(r.systemPrompt).toMatch(/看板/)
  })

  test('coder 角色投影含角色正文与防递归', () => {
    const r = resolveForWorker({
      roleId: 'coder',
      boardId: 'b1',
      taskId: 't1',
      taskTitle: '实现 API',
    })
    expect(r.role.id).toBe('coder')
    expect(r.systemPrompt).toContain(r.role.displayName)
    expect(r.systemPrompt).toMatch(/kanban_create_board|禁止创建看板/)
    expect(r.systemPrompt).toContain('t1')
    expect(r.tools).toContain('Edit')
  })

  test('reviewer 为只读工具集', () => {
    const r = resolveForWorker({ roleId: 'reviewer' })
    expect(r.permissionMode).toBe('auto')
    expect(r.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
    expect(r.tools).not.toContain('Write')
  })

  test('显式 modelId 优先', () => {
    const r = resolveForWorker({
      roleId: 'coder',
      modelId: 'custom-model',
      availableModels: ['a', 'b'],
    })
    expect(r.modelId).toBe('custom-model')
  })

  test('modelPool 空时用 availableModels', () => {
    const r = resolveForWorker({
      roleId: 'generalist',
      availableModels: ['glm-5.2', 'kimi-k2.5'],
    })
    expect(r.modelId).toBe('glm-5.2')
  })

  test('assignModelFromPools 并发满则跳过', () => {
    const id = assignModelFromPools({
      modelPool: ['m1', 'm2'],
      availableModels: ['m1', 'm2', 'm3'],
      occupancy: { m1: 2, m2: 2 },
      maxPerModel: 2,
      fallbackToChannelDefault: true,
    })
    expect(id).toBe('m3')
  })

  test('池满且不允许 fallback → undefined', () => {
    const id = assignModelFromPools({
      modelPool: ['m1'],
      availableModels: ['m1', 'm2'],
      occupancy: { m1: 2 },
      maxPerModel: 2,
      fallbackToChannelDefault: false,
    })
    expect(id).toBeUndefined()
  })

  test('buildKanbanWorkerSystemPrompt goal 模式', () => {
    const role = DEFAULT_ROLES.find((x) => x.id === 'generalist')!
    const prompt = buildKanbanWorkerSystemPrompt(role, {
      taskId: 't9',
      goalMode: true,
      acceptanceCriteria: '测试通过',
    })
    expect(prompt).toMatch(/Goal 模式/)
    expect(prompt).toContain('测试通过')
  })
})
