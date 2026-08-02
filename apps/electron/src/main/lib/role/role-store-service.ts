/**
 * 角色商店：内置 catalog + 本地缓存；安装写入 agent-roles.json
 *
 * 远程拉取可选；失败一律降级 builtin（Desktop 不依赖外网成功）。
 */
import { existsSync, readFileSync } from 'node:fs'

import type {
  AgentRoleProfile,
  InstallStoreRoleResult,
  RoleStoreCatalog,
  RoleStoreCatalogResult,
} from '@tagent/shared'
import { getBuiltinRoleStoreCatalog } from '@tagent/shared'

import { getRoleStoreCatalogPath } from '../config/config-paths'
import { writeJsonAtomic } from '../atomic-json'
import { loadRoles, saveRole } from './agent-role-service'

let cachedCatalog: RoleStoreCatalog | null = null

/** 加载商店 catalog（先缓存，再 builtin；可选尝试远程） */
export async function loadRoleStoreCatalog(): Promise<RoleStoreCatalogResult> {
  // 可选远程：超时短，失败忽略
  try {
    const remote = await fetchRemoteCatalogOptional()
    if (remote) {
      cachedCatalog = remote
      try {
        writeJsonAtomic(getRoleStoreCatalogPath(), remote)
      } catch {
        /* ignore cache write */
      }
      return { catalog: remote, source: 'remote', stale: false }
    }
  } catch (err) {
    console.warn('[角色商店] 远程拉取失败:', err)
  }

  const cached = readLocalCache()
  if (cached) {
    cachedCatalog = cached
    return { catalog: cached, source: 'cached', stale: true }
  }

  const builtin = getBuiltinRoleStoreCatalog()
  cachedCatalog = builtin
  return { catalog: builtin, source: 'builtin', stale: false }
}

/** 安装商店角色到本地库 */
export function installStoreRole(roleId: string): InstallStoreRoleResult {
  const catalog = cachedCatalog || getBuiltinRoleStoreCatalog()
  const entry = catalog.entries.find((e) => e.id === roleId)
  if (!entry) {
    return { role: null, installed: false, reason: '角色不存在于商店 catalog' }
  }
  if (loadRoles().some((r) => r.id === roleId)) {
    return { role: null, installed: false, reason: '角色已存在' }
  }
  const role: AgentRoleProfile = { ...entry.role, id: entry.role.id || entry.id }
  saveRole(role)
  console.log(`[角色商店] 已安装: ${entry.displayName} (${roleId})`)
  return { role, installed: true }
}

async function fetchRemoteCatalogOptional(): Promise<RoleStoreCatalog | null> {
  // 暂无稳定公开 Raw；预留接口，直接返回 null 走 builtin/cache
  return null
}

function readLocalCache(): RoleStoreCatalog | null {
  const path = getRoleStoreCatalogPath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as RoleStoreCatalog
    if (!parsed.entries || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}
