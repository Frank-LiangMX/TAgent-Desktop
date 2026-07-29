/**
 * 工作区管理器
 *
 * 2.0 核心模块：项目目录 = 工作区。
 * 数据组织对齐 kscc 模式：~/.tagent/projects/{sanitizedPath}/
 *
 * 职责：
 * - getOrCreateWorkspace：按 projectPath 算出 sanitized 目录名，不存在则创建
 * - listWorkspaces：扫描 projects/ 下所有子目录
 * - resolveWorkspaceForSession：从 session meta 的 workspaceId 反查 workspace
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, type Dirent } from 'node:fs'
import { join, basename } from 'node:path'
import type { AgentWorkspace } from '@tagent/shared'
import { sanitizePath } from './workspace-utils'
import { getProjectsDir, getProjectDir } from '../config/config-paths'

/** workspace 元数据文件名 */
const META_FILENAME = 'workspace-meta.json'
/** 工作区侧栏顺序与隐藏状态；只管理应用索引，不触碰项目目录。 */
const REGISTRY_FILENAME = 'workspace-registry.json'

interface WorkspaceRegistry {
  version: 1
  order: string[]
  hidden: string[]
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
}

function readRegistry(): WorkspaceRegistry {
  const registryPath = join(getProjectsDir(), REGISTRY_FILENAME)
  if (!existsSync(registryPath)) return { version: 1, order: [], hidden: [] }
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as Partial<WorkspaceRegistry>
    return {
      version: 1,
      order: uniqueStrings(parsed.order),
      hidden: uniqueStrings(parsed.hidden),
    }
  } catch {
    return { version: 1, order: [], hidden: [] }
  }
}

function writeRegistry(registry: WorkspaceRegistry): void {
  const registryPath = join(getProjectsDir(), REGISTRY_FILENAME)
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8')
}

/** 新建或重新打开目录时恢复其可见性，并放到用户顺序最前。 */
function revealWorkspace(id: string): void {
  const registry = readRegistry()
  const wasHidden = registry.hidden.includes(id)
  const wasOrdered = registry.order.includes(id)
  if (!wasHidden && wasOrdered) return

  registry.hidden = registry.hidden.filter((item) => item !== id)
  registry.order = [id, ...registry.order.filter((item) => item !== id)]
  writeRegistry(registry)
}

/** 读 workspace-meta.json（不存在返回 undefined） */
function readMeta(sanitizedPath: string): AgentWorkspace | undefined {
  const metaPath = join(getProjectDir(sanitizedPath), META_FILENAME)
  if (!existsSync(metaPath)) return undefined
  try {
    const raw = readFileSync(metaPath, 'utf8')
    return JSON.parse(raw) as AgentWorkspace
  } catch {
    return undefined
  }
}

/** 写 workspace-meta.json */
function writeMeta(workspace: AgentWorkspace): void {
  const metaPath = join(getProjectDir(workspace.id), META_FILENAME)
  writeFileSync(metaPath, JSON.stringify(workspace, null, 2), 'utf8')
}

/**
 * 获取或创建工作区
 *
 * - 用 sanitizePath 算出目录名（= workspace id）
 * - 如果 projects/{sanitized} 目录不存在则创建（mkdir 已在 getProjectDir 中完成）
 * - 读 meta 文件：存在则返回，不存在则创建 meta
 * - 去重：同一 projectPath 不重复创建（检查 sanitized 目录 + meta 匹配）
 */
export function getOrCreateWorkspace(projectPath: string): AgentWorkspace {
  const id = sanitizePath(projectPath)
  const existing = readMeta(id)

  // 已存在且 projectDirectory 匹配 → 直接返回，仅更新 updatedAt
  if (existing && existing.projectDirectory === projectPath) {
    if (existing.updatedAt !== Date.now()) {
      existing.updatedAt = Date.now()
      writeMeta(existing)
    }
    revealWorkspace(existing.id)
    return existing
  }

  // 已存在但 projectDirectory 不匹配 → 同一 sanitized id 映射了不同路径
  // 这种情况极罕见（hash 冲突），此时用新路径覆盖
  // 注意：sanitizePath 对不同路径极少产生相同 id，但安全起见处理
  const now = Date.now()
  const workspace: AgentWorkspace = {
    id,
    name: extractProjectName(projectPath),
    slug: id,
    projectDirectory: projectPath,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  writeMeta(workspace)
  revealWorkspace(workspace.id)
  return workspace
}

/**
 * 列出所有工作区
 *
 * 扫描 projects/ 下所有子目录，每个子目录名就是 workspace id。
 * 读 workspace-meta.json 获取完整信息；meta 不存在则从目录名反推。
 */
export function listWorkspaces(): AgentWorkspace[] {
  const projectsDir = getProjectsDir()
  const registry = readRegistry()
  const hidden = new Set(registry.hidden)
  let entries: Dirent[]
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const workspaces: AgentWorkspace[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    if (hidden.has(id)) continue
    const meta = readMeta(id)
    if (meta) {
      workspaces.push(meta)
    } else {
      // 无 meta：从目录名反推（仅存 id，name 用目录名）
      workspaces.push({
        id,
        name: id,
        slug: id,
        projectDirectory: undefined,
        createdAt: 0,
        updatedAt: 0,
      })
    }
  }

  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const ordered: AgentWorkspace[] = []
  for (const id of registry.order) {
    const workspace = byId.get(id)
    if (!workspace) continue
    ordered.push(workspace)
    byId.delete(id)
  }

  // 尚未进入用户顺序的历史工作区按最近使用排序，追加在后。
  const remaining = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  return [...ordered, ...remaining]
}

/** 按指定 ID 顺序持久化侧栏工作区；未列出的可见工作区追加到末尾。 */
export function reorderWorkspaces(orderedIds: string[]): AgentWorkspace[] {
  const current = listWorkspaces()
  const byId = new Map(current.map((workspace) => [workspace.id, workspace]))
  const reordered: AgentWorkspace[] = []

  for (const id of uniqueStrings(orderedIds)) {
    const workspace = byId.get(id)
    if (!workspace) continue
    reordered.push(workspace)
    byId.delete(id)
  }
  for (const workspace of byId.values()) reordered.push(workspace)

  const registry = readRegistry()
  registry.order = reordered.map((workspace) => workspace.id)
  writeRegistry(registry)
  return reordered
}

/**
 * 删除工作区的侧栏索引。
 * 会话由 WorkspaceService 在调用前统一停止并删除；这里仍不删除用户的项目源码目录。
 */
export function deleteWorkspace(id: string): void {
  const workspace = listWorkspaces().find((item) => item.id === id)
  if (!workspace) throw new Error(`工作区不存在: ${id}`)

  const registry = readRegistry()
  registry.hidden = uniqueStrings([...registry.hidden, id])
  registry.order = registry.order.filter((item) => item !== id)
  writeRegistry(registry)
}

/**
 * 从 sessionId 反查所属工作区
 *
 * 读 session meta 的 workspaceId，再查找对应 workspace。
 * workspaceId 不存在则返回 undefined。
 */
export function resolveWorkspaceForSession(sessionId: string): AgentWorkspace | undefined {
  // 延迟导入避免循环依赖
  const { getSessionMeta } = require('../agent/session-store') as {
    getSessionMeta: (id: string) => import('@tagent/shared').AgentSessionMeta | undefined
  }
  const meta = getSessionMeta(sessionId)
  if (!meta?.workspaceId) return undefined
  return readMeta(meta.workspaceId)
}

/** 从项目路径提取显示名：取最后一段目录名 */
function extractProjectName(projectPath: string): string {
  return basename(projectPath) || projectPath
}
