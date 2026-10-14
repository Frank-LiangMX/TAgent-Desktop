import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ created: 0 }))
vi.mock('./pi/pi-agent-adapter', () => ({ PiAgentAdapter: class {
  constructor() { state.created++ }
  dispose() {}
} }))
vi.mock('./codex/codex-app-server-adapter', () => ({ CodexAppServerAdapter: class { dispose() {} } }))
vi.mock('./claude/claude-agent-adapter', () => ({ ClaudeAgentAdapter: class { dispose() {} } }))
import { disposeAllAdapters, getAdapter, registerAdapterFactory } from './index'

afterEach(() => { disposeAllAdapters(); state.created = 0 })
describe('HTTP runtime adapter registry', () => {
  it.each(['codex', 'claude-code'] as const)('supports the optional %s engine without instantiating Pi', kind => {
    expect(getAdapter(kind)).toBe(getAdapter(kind))
    expect(() => registerAdapterFactory(kind, vi.fn())).toThrow('运行中的后端不可替换')
    expect(state.created).toBe(0)
  })
  it('shares the Pi adapter across HTTP channels', () => {
    expect(getAdapter('external')).toBe(getAdapter('external'))
    expect(state.created).toBe(1)
  })
})
