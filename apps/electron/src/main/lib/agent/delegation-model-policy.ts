/**
 * Stable model choices for subagents.
 *
 * This module deliberately exposes only display/configuration metadata. Credentials, base URLs,
 * provider-name guesses never enter the delegation prompt. An absent profile is represented as
 * unknown capability metadata; it is not an opt-in gate.
 */
import { isMoaModelId, type DelegationModelProfile } from '@tagent/shared'
import { listChannels } from '../channel/channel-store'
import { readAgentCrewPrefs } from './agent-crew-prefs'

export interface DelegationModelCandidate {
  channelId: string
  channelName: string
  modelId: string
  modelName: string
  strength: DelegationModelProfile['strength']
  speed: DelegationModelProfile['speed']
  cost: DelegationModelProfile['cost']
  goodFor: string[]
  contextWindow?: number
}

export interface DelegationModelSelectionInput {
  channelId: string
  modelId: string
  /** Tool-facing field used by `task`. */
  selectionReason?: string
  /** @deprecated Compatibility for callers not yet migrated to `selectionReason`. */
  reason?: string
  complexity?: 'simple' | 'standard' | 'complex'
}

/**
 * List every active external API model. A profile is optional metadata: an explicit
 * `enabled: false` profile excludes the binding, while an absent profile is exposed
 * with unknown capability/speed/cost so the main model can still make the decision.
 * Channel order and then model order are preserved, making prompt output deterministic.
 */
export function listDelegationModelCandidates(): DelegationModelCandidate[] {
  const profiles = readAgentCrewPrefs().modelProfiles ?? []
  const byBinding = new Map(
    profiles.map((profile) => [`${profile.channelId}\u0000${profile.modelId}`, profile]),
  )
  const candidates: DelegationModelCandidate[] = []
  for (const channel of listChannels()) {
    if (
      !channel.enabled ||
      channel.provider === 'kscc-internal' ||
      channel.provider === 'codex-internal'
    ) {
      continue
    }
    for (const model of channel.models) {
      if (!model.enabled || isMoaModelId(model.id)) continue
      const profile = byBinding.get(`${channel.id}\u0000${model.id}`)
      if (profile?.enabled === false) continue
      candidates.push({
        channelId: channel.id,
        channelName: channel.name,
        modelId: model.id,
        modelName: model.name,
        strength: profile?.strength ?? 'unknown',
        speed: profile?.speed ?? 'unknown',
        cost: profile?.cost ?? 'unknown',
        goodFor: profile ? [...profile.goodFor] : [],
        ...(model.contextWindow !== undefined
          ? { contextWindow: model.contextWindow }
          : {}),
      })
    }
  }
  return candidates
}

/**
 * Controlled instruction for the main model. It selects rather than auto-selecting a model, and
 * the JSON is intentionally limited to public display/capability metadata.
 */
export function buildDelegationModelPrompt(
  candidates: DelegationModelCandidate[] = listDelegationModelCandidates(),
): string {
  const inventory = JSON.stringify(candidates)
  return [
    '## 子代理模型选择',
    `可选模型（已启用的 external API 渠道/模型；只有画像 enabled:false 才排除）：${inventory}`,
    '由主模型为每个子任务选择；先满足足够能力，再权衡速度和成本。小任务优先主模型自己完成；复杂任务优先 strong。未标注画像的模型为 unknown 不得当作快或强。不得重复扫描或修改同一文件；子代理结果必须由主模型验收。不得自动换模；task 的显式 model 必须给出 selectionReason，建议同时给出 complexity。',
    '这里列出的是 API 派发模型的能力画像，不是 Agent runtime 选择；runtime（例如 Pi、Codex、Claude Code）由会话绑定契约单独决定，不要把二者混为一谈。',
  ].join('\n')
}

/**
 * Validate a proposed selection against the live enabled API inventory at dispatch time.
 * It returns the current candidate so callers cannot dispatch from stale profile metadata.
 */
export function validateDelegationModelSelection(
  input: DelegationModelSelectionInput,
): DelegationModelCandidate {
  if (!input || typeof input.channelId !== 'string' || !input.channelId.trim() ||
    typeof input.modelId !== 'string' || !input.modelId.trim()) {
    throw new Error('子代理模型选择须包含 channelId 和 modelId')
  }
  const selectionReason = typeof input.selectionReason === 'string'
    ? input.selectionReason.trim()
    : typeof input.reason === 'string'
      ? input.reason.trim()
      : ''
  if (!selectionReason) throw new Error('子代理模型选择须说明 selectionReason')
  const candidate = listDelegationModelCandidates().find(
    (item) => item.channelId === input.channelId && item.modelId === input.modelId,
  )
  if (!candidate) {
    throw new Error('所选子代理模型当前不可用、未启用或未获用户授权')
  }
  if (input.complexity === 'complex' && candidate.strength === 'standard') {
    throw new Error('复杂任务不能选择标记为 standard 的子代理模型')
  }
  // For unknown on complex work, a non-empty explicit reason is sufficient: do not invent a
  // brittle keyword rule or pretend the unknown capability is stronger/faster than declared.
  return candidate
}
