/**
 * 可配置执行 Agent 目录存储服务。
 *
 * 这里只保存 Agent 的非敏感声明配置：运行时、角色、权限、工作区策略和能力标签。
 * 渠道/API Key 仍由 channels.json 管理，本文件只允许保存 channelId/modelId 引用，
 * 不接受 apiKey、token、secret 等凭据字段，也不迁移 cli-workers.json。
 *
 * 落盘路径：~/.tagent[-dev]/agent-catalog.json（版本化 v1）
 * - listAgentProfiles：纯读；缺失、损坏或整单非法时返回内存 seed，不自动写盘。
 * - writeAgentProfiles：整单校验通过后覆盖式原子写；任一条目非法即拒写。
 * - validateAgentProfiles：纯校验，不读写文件。
 */
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getAgentCatalogPath } from '../config/config-paths'

export const AGENT_CATALOG_VERSION = 1 as const

export type AgentRuntime = 'pi' | 'codex' | 'claude-code' | 'kscc' | 'custom-cli'
export type AgentPermissionProfile = 'read-only' | 'workspace-write' | 'full'
export type AgentWorkspacePolicy = 'inherit' | 'fixed' | 'temporary'
export type AgentReasoning = 'low' | 'medium' | 'high'

export interface AgentCapabilities {
  tags: readonly string[]
  vision?: boolean
  reasoning?: AgentReasoning
}

/**
 * 执行 Agent 的可持久化配置。
 *
 * channelId/modelId 是引用，不是凭据；运行时需要的 API Key 由渠道存储服务解析。
 */
export interface AgentProfile {
  id: string
  name: string
  description?: string
  runtime: AgentRuntime
  enabled: boolean
  builtIn: boolean
  channelId?: string
  modelId?: string
  systemPrompt?: string
  skills?: string[]
  mcpServers?: string[]
  tools?: string[]
  permissionProfile: AgentPermissionProfile
  workspacePolicy: AgentWorkspacePolicy
  workspacePath?: string
  capabilities: AgentCapabilities
  allowPiTask: boolean
  allowBackground: boolean
  approvalRequired: boolean
}

export interface AgentCatalogFile {
  version: typeof AGENT_CATALOG_VERSION
  profiles: AgentProfile[]
}

const AGENT_CATALOG_DEFAULT_SEED: AgentCatalogFile = {
  version: AGENT_CATALOG_VERSION,
  profiles: [
    {
      id: 'pi',
      name: 'Pi 主编排器',
      description: '负责主会话、上下文、工具循环和多 Agent 调度。',
      runtime: 'pi',
      enabled: true,
      builtIn: true,
      permissionProfile: 'read-only',
      workspacePolicy: 'inherit',
      capabilities: { tags: ['reasoning', 'research'], vision: true, reasoning: 'high' },
      allowPiTask: false,
      allowBackground: false,
      approvalRequired: false,
    },
    {
      id: 'codex',
      name: '代码实现者',
      description: '使用 Pi 内核和 HTTP 模型实现代码、修改文件并运行测试。',
      runtime: 'pi',
      enabled: true,
      builtIn: true,
      permissionProfile: 'workspace-write',
      workspacePolicy: 'inherit',
      capabilities: { tags: ['backend', 'refactor', 'test', 'command'], reasoning: 'high' },
      allowPiTask: true,
      allowBackground: true,
      approvalRequired: true,
    },
    {
      id: 'claude-code',
      name: '代码审查员',
      description: '使用 Pi 内核和 HTTP 模型进行代码审查和风险检查。',
      runtime: 'pi',
      enabled: true,
      builtIn: true,
      permissionProfile: 'read-only',
      workspacePolicy: 'inherit',
      capabilities: { tags: ['review', 'reasoning', 'refactor'], reasoning: 'high' },
      allowPiTask: true,
      allowBackground: true,
      approvalRequired: false,
    },
    {
      id: 'kscc',
      name: '通用工人',
      description: '使用 Pi 内核和 HTTP 模型执行通用任务。',
      runtime: 'pi',
      enabled: false,
      builtIn: true,
      permissionProfile: 'workspace-write',
      workspacePolicy: 'inherit',
      capabilities: { tags: ['backend', 'refactor', 'command'], reasoning: 'high' },
      allowPiTask: true,
      allowBackground: true,
      approvalRequired: true,
    },
  ],
}

/** 对外提供深拷贝，避免调用方修改内存 seed 影响后续读取。 */
export function getAgentCatalogDefaultSeed(): AgentCatalogFile {
  return cloneCatalog(AGENT_CATALOG_DEFAULT_SEED)
}

const PROFILE_KEYS = new Set([
  'id',
  'name',
  'description',
  'runtime',
  'enabled',
  'builtIn',
  'channelId',
  'modelId',
  'systemPrompt',
  'skills',
  'mcpServers',
  'tools',
  'permissionProfile',
  'workspacePolicy',
  'workspacePath',
  'capabilities',
  'allowPiTask',
  'allowBackground',
  'approvalRequired',
])

const SECRET_KEY_NAMES = new Set([
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'authorization',
  'password',
  'secret',
  'token',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0)
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function findSecretField(value: unknown, path = 'catalog'): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSecretField(item, `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_NAMES.has(key.replaceAll('-', '_').toLowerCase())) return `${path}.${key}`
    const found = findSecretField(child, `${path}.${key}`)
    if (found) return found
  }
  return null
}

function validateStringArray(value: unknown, label: string): string | null {
  if (!isStringArray(value)) return `${label} 须为非空字符串数组`
  if (hasDuplicate(value)) return `${label} 不得包含重复项`
  return null
}

function validateProfile(value: unknown, index: number): string | null {
  const label = `Agent 条目 #${index + 1}`
  if (!isRecord(value)) return `${label} 结构不合法：期望对象`

  const secretField = findSecretField(value, label)
  if (secretField) return `${label} 禁止保存凭据字段：${secretField}`

  for (const key of Object.keys(value)) {
    if (!PROFILE_KEYS.has(key)) return `${label} 包含未知字段：${key}`
  }

  if (!isNonEmptyString(value.id)) return `${label} 的 id 须为非空字符串`
  if (!isNonEmptyString(value.name)) return `Agent「${value.id}」的 name 须为非空字符串`
  if (!['pi', 'codex', 'claude-code', 'kscc', 'custom-cli'].includes(value.runtime as string)) {
    return `Agent「${value.id}」的 runtime 不受支持`
  }
  if (typeof value.enabled !== 'boolean') return `Agent「${value.id}」的 enabled 须为布尔`
  if (typeof value.builtIn !== 'boolean') return `Agent「${value.id}」的 builtIn 须为布尔`

  for (const key of ['description', 'channelId', 'modelId', 'systemPrompt', 'workspacePath']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      return `Agent「${value.id}」的 ${key} 须为字符串`
    }
  }
  for (const key of ['channelId', 'modelId', 'workspacePath']) {
    if (typeof value[key] === 'string' && value[key].trim().length === 0) {
      return `Agent「${value.id}」的 ${key} 不能是空字符串`
    }
  }
  for (const key of ['skills', 'mcpServers', 'tools']) {
    const error = value[key] === undefined ? null : validateStringArray(value[key], `Agent「${value.id}」的 ${key}`)
    if (error) return error
  }

  if (!['read-only', 'workspace-write', 'full'].includes(value.permissionProfile as string)) {
    return `Agent「${value.id}」的 permissionProfile 不受支持`
  }
  if (!['inherit', 'fixed', 'temporary'].includes(value.workspacePolicy as string)) {
    return `Agent「${value.id}」的 workspacePolicy 不受支持`
  }
  if (value.workspacePolicy === 'fixed' && !isNonEmptyString(value.workspacePath)) {
    return `Agent「${value.id}」使用 fixed workspacePolicy 时必须提供 workspacePath`
  }

  if (!isRecord(value.capabilities)) return `Agent「${value.id}」的 capabilities 须为对象`
  const capabilityKeys = new Set(['tags', 'vision', 'reasoning'])
  for (const key of Object.keys(value.capabilities)) {
    if (!capabilityKeys.has(key)) return `Agent「${value.id}」的 capabilities 包含未知字段：${key}`
  }
  const tagsError = validateStringArray(value.capabilities.tags, `Agent「${value.id}」的 capabilities.tags`)
  if (tagsError) return tagsError
  if (value.capabilities.vision !== undefined && typeof value.capabilities.vision !== 'boolean') {
    return `Agent「${value.id}」的 capabilities.vision 须为布尔`
  }
  if (value.capabilities.reasoning !== undefined && !['low', 'medium', 'high'].includes(value.capabilities.reasoning as string)) {
    return `Agent「${value.id}」的 capabilities.reasoning 不受支持`
  }

  for (const key of ['allowPiTask', 'allowBackground', 'approvalRequired']) {
    if (typeof value[key] !== 'boolean') return `Agent「${value.id}」的 ${key} 须为布尔`
  }
  return null
}

function validateCatalogFile(value: unknown): string | null {
  if (!isRecord(value)) return 'Agent 目录结构不合法：期望对象'
  if (value.version !== AGENT_CATALOG_VERSION) return `Agent 目录不合法：version 须为 ${AGENT_CATALOG_VERSION}`
  if (!Array.isArray(value.profiles)) return 'Agent 目录不合法：profiles 须为数组'

  const ids = new Set<string>()
  for (const [index, profile] of value.profiles.entries()) {
    const error = validateProfile(profile, index)
    if (error) return error
    const id = (profile as AgentProfile).id
    if (ids.has(id)) return `Agent id 重复：「${id}」`
    ids.add(id)
  }
  return null
}

/** 校验待写入的 Agent profile 列表；不读写文件。 */
export function validateAgentProfiles(profiles: unknown): string | null {
  if (!Array.isArray(profiles)) return 'Agent profile 列表格式不合法：期望数组'
  return validateCatalogFile({ version: AGENT_CATALOG_VERSION, profiles })
}

/** 校验完整版本化文件；不读写文件。 */
export function validateAgentCatalog(value: unknown): string | null {
  if (Array.isArray(value)) return validateAgentProfiles(value)
  return validateCatalogFile(value)
}

function cloneCatalog(value: AgentCatalogFile): AgentCatalogFile {
  return JSON.parse(JSON.stringify(value)) as AgentCatalogFile
}

function normalizeProfile(profile: AgentProfile): AgentProfile {
  return {
    id: profile.id,
    name: profile.name,
    ...(profile.description !== undefined ? { description: profile.description } : {}),
    runtime: 'pi',
    enabled: profile.enabled,
    builtIn: profile.builtIn,
    ...(profile.channelId !== undefined ? { channelId: profile.channelId } : {}),
    ...(profile.modelId !== undefined ? { modelId: profile.modelId } : {}),
    ...(profile.systemPrompt !== undefined ? { systemPrompt: profile.systemPrompt } : {}),
    ...(profile.skills !== undefined ? { skills: [...profile.skills] } : {}),
    ...(profile.mcpServers !== undefined ? { mcpServers: [...profile.mcpServers] } : {}),
    ...(profile.tools !== undefined ? { tools: [...profile.tools] } : {}),
    permissionProfile: profile.permissionProfile,
    workspacePolicy: profile.workspacePolicy,
    ...(profile.workspacePath !== undefined ? { workspacePath: profile.workspacePath } : {}),
    capabilities: {
      tags: [...profile.capabilities.tags],
      ...(profile.capabilities.vision !== undefined ? { vision: profile.capabilities.vision } : {}),
      ...(profile.capabilities.reasoning !== undefined ? { reasoning: profile.capabilities.reasoning } : {}),
    },
    allowPiTask: profile.allowPiTask,
    allowBackground: profile.allowBackground,
    approvalRequired: profile.approvalRequired,
  }
}

/** 读取 Agent profile；缺失、损坏或版本/结构非法时返回内存 seed，不自动改写文件。 */
export function listAgentProfiles(): AgentProfile[] {
  const parsed = readJsonSafe<unknown>(getAgentCatalogPath(), null)
  if (validateCatalogFile(parsed)) return getAgentCatalogDefaultSeed().profiles
  return (parsed as AgentCatalogFile).profiles.map(normalizeProfile)
}

/** 覆盖式写入完整 Agent profile 列表；校验失败时不产生任何写盘。 */
export function writeAgentProfiles(profiles: AgentProfile[]): void {
  const error = validateAgentProfiles(profiles)
  if (error) throw new Error(error)
  writeJsonAtomic(getAgentCatalogPath(), {
    version: AGENT_CATALOG_VERSION,
    profiles: profiles.map(normalizeProfile),
  } satisfies AgentCatalogFile)
}

// 目录命名别名，便于调用方按“catalog”概念接入；两组接口行为完全一致。
export const listAgentCatalog = listAgentProfiles
export const writeAgentCatalog = writeAgentProfiles

/** 兼容现有 IPC 命名；输入仍在 writeAgentProfiles 内做整单运行时校验。 */
export function saveAgentProfiles(profiles: unknown[]): void {
  writeAgentProfiles(profiles as AgentProfile[])
}
