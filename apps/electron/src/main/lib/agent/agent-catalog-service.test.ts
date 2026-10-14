import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const implementationPath = new URL('./agent-catalog-service.ts', import.meta.url)

// 该测试只在实现存在时导入；实现缺失时用例会明确跳过，而不是伪造通过。
const implementationExists = existsSync(implementationPath)
const catalogFile = { path: '' }

vi.mock('../config/config-paths', () => ({
  getAgentCatalogPath: () => catalogFile.path,
}))

type CatalogService = typeof import('./agent-catalog-service')
let service: CatalogService | null = null

beforeEach(async () => {
  catalogFile.path = join(mkdtempSync(join(tmpdir(), 'tagent-agent-catalog-')), 'agent-catalog.json')
  if (implementationExists) {
    vi.resetModules()
    service = await import('./agent-catalog-service')
  }
})

afterEach(() => {
  if (catalogFile.path) rmSync(dirname(catalogFile.path), { recursive: true, force: true })
  catalogFile.path = ''
  service = null
  vi.restoreAllMocks()
})

const contractTest = implementationExists ? it : it.skip

const validAgent = {
  id: 'pi-researcher',
  name: 'Pi Researcher',
  description: '只读分析 Agent',
  runtime: 'pi',
  enabled: true,
  builtIn: false,
  permissionProfile: 'read-only',
  workspacePolicy: 'inherit',
  capabilities: { tags: ['research'] },
  allowPiTask: true,
  allowBackground: true,
  approvalRequired: false,
} as const

describe('AgentCatalogService 契约', () => {
  it.skipIf(!implementationExists)('实现文件尚不存在：保留契约测试，待实现落地后执行', () => {})

  contractTest('拒绝非法 runtime、空字段和重复 id', () => {
    expect(service!.validateAgentProfiles([{ ...validAgent, runtime: 'invalid-runtime' }])).not.toBeNull()
    expect(service!.validateAgentProfiles([{ ...validAgent, name: '' }])).not.toBeNull()
    expect(service!.validateAgentProfiles([validAgent, validAgent])).not.toBeNull()
  })

  contractTest('配置文件缺失时返回默认目录', () => {
    const profiles = service!.listAgentProfiles()

    expect(profiles.map((profile) => profile.id)).toEqual(['pi', 'codex', 'claude-code', 'kscc'])
    expect(profiles.find((profile) => profile.id === 'pi')?.enabled).toBe(true)
    expect(profiles.find((profile) => profile.id === 'kscc')?.enabled).toBe(false)
  })

  contractTest('原子保存后可以读取相同目录', () => {
    service!.writeAgentProfiles([validAgent])

    expect(service!.listAgentProfiles()).toEqual([validAgent])
    expect(JSON.parse(readFileSync(catalogFile.path, 'utf8'))).toEqual({
      version: 1,
      profiles: [validAgent],
    })
  })

  contractTest('旧内核预设转为 Pi，保留渠道、角色和权限', () => {
    const legacy = { ...validAgent, runtime: 'codex', channelId: 'http-api', modelId: 'model', enabled: false }
    writeFileSync(catalogFile.path, JSON.stringify({ version: 1, profiles: [legacy] }))
    expect(service!.listAgentProfiles()).toEqual([{ ...legacy, runtime: 'pi' }])
    expect(JSON.parse(readFileSync(catalogFile.path, 'utf8')).profiles[0].runtime).toBe('codex')
  })

  contractTest('API Key 不进入配置序列化', () => {
    const before = existsSync(catalogFile.path) ? readFileSync(catalogFile.path, 'utf8') : null
    const withSecret = {
      ...validAgent,
      apiKey: 'must-not-persist',
      channel: { id: 'channel-1', apiKey: 'must-not-persist' },
    }

    expect(() => service!.writeAgentProfiles([withSecret])).toThrow(/凭据|apiKey/i)
    expect(existsSync(catalogFile.path)).toBe(before !== null)
    if (before !== null) expect(readFileSync(catalogFile.path, 'utf8')).toBe(before)
    expect(JSON.stringify(withSecret)).toContain('must-not-persist')
  })
})
