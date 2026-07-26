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

  // 按 updatedAt 降序排列（最近使用的在前）
  workspaces.sort((a, b) => b.updatedAt - a.updatedAt)
  return workspaces
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
