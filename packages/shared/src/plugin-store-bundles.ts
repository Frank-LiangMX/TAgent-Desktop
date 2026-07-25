/**
 * TAgent 插件商店 — 整合包定义
 *
 * 整合包 = 一次 Get 安装的一组 MCP + Skill；单条条目仍保留在扁平 catalog 中。
 */

import type { PluginStoreCategory, PluginStoreTier } from './plugin-store-catalog'

/** 整合包 logo：renderer 内 assets 路径键名 */
export type PluginStoreLogoKey =
  | 'ta-agent-suite'
  | 'github-dev-collab'
  | 'frontend-e2e'
  | 'context7-docs'
  | 'office-suite'
  | 'planning-suite'
  | 'skill-workshop'
  | 'superpowers-full'
  | 'csv-analysis'

export interface StorePluginBundle {
  id: string
  name: string
  description: string
  category: PluginStoreCategory
  tier: PluginStoreTier
  /** MCP 名称（对应 BUILTIN_MCP_CATALOG.name） */
  mcps: readonly string[]
  /** Skill slug（对应 TAGENT_STORE_SKILL_CATALOG.slug） */
  skills: readonly string[]
  logo: PluginStoreLogoKey
  publisher: string
  repositoryUrl: string
  homepageUrl?: string
}

const TAGENT_REPO = 'https://github.com/Frank-LiangMX/TAgent_General/tree/main/apps/electron'

export const TAGENT_STORE_PLUGIN_BUNDLES: readonly StorePluginBundle[] = [
  {
    id: 'ta-agent-suite',
    name: 'TA Agent 套件',
    description: 'Technical Artist 工具链 MCP：资产检查、命名规范、网格与贴图分析等（TA 模式）。',
    category: 'ta',
    tier: 'recommended',
    mcps: ['ta-agent-mcp'],
    skills: [],
    logo: 'ta-agent-suite',
    publisher: 'TAgent',
    repositoryUrl: `${TAGENT_REPO}/default-mcp/ta-agent-mcp`,
  },
  {
    id: 'github-dev-collab',
    name: 'GitHub 开发协作',
    description: 'GitHub MCP + 代码审查、Bug 排查与发布说明工作流 Skill。',
    category: 'dev',
    tier: 'recommended',
    mcps: ['github'],
    skills: ['code-review', 'bug-hunt', 'release-notes'],
    logo: 'github-dev-collab',
    publisher: 'TAgent',
    repositoryUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    homepageUrl: 'https://github.com/',
  },
  {
    id: 'frontend-e2e',
    name: '前端与 E2E 测试',
    description: 'Playwright 浏览器自动化 MCP + 前端界面打磨 Skill。',
    category: 'dev',
    tier: 'recommended',
    mcps: ['playwright'],
    skills: ['frontend-polish'],
    logo: 'frontend-e2e',
    publisher: 'TAgent',
    repositoryUrl: 'https://github.com/microsoft/playwright-mcp',
    homepageUrl: 'https://playwright.dev/',
  },
  {
    id: 'context7-docs',
    name: '库文档助手',
    description: 'Context7 MCP：为编码任务拉取最新库/框架文档与 API 说明。',
    category: 'dev',
    tier: 'recommended',
    mcps: ['context7'],
    skills: [],
    logo: 'context7-docs',
    publisher: 'TAgent',
    repositoryUrl: 'https://github.com/upstash/context7-mcp',
    homepageUrl: 'https://context7.com/',
  },
  {
    id: 'office-suite',
    name: '办公文档套件',
    description: 'Word / PDF / Excel / PPT 与网页演示 Skill（与 Anthropic document-skills 同源）。',
    category: 'office',
    tier: 'recommended',
    mcps: [],
    skills: ['docx', 'pdf', 'xlsx', 'pptx', 'guizang-ppt-skill'],
    logo: 'office-suite',
    publisher: 'TAgent',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills',
    homepageUrl: 'https://github.com/anthropics/skills',
  },
  {
    id: 'skill-workshop',
    name: 'Skill 扩展工坊',
    description: '创建、迭代 Skill 与发现已有能力路径的 meta 工具包。',
    category: 'meta',
    tier: 'optional',
    mcps: [],
    skills: ['skill-creator', 'find-skills'],
    logo: 'skill-workshop',
    publisher: 'TAgent',
    repositoryUrl: `${TAGENT_REPO}/default-skills/skill-creator`,
  },
  {
    id: 'superpowers-full',
    name: 'Superpowers 完整开发方法论',
    description:
      'Jesse Vincent 的 Superpowers 全套 14 个 skill：头脑风暴、计划、TDD、系统化调试、子代理开发、代码审查、worktree 隔离、完成前验证等完整工作流。',
    category: 'dev',
    tier: 'recommended',
    mcps: [],
    skills: [
      'brainstorming',
      'writing-plans',
      'executing-plans',
      'systematic-debugging',
      'test-driven-development',
      'verification-before-completion',
      'subagent-driven-development',
      'dispatching-parallel-agents',
      'requesting-code-review',
      'receiving-code-review',
      'using-git-worktrees',
      'finishing-a-development-branch',
      'using-superpowers',
      'writing-skills',
    ],
    logo: 'superpowers-full',
    publisher: 'Superpowers (Jesse Vincent)',
    repositoryUrl: 'https://github.com/obra/superpowers',
    homepageUrl: 'https://github.com/obra/superpowers',
  },
  {
    id: 'csv-analysis',
    name: 'CSV 数据分析看板',
    description: '读取任意 CSV 文件，自动推断列结构，生成交互式数据看板（图表+可排序表格）。',
    category: 'workflow',
    tier: 'recommended',
    mcps: ['tagent-csv'],
    skills: ['csv-analysis'],
    logo: 'csv-analysis',
    publisher: 'TAgent',
    repositoryUrl: `${TAGENT_REPO}/src/main/lib/tools/csv-prepare-tool.ts`,
  },
] as const

export function getPluginStoreBundles(): StorePluginBundle[] {
  return [...TAGENT_STORE_PLUGIN_BUNDLES]
}

export function getStorePluginBundle(bundleId: string): StorePluginBundle | undefined {
  return TAGENT_STORE_PLUGIN_BUNDLES.find((bundle) => bundle.id === bundleId)
}

/** 工作区已安装整合包记录（plugins-installed.json） */
export interface WorkspacePluginBundleRecord {
  bundleId: string
  source: 'store'
  installedAt: string
  mcps: string[]
  skills: string[]
}

export interface WorkspacePluginsInstalledManifest {
  version: 1
  bundles: Record<string, WorkspacePluginBundleRecord>
}

export function createEmptyPluginsInstalledManifest(): WorkspacePluginsInstalledManifest {
  return { version: 1, bundles: {} }
}
