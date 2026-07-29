import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  getInstalledPluginBundles,
  installStoreBundle,
  uninstallStoreBundle,
} from './plugin-store'
import { getMcpConfig, saveMcpConfig } from '../mcp/mcp-store'
import { getProjectDir } from '../config/config-paths'

const SLUG = 'ws-plugin-test'

describe('plugin store bundle install / uninstall', () => {
  let configDir = ''

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'tagent-plugin-store-'))
    process.env.TAGENT_CONFIG_DIR = configDir
    // 触发 getProjectDir 创建 projects/{SLUG}
    getProjectDir(SLUG)
  })

  afterEach(() => {
    delete process.env.TAGENT_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
  })

  /** 工作区 skills 根：projects/{slug}/skills/ */
  function skillsDir(): string {
    return join(getProjectDir(SLUG), 'skills')
  }
  function skillMd(slug: string): string {
    return join(skillsDir(), slug, 'SKILL.md')
  }

  it('installStoreBundle writes MCP into mcp.json, inline skills to disk, and a manifest record', () => {
    const result = installStoreBundle(SLUG, 'github-dev-collab')

    expect(result.installedMcps).toEqual(['github'])
    expect(result.installedSkills).toEqual(['code-review', 'bug-hunt', 'release-notes'])
    expect(result.skippedMcps).toEqual([])
    expect(result.skippedSkills).toEqual([])
    expect(result.errors).toEqual([])

    // MCP 落盘 mcp.json，enabled: true，command 来自商店
    const mcp = getMcpConfig(SLUG).servers['github']
    expect(mcp).toBeDefined()
    expect(mcp?.enabled).toBe(true)
    expect(mcp?.command).toBe('npx')

    // inline Skill 写成 SKILL.md
    expect(existsSync(skillMd('code-review'))).toBe(true)
    expect(existsSync(skillMd('bug-hunt'))).toBe(true)
    expect(existsSync(skillMd('release-notes'))).toBe(true)

    // manifest 记录该 bundle（含完整 mcps/skills 列表）
    const installed = getInstalledPluginBundles(SLUG)
    expect(installed).toHaveLength(1)
    const record = installed[0]
    expect(record?.bundleId).toBe('github-dev-collab')
    expect(record?.source).toBe('store')
    expect(record?.mcps).toEqual(['github'])
    expect(record?.skills).toEqual(['code-review', 'bug-hunt', 'release-notes'])
  })

  it('repeated install skips already-installed MCP and skills (idempotent)', () => {
    installStoreBundle(SLUG, 'github-dev-collab')
    const result = installStoreBundle(SLUG, 'github-dev-collab')

    expect(result.installedMcps).toEqual([])
    expect(result.installedSkills).toEqual([])
    expect(result.skippedMcps).toEqual(['github'])
    expect(result.skippedSkills).toEqual(['code-review', 'bug-hunt', 'release-notes'])
    expect(result.errors).toEqual([])

    // manifest 仍只有一条记录
    expect(getInstalledPluginBundles(SLUG)).toHaveLength(1)
  })

  it('uninstallStoreBundle clears the manifest, removes the store MCP and skill dirs', () => {
    installStoreBundle(SLUG, 'github-dev-collab')

    const result = uninstallStoreBundle(SLUG, 'github-dev-collab')
    expect(result.ok).toBe(true)
    expect(result.removedMcps).toEqual(['github'])
    expect(result.removedSkills).toEqual(['code-review', 'bug-hunt', 'release-notes'])
    expect(result.errors).toEqual([])

    expect(getMcpConfig(SLUG).servers['github']).toBeUndefined()
    expect(existsSync(skillMd('code-review'))).toBe(false)
    expect(getInstalledPluginBundles(SLUG)).toHaveLength(0)
  })

  it('bundled skill without local resource is recorded as error and skipped (no fake success)', () => {
    const result = installStoreBundle(SLUG, 'office-suite')

    // 仅含 bundled Skill，无 MCP
    expect(result.installedMcps).toEqual([])
    expect(result.installedSkills).toEqual([])
    expect(result.errors).toHaveLength(5)
    // 每个 bundled skill 都有一条失败说明
    for (const slug of ['docx', 'pdf', 'xlsx', 'pptx', 'guizang-ppt-skill']) {
      expect(result.errors.some((e) => e.includes(slug))).toBe(true)
    }

    // 不应创建任何 skill 目录
    expect(existsSync(join(skillsDir(), 'docx'))).toBe(false)

    // 仍落盘 manifest 记录（卸载时按此清理）
    const installed = getInstalledPluginBundles(SLUG)
    expect(installed).toHaveLength(1)
    expect(installed[0]?.skills).toHaveLength(5)
  })

  it('uninstall preserves a user-customized MCP (command/args no longer match the store form)', () => {
    installStoreBundle(SLUG, 'github-dev-collab')

    // 模拟用户改过 args（与商店安装形态不一致）
    const cfg = getMcpConfig(SLUG)
    const github = cfg.servers['github']
    expect(github).toBeDefined()
    if (!github) return
    cfg.servers['github'] = { ...github, args: [...(github.args ?? []), '--custom-flag'] }
    saveMcpConfig(SLUG, cfg)

    const result = uninstallStoreBundle(SLUG, 'github-dev-collab')
    expect(result.ok).toBe(true)
    // 用户改过的 MCP 不应被删除
    expect(result.removedMcps).toEqual([])
    expect(getMcpConfig(SLUG).servers['github']).toBeDefined()

    // skill 目录无「匹配」保护，按记录删除
    expect(result.removedSkills).toEqual(['code-review', 'bug-hunt', 'release-notes'])
    expect(existsSync(skillMd('code-review'))).toBe(false)

    // manifest 记录始终移除
    expect(getInstalledPluginBundles(SLUG)).toHaveLength(0)
  })
})
