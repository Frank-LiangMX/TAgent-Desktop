/**
 * TAgent 角色商店目录
 *
 * 内置来自 agency-agents-zh 的 250+ 个专业化角色，
 * 用户可一键安装到本地角色库，供看板 worker 使用。
 *
 * 数据源：role-store-catalog-data.ts（转换脚本生成）
 * 远程更新：主进程启动时从 GitHub Raw 拉取最新版本，失败降级本地
 */

import type { RoleStoreCatalogEntry } from './types/agent-role'

import { ROLE_STORE_CATALOG } from './role-store-catalog-data'

/** 获取内置 catalog（硬编码在代码中，离线兜底） */
export function getBuiltinRoleStoreCatalog() {
  return ROLE_STORE_CATALOG
}

/** 获取所有分类（去重 + 排序） */
export function getRoleStoreCategories(): string[] {
  const cats = new Set<string>()
  for (const entry of ROLE_STORE_CATALOG.entries) {
    cats.add(entry.category)
  }
  return [...cats].sort()
}

/** 按分类筛选 */
export function filterByCategory(entries: RoleStoreCatalogEntry[], category: string) {
  if (category === 'all') return entries
  return entries.filter((e) => e.category === category)
}

/** 搜索（匹配 displayName + description） */
export function searchRoleStoreEntries(
  entries: RoleStoreCatalogEntry[],
  query: string
): RoleStoreCatalogEntry[] {
  const q = query.toLowerCase().trim()
  if (!q) return entries
  return entries.filter(
    (e) => e.displayName.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)
  )
}
