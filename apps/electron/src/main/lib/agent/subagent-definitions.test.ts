/**
 * SubAgent 目录 = 角色投影
 */
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// 本地 CLI 编排段注入依赖：默认返回空串（未启用），个别用例覆盖覆盖
let mockCliCards = ''
vi.mock('../agent/cli-workers/resolve-backend', () => ({
  listEnabledCliWorkerCards: () => mockCliCards,
}))

const { buildBuiltinSubagentDefinitions, resolveSubagentDefinition, buildSubagentDelegationPrompt } =
  await import('./subagent-definitions')
const { DEFAULT_ROLES } = await import('@tagent/shared')

describe('subagent-definitions 角色投影', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tagent-subagent-'))
    rolesPath = join(tmpDir, 'agent-roles.json')
    writeFileSync(rolesPath, JSON.stringify(DEFAULT_ROLES, null, 2), 'utf-8')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('目录含操作型 + code-reviewer + 岗位短列表', () => {
    const agents = buildBuiltinSubagentDefinitions(true)
    expect(agents.explorer).toBeDefined()
    expect(agents.researcher).toBeDefined()
    expect(agents['code-reviewer']).toBeDefined()
    expect(agents.reviewer).toBeDefined()
    expect(agents.analyst).toBeDefined()
    expect(agents.coder).toBeDefined()
    expect(agents.generalist).toBeDefined()
  })

  test('code-reviewer prompt 来自角色库 reviewer', () => {
    const def = resolveSubagentDefinition('code-reviewer', { claudeAvailable: true })!
    const reviewer = DEFAULT_ROLES.find((r) => r.id === 'reviewer')!
    expect(def.prompt).toContain(reviewer.displayName)
    expect(def.prompt).toContain(reviewer.systemPrompt.slice(0, 50))
    expect(def.model).toBe('haiku')
  })

  test('角色 id analyst 可解析', () => {
    const def = resolveSubagentDefinition('analyst', { claudeAvailable: false })!
    expect(def.prompt).toMatch(/软件架构师|analyst/i)
    expect(def.model).toBeUndefined()
  })

  test('未知类型返回 undefined', () => {
    expect(resolveSubagentDefinition('no-such-agent')).toBeUndefined()
  })

  test('委派策略列出角色投影目录', () => {
    const text = buildSubagentDelegationPrompt('conservative')
    expect(text).toContain('explorer')
    expect(text).toContain('code-reviewer')
    expect(text).toContain('analyst')
    expect(text).toMatch(/角色库/)
  })

  test('未启用 CLI 工人 → 委派策略含禁用提示段', () => {
    mockCliCards = ''
    const text = buildSubagentDelegationPrompt('conservative')
    expect(text).toContain('本地 CLI 编排')
    expect(text).toContain('未启用本机 CLI 工人')
  })

  test('启用 CLI 工人 → 委派策略注入能力卡 + Bash spawn 用法', () => {
    mockCliCards = 'CLI 工人能力卡（按优先级）：\n  codex — cost 3 · reasoning high · text'
    const text = buildSubagentDelegationPrompt('conservative')
    expect(text).toContain('本地 CLI 编排')
    expect(text).toContain('codex — cost 3 · reasoning high · text')
    expect(text).toContain('Bash 工具')
    expect(text).toContain('按特长选 CLI')
  })

  test('claudeAvailable:false → 内置角色均无 model（继承父会话模型）', () => {
    // kscc-internal 等无 Claude 渠道：isClaudeAvailableForChannel → false
    // → resolveModelForRole 返回 undefined → AgentDefinition 不带 model → SDK 继承父模型
    const agents = buildBuiltinSubagentDefinitions(false)
    // 操作型 seed（modelPool 空）
    expect(agents.explorer!.model).toBeUndefined()
    expect(agents.researcher!.model).toBeUndefined()
    // code-reviewer 投影自 reviewer（modelPool 空）
    expect(agents['code-reviewer']!.model).toBeUndefined()
    // 岗位短列表（DEFAULT_ROLES modelPool 均空）—— 全部继承父，无一处钉 haiku
    expect(agents.reviewer!.model).toBeUndefined()
    expect(agents.analyst!.model).toBeUndefined()
    expect(agents.coder!.model).toBeUndefined()
    expect(agents.generalist!.model).toBeUndefined()
  })

  test('claudeAvailable:true → 操作型钉 haiku（对照组）', () => {
    const agents = buildBuiltinSubagentDefinitions(true)
    expect(agents.explorer!.model).toBe('haiku')
    expect(agents.researcher!.model).toBe('haiku')
    expect(agents['code-reviewer']!.model).toBe('haiku')
  })
})
