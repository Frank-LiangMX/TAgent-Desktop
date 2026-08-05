/**
 * 内置子代理定义 + System Prompt 委派策略
 *
 * C3：通过角色库投影生成 AgentDefinition（roleToSubagentDef），
 * 操作型 explorer/researcher 用 seed 角色；code-reviewer → 岗位 reviewer。
 * 亦可按角色库 id（analyst/coder/…）委派。
 *
 * kscc：SDK agents 选项；Pi：subagent-task-tool。
 */
import type { AgentDefinition } from '@tagent/shared'
import {
  DEFAULT_SUBAGENT_EAGERNESS,
  type SubagentEagerness,
} from '@tagent/shared'
import { getRoleById, resolveRole } from '../role/agent-role-service'
import {
  getOperationalSubagentRoles,
  OPERATIONAL_TO_ROLE_ID,
  roleToSubagentDef,
  SUBAGENT_CATALOG_ROLE_IDS,
} from '../role/role-projection'

export interface BuildSubagentDefinitionsOptions {
  /** Claude 渠道：子代理默认 haiku；非 Claude 省略 model 继承主模型 */
  claudeAvailable?: boolean
}

/**
 * 解析单个 subagent 类型 → 定义
 * 顺序：操作型 seed → 操作名映射岗位 → 角色库 id
 */
export function resolveSubagentDefinition(
  type: string,
  options: BuildSubagentDefinitionsOptions = {},
): AgentDefinition | undefined {
  const claudeAvailable = options.claudeAvailable !== false
  const opts = { claudeAvailable, purpose: 'subagent' as const }

  // 1. 操作型 explorer / researcher
  const operational = getOperationalSubagentRoles().find((r) => r.id === type)
  if (operational) {
    return roleToSubagentDef(operational, opts)
  }

  // 2. 操作名 → 岗位（code-reviewer → reviewer）
  const mappedRoleId = OPERATIONAL_TO_ROLE_ID[type]
  if (mappedRoleId) {
    return roleToSubagentDef(resolveRole(mappedRoleId), opts)
  }

  // 3. 角色库 id
  const role = getRoleById(type)
  if (role) {
    return roleToSubagentDef(role, opts)
  }

  return undefined
}

/**
 * 构建 SubAgent 目录（传给 SDK agents / Pi task 查找表）
 *
 * 含：explorer、researcher、code-reviewer + 短列表岗位角色
 */
export function buildBuiltinSubagentDefinitions(
  claudeAvailable = true,
): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {}
  const opts = { claudeAvailable, purpose: 'subagent' as const }

  for (const role of getOperationalSubagentRoles()) {
    agents[role.id] = roleToSubagentDef(role, opts)
  }

  // code-reviewer：从角色库 reviewer 投影（缺省走 resolveRole 兜底）
  agents['code-reviewer'] = roleToSubagentDef(resolveRole('reviewer'), opts)

  for (const roleId of SUBAGENT_CATALOG_ROLE_IDS) {
    if (agents[roleId]) continue
    try {
      agents[roleId] = roleToSubagentDef(resolveRole(roleId), opts)
    } catch {
      // DEFAULT_ROLES 异常时跳过
    }
  }

  return agents
}

/**
 * 子代理委派策略（注入主 Agent system prompt）
 *
 * @param eagerness 委派积极性档位（never/conservative/balanced/aggressive）
 */
export function buildSubagentDelegationPrompt(
  eagerness: SubagentEagerness = DEFAULT_SUBAGENT_EAGERNESS,
): string {
  const modelHint = '渠道默认 / haiku'
  const catalog = buildBuiltinSubagentDefinitions(true)
  const subagentList = Object.entries(catalog)
    .map(([name, def]) => {
      const short =
        def.description.length > 72 ? `${def.description.slice(0, 72)}…` : def.description
      return `- **${name}**（${def.model ?? modelHint}）：${short}`
    })
    .join('\n')

  const eagernessGuide: Record<string, string> = {
    never: '你不会主动委派子代理，只有用户明确要求时才使用。',
    conservative:
      '默认自己先读少量关键文件；仅当任务明显跨多目录/需隔离上下文时才委派。**默认最多 1 个**子代理，确有必要再开第 2 个；禁止为「分析项目」之类问题并行甩 3 个探索子代理。',
    balanced:
      '独立子任务可委派以保持主上下文干净。**并行默认 ≤2**；只有互不依赖且收益明确时才并行。',
    aggressive:
      '优先委派，主会话偏编排。仍避免无意义堆叠：同一问题不要重复开多个同质 explorer。',
  }

  return `## SubAgent 委派策略

**核心原则：主会话干净、少而准。** 子代理在 UI 只显示一张进度卡；滥开会拖慢任务、浪费 token。

当前委派积极性：**${eagerness}** — ${eagernessGuide[eagerness]}

### 可用 SubAgent（角色库投影 + 操作型）

系统已预定义以下子代理（岗位角色来自角色库；prompt/工具/模型由角色投影）：

${subagentList}

也可使用角色库中的其它 \`roleId\`（若已安装）。子代理默认继承渠道模型或 haiku（Claude 渠道），角色配置了 modelPool 时优先池内首项。

### 何时委派 SubAgent

- 需要深入探索**单一**大目录且会淹没主上下文 → 委派 1 个 \`explorer\`
- 需要调研技术方案、对比多个选项 → 委派 \`researcher\`
- 代码修改完成后做质量检查 → 委派 \`code-reviewer\`（岗位：代码审查员）
- 需要架构/实现向短任务 → 委派 \`analyst\` / \`coder\`
- **不要**对「分析一下项目」这类总览问题默认并行多开；应先主会话摸骨架，再按需委派

### 委派最佳实践

- 给 SubAgent **清晰、可验收**的任务描述（要收集什么、返回什么格式）
- **克制并行**：先 1 个拿结果，不够再开；禁止同时开多个同质 explorer 扫同一仓库
- SubAgent 返回后在主上下文整合结论，用自然语言回用户
- 主会话自己能用几次 Glob/Read 解决的，不要委派`
}
