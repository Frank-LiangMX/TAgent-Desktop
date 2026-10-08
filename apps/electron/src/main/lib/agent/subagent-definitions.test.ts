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

vi.mock('./agent-crew-prefs', () => ({
  readAgentCrewPrefs: () => ({ maxParallelWorkers: 3 }),
}))

vi.mock('./delegation-model-policy', () => ({
  buildDelegationModelPrompt: () => 'MODEL_POLICY_TEST_PROMPT',
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
    expect(text).toContain('MODEL_POLICY_TEST_PROMPT')
    expect(text).toContain('子代理并行上限：**3** 个 worker')
    expect(text).toContain('班组编排已暂停')
    expect(text).toContain('小任务由主模型自己完成')
    expect(text).toContain('选型理由、任务范围和验收标准')
    expect(text).toContain('后台回传后由主模型验收')
    expect(text).not.toContain('并行默认 ≤4')
    expect(text).not.toContain('haiku（Claude 渠道）')
  })

  test('CLI 段仅说明历史配置 fail closed 与官方派发入口', () => {
    const text = buildSubagentDelegationPrompt('conservative')
    expect(text).toContain('fail closed')
    expect(text).toContain('mcp__tagent-delegation__task')
    expect(text).toContain('Codex 与 Pi 使用普通 task')
    expect(text).toContain('不得使用原生 Task/Agent 或 Bash spawn')
    expect(text).not.toContain('本地 CLI 编排')
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

  test('委派策略目录不固定角色模型，未选型时继承主会话', () => {
    const text = buildSubagentDelegationPrompt('balanced')
    expect(text).toContain('角色只决定职责与工具')
    expect(text).toContain('继承主会话实际模型')
    expect(text).not.toContain('角色默认')
    expect(text).not.toContain('haiku（Claude 渠道）')
  })
})
