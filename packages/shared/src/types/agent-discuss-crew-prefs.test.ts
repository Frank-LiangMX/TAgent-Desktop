import { describe, expect, it } from 'vitest'
import {
  AGENT_CREW_PREFS_DEFAULT,
  sanitizeAgentCrewPrefs,
  validateAgentCrewPrefs,
  type AgentCrewPrefs,
  type DelegationModelProfile,
} from './agent-discuss-crew-prefs'

const base: AgentCrewPrefs & {
  modelProfiles: Array<DelegationModelProfile & { apiKey: string; baseUrl: string }>
} = {
  ...AGENT_CREW_PREFS_DEFAULT,
  modelProfiles: [{
    channelId: ' api ',
    modelId: ' model ',
    enabled: true,
    strength: 'strong',
    speed: 'fast',
    cost: 'medium',
    goodFor: [' coding ', 'review'],
    apiKey: 'must-not-survive',
    baseUrl: 'must-not-survive',
  }],
}

describe('AgentCrewPrefs delegation model profiles', () => {
  it('keeps old prefs valid when modelProfiles is absent', () => {
    expect(validateAgentCrewPrefs(AGENT_CREW_PREFS_DEFAULT)).toBeNull()
    expect(sanitizeAgentCrewPrefs(AGENT_CREW_PREFS_DEFAULT)).not.toHaveProperty('modelProfiles')
  })

  it('validates and sanitizes known profile fields without credentials', () => {
    expect(validateAgentCrewPrefs(base)).toBeNull()
    expect(sanitizeAgentCrewPrefs(base)).toEqual({
      ...AGENT_CREW_PREFS_DEFAULT,
      modelProfiles: [{
        channelId: 'api',
        modelId: 'model',
        enabled: true,
        strength: 'strong',
        speed: 'fast',
        cost: 'medium',
        goodFor: ['coding', 'review'],
      }],
    })
  })

  it('rejects duplicate bindings, invalid enums, and excessive labels', () => {
    expect(validateAgentCrewPrefs({
      ...base,
      modelProfiles: [base.modelProfiles[0], { ...base.modelProfiles[0] }],
    })).toMatch(/重复/)
    expect(validateAgentCrewPrefs({
      ...base,
      modelProfiles: [{ ...base.modelProfiles[0], strength: 'fast' }],
    })).toMatch(/能力/)
    expect(validateAgentCrewPrefs({
      ...base,
      modelProfiles: [{ ...base.modelProfiles[0], goodFor: Array.from({ length: 9 }, () => 'tag') }],
    })).toMatch(/最多 8/)
    expect(validateAgentCrewPrefs({
      ...base,
      modelProfiles: Array.from({ length: 201 }, (_, i) => ({ ...base.modelProfiles[0], modelId: `m-${i}` })),
    })).toMatch(/最多 200/)
  })
})
