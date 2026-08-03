/**
 * Agent 角色库服务
 *
 * 管理 ~/.tagent[-dev]/agent-roles.json 的读写与 CRUD。
 * @see docs/plans/multi-runtime/04-role-library.md
 * @see packages/shared/src/types/agent-role.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

import {
  DEFAULT_KANBAN_ROLE_ID,
  DEFAULT_ROLES,
  isLegacyBuiltinModelPool,
  type AgentRoleProfile,
  type ImportRoleFromMdResult,
} from '@tagent/shared'

import { getAgentRolesPath } from '../config/config-paths'
import { writeJsonAtomic } from '../atomic-json'

/** 内置角色 ID（不可删，可编辑后由 reset 恢复） */
const BUILTIN_ROLE_IDS = new Set(DEFAULT_ROLES.map((r) => r.id))

/** 加载全部角色；首次 seed DEFAULT_ROLES；补齐缺失内置 */
export function loadRoles(): AgentRoleProfile[] {
  const path = getAgentRolesPath()

  if (!existsSync(path)) {
    saveRoles(DEFAULT_ROLES)
    console.log(`[角色库] 已初始化默认角色: ${path}`)
    return [...DEFAULT_ROLES]
  }

  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      console.warn('[角色库] agent-roles.json 不是数组，回退默认')
      return [...DEFAULT_ROLES]
    }

    const roles = parsed as AgentRoleProfile[]
    const existingIds = new Set(roles.map((r) => r.id))
    const missingBuiltins = DEFAULT_ROLES.filter((r) => !existingIds.has(r.id))

    // 内置 systemPrompt 变更时同步；清除历史写死的 glm 模型池
    let needsUpdate = false
    const updated = roles.map((r) => {
      const builtin = DEFAULT_ROLES.find((d) => d.id === r.id)
      if (!builtin) return r

      if (builtin.systemPrompt !== r.systemPrompt) {
        needsUpdate = true
        console.log(`[角色库] 内置角色已更新: ${r.id}`)
        // 内置 prompt 更新走整体替换（既有行为），仅额外保留用户的 pin 标记
        return { ...builtin, pinned: r.pinned === true }
      }

      // 曾 seed 的 kscc 模型列表 → 空池（渠道默认）；用户自配其他池保留
      if (isLegacyBuiltinModelPool(r.modelPool)) {
        needsUpdate = true
        console.log(`[角色库] 清除内置角色遗留模型池: ${r.id}`)
        return { ...r, modelPool: [] }
      }

      return r
    })

    if (missingBuiltins.length > 0) {
      updated.push(...missingBuiltins)
      needsUpdate = true
      console.log(
        `[角色库] 补齐 ${missingBuiltins.length} 个内置: ${missingBuiltins.map((r) => r.id).join(', ')}`,
      )
    }

    if (needsUpdate) {
      saveRoles(updated)
      return updated
    }
    return roles
  } catch (err) {
    console.warn('[角色库] 读取失败，回退默认:', err)
    return [...DEFAULT_ROLES]
  }
}

export function saveRoles(roles: AgentRoleProfile[]): void {
  writeJsonAtomic(getAgentRolesPath(), roles)
}

export function getRoleById(id: string): AgentRoleProfile | undefined {
  return loadRoles().find((r) => r.id === id)
}

/**
 * 解析角色：指定 id → 命中；否则 generalist；再否则 DEFAULT_ROLES[0]
 * 供看板 dispatcher / MoA / SubAgent 统一调用
 */
export function resolveRole(roleId?: string | null): AgentRoleProfile {
  if (roleId) {
    const hit = getRoleById(roleId)
    if (hit) return hit
  }
  const fallback =
    getRoleById(DEFAULT_KANBAN_ROLE_ID) ??
    DEFAULT_ROLES.find((r) => r.id === DEFAULT_KANBAN_ROLE_ID) ??
    DEFAULT_ROLES[0]
  if (!fallback) {
    throw new Error('[角色库] DEFAULT_ROLES 为空')
  }
  return fallback
}

export function saveRole(role: AgentRoleProfile): AgentRoleProfile[] {
  if (!role?.id?.trim()) {
    throw new Error('角色 id 不能为空')
  }
  const normalized: AgentRoleProfile = {
    ...role,
    id: role.id.trim(),
    displayName: role.displayName?.trim() || role.id,
    description: role.description ?? '',
    systemPrompt: role.systemPrompt ?? '',
    permissionMode: role.permissionMode === 'auto' ? 'auto' : 'bypassPermissions',
    modelPool: Array.isArray(role.modelPool) ? role.modelPool : [],
    maxConcurrentPerModel:
      typeof role.maxConcurrentPerModel === 'number' && role.maxConcurrentPerModel > 0
        ? role.maxConcurrentPerModel
        : 2,
    fallbackToChannelDefault: role.fallbackToChannelDefault !== false,
    pinned: role.pinned === true,
  }
  const roles = loadRoles()
  const idx = roles.findIndex((r) => r.id === normalized.id)
  if (idx >= 0) roles[idx] = normalized
  else roles.push(normalized)
  saveRoles(roles)
  console.log(`[角色库] 已保存: ${normalized.id} (${normalized.displayName})`)
  return roles
}

export function deleteRole(roleId: string): {
  roles: AgentRoleProfile[]
  deleted: boolean
  reason?: string
} {
  if (BUILTIN_ROLE_IDS.has(roleId)) {
    return {
      roles: loadRoles(),
      deleted: false,
      reason: '内置角色不可删除，可编辑覆盖或重置全部',
    }
  }
  const roles = loadRoles()
  const idx = roles.findIndex((r) => r.id === roleId)
  if (idx < 0) return { roles, deleted: false, reason: '角色不存在' }
  roles.splice(idx, 1)
  saveRoles(roles)
  console.log(`[角色库] 已删除: ${roleId}`)
  return { roles, deleted: true }
}

export function resetDefaultRoles(): AgentRoleProfile[] {
  saveRoles(DEFAULT_ROLES)
  console.log('[角色库] 已重置为默认角色')
  return [...DEFAULT_ROLES]
}

export function isBuiltinRole(roleId: string): boolean {
  return BUILTIN_ROLE_IDS.has(roleId)
}

export function findSimilarRoles(displayName: string): AgentRoleProfile[] {
  const roles = loadRoles()
  const normalizedName = displayName.toLowerCase().trim()
  if (!normalizedName) return []

  return roles.filter((r) => {
    const existing = r.displayName.toLowerCase().trim()
    if (existing === normalizedName) return true
    if (existing.includes(normalizedName) || normalizedName.includes(existing)) return true
    if (
      Math.abs(existing.length - normalizedName.length) <= 2 &&
      levenshteinDistance(existing, normalizedName) <= 2
    ) {
      return true
    }
    return false
  })
}

export function deleteRoles(roleIds: string[]): {
  roles: AgentRoleProfile[]
  deleted: string[]
  skipped: Array<{ id: string; reason: string }>
} {
  const roles = loadRoles()
  const deleted: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []

  for (const roleId of roleIds) {
    if (BUILTIN_ROLE_IDS.has(roleId)) {
      skipped.push({ id: roleId, reason: '内置角色不可删除' })
      continue
    }
    const idx = roles.findIndex((r) => r.id === roleId)
    if (idx < 0) {
      skipped.push({ id: roleId, reason: '角色不存在' })
      continue
    }
    roles.splice(idx, 1)
    deleted.push(roleId)
  }

  if (deleted.length > 0) {
    saveRoles(roles)
    console.log(`[角色库] 批量删除 ${deleted.length}: ${deleted.join(', ')}`)
  }
  return { roles, deleted, skipped }
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i]![0] = i
  for (let j = 0; j <= n; j++) dp[0]![j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost)
    }
  }
  return dp[m]![n]!
}

export function importRoleFromMd(filePath: string): ImportRoleFromMdResult {
  if (!existsSync(filePath)) {
    return { role: null, imported: false, reason: '文件不存在' }
  }
  if (extname(filePath).toLowerCase() !== '.md') {
    return { role: null, imported: false, reason: '仅支持 .md 文件' }
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return { role: null, imported: false, reason: '读取文件失败' }
  }

  const { meta, body } = parseMdFrontmatter(content)
  if (!body) return { role: null, imported: false, reason: '文件内容为空' }

  const displayName = meta.name || basename(filePath, '.md')
  const id = toKebabCase(displayName)

  const role: AgentRoleProfile = {
    id,
    displayName,
    description: meta.description || `${displayName}专业角色`,
    systemPrompt: body,
    permissionMode: 'bypassPermissions',
    modelPool: [],
    maxConcurrentPerModel: 2,
    fallbackToChannelDefault: true,
  }

  if (loadRoles().some((r) => r.id === id)) {
    return { role: null, imported: false, reason: `角色 "${displayName}" 已存在（id: ${id}）` }
  }

  saveRole(role)
  console.log(`[角色库] 从 .md 导入: ${displayName} (${id})`)
  return { role, imported: true }
}

function parseMdFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: content.trim() }
  const yamlStr = match[1]!
  const body = match[2]!.trim()
  const meta: Record<string, string> = {}
  for (const line of yamlStr.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) meta[kv[1]!] = kv[2]!.trim()
  }
  return { meta, body }
}

function toKebabCase(str: string): string {
  return (
    str
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9一-鿿-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'imported-role'
  )
}
