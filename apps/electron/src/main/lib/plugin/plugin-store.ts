/**
 * 插件商店服务（主进程 lib）
 *
 * 产品单位 = 整合包 Bundle（参考 Cursor/Codex/TAgent_General）。
 * 职责：从商店安装/卸载整合包——打包写 MCP（复用 mcp-store）+ 写 Skill（inline
 * SKILL.md；bundled 资源未随本应用分发则记入 errors 并 skip，不假成功）+ 维护
 * 工作区 plugins-installed.json。
 *
 * 不引 electron，纯 node fs/path，可在 vitest 中直接测（与 mcp-store/workspace-manager 同风格）。
 * 逻辑参考 TAgent_General agent-workspace-manager.installStore*，精简移殖，UI 不在此处。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILTIN_MCP_CATALOG,
  mcpCatalogEntryToServerEntry,
  buildPluginStoreCatalog,
  getStorePluginBundle,
  getStoreSkillCatalogEntry,
  createEmptyPluginsInstalledManifest,
  type McpServerEntry,
  type PluginStoreCatalog,
  type InstallStoreBundleResult,
  type WorkspacePluginBundleRecord,
  type WorkspacePluginsInstalledManifest,
  type PluginStoreSkillInstallSpec,
} from '@tagent/shared'
import { getProjectDir } from '../config/config-paths'
import { getMcpConfig, saveMcpConfig } from '../mcp/mcp-store'

/** plugins-installed.json 文件名（工作区内） */
const PLUGINS_INSTALLED_FILENAME = 'plugins-installed.json'
/** 工作区 skills 根目录名：projects/{slug}/skills/ */
const SKILLS_DIRNAME = 'skills'
const SKILL_MD_FILENAME = 'SKILL.md'

/** 卸载整合包结果 */
export interface UninstallStoreBundleResult {
  ok: boolean
  /** 实际从 mcp.json 移除的 MCP 名称（仅仍匹配商店安装形态的） */
  removedMcps: string[]
  /** 实际删除的 Skill 目录 */
  removedSkills: string[]
  /** 卸载过程中发生的错误（如 Skill 目录删除失败） */
  errors: string[]
}

/** 工作区 skills 根目录：projects/{slug}/skills/ */
function getProjectSkillsDir(slug: string): string {
  return join(getProjectDir(slug), SKILLS_DIRNAME)
}

/** 工作区 plugins-installed.json 路径：projects/{slug}/plugins-installed.json */
function getPluginsInstalledPath(slug: string): string {
  return join(getProjectDir(slug), PLUGINS_INSTALLED_FILENAME)
}

/** 读 plugins-installed.json；缺失/损坏返回空 manifest（不抛） */
function readPluginsInstalledManifest(slug: string): WorkspacePluginsInstalledManifest {
  const path = getPluginsInstalledPath(slug)
  if (!existsSync(path)) return createEmptyPluginsInstalledManifest()
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<WorkspacePluginsInstalledManifest>
    if (!parsed || parsed.version !== 1 || !parsed.bundles || typeof parsed.bundles !== 'object') {
      return createEmptyPluginsInstalledManifest()
    }
    return { version: 1, bundles: parsed.bundles }
  } catch (err) {
    console.warn('[插件商店] 读取 plugins-installed.json 失败，按空处理:', err)
    return createEmptyPluginsInstalledManifest()
  }
}

function writePluginsInstalledManifest(
  slug: string,
  manifest: WorkspacePluginsInstalledManifest
): void {
  writeFileSync(getPluginsInstalledPath(slug), JSON.stringify(manifest, null, 2), 'utf-8')
}

/** 工作区是否已存在同名 Skill（仅检查 active skills 根） */
function workspaceHasSkill(slug: string, skillSlug: string): boolean {
  return existsSync(join(getProjectSkillsDir(slug), skillSlug))
}

// ===== 读取 =====

/** 获取插件商店目录（整合包 + Skill + MCP） */
export function getPluginStoreCatalog(): PluginStoreCatalog {
  return buildPluginStoreCatalog()
}

/** 获取工作区已安装整合包记录列表（来自 plugins-installed.json） */
export function getInstalledPluginBundles(slug: string): WorkspacePluginBundleRecord[] {
  return Object.values(readPluginsInstalledManifest(slug).bundles)
}

// ===== 安装 =====

/**
 * 从商店安装单个 MCP 到工作区 mcp.json。
 * 用 mcpCatalogEntryToServerEntry + enabled: true 写入；已存在则 skip（不动用户配置）。
 */
export function installStoreMcp(slug: string, mcpName: string): 'installed' | 'skipped' {
  const catalogEntry = BUILTIN_MCP_CATALOG.find((mcp) => mcp.name === mcpName)
  if (!catalogEntry) {
    throw new Error(`插件商店中不存在该 MCP: ${mcpName}`)
  }

  const config = getMcpConfig(slug)
  if (config.servers[mcpName]) return 'skipped'

  config.servers[mcpName] = {
    ...mcpCatalogEntryToServerEntry(catalogEntry),
    enabled: true,
  }
  saveMcpConfig(slug, config)
  console.log(`[插件商店] 已安装 MCP: ${slug}/${mcpName}`)
  return 'installed'
}

/**
 * 从商店安装单个 Skill 到工作区 skills 根。
 * - inline：写 SKILL.md（frontmatter + body）
 * - bundled：本应用未随附 bundled 资源目录 → 抛错，由调用方记入 errors 并 skip（不假成功）
 */
export function installStoreSkill(slug: string, skillSlug: string): void {
  const spec = getStoreSkillCatalogEntry(skillSlug)
  if (!spec) {
    throw new Error(`插件商店中不存在该 Skill: ${skillSlug}`)
  }

  if (spec.installKind === 'inline') {
    if (workspaceHasSkill(slug, skillSlug)) {
      throw new Error(`当前工作区已存在同名 Skill: ${skillSlug}`)
    }
    const targetDir = join(getProjectSkillsDir(slug), skillSlug)
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, SKILL_MD_FILENAME), buildInlineSkillMd(spec), 'utf-8')
    console.log(`[插件商店] 已安装 Skill: ${slug}/${skillSlug}`)
    return
  }

  // bundled：本应用未分发 bundled 资源目录，无法安装（不假成功）
  throw new Error(`bundled Skill 资源未随本应用分发，暂不可安装: ${skillSlug}`)
}

/**
 * 从插件商店安装整合包：打包写 MCP + 可装 Skill + 写 manifest。
 * 已存在的 MCP/Skip 跳过；bundled Skill 缺资源则记入 errors 并 skip（不假成功）。
 * manifest 始终落盘一条该 bundle 的记录（卸载时按此清理）。
 */
export function installStoreBundle(
  slug: string,
  bundleId: string
): InstallStoreBundleResult {
  const bundle = getStorePluginBundle(bundleId)
  if (!bundle) {
    throw new Error(`插件商店中不存在该整合包: ${bundleId}`)
  }

  const result: InstallStoreBundleResult = {
    bundleId,
    installedSkills: [],
    skippedSkills: [],
    installedMcps: [],
    skippedMcps: [],
    errors: [],
  }

  for (const skillSlug of bundle.skills) {
    try {
      if (workspaceHasSkill(slug, skillSlug)) {
        result.skippedSkills.push(skillSlug)
        continue
      }
      installStoreSkill(slug, skillSlug)
      result.installedSkills.push(skillSlug)
    } catch (error) {
      result.errors.push(`Skill ${skillSlug}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const mcpName of bundle.mcps) {
    try {
      const status = installStoreMcp(slug, mcpName)
      if (status === 'installed') result.installedMcps.push(mcpName)
      else result.skippedMcps.push(mcpName)
    } catch (error) {
      result.errors.push(`MCP ${mcpName}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const manifest = readPluginsInstalledManifest(slug)
  manifest.bundles[bundleId] = {
    bundleId,
    source: 'store',
    installedAt: new Date().toISOString(),
    mcps: [...bundle.mcps],
    skills: [...bundle.skills],
  }
  writePluginsInstalledManifest(slug, manifest)

  console.log(
    `[插件商店] 安装整合包 ${slug}/${bundleId}: +${result.installedMcps.length} MCP, +${result.installedSkills.length} Skill` +
      (result.errors.length ? `, ${result.errors.length} 项失败` : '')
  )
  return result
}

// ===== 卸载 =====

/**
 * 卸载整合包：
 * - 从 manifest 删除该 bundle 记录
 * - 移除该 bundle 记录的 MCP（仅当 mcp.json 条目仍匹配商店安装形态 command/args 时可删，
 *   避免误删用户改过的自定义）
 * - 删除该 bundle 记录的 Skill 目录（存在则 rm）
 */
export function uninstallStoreBundle(
  slug: string,
  bundleId: string
): UninstallStoreBundleResult {
  const manifest = readPluginsInstalledManifest(slug)
  const record = manifest.bundles[bundleId]
  if (!record) {
    return { ok: false, removedMcps: [], removedSkills: [], errors: [] }
  }

  const errors: string[] = []

  // MCP：仅删仍匹配商店安装形态的条目
  const config = getMcpConfig(slug)
  const removedMcps: string[] = []
  for (const mcpName of record.mcps) {
    const existing = config.servers[mcpName]
    if (!existing) continue
    if (mcpEntryMatchesStore(mcpName, existing)) {
      delete config.servers[mcpName]
      removedMcps.push(mcpName)
    }
  }
  saveMcpConfig(slug, config)

  // Skill：删除记录的 skill 目录（存在则 rm）
  const removedSkills: string[] = []
  for (const skillSlug of record.skills) {
    const skillDir = join(getProjectSkillsDir(slug), skillSlug)
    if (!existsSync(skillDir)) continue
    try {
      rmSync(skillDir, { recursive: true, force: true })
      removedSkills.push(skillSlug)
    } catch (error) {
      errors.push(`Skill ${skillSlug}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  delete manifest.bundles[bundleId]
  writePluginsInstalledManifest(slug, manifest)

  console.log(
    `[插件商店] 卸载整合包 ${slug}/${bundleId}: -${removedMcps.length} MCP, -${removedSkills.length} Skill`
  )
  return { ok: true, removedMcps, removedSkills, errors }
}

// ===== 内部 =====

/**
 * 判断 mcp.json 中的条目是否仍与商店安装形态一致（type=stdio 且 command/args 未被用户改过）。
 * 不一致（用户改过或已删除）则保留，避免误删用户自定义。
 */
function mcpEntryMatchesStore(mcpName: string, entry: McpServerEntry): boolean {
  const catalogEntry = BUILTIN_MCP_CATALOG.find((mcp) => mcp.name === mcpName)
  if (!catalogEntry) return false
  if (entry.type !== 'stdio') return false // 商店 MCP 一律 stdio

  const catalogCommand = catalogEntry.installCommand ?? ''
  if ((entry.command ?? '') !== catalogCommand) return false

  const catalogArgs = catalogEntry.installArgs ?? []
  const entryArgs = entry.args ?? []
  if (catalogArgs.length !== entryArgs.length) return false
  for (let i = 0; i < catalogArgs.length; i++) {
    if (catalogArgs[i] !== entryArgs[i]) return false
  }
  return true
}

/** 构造 inline Skill 的 SKILL.md（frontmatter + body） */
function buildInlineSkillMd(spec: PluginStoreSkillInstallSpec): string {
  return [
    '---',
    `name: ${spec.slug}`,
    `description: ${JSON.stringify(spec.description)}`,
    `version: "${spec.version}"`,
    `category: ${spec.category}`,
    `tier: ${spec.tier}`,
    '---',
    '',
    spec.body.trim(),
    '',
  ].join('\n')
}
