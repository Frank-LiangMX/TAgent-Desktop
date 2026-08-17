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
import { listEnabledCliWorkerCards } from '../agent/cli-workers/resolve-backend'

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
 * 本地 CLI 编排段：启用本机 CLI 工人时注入，教主 agent 用 Bash spawn 本地 CLI 当外部子代理。
 * 未启用（总开关关 / 无启用工人）→ 返回禁用提示段，让主 agent 知道这条路存在但当前不可用。
 */
function buildLocalCliDelegationSection(): string {
  const cards = listEnabledCliWorkerCards()
  if (!cards) {
    return [
      '当前未启用本机 CLI 工人。如需按特长把子活外包给本地 CLI（codex/grok/kscc/mimo/opencode/claude 等），',
      '可在设置页「CLI 工人」启用并配置后端；启用后此处会列出可用 CLI 及其能力画像。',
    ].join('')
  }
  return [
    '本机已启用 CLI 工人，可按特长把子活外包给本地 CLI 当外部子代理——用 Bash 工具 spawn CLI 进程跑，收 stdout 整合结论。',
    '',
    cards,
    '',
    '**用法**：用 Bash 工具调对应 CLI 的非交互命令（如 `codex exec "任务描述"`、`grok -p "任务描述"`、',
    '`kscc -p "任务描述" --model <id>` 等，具体语法以各 CLI --help 为准），在 cwd 下跑、收 stdout、整合结论回主会话。',
    '- 按特长选 CLI：看上方能力卡的「擅长: ...」标签匹配任务类型（前端/后端/推理/杂活/测试/审查/调研/重构/命令）；标签由设置页「擅长任务类型」配置。',
    '- 给 CLI **清晰、可验收**的单次任务描述；长输出可重定向到临时文件再 Read 整合。',
    '- 外部 CLI 无 TAgent 的会话状态，**不要**指望它续接主会话上下文——把必要上下文写进任务描述里。',
    '- Bash spawn CLI 属非结构化派工（无进度卡/详情页）；高频或需进度可见时，优先用内置 SubAgent（上方目录）。',
    '- 失败（命令找不到 / 超时 / 非零退出）先看 stderr，别静默重试同一命令。',
  ].join('\n')
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
      '默认自己先读少量关键文件；**大项目按子系统异质分工可并行**派 2-4 个 explorer（各管不同目录/不同问题，主上下文只收结论）。单点小任务默认 1 个，确有必要再加。**禁止同质冗余**：多个子代理扫同一目录/同一问题是浪费。',
    balanced:
      '独立子任务积极委派以保持主上下文干净。**大项目按模块异质扇出**（一模块一 explorer）；**并行默认 ≤4**。**禁止同质冗余**：同一目录/同一问题不开多个。',
    aggressive:
      '优先委派，主会话偏编排与整合。大项目首选按子系统异质扇出；**禁止同质冗余**：同一目录/同一问题不开多个。',
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
- **大项目分析**：先主会话用 1-2 次 Glob 摸清顶层骨架与模块边界，再**按子系统异质扇出**多个 explorer（每个管一个目录/模块、返回结构化摘要），主会话只做整合
- **小总览题**（主会话几次 Glob/Read 能答）不委派；**禁止同质冗余**：多个子代理扫同一目录/同一问题是浪费

### 本地 CLI 编排（外部子代理）

${buildLocalCliDelegationSection()}

### 委派最佳实践

- 给 SubAgent **清晰、可验收**的任务描述（要收集什么、返回什么格式）
- **异质分工 ≠ 同质冗余**：大项目按模块各派一个 explorer（异质，合理）是正解；多个子代理扫**同一目录/同一问题**（同质，浪费）才禁止。单点任务先 1 个拿结果，不够再加
- SubAgent 返回后在主上下文整合结论，用自然语言回用户
- 主会话自己能用几次 Glob/Read 解决的，不要委派`
}
