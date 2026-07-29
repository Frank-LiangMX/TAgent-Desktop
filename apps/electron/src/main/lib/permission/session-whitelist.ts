/**
 * 会话级权限白名单（纯逻辑，无 Electron 依赖）
 *
 * 「始终允许」对齐 TAgent_General：
 * - Bash → 本会话放行整类 Bash（危险命令 / 写结构仍拦截）
 * - 其它工具 → 按工具名放行
 */
import { hasWriteStructure, isDangerousCommand } from '@tagent/shared'

export interface SessionWhitelist {
  /** 总是允许的工具名（含 'Bash' 整类） */
  allowedTools: Set<string>
  /** 细粒度 Bash 基础命令（审计 / 兼容） */
  allowedBashCommands: Set<string>
}

const sessionWhitelists = new Map<string, SessionWhitelist>()

export function getOrCreateWhitelist(sessionId: string): SessionWhitelist {
  const existing = sessionWhitelists.get(sessionId)
  if (existing) return existing
  const created: SessionWhitelist = {
    allowedTools: new Set(),
    allowedBashCommands: new Set(),
  }
  sessionWhitelists.set(sessionId, created)
  return created
}

/** 提取 Bash 基础命令（git push / npm install / ls） */
export function extractBaseCommand(command: string): string {
  const parts = command.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length >= 2 && ['git', 'npm', 'bun', 'yarn', 'pnpm'].includes(parts[0]!)) {
    return `${parts[0]} ${parts[1]}`
  }
  return parts[0] ?? ''
}

/**
 * 会话白名单是否放行。
 * Bash 整类放行时仍拦截危险命令与写结构（重定向 / $() / -exec 等）。
 */
export function isSessionWhitelisted(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const whitelist = sessionWhitelists.get(sessionId)
  if (!whitelist) return false

  if (toolName !== 'Bash') {
    return whitelist.allowedTools.has(toolName)
  }

  const command = typeof input.command === 'string' ? input.command : ''
  if (isDangerousCommand(command)) return false
  if (hasWriteStructure(command)) return false
  // 用户对任一 Bash 点过「始终」→ 本会话放行所有非危险 Bash
  if (whitelist.allowedTools.has('Bash')) return true
  // 回退：细粒度基础命令（兼容旧逻辑）
  const base = extractBaseCommand(command)
  return base !== '' && whitelist.allowedBashCommands.has(base)
}

/** 写入会话白名单（「始终允许」） */
export function addToSessionWhitelist(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
): void {
  const whitelist = getOrCreateWhitelist(sessionId)
  if (toolName !== 'Bash') {
    whitelist.allowedTools.add(toolName)
    return
  }
  const command = typeof input.command === 'string' ? input.command : ''
  // 危险命令 / 写结构永不入白名单（每次仍问）
  if (isDangerousCommand(command) || hasWriteStructure(command)) return
  whitelist.allowedTools.add('Bash')
  const base = extractBaseCommand(command)
  if (base) whitelist.allowedBashCommands.add(base)
}

export function clearSessionWhitelist(sessionId: string): void {
  sessionWhitelists.delete(sessionId)
}
