import { describe, expect, it } from 'vitest'
import { runSessionAutoArchive } from './session-auto-archive'

const DAY = 24 * 60 * 60 * 1000
const now = 100 * DAY

function session(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    mode: 'general',
    createdAt: now - 60 * DAY,
    updatedAt: now - 31 * DAY,
    ...patch,
  } as never
}

describe('session auto archive', () => {
  it('archives ordinary sessions older than the threshold', () => {
    const updated: Array<[string, Record<string, unknown>]> = []
    const result = runSessionAutoArchive({
      list: () => [session('old'), session('recent', { updatedAt: now - 29 * DAY })],
      update: (id, patch) => {
        updated.push([id, patch])
        return session(id, patch)
      },
      now: () => now,
    })
    expect(result.archivedIds).toEqual(['old'])
    expect(updated).toEqual([['old', { archived: true }]])
  })

  it('does not archive pinned, active, hidden, or already archived sessions', () => {
    const updated: string[] = []
    const result = runSessionAutoArchive({
      list: () => [
        session('pinned', { pinned: true }),
        session('active'),
        session('hidden', { hidden: true }),
        session('automation', { sourceAutomationId: 'auto-1' }),
        session('archived', { archived: true }),
      ],
      update: (id) => {
        updated.push(id)
        return session(id)
      },
      isActive: (id) => id === 'active',
      now: () => now,
    })
    expect(result.archivedIds).toEqual([])
    expect(updated).toEqual([])
    expect(result.skippedPinned).toBe(1)
    expect(result.skippedActive).toBe(1)
  })
})
