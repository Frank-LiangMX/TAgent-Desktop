import type { AgentSessionMeta } from '@tagent/shared'
import { isHiddenSessionMeta, listSessions, updateSessionMeta } from './session-store'

/** 普通会话连续 30 天未更新后自动归档。 */
export const SESSION_AUTO_ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_AUTO_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface SessionAutoArchiveDependencies {
  list?: () => AgentSessionMeta[]
  update?: (id: string, patch: Partial<AgentSessionMeta>) => AgentSessionMeta | undefined
  isActive?: (id: string) => boolean
  now?: () => number
  maxAgeMs?: number
}

export interface AutoArchiveResult {
  archivedIds: string[]
  skippedActive: number
  skippedPinned: number
}

/** 执行一次归档扫描；保持纯依赖注入，便于启动任务和 IPC 共用。 */
export function runSessionAutoArchive(
  deps: SessionAutoArchiveDependencies = {},
): AutoArchiveResult {
  const sessions = (deps.list ?? (() => listSessions({ includeHidden: true })))()
  const update = deps.update ?? updateSessionMeta
  const isActive = deps.isActive ?? (() => false)
  const now = deps.now ?? Date.now
  const maxAgeMs = deps.maxAgeMs ?? SESSION_AUTO_ARCHIVE_MAX_AGE_MS
  const archivedIds: string[] = []
  let skippedActive = 0
  let skippedPinned = 0

  for (const session of sessions) {
    if (session.archived || isHiddenSessionMeta(session)) continue
    if (session.pinned) {
      skippedPinned++
      continue
    }
    if (isActive(session.id)) {
      skippedActive++
      continue
    }
    const updatedAt = Number(session.updatedAt ?? session.createdAt ?? 0)
    if (!Number.isFinite(updatedAt) || now() - updatedAt < maxAgeMs) continue
    if (update(session.id, { archived: true })) archivedIds.push(session.id)
  }

  return { archivedIds, skippedActive, skippedPinned }
}

let timer: ReturnType<typeof setInterval> | undefined

export function startSessionAutoArchiveScheduler(
  deps: Omit<SessionAutoArchiveDependencies, 'now'> = {},
): void {
  stopSessionAutoArchiveScheduler()
  void runSessionAutoArchive(deps)
  timer = setInterval(() => {
    void runSessionAutoArchive(deps)
  }, SESSION_AUTO_ARCHIVE_INTERVAL_MS)
}

export function stopSessionAutoArchiveScheduler(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
