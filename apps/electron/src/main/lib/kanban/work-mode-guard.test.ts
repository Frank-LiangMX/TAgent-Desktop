import { describe, expect, test, beforeEach, vi } from 'vitest'

const metas = new Map<string, { id: string; executionMode?: string }>()

vi.mock('../agent/session-store', () => ({
  getSessionMeta: (id: string) => metas.get(id),
}))

const { assertKanbanWriteAllowed, isKanbanWriteAllowed, KANBAN_CHAT_BLOCK_REASON } =
  await import('./work-mode-guard')

describe('work-mode-guard', () => {
  beforeEach(() => {
    metas.clear()
  })

  test('work 允许写', () => {
    metas.set('s1', { id: 's1', executionMode: 'work' })
    expect(isKanbanWriteAllowed('s1')).toBe(true)
    expect(assertKanbanWriteAllowed('s1')).toEqual({ ok: true })
  })

  test('chat 拒绝写', () => {
    metas.set('s2', { id: 's2', executionMode: 'chat' })
    expect(isKanbanWriteAllowed('s2')).toBe(false)
    const r = assertKanbanWriteAllowed('s2')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe(KANBAN_CHAT_BLOCK_REASON)
      expect(r.executionMode).toBe('chat')
    }
  })

  test('无 session 按 legacy work（兼容）', () => {
    // migrateExecutionMode(undefined) → work
    expect(isKanbanWriteAllowed(undefined)).toBe(true)
  })

  test('旧会话无字段 → work', () => {
    metas.set('s3', { id: 's3' })
    expect(isKanbanWriteAllowed('s3')).toBe(true)
  })
})
