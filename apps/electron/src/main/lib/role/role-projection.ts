/**
 * 角色库 → 运行时投影（SubAgent / 未来 worker·MoA 共用）
 *
 * 禁止各处手拼 system prompt；统一走 composeRoleSystemPrompt + roleToSubagentDef。
 * @see docs/plans/multi-runtime/04-role-library.md §5
 * @see docs/plans/multi-runtime/07-implementation-phases.md C3
 */
import type { AgentDefinition, AgentRoleProfile, AgentRolePermissionMode } from '@tagent/shared'

const LANGUAGE_INSTRUCTION =
  '**语言**：始终使用中文回复和中文思考（包括 thinking / chain-of-thought 内部推理），保留必要的英文技术术语。'

/** 只读向工具（审核 / 探索类；permissionMode=auto 时默认） */
export const ROLE_READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'] as const

/** Explorer 的硬只读工具集：搜索即可，不允许通过 Bash 绕过文件写入边界。 */
export const ROLE_EXPLORER_TOOLS = ['Read', 'Glob', 'Grep'] as const
export const ROLE_EXPLORER_DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Task',
  'Agent',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
] as const

/** 可写向工具（bypass 时显式列出，避免子代理继承 kanban 等编排工具） */
export const ROLE_WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'] as const

export type RoleProjectionPurpose = 'subagent' | 'kanban-worker' | 'moa-seat' | 'mention-turn'

export interface ComposeRolePromptOptions {
  purpose?: RoleProjectionPurpose
  /** 额外运行时约束（Chat 只读、输出契约等），追加在角色正文后 */
  runtimeConstraints?: string
  /** 是否前置语言指令，默认 true */
  includeLanguage?: boolean
  /**
   * MoA 等多席时压缩角色 prompt（字符上限，超出截断）
   * SubAgent 默认不截断
   */
  maxRolePromptChars?: number
}

export interface RoleToSubagentOptions {
  /** Claude 渠道：无 modelPool 时默认 haiku */
  claudeAvailable?: boolean
  /** 覆盖模型（显式 modelId > 本字段 > modelPool[0] > haiku/继承） */
  modelOverride?: string
  purpose?: RoleProjectionPurpose
  runtimeConstraints?: string
  maxRolePromptChars?: number
  /** 强制工具列表；默认按 permissionMode 推导 */
  tools?: string[]
}

const PURPOSE_LABEL: Record<RoleProjectionPurpose, string> = {
  subagent: 'SubAgent 临时委派',
  'kanban-worker': '看板工人',
  'moa-seat': 'MoA 会诊席',
  'mention-turn': 'Chat @ 发言',
}

/**
 * 合成角色 system prompt（投影单点）
 *
 * 顺序：语言 → 运行时身份头 → 角色 systemPrompt → 可选 runtime 约束
 * 主会话 SOUL 不在此叠入（主会话默认不绑岗；worker 若需 SOUL 核心由调用方 prepend）。
 */
export function composeRoleSystemPrompt(
  role: AgentRoleProfile,
  options: ComposeRolePromptOptions = {},
): string {
  const purpose = options.purpose ?? 'subagent'
  const includeLanguage = options.includeLanguage !== false
  let body = role.systemPrompt?.trim() ?? ''
  if (options.maxRolePromptChars && body.length > options.maxRolePromptChars) {
    body =
      body.slice(0, options.maxRolePromptChars) +
      `\n\n…（角色 prompt 已截断，共 ${role.systemPrompt.length} 字）`
  }

  const parts: string[] = []
  if (includeLanguage) parts.push(LANGUAGE_INSTRUCTION)

  parts.push(
    [
      `你正在以岗位角色 **${role.displayName}**（\`${role.id}\`）执行任务。`,
      `运行形态：${PURPOSE_LABEL[purpose]}。`,
      role.description ? `职责摘要：${role.description}` : null,
      '按本角色能力边界完成任务；结果需自包含、可被父会话直接使用。',
    ]
      .filter(Boolean)
      .join('\n'),
  )

  if (body) parts.push(body)

  if (options.runtimeConstraints?.trim()) {
    parts.push(options.runtimeConstraints.trim())
  }

  return parts.join('\n\n')
}

/** permissionMode → 工具集（subagent 不继承看板工具） */
export function toolsForRolePermission(
  mode: AgentRolePermissionMode,
  purpose: RoleProjectionPurpose = 'subagent',
): string[] {
  if (purpose === 'mention-turn') {
    // @ 讨论：默认只读
    return [...ROLE_READONLY_TOOLS]
  }
  if (mode === 'auto') return [...ROLE_READONLY_TOOLS]
  return [...ROLE_WRITE_TOOLS]
}

/**
 * 模型解析：显式 override > modelPool[0] > Claude haiku > undefined（继承父）
 */
export function resolveModelForRole(
  role: AgentRoleProfile,
  options: { claudeAvailable?: boolean; modelOverride?: string } = {},
): string | undefined {
  if (options.modelOverride?.trim()) return options.modelOverride.trim()
  const fromPool = role.modelPool?.find((m) => typeof m === 'string' && m.trim())
  if (fromPool) return fromPool.trim()
  if (options.claudeAvailable) return 'haiku'
  return undefined
}

/**
 * 角色 → SubAgent AgentDefinition（kscc agents / Pi task 共用）
 */
export function roleToSubagentDef(
  role: AgentRoleProfile,
  options: RoleToSubagentOptions = {},
): AgentDefinition {
  const purpose = options.purpose ?? 'subagent'
  const tools =
    options.tools ??
    (role.id === 'explorer'
      ? [...ROLE_EXPLORER_TOOLS]
      : toolsForRolePermission(role.permissionMode, purpose))
  const model = resolveModelForRole(role, {
    claudeAvailable: options.claudeAvailable,
    modelOverride: options.modelOverride,
  })

  const def: AgentDefinition = {
    description: `${role.displayName}：${role.description || role.id}`,
    prompt: composeRoleSystemPrompt(role, {
      purpose,
      runtimeConstraints: options.runtimeConstraints,
      maxRolePromptChars: options.maxRolePromptChars,
    }),
    tools: [...tools],
  }
  if (role.id === 'explorer') {
    def.disallowedTools = [...ROLE_EXPLORER_DISALLOWED_TOOLS]
  }
  if (model) def.model = model
  return def
}

// ── 内置操作型 SubAgent（无对应「岗位角色」时的 seed，仍走同一投影函数）──
// 语言指令由 composeRoleSystemPrompt 统一前置，此处只写职责正文

/** explorer / researcher 操作型 seed（非岗位库条目，但结构对齐 AgentRoleProfile） */
export function getOperationalSubagentRoles(): AgentRoleProfile[] {
  return [
    {
      id: 'explorer',
      displayName: '代码探索',
      description: '快速搜索文件、理解项目结构、查找相关代码；只读。',
      systemPrompt: `你是一个高效的代码库探索员。你的职责是快速搜索和收集信息，然后返回结构化的结果。

工作方式：
- 并行使用 Glob 和 Grep 搜索，最大化效率
- 返回信息时包含具体的文件路径和关键代码片段
- 整理为清晰的结构：文件列表、关键函数/类型、依赖关系、相关模式
- 不要做修改，只负责收集和整理信息

保持简洁，只返回与任务相关的信息。`,
      permissionMode: 'auto',
      modelPool: [],
      maxConcurrentPerModel: 2,
      fallbackToChannelDefault: true,
    },
    {
      id: 'researcher',
      displayName: '技术调研',
      description: '对比技术方案、评估依赖库、分析架构选型。',
      systemPrompt: `你是一个技术调研员。你的职责是针对特定技术问题进行深入调研，输出结构化的分析报告。

输出格式：
- **问题概述**：一句话说明调研目标
- **方案对比**：表格形式对比各选项的优劣
- **推荐方案**：明确推荐并说明理由
- **风险提示**：潜在的问题和注意事项

保持客观，给出有依据的建议。`,
      permissionMode: 'auto',
      modelPool: [],
      maxConcurrentPerModel: 2,
      fallbackToChannelDefault: true,
    },
  ]
}

/**
 * 操作型名称 → 角色库 id（有映射时优先从角色库投影）
 * code-reviewer 收敛到岗位 reviewer
 */
export const OPERATIONAL_TO_ROLE_ID: Record<string, string> = {
  'code-reviewer': 'reviewer',
}

/** 委派目录里额外挂上的岗位角色（短列表，非全库） */
export const SUBAGENT_CATALOG_ROLE_IDS = [
  'reviewer',
  'analyst',
  'coder',
  'generalist',
] as const

export function isOperationalSubagentType(type: string): boolean {
  return type === 'explorer' || type === 'researcher' || type === 'code-reviewer'
}
