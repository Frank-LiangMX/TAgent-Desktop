/**
 * TAgent 插件商店目录
 *
 * - inline Skill：安装时写入轻量 SKILL.md（参考 Kun 推荐工作流）
 * - bundled Skill：从 app bundle `default-skills/` 复制（办公/规划等含脚本）
 * - 整合包：见 plugin-store-bundles.ts
 * - 不展示 Proma 设计包、Coach、tool-builder 等 legacy 条目
 */

import type { McpServerEntry } from './types/agent'

import { getPluginStoreBundles, type StorePluginBundle } from './plugin-store-bundles'

export const PREINSTALLED_SKILL_SLUGS: readonly string[] = []

/** 商店条目层级 */
export type PluginStoreTier = 'recommended' | 'optional'

/** Skill / MCP 场景分类 */
export type PluginStoreCategory = 'dev' | 'ta' | 'workflow' | 'office' | 'planning' | 'meta'

export type PluginStoreSkillInstallKind = 'inline' | 'bundled'

export interface BuiltinMcpEnvHint {
  key: string
  description: string
  required: boolean
}

export interface BuiltinMcpCatalogEntry {
  name: string
  displayName: string
  description: string
  category: PluginStoreCategory
  tier: PluginStoreTier
  installCommand: string
  installArgs: string[]
  envHints?: BuiltinMcpEnvHint[]
  docsUrl?: string
}

export interface PluginStoreSkillEntry {
  slug: string
  name: string
  description: string
  version: string
  category: PluginStoreCategory
  tier: PluginStoreTier
  installKind: PluginStoreSkillInstallKind
}

/** inline Skill 安装规格（含 SKILL.md 正文） */
export interface PluginStoreSkillInstallSpec extends PluginStoreSkillEntry {
  installKind: 'inline'
  body: string
}

/** bundled Skill 仅元数据，安装时从 default-skills 复制 */
export interface PluginStoreBundledSkillEntry extends PluginStoreSkillEntry {
  installKind: 'bundled'
}

export type PluginStoreSkillCatalogEntry =
  | PluginStoreSkillInstallSpec
  | PluginStoreBundledSkillEntry

const INLINE_STORE_SKILLS: PluginStoreSkillInstallSpec[] = [
  {
    slug: 'code-review',
    name: 'Code Review',
    description: '审查代码变更，优先发现缺陷、回归、安全问题和缺失测试。',
    version: '1.0.0',
    category: 'workflow',
    tier: 'recommended',
    installKind: 'inline',
    body: `# Code Review

审查代码变更时使用本 Skill。

1. 优先关注：正确性、回归、安全、性能、缺失测试。
2. 先列出**具体发现**与**文件/行号**，再给总结。
3. 区分必须修复与可后续改进。
4. 若变更缺少测试，指出应补哪些用例。`,
  },
  {
    slug: 'bug-hunt',
    name: 'Bug Hunt',
    description: '复现并定位问题，给出最小修复与验证路径。',
    version: '1.0.0',
    category: 'workflow',
    tier: 'recommended',
    installKind: 'inline',
    body: `# Bug Hunt

排查 Bug 时使用本 Skill。

1. 复现或收窄症状，确认触发条件。
2. 追踪数据流与最近相关改动。
3. 提出**最小可行修复**，避免过度重构。
4. 补充针对性验证（测试、日志或手动步骤）。`,
  },
  {
    slug: 'frontend-polish',
    name: 'Frontend Polish',
    description: '优化界面细节、响应式状态与视觉一致性。',
    version: '1.0.0',
    category: 'workflow',
    tier: 'recommended',
    installKind: 'inline',
    body: `# Frontend Polish

改进 UI 时使用本 Skill。

1. 保持产品现有风格与 token，不引入 Generic AI 模板感。
2. 检查常见断点与交互状态（hover、focus、loading）。
3. 优先改层次、间距、对比度，再考虑动效。
4. 交付前做视觉自检，说明改了什么、为什么。`,
  },
  {
    slug: 'release-notes',
    name: 'Release Notes',
    description: '整理面向用户的发布说明与升级注意事项。',
    version: '1.0.0',
    category: 'workflow',
    tier: 'recommended',
    installKind: 'inline',
    body: `# Release Notes

编写发布说明时使用本 Skill。

1. 按**用户可感知的结果**分组（新功能 / 改进 / 修复）。
2. 标注破坏性变更、迁移步骤与已知风险。
3. 语言简洁可扫读，避免堆砌内部实现细节。`,
  },
  {
    slug: 'csv-analysis',
    name: 'CSV 数据分析',
    description: '读取 CSV 文件，建立 SQLite 索引，生成交互式数据看板。',
    version: '1.0.0',
    category: 'workflow',
    tier: 'recommended',
    installKind: 'inline',
    body: `# CSV 数据分析

分析 CSV 数据时使用本 Skill。

## 工作流程

1. **加载数据** — 调用 csv_prepare 加载 CSV 文件到 SQLite，获取列结构和统计摘要。
2. **查询分析** — 调用 csv_query 按维度聚合/筛选/排序，获取分析结果。
3. **生成看板** — 调用 csv_dashboard 生成交互式 HTML 看板。

## 数据严谨性

- 所有涉及数据的问题必须调用 csv_query 查询，不得估算或猜测数字。
- 回答中必须引用查询结果和查询语句。
- 不确定时说"需要查询数据"而不是猜测。

## csv_dashboard sections_json 字段结构

**stats 卡片**（data 是 label→value 扁平对象）:
\`\`\`json
{"type":"stats", "data":{"资源总数":"999,999","总体积":"40.6 GB","最大引用":"399次"}}
\`\`\`

**chart 饼图/水平柱图**（data 是 label→number 扁平对象）:
\`\`\`json
{"type":"chart", "chart_type":"pie", "title":"分类分布", "data":{"贴图":25.97,"模型":5.97,"烘焙":6.37}}
\`\`\`

**chart 柱状图**（data 是 [{name,value}] 数组）:
\`\`\`json
{"type":"chart", "chart_type":"bar", "title":"模块体积", "data":[{"name":"地形","value":8.29},{"name":"建筑","value":4.67}]}
\`\`\`

**table 表格**（columns + rows）:
\`\`\`json
{"type":"table", "title":"明细", "columns":["分类","数量","体积"], "rows":[{"分类":"贴图","数量":664879,"体积":"25.97GB"}], "sortable":true, "paginated":true}
\`\`\`

## 看板类型

- **总览看板** — 调用 csv_dashboard(action="create") 生成包含统计卡片、图表、表格的完整看板。
- **聚焦视图** — 调用 csv_dashboard(action="add_view") 追加特定分类的聚焦分析视图。
- **临时查询** — 维度少时直接用 markdown 表格回答，不需要生成看板。`,
  },
]

/** bundled Skill 元数据（目录在 apps/electron/default-skills/） */
const BUNDLED_STORE_SKILLS: PluginStoreBundledSkillEntry[] = [
  {
    slug: 'docx',
    name: 'Word 文档',
    description: '创建、编辑、读取 .docx：报告、备忘录、模板与 tracked changes。',
    version: '1.0.0',
    category: 'office',
    tier: 'recommended',
    installKind: 'bundled',
  },
  {
    slug: 'pdf',
    name: 'PDF',
    description: '合并、拆分、提取、OCR、表单填写等 PDF 操作。',
    version: '1.0.0',
    category: 'office',
    tier: 'recommended',
    installKind: 'bundled',
  },
  {
    slug: 'xlsx',
    name: 'Excel 表格',
    description: '读写 .xlsx / .csv：公式、格式、图表与数据清洗。',
    version: '1.0.0',
    category: 'office',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'pptx',
    name: 'PowerPoint',
    description: '创建与编辑演示文稿、读取幻灯片内容与模板。',
    version: '1.0.0',
    category: 'office',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'guizang-ppt-skill',
    name: '网页 PPT',
    description: '生成可分享的横向翻页 HTML 演示（杂志风 / 瑞士网格风）。',
    version: '1.0.0',
    category: 'office',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'brainstorming',
    name: '需求澄清',
    description: '动手写代码前先对齐意图、约束与方案，避免直接开干。',
    version: '1.0.0',
    category: 'planning',
    tier: 'recommended',
    installKind: 'bundled',
  },
  {
    slug: 'writing-plans',
    name: '编写计划',
    description: '有多步骤需求时，先写可执行计划再进入实现。',
    version: '1.0.0',
    category: 'planning',
    tier: 'recommended',
    installKind: 'bundled',
  },
  {
    slug: 'executing-plans',
    name: '执行计划',
    description: '按书面计划在独立阶段推进，并在检查点复盘。',
    version: '1.0.0',
    category: 'planning',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'systematic-debugging',
    name: '系统化调试',
    description: '遇到 bug / 测试失败 / 异常行为时，先找根因再修，避免盲目 patch。',
    version: '1.0.0',
    category: 'dev',
    tier: 'recommended',
    installKind: 'bundled',
  },
  {
    slug: 'test-driven-development',
    name: '测试驱动开发',
    description: 'RED-GREEN-REFACTOR 循环：先写失败测试，再写实现，最后重构。',
    version: '1.0.0',
    category: 'dev',
    tier: 'recommended',
    installKind: 'bundled',
  },
  {
    slug: 'verification-before-completion',
    name: '完成前验证',
    description: '声称工作完成前，必须跑验证命令并确认输出——证据先于断言。',
    version: '1.0.0',
    category: 'dev',
    tier: 'recommended',
    installKind: 'bundled',
  },
  {
    slug: 'subagent-driven-development',
    name: '子代理驱动开发',
    description: '把任务拆给独立子代理执行，含两阶段审查（规范合规 + 代码质量）。',
    version: '1.0.0',
    category: 'dev',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'dispatching-parallel-agents',
    name: '并行子代理派发',
    description: '判断任务该并行还是串行，避免子代理间冲突。',
    version: '1.0.0',
    category: 'dev',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'requesting-code-review',
    name: '请求代码审查',
    description: '作为被审查者，如何发起审查请求并准备审查材料。',
    version: '1.0.0',
    category: 'dev',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'receiving-code-review',
    name: '接收代码审查',
    description: '如何接收审查反馈、判断采纳与回应，形成闭环。',
    version: '1.0.0',
    category: 'dev',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'using-git-worktrees',
    name: 'Git Worktree 隔离',
    description: '用 git worktree 在独立工作树中开发，避免污染主分支。',
    version: '1.0.0',
    category: 'dev',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'finishing-a-development-branch',
    name: '完成开发分支',
    description: '分支开发完成后的收尾流程：测试、diff 检查、合并/PR 决策。',
    version: '1.0.0',
    category: 'dev',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'using-superpowers',
    name: 'Superpowers 框架引导',
    description: 'Superpowers skill 集合的总目录与调用入口（框架自组织）。',
    version: '1.0.0',
    category: 'meta',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'writing-skills',
    name: 'Skill 编写方法论',
    description: '教 Agent 如何编写高质量的 SKILL.md——frontmatter、description、目录结构规范。',
    version: '1.0.0',
    category: 'meta',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'skill-creator',
    name: 'Skill 创作器',
    description: '创建、迭代与评估自定义 Skill（含脚本与 eval 工具）。',
    version: '1.0.0',
    category: 'meta',
    tier: 'optional',
    installKind: 'bundled',
  },
  {
    slug: 'find-skills',
    name: '发现 Skill',
    description: '帮用户查找可能已存在的 Skill 或扩展能力的路径。',
    version: '1.0.0',
    category: 'meta',
    tier: 'optional',
    installKind: 'bundled',
  },
]

export const TAGENT_STORE_SKILL_CATALOG: PluginStoreSkillCatalogEntry[] = [
  ...INLINE_STORE_SKILLS,
  ...BUNDLED_STORE_SKILLS,
]

/** 插件商店 MCP 目录（参考 Kun RECOMMENDED_ITEMS，去掉与 SDK 重复项） */
export const BUILTIN_MCP_CATALOG: BuiltinMcpCatalogEntry[] = [
  {
    name: 'context7',
    displayName: 'Context7 文档查询',
    description: '为编码任务拉取最新库/框架文档，适合查 API 与版本差异。',
    category: 'dev',
    tier: 'recommended',
    installCommand: 'npx',
    installArgs: ['-y', '@upstash/context7-mcp'],
    docsUrl: 'https://github.com/upstash/context7-mcp',
  },
  {
    name: 'github',
    displayName: 'GitHub',
    description: '读取仓库、Issue、Pull Request 与代码搜索上下文。',
    category: 'dev',
    tier: 'recommended',
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-github'],
    envHints: [
      { key: 'GITHUB_TOKEN', description: 'GitHub PAT (classic or fine-grained)', required: true },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    name: 'playwright',
    displayName: 'Playwright 浏览器',
    description: '自动化真实浏览器：打开页面、点击、截图与可访问性检查。',
    category: 'dev',
    tier: 'recommended',
    installCommand: 'npx',
    installArgs: ['-y', '@playwright/mcp@latest'],
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    name: 'brave-search',
    displayName: 'Brave Search',
    description: '通过 Brave Search API 检索网页（需自行申请 API Key）。',
    category: 'dev',
    tier: 'optional',
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-brave-search'],
    envHints: [{ key: 'BRAVE_API_KEY', description: 'Brave Search API Key', required: true }],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    name: 'sequential-thinking',
    displayName: 'Sequential Thinking',
    description: '把复杂任务拆成可追踪的推理步骤（偏辅助，非必需）。',
    category: 'dev',
    tier: 'optional',
    installCommand: 'npx',
    installArgs: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    name: 'ta-agent-mcp',
    displayName: 'TA Agent MCP',
    description: 'Technical Artist 工具链：资产检查、命名规范、FBX 分析等（TA 模式）。',
    category: 'ta',
    tier: 'recommended',
    installCommand: 'python',
    installArgs: ['-m', 'ta_agent_mcp'],
    envHints: [
      { key: 'TA_AGENT_DATA_DIR', description: 'TA 数据目录，默认 ~/.tagent/ta/', required: false },
    ],
    docsUrl:
      'https://github.com/Frank-LiangMX/TAgent_General/tree/main/apps/electron/default-mcp/ta-agent-mcp',
  },
  {
    name: 'tagent-csv',
    displayName: 'TAgent CSV 数据分析',
    description: '读取 CSV 文件，建立 SQLite 索引，生成交互式数据看板（图表+可排序表格）。',
    category: 'workflow',
    tier: 'recommended',
    installCommand: 'builtin',
    installArgs: [],
    docsUrl:
      'https://github.com/Frank-LiangMX/TAgent_General/tree/main/apps/electron/src/main/lib/tools/csv-prepare-tool.ts',
  },
]

export interface PluginStoreCatalog {
  bundles: StorePluginBundle[]
  skills: PluginStoreSkillEntry[]
  mcps: BuiltinMcpCatalogEntry[]
}

/** 整合包安装结果 */
export interface InstallStoreBundleResult {
  bundleId: string
  installedSkills: string[]
  skippedSkills: string[]
  installedMcps: string[]
  skippedMcps: string[]
  errors: string[]
}

export function buildPluginStoreCatalog(): PluginStoreCatalog {
  return {
    bundles: getPluginStoreBundles(),
    skills: getPluginStoreSkills(),
    mcps: BUILTIN_MCP_CATALOG,
  }
}

/** 将商店 MCP 条目转为 McpServerEntry（写入 mcp.json） */
export function mcpCatalogEntryToServerEntry(mcp: BuiltinMcpCatalogEntry): McpServerEntry {
  return {
    type: 'stdio',
    command: mcp.installCommand,
    args: mcp.installArgs,
    enabled: false,
  }
}

export function getPluginStoreSkills(): PluginStoreSkillEntry[] {
  return TAGENT_STORE_SKILL_CATALOG.map(
    ({ slug, name, description, version, category, tier, installKind }) => ({
      slug,
      name,
      description,
      version,
      category,
      tier,
      installKind,
    })
  )
}

export function getStoreSkillCatalogEntry(slug: string): PluginStoreSkillCatalogEntry | undefined {
  return TAGENT_STORE_SKILL_CATALOG.find((skill) => skill.slug === slug)
}

/** @deprecated 使用 getStoreSkillCatalogEntry */
export function getStoreSkillInstallSpec(slug: string): PluginStoreSkillInstallSpec | undefined {
  const entry = getStoreSkillCatalogEntry(slug)
  return entry?.installKind === 'inline' ? entry : undefined
}

export function isBundledStoreSkill(slug: string): boolean {
  return getStoreSkillCatalogEntry(slug)?.installKind === 'bundled'
}

export function getRecommendedDevMcps(): BuiltinMcpCatalogEntry[] {
  return BUILTIN_MCP_CATALOG.filter((m) => m.category === 'dev' && m.tier === 'recommended')
}

export function getTaMcps(): BuiltinMcpCatalogEntry[] {
  return BUILTIN_MCP_CATALOG.filter((m) => m.category === 'ta')
}

/** @deprecated 使用 TAGENT_STORE_SKILL_CATALOG */
export const TAGENT_RECOMMENDED_STORE_SKILLS = INLINE_STORE_SKILLS
