import { describe, expect, test, beforeEach } from 'vitest'
import {
  killSessionProcess,
  listSessionProcesses,
  resetSessionProcessRegistryForTests,
  trackSessionProcess,
  untrackSessionProcess,
} from './session-process-registry'

describe('session-process-registry', () => {
  beforeEach(() => {
    resetSessionProcessRegistryForTests()
  })

  test('tracks and lists by session', () => {
    trackSessionProcess({ sessionId: 's1', command: 'bun run dev', source: 'bash', pid: 11 })
    trackSessionProcess({ sessionId: 's2', command: 'rg foo', source: 'bash', pid: 12 })
    expect(listSessionProcesses('s1').map((p) => p.command)).toEqual(['bun run dev'])
    expect(listSessionProcesses('s2')).toHaveLength(1)
  })

  test('untrack removes item', () => {
    const id = trackSessionProcess({ sessionId: 's1', command: 'python x.py', source: 'bash', pid: 3 })
    untrackSessionProcess(id)
    expect(listSessionProcesses('s1')).toEqual([])
  })

  test('kill missing process returns error', () => {
    const r = killSessionProcess('s1', 'nope')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/不存在/)
  })
})
