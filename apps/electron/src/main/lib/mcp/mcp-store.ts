/**
 * 工作区 MCP 配置存储
 *
 * 读写 ~/.tagent[-dev]/projects/{sanitizedPath}/mcp.json（WorkspaceMcpConfig）。
 * 复用 @tagent/shared 的 McpServerEntry/WorkspaceMcpConfig 类型。
 * CRUD + getMcpConfig（pi-core buildMcpTools 用）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerEntry, WorkspaceMcpConfig } from '@tagent/shared'
import { getProjectDir } from '../config/config-paths'

const MCP_FILENAME = 'mcp.json'

/** 工作区 MCP 配置文件路径：~/.tagent[-dev]/projects/{slug}/mcp.json */
function getMcpConfigPath(sanitizedPath: string): string {
  return join(getProjectDir(sanitizedPath), MCP_FILENAME)
}

/** 读工作区 MCP 配置（不存在返回空 servers） */
export function getMcpConfig(sanitizedPath: string): WorkspaceMcpConfig {
  const path = getMcpConfigPath(sanitizedPath)
  if (!existsSync(path)) return { servers: {} }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as WorkspaceMcpConfig
    if (!parsed || typeof parsed !== 'object' || !parsed.servers) {
      return { servers: {} }
    }
    return parsed
  } catch (err) {
    console.error('[MCP 存储] 读取配置失败:', err)
    return { servers: {} }
  }
}

/** 写工作区 MCP 配置（全量覆盖） */
export function saveMcpConfig(sanitizedPath: string, config: WorkspaceMcpConfig): void {
  const path = getMcpConfigPath(sanitizedPath)
  try {
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('[MCP 存储] 写入配置失败:', err)
    throw new Error('写入 MCP 配置失败')
  }
}

/** 更新单个 MCP server（新增/改） */
export function upsertMcpServer(
  sanitizedPath: string,
  name: string,
  entry: McpServerEntry
): WorkspaceMcpConfig {
  const config = getMcpConfig(sanitizedPath)
  config.servers[name] = entry
  saveMcpConfig(sanitizedPath, config)
  return config
}

/** 删除单个 MCP server */
export function deleteMcpServer(
  sanitizedPath: string,
  name: string
): { ok: boolean; error?: string } {
  const config = getMcpConfig(sanitizedPath)
  if (!config.servers[name]) return { ok: false, error: 'MCP server 不存在' }
  delete config.servers[name]
  saveMcpConfig(sanitizedPath, config)
  return { ok: true }
}

/** 取启用的 MCP server 列表（pi-core buildMcpTools 用，只传启用的） */
export function getEnabledMcpServers(sanitizedPath: string): Record<string, McpServerEntry> {
  const config = getMcpConfig(sanitizedPath)
  const enabled: Record<string, McpServerEntry> = {}
  for (const [name, entry] of Object.entries(config.servers)) {
    if (entry.enabled) enabled[name] = entry
  }
  return enabled
}

/**
 * 更新某个 MCP server 的最近测试结果。
 *
 * 仅在该 server 已存在时写回 `lastTestResult`（避免给尚未保存的草稿落盘），
 * 返回是否成功更新。供 test handler 在真实探测后持久化用。
 */
export function setMcpLastTestResult(
  sanitizedPath: string,
  name: string,
  result: { success: boolean; message: string; timestamp: number },
): boolean {
  const config = getMcpConfig(sanitizedPath)
  const existing = config.servers[name]
  if (!existing) return false
  config.servers[name] = { ...existing, lastTestResult: result }
  saveMcpConfig(sanitizedPath, config)
  return true
}
