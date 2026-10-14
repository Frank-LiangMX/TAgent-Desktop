import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from '../../agent/agent-catalog-service'

const { listAgentProfilesMock } = vi.hoisted(() => ({
  listAgentProfilesMock: vi.fn(),
}))

vi.mock('../../agent/agent-catalog-service', () => ({
  listAgentProfiles: listAgentProfilesMock,
}))

import { resolvePiTaskAgent } from './agent-catalog-resolver'

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    runtime: 'pi',
    enabled: true,
    builtIn: false,
    permissionProfile: 'read-only',
    workspacePolicy: 'inherit',
    capabilities: { tags: [] },
    allowPiTask: true,
    allowBackground: true,
    approvalRequired: false,
    ...overrides,
  }
}

beforeEach(() => {
  listAgentProfilesMock.mockReset()
})

describe('resolvePiTaskAgent', () => {
  it('拒绝 disabled profile', () => {
    listAgentProfilesMock.mockReturnValue([profile({ id: 'disabled', enabled: false })])

    expect(() => resolvePiTaskAgent('disabled')).toThrow('已禁用')
  })

  it('拒绝 allowPiTask=false profile', () => {
    listAgentProfilesMock.mockReturnValue([profile({ id: 'private', allowPiTask: false })])

    expect(() => resolvePiTaskAgent('private')).toThrow('未允许被 Pi task 调用')
  })

  it('将 pi runtime 映射为 in-process', () => {
    const agent = profile({ id: 'pi-researcher', runtime: 'pi' })
    listAgentProfilesMock.mockReturnValue([agent])

    expect(resolvePiTaskAgent('pi-researcher')).toEqual({
      profile: agent,
      runtime: 'in-process',
    })
  })

  it.each(['codex', 'claude-code'] as const)('rejects removed runtime %s', runtime => {
    const agent = profile({ id: 'stale', runtime })
    listAgentProfilesMock.mockReturnValue([agent])
    expect(() => resolvePiTaskAgent('stale')).toThrow('仅支持 Pi')
  })

  it('拒绝 legacy CLI 与 temporary workspace', () => {
    const legacy = profile({ id: 'legacy', runtime: 'kscc' })
    listAgentProfilesMock.mockReturnValue([legacy])
    expect(() => resolvePiTaskAgent('legacy')).toThrow(/仅支持 Pi/)

    listAgentProfilesMock.mockReturnValue([profile({ id: 'temporary', workspacePolicy: 'temporary' })])
    expect(() => resolvePiTaskAgent('temporary')).toThrow(/temporary workspace/)
  })

  it('将 fixed workspace 映射为 workspacePath', () => {
    const agent = profile({
      id: 'fixed-agent',
      workspacePolicy: 'fixed',
      workspacePath: 'F:/projects/fixed-agent',
    })
    listAgentProfilesMock.mockReturnValue([agent])

    expect(resolvePiTaskAgent('fixed-agent')).toEqual({
      profile: agent,
      runtime: 'in-process',
      workspacePath: 'F:/projects/fixed-agent',
    })
  })
})
