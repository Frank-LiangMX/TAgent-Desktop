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
import { buildDelegationModelPrompt } from './delegation-model-policy'
import { readAgentCrewPrefs } from './agent-crew-prefs'

export interface BuildSubagentDefinitionsOptions {
  /** 是否存在可用的 Claude 渠道；未提供时按角色投影规则继承主模型 */
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
  const catalog = buildBuiltinSubagentDefinitions(false)
  const subagentList = Object.entries(catalog)
    .map(([name, def]) => {
      const short =
        def.description.length > 72 ? `${def.description.slice(0, 72)}…` : def.description
      return `- **${name}**：${short}`
    })
    .join('\n')

  const eagernessGuide: Record<string, string> = {
    never: '你不会主动委派子代理，只有用户明确要求时才使用。',
    conservative:
      '默认自己先处理小任务；只有独立且确有收益的任务才委派。大项目按子系统异质分工并行，禁止同质冗余。',
    balanced:
      '独立子任务积极委派以保持主上下文干净；按模块异质分工并行，禁止同质冗余。',
    aggressive:
      '优先委派独立子任务，主会话负责编排、验收与整合；禁止同质冗余。',
  }
  const maxParallelWorkers = readAgentCrewPrefs().maxParallelWorkers

  return `## SubAgent 委派策略

**核心原则：主会话干净、少而准。** 子代理在 UI 只显示一张进度卡；滥开会拖慢任务、浪费 token。

当前委派积极性：**${eagerness}** — ${eagernessGuide[eagerness]}

${buildDelegationModelPrompt()}

### 并行上限

子代理并行上限：**${maxParallelWorkers}** 个 worker。班组编排已暂停，但已有班组数据保留；不要使用班组派工。按任务独立性与收益决定是否并行。

### 可用 SubAgent（角色库投影 + 操作型）

系统已预定义以下子代理（岗位角色来自角色库；prompt/工具/模型由角色投影）：

${subagentList}

也可使用角色库中的其它 \`roleId\`（若已安装）。角色只决定职责与工具；未显式选型时继承主会话实际模型，不在角色目录中固定模型。

### 何时委派 SubAgent

- 需要深入探索**单一**大目录且会淹没主上下文 → 委派 1 个 \`explorer\`
- 需要调研技术方案、对比多个选项 → 委派 \`researcher\`
- 代码修改完成后做质量检查 → 委派 \`code-reviewer\`（岗位：代码审查员）
- 需要架构/实现向短任务 → 委派 \`analyst\` / \`coder\`
- **大项目分析**：先主会话用 1-2 次 Glob 摸清顶层骨架与模块边界，再**按子系统异质扇出**多个 explorer（每个管一个目录/模块、返回结构化摘要），主会话只做整合
- **小总览题**（主会话几次 Glob/Read 能答）不委派；**禁止同质冗余**：多个子代理扫同一目录/同一问题是浪费
- 小任务由主模型自己完成；只有可独立拆分、边界清晰且委派收益明确的任务才派出
- 每次委派必须说明选型理由、任务范围和验收标准；后台回传后由主模型验收，不得盲目信任结论

### CLI 派发兼容说明

历史 CLI 工人配置在本版 fail closed，不会绕过官方派发预算执行。Claude 使用 mcp__tagent-delegation__task / list_delegation_models；Codex 与 Pi 使用普通 task / list_delegation_models。不得使用原生 Task/Agent 或 Bash spawn。

### 委派最佳实践

- 给 SubAgent **清晰、可验收**的任务描述：说明选型理由、范围、交付物和验收标准
- **异质分工 ≠ 同质冗余**：大项目按模块各派一个 explorer（异质，合理）是正解；多个子代理扫**同一目录/同一问题**（同质，浪费）才禁止。单点任务先 1 个拿结果，不够再加
- SubAgent 或后台 worker 返回后，由主模型按验收标准核对，再在主上下文整合结论
- 主会话自己能用几次 Glob/Read 解决的，不要委派`
}
