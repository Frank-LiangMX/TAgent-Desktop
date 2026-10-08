import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'tagent-delegation-model-'))
process.env.TAGENT_CONFIG_DIR = configDir
process.env.TAGENT_DEV = '1'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => configDir, getAppPath: () => configDir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}))

const { writeJsonAtomic } = await import('../atomic-json')
const { getChannelsPath } = await import('../config/config-paths')
const { writeAgentCrewPrefs } = await import('./agent-crew-prefs')
const {
  buildDelegationModelPrompt,
  listDelegationModelCandidates,
  validateDelegationModelSelection,
} = await import('./delegation-model-policy')

function seedChannels(): void {
  writeJsonAtomic(getChannelsPath(), {
    version: 1,
    channels: [
      {
        id: 'api-a', name: 'API A', provider: 'custom',
        baseUrl: 'https://secret-a.example/v1', apiKey: 'secret-a', enabled: true,
        models: [
          { id: 'strong-model', name: 'Strong', enabled: true, contextWindow: 128000 },
          { id: 'standard-model', name: 'Standard', enabled: true },
          { id: 'unprofiled-model', name: 'Unprofiled', enabled: true },
          { id: 'opted-out-model', name: 'Opted out', enabled: true },
          { id: 'moa:roundtable', name: 'MoA', enabled: true },
          { id: 'disabled-model', name: 'Disabled', enabled: false },
        ], createdAt: 0, updatedAt: 0,
      },
      {
        id: 'api-disabled', name: 'Disabled API', provider: 'openai',
        baseUrl: 'https://secret-disabled.example', apiKey: 'secret-disabled', enabled: false,
        models: [{ id: 'model', name: 'Model', enabled: true }], createdAt: 0, updatedAt: 0,
      },
      {
        id: 'kscc', name: 'Legacy', provider: 'kscc-internal',
        baseUrl: '', apiKey: '', enabled: true,
        models: [{ id: 'kscc-model', name: 'KSCC', enabled: true }], createdAt: 0, updatedAt: 0,
      },
    ],
  })
}

beforeEach(() => {
  mkdirSync(configDir, { recursive: true })
  seedChannels()
  writeAgentCrewPrefs({
    autoOpenPanelOnDispatch: true,
    maxParallelWorkers: 3,
    showFlowAsGraph: false,
    modelProfiles: [
      { channelId: 'api-a', modelId: 'strong-model', enabled: true, strength: 'strong', speed: 'fast', cost: 'high', goodFor: ['coding'] },
      { channelId: 'api-a', modelId: 'standard-model', enabled: true, strength: 'standard', speed: 'balanced', cost: 'low', goodFor: ['review'] },
      { channelId: 'api-a', modelId: 'opted-out-model', enabled: false, strength: 'strong', speed: 'fast', cost: 'low', goodFor: [] },
      { channelId: 'api-a', modelId: 'disabled-model', enabled: false, strength: 'strong', speed: 'fast', cost: 'low', goodFor: [] },
      { channelId: 'api-disabled', modelId: 'model', enabled: true, strength: 'strong', speed: 'fast', cost: 'low', goodFor: [] },
      { channelId: 'kscc', modelId: 'kscc-model', enabled: true, strength: 'strong', speed: 'fast', cost: 'low', goodFor: [] },
      { channelId: 'api-a', modelId: 'moa:roundtable', enabled: true, strength: 'strong', speed: 'fast', cost: 'low', goodFor: [] },
    ],
  })
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

describe('delegation model policy', () => {
  it('lists enabled external API models and marks absent profiles unknown', () => {
    expect(listDelegationModelCandidates()).toEqual([
      {
        channelId: 'api-a', channelName: 'API A',
        modelId: 'strong-model', modelName: 'Strong',
        strength: 'strong', speed: 'fast', cost: 'high', goodFor: ['coding'], contextWindow: 128000,
      },
      {
        channelId: 'api-a', channelName: 'API A',
        modelId: 'standard-model', modelName: 'Standard',
        strength: 'standard', speed: 'balanced', cost: 'low', goodFor: ['review'],
      },
      {
        channelId: 'api-a', channelName: 'API A',
        modelId: 'unprofiled-model', modelName: 'Unprofiled',
        strength: 'unknown', speed: 'unknown', cost: 'unknown', goodFor: [],
      },
    ])
    expect(listDelegationModelCandidates().map((candidate) => candidate.modelId)).not.toContain('opted-out-model')
  })

  it('builds a concise safe prompt without credentials, endpoint, or model-name guesses', () => {
    const prompt = buildDelegationModelPrompt()
    expect(prompt).toContain('strong-model')
    expect(prompt).toContain('先满足足够能力，再权衡速度和成本')
    expect(prompt).toContain('unknown 不得当作快或强')
    expect(prompt).toContain('不得自动换模')
    expect(prompt).toContain('selectionReason')
    expect(prompt).toContain('complexity')
    expect(prompt).toContain('task 的显式 model')
    expect(prompt).not.toContain('kanban_add_task')
    expect(prompt).toContain('建议同时给出 complexity')
    expect(prompt).toContain('API 派发模型的能力画像，不是 Agent runtime')
    expect(prompt).not.toContain('secret-a')
    expect(prompt).not.toContain('secret-a.example')
    expect(prompt).not.toContain('disabled-model')
  })

  it('requires selectionReason and a live candidate; complex work rejects standard but permits unknown with stated uncertainty', () => {
    expect(() => validateDelegationModelSelection({ channelId: 'api-a', modelId: 'strong-model' })).toThrow(/selectionReason/)
    expect(() => validateDelegationModelSelection({ channelId: 'api-a', modelId: 'standard-model', selectionReason: 'review', complexity: 'complex' })).toThrow(/standard/)
    expect(validateDelegationModelSelection({ channelId: 'api-a', modelId: 'strong-model', selectionReason: 'complex refactor', complexity: 'complex' })).toMatchObject({ modelId: 'strong-model' })

    writeAgentCrewPrefs({
      autoOpenPanelOnDispatch: true, maxParallelWorkers: 3, showFlowAsGraph: false,
      modelProfiles: [{ channelId: 'api-a', modelId: 'standard-model', enabled: true, strength: 'unknown', speed: 'unknown', cost: 'unknown', goodFor: [] }],
    })
    expect(validateDelegationModelSelection({
      channelId: 'api-a', modelId: 'standard-model', complexity: 'complex',
      selectionReason: '能力资料未知，先让主模型复核子结果',
    })).toMatchObject({ strength: 'unknown' })
  })
})
