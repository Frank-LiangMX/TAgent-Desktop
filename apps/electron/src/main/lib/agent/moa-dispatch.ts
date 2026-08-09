/**
 * MoA 调度纯函数：把「会话 modelId 是否走会诊」的决策从 session-service 抽出，便于单测。
 *
 * 不依赖 pi-core / 不拉起子进程 —— 只读渠道 + 预置做结构化判定，返回三种结果：
 * - moa：走 runMoaTurn，预置已校验通过（**绝不**把 moa:* 交给 setModel / kscc --model）
 * - normal：走普通 adapter.query（modelId 为真实模型，可安全 setModel）
 * - error：锁核外部 / 预置缺失 / 模型未启用等，附中文文案
 *
 * 运行时可用性（参考/汇总模型是否 enabled）也在此校验，早失败少占资源。
 */
import {
  type Channel,
  type MoAPreset,
  isMoaModelId,
  moaModelId,
  parseMoaPresetId,
} from '@tagent/shared'

/** 渠道内查找已启用模型；返回 {name} 或 null */
function findEnabledModel(channel: Channel, modelId: string): { name: string } | null {
  const m = channel.models.find((x) => x.id === modelId)
  if (!m || !m.enabled) return null
  return { name: m.name }
}

/**
 * 校验预置对渠道的可用性：参考≥2、参考/汇总模型均在**当前**渠道且 enabled。
 *
 * 不再「仅 kscc-internal」硬拒——跨渠禁席由 modelId 是否属于当前渠道天然保证：
 * kscc 预置的 modelId 不在外部渠 → 这里返回「未启用」错误；反之亦然。
 * 预置结构已由 isValidMoAPreset 保证；此处只做运行时可用性校验。返回中文错误或 null。
 */
export function validateMoAPresetForChannel(preset: MoAPreset, channel: Channel): string | null {
  if (!preset.enabled) {
    return `会诊预置「${preset.name}」已停用`
  }
  if (preset.references.length < 2) {
    return `会诊预置「${preset.name}」参考席不足 2 个，无法会诊`
  }
  for (const ref of preset.references) {
    if (!findEnabledModel(channel, ref.modelId)) {
      return `会诊参考席模型「${ref.modelId}」在当前渠道「${channel.name}」未启用，请在渠道管理中启用或更换预置`
    }
  }
  if (!findEnabledModel(channel, preset.aggregatorModelId)) {
    return `会诊汇总模型「${preset.aggregatorModelId}」在当前渠道「${channel.name}」未启用，请在渠道管理中启用或更换预置`
  }
  return null
}

export type MoADispatch =
  | { kind: 'moa'; preset: MoAPreset }
  | { kind: 'normal'; modelId: string }
  | { kind: 'error'; message: string }

/**
 * One-shot 会诊本条：按 presetId 解析虚拟 modelId 后走与 sticky MoA 相同的调度。
 * 返回的 `modelId` 字段为 `moa:<presetId>`（仅作占位语义，不下发给 kscc）。
 *
 * 不变式：与 `resolveMoADispatch(moaModelId(id), …)` 等价，但少传一层字符串拼装。
 */
export function resolveOneShotMoADispatch(
  presetId: string,
  channel: Channel,
  presets: MoAPreset[],
): MoADispatch {
  return resolveMoADispatch(moaModelId(presetId), channel, presets)
}

/**
 * MoA 单轮要写入会话 meta 的 patch（纯函数，便于单测「one-shot 不写 sticky moa」）。
 *
 * - sticky=true（用户已在 ModelSelector 选 MoA 预置）：modelId 写回 `moa:<id>`，与历史口径一致。
 * - sticky=false（one-shot：本轮临时走会诊但会话 tab / ModelSelector 仍显示真实模型）：
 *   modelId **不**写入 moa:<id>；保留 meta 上的真实 modelId。
 *   草稿会话无 meta 时用 `realModelId` 兜底创建（须为真实模型 id，不以 `moa:` 开头）。
 *
 * channelId / workspaceId / turnCount 与 MoA 无关，本轮一律更新（对齐普通路径）。
 */
export interface MoaMetaPatch {
  channelId: string
  workspaceId?: string
  turnCount: number
  /** sticky 时为 moa:<id>；one-shot 时为 undefined（保留 meta 上的真实 modelId） */
  modelId?: string
}

export function decideMoaMetaPatch(opts: {
  sticky: boolean
  moaModelId: `moa:${string}`
  channelId: string
  workspaceId?: string
  previousTurnCount?: number
  /** one-shot 路径：保留的真实 modelId（must not start with moa:） */
  realModelId?: string
}): MoaMetaPatch {
  const turnCount = (opts.previousTurnCount ?? 0) + 1
  if (opts.sticky) {
    return {
      channelId: opts.channelId,
      workspaceId: opts.workspaceId,
      turnCount,
      modelId: opts.moaModelId,
    }
  }
  // one-shot：不写 modelId；realModelId 仅在「新建会话首条」时回退使用（不该下到 updateSessionMeta）
  return {
    channelId: opts.channelId,
    workspaceId: opts.workspaceId,
    turnCount,
  }
}

/**
 * 按 modelId 决策走 MoA 还是普通链路。
 *
 * 不变式：返回 `normal` 时 modelId 必为真实模型（非 moa:*），可安全 setModel；
 * 返回 `moa` 时调用方走 runMoaTurn，**禁止** setModel('moa:…') / 把 moa:* 传给 kscc。
 */
export function resolveMoADispatch(
  modelId: string | null | undefined,
  channel: Channel,
  presets: MoAPreset[],
): MoADispatch {
  if (!isMoaModelId(modelId)) {
    return { kind: 'normal', modelId: modelId ?? '' }
  }
  // 此后 modelId 形如 moa:<presetId>，绝不作为真实 modelId 下发
  // 不再按 provider 硬拒外部渠：预置席位是否属于当前渠道由 validateMoAPresetForChannel 校验
  // （跨渠禁席 = kscc 预置的 modelId 不在外部渠 → 未启用错误）。外部渠的合成预置由调用方
  // 经 resolveConsultPresetsForChannel 注入 presets 列表，此处按 id 命中。
  const presetId = parseMoaPresetId(modelId)
  const preset = presets.find((p) => p.id === presetId)
  if (!preset) {
    return {
      kind: 'error',
      message: `会诊预置「${presetId ?? modelId}」不存在，请重新选择会诊预置`,
    }
  }
  const validateErr = validateMoAPresetForChannel(preset, channel)
  if (validateErr) {
    return { kind: 'error', message: validateErr }
  }
  return { kind: 'moa', preset }
}
