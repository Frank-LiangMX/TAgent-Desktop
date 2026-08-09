/**
 * MoA（Mixture-of-Agents）预置挂载模型选择器数据契约。
 *
 * 设计要点：
 * - 「会诊」是一种会话级的能力；它用虚拟 modelId `moa:<presetId>` 与渠道/模型平级存放。
 * - 虚拟 modelId 永远不允许被传到 kscc / 任何外部 adapter 的 `--model` / `setModel`
 *   接口；调用前必须先 `parseMoaPresetId` 落回真实预置，再用预置里的真实 modelId 调度。
 * - 预置持久化：默认 seed `default` / `cheap`，落 `~/.tagent/moa-presets.json`；缺省文件
 *   时首次访问会就地 seed 写入。
 *
 * 不在本文件做的：
 * - 运行时编排（runReferenceModels / 汇总）仍在 `packages/pi-core/src/moa-orchestrator.ts`
 * - 会话级"开 MoA / 切 MoA 预置"语义在主进程 `runMoaTurn` 钩子里落地
 */

import type { Channel, ChannelModel } from './channel'

/** MoA 预置的命名空间：与真实 modelId 不冲突，调用方一眼可辨 */
export const MOA_MODEL_ID_PREFIX = 'moa:'

/**
 * 外部渠道合并档的哨兵 channelId（SPEC 05 V3 · 双档：kscc | 外部）。
 *
 * 会诊设置只保留两档：
 * - **kscc 内网**：`channelId` = kscc-internal 渠真实 id（与现 seed 一致）。
 * - **外部渠道**：`channelId` = 本哨兵 `'external'`。所有非 kscc 渠的 stored 预置统一落
 *   `'external'`，不再「一供应商一会诊」；模型下拉 = 所有已启用非 kscc 渠的 enabled 模型按 id 去重合并。
 *
 * 运行时 `resolveConsultPresetsForChannel` 对外部会话渠取 `channelId === 'external'` 班底，
 * 再按**当前会话渠**做 `presetSeatsUsableInChannel`（席位须属当前渠且 enabled，跨渠禁席天然门禁），
 * 不可用则过滤；若空 → 现有合成兜底。
 */
export const MOA_EXTERNAL_SCOPE_ID = 'external'

/** 预置 ID 形态约束：仅允许小写字母/数字/下划线/短横线，长度 1~32。 */
const PRESET_ID_RE = /^[a-z0-9_-]{1,32}$/

/**
 * 判断给定字符串是否为 MoA 虚拟 modelId。
 *
 * 例：`moa:default` → true；`moa:`、`moa`、`<空>`、`glm-5.2` → false。
 */
export function isMoaModelId(modelId: string | null | undefined): modelId is `moa:${string}` {
  if (!modelId) return false
  if (!modelId.startsWith(MOA_MODEL_ID_PREFIX)) return false
  const presetId = modelId.slice(MOA_MODEL_ID_PREFIX.length)
  return PRESET_ID_RE.test(presetId)
}

/** 从虚拟 modelId 抽出 presetId；非法 modelId 返回 null。 */
export function parseMoaPresetId(modelId: string | null | undefined): string | null {
  if (!isMoaModelId(modelId)) return null
  return modelId.slice(MOA_MODEL_ID_PREFIX.length)
}

/** 把 presetId 拼成虚拟 modelId。非法 presetId 抛错（fail-fast，开发期显形）。 */
export function moaModelId(presetId: string): `moa:${string}` {
  if (!PRESET_ID_RE.test(presetId)) {
    throw new Error(`非法 MoA presetId: ${presetId}（仅允许 a-z / 0-9 / _ / -，长度 1~32）`)
  }
  return `${MOA_MODEL_ID_PREFIX}${presetId}` as `moa:${string}`
}

/** 单个参考席（一个会诊模型的角色） */
export interface MoAReferenceSeat {
  /** 显示名（UI 用） */
  name: string
  /** 当前渠道下已启用的真实 modelId（kscc-internal / 外部渠均同此口径） */
  modelId: string
  /**
   * 可选 system 角色提示（同模多角色预置用：怀疑者 / 实操者 各自不同 system）。
   * kscc bare 走 appendSystemPrompt；Pi HTTP 直连走 Context.systemPrompt。
   * 普通多模预置不填 → 走模型默认 system。
   */
  systemPrompt?: string
}

/**
 * MoA 预置（落盘形态）。
 *
 * `references` 至少 2 个；不足时主进程 `runMoaTurn` 会拒绝并发错误消息。
 * `aggregatorModelId` 须属于 kscc-internal 渠道且 enabled，否则同样报错降级。
 */
export interface MoAPreset {
  /** 预置 ID（与虚拟 modelId 后缀一致） */
  id: string
  /**
   * 所属档的 channelId（落盘必填，v2；SPEC 05 V3 · 双档：kscc | 外部）。
   * - kscc 内网档：值 = kscc-internal 渠真实 id（与 seed 一致）。
   * - 外部渠道档：值 = 哨兵 `MOA_EXTERNAL_SCOPE_ID`（'external'），所有非 kscc 渠合并为一档。
   * - 设置 UI / `resolveConsultPresetsForChannel` 按档过滤班底，避免跨档混席。
   * - v1 旧条目无此字段 → `migrateMoAPresetsV1toV2` 绑到唯一 kscc-internal 渠道 id
   *   （兼容「旧无字段视为 kscc」）；遗留真实非 kscc 渠 id → 改写为 'external'。
   * - synthetic 合成预置可不带（ephemeral，不落盘）。
   */
  channelId?: string
  /** UI 显示名（默认会诊 / 省并发 …） */
  name: string
  /** 是否启用（被禁用的预置不展示在 ModelSelector） */
  enabled: boolean
  /** 参考席（至少 2） */
  references: MoAReferenceSeat[]
  /** 汇总席 modelId（须属于当前渠道且 enabled） */
  aggregatorModelId: string
  /** 单席超时（ms），默认 120_000 */
  timeoutMsPerSeat?: number
  /**
   * 圆桌研讨全场轮数上限（仅「圆桌 · 研讨」生效；快速模式 / 会诊忽略）。
   *
   * 缺省 = 3（见设计文档 §5.4「防失控」；T9 提前收敛后默认值由 6 降为 3）。
   * 运行时取值优先级：`ctx.roundLimit` > `preset.roundLimit` > `3`（见 run-moa-discussion.ts）。
   * 合法区间 1..6 的整数；`isValidMoAPreset` 校验，越界 / 非整数拒（缺省放行）。
   */
  roundLimit?: number
  /**
   * 合成预置来源标记（ephemeral，**不落盘**）。
   * 由 `resolveConsultPresetsForChannel` 对外部渠现场合成：
   * - `channel-default`：外部 ≥2 模，无可用 stored 预置时合成「默认会诊」
   * - `channel-same-model`：外部仅 1 模时合成「同模多角色」
   * kscc-internal 的 seed 预置不携带此字段；`isValidMoAPreset` 允许其存在但不要求。
   */
  synthetic?: 'channel-default' | 'channel-same-model'
}

/** 预置文件落盘结构 */
export interface MoAPresetsFile {
  version: 2
  presets: MoAPreset[]
}

/** 默认 seed 预置（首次启动时落盘） */
export const MOA_DEFAULT_PRESETS: readonly MoAPreset[] = [
  {
    id: 'default',
    name: '默认会诊',
    enabled: true,
    references: [
      { name: '架构师', modelId: 'glm-5.2' },
      { name: '实战派', modelId: 'kimi-k2.5' },
    ],
    aggregatorModelId: 'glm-5.2',
    timeoutMsPerSeat: 120_000,
  },
  {
    id: 'cheap',
    name: '省并发',
    enabled: true,
    references: [
      { name: '省并发·甲', modelId: 'glm-5.1' },
      { name: '省并发·乙', modelId: 'mimo-v2.5' },
    ],
    aggregatorModelId: 'glm-5.2',
    timeoutMsPerSeat: 120_000,
  },
] as const

/**
 * 校验预置结构是否合法（仅做字段级校验，不校验 modelId 是否真实可用 — 那是运行时校验）。
 * 用于 seed / load 后的安全检查，避免坏文件导致 UI 崩。
 */
export function isValidMoAPreset(preset: unknown): preset is MoAPreset {
  if (!preset || typeof preset !== 'object') return false
  const p = preset as Partial<MoAPreset>
  if (typeof p.id !== 'string' || !PRESET_ID_RE.test(p.id)) return false
  if (typeof p.name !== 'string' || p.name.length === 0) return false
  if (typeof p.enabled !== 'boolean') return false
  if (!Array.isArray(p.references) || p.references.length < 2) return false
  for (const ref of p.references) {
    if (!ref || typeof ref !== 'object') return false
    const r = ref as Partial<MoAReferenceSeat>
    if (typeof r.name !== 'string' || r.name.length === 0) return false
    if (typeof r.modelId !== 'string' || r.modelId.length === 0) return false
    if (r.modelId.startsWith(MOA_MODEL_ID_PREFIX)) return false // 禁止嵌套
    // systemPrompt 可选；存在则须为字符串（同模多角色预置用）
    if (r.systemPrompt != null && typeof r.systemPrompt !== 'string') return false
  }
  if (typeof p.aggregatorModelId !== 'string' || p.aggregatorModelId.length === 0) return false
  if (p.aggregatorModelId.startsWith(MOA_MODEL_ID_PREFIX)) return false
  if (p.timeoutMsPerSeat != null) {
    if (typeof p.timeoutMsPerSeat !== 'number' || p.timeoutMsPerSeat <= 0) return false
  }
  // roundLimit（圆桌研讨轮数上限）：缺省放行（运行时兜底默认 3）；存在则须为 1..6 的整数
  if (p.roundLimit != null) {
    if (
      typeof p.roundLimit !== 'number' ||
      !Number.isInteger(p.roundLimit) ||
      p.roundLimit < 1 ||
      p.roundLimit > 6
    ) {
      return false
    }
  }
  // channelId：落盘必填（v2）；synthetic 合成预置豁免（ephemeral 不落盘，可无 channelId）。
  // v1 旧条目无 channelId → 服务侧 migrateMoAPresetsV1toV2 绑到 kscc 后再过此校验。
  if (!p.synthetic) {
    if (typeof p.channelId !== 'string' || p.channelId.length === 0) return false
  } else if (p.channelId != null && typeof p.channelId !== 'string') {
    return false
  }
  return true
}

/** 选首条启用的预置；找不到则 fallback 到第一个；都没有返回 null。 */
export function pickDefaultMoAPreset(presets: MoAPreset[]): MoAPreset | null {
  const enabled = presets.find((p) => p.enabled)
  return enabled ?? presets[0] ?? null
}

/**
 * 落盘预置归一到双档（kscc | 外部）模型（SPEC 05 V3）。
 *
 * - 缺 channelId（v1 旧文件）→ 绑到 `ksccChannelId`（兼容「旧无字段视为 kscc」）。
 * - `channelId === ksccChannelId` → 保持（kscc 内网档）。
 * - `channelId === MOA_EXTERNAL_SCOPE_ID` → 保持（已迁移外部档）。
 * - 其余（旧「一供应商一会诊」落盘的真实非 kscc 渠 id，如 DeepSeek 的真实 id）→ 改写为
 *   `MOA_EXTERNAL_SCOPE_ID`（'external' 哨兵），实现「外部渠合并」。
 * - 调用方（moa-preset-service）在读到 version<2、条目缺 channelId、或存在遗留非 kscc 渠 id 时调用，
 *   随后写回 `version: 2`。纯函数，便于单测。
 */
export function migrateMoAPresetsV1toV2(
  presets: MoAPreset[],
  ksccChannelId: string,
): MoAPreset[] {
  return presets.map((p) => {
    if (!p.channelId || p.channelId.length === 0) {
      return { ...p, channelId: ksccChannelId }
    }
    if (p.channelId === ksccChannelId || p.channelId === MOA_EXTERNAL_SCOPE_ID) {
      return p
    }
    // 遗留非 kscc 真实渠 id → 外部合并档哨兵
    return { ...p, channelId: MOA_EXTERNAL_SCOPE_ID }
  })
}

// ============ 按渠道解析会诊预置（SPEC 03-PI-EXTERNAL-MOA §3） ============

/** 同模多角色：怀疑者 system 提示（挑刺 / 反例 / 风险） */
const SAME_MODEL_SKEPTIC_SYSTEM =
  '你是「怀疑者」。请以审慎、批判的视角回答用户问题：指出假设漏洞、潜在风险、边界情况与反例，必要时给出明确的反对意见。'
/** 同模多角色：实操者 system 提示（务实 / 步骤 / 工程取舍） */
const SAME_MODEL_PRACTITIONER_SYSTEM =
  '你是「实操者」。请以可落地执行的视角回答用户问题：给出务实方案、具体步骤与工程取舍，关注可行性与成本。'

/** 渠道内某 modelId 是否属于已启用模型 */
function isModelEnabledInChannel(channel: Channel, modelId: string): boolean {
  return channel.models.some((m) => m.id === modelId && m.enabled)
}

/**
 * 预置的全部席位（参考 ≥2 + 汇总）是否都属于当前渠道且 enabled。
 * 这是「同场不混核 / 跨渠禁席」的天然门禁：kscc 预置的 modelId 不在外部渠 → 这里 false。
 */
function presetSeatsUsableInChannel(preset: MoAPreset, channel: Channel): boolean {
  if (!preset.enabled) return false
  if (preset.references.length < 2) return false
  if (!preset.references.every((r) => isModelEnabledInChannel(channel, r.modelId))) return false
  if (!isModelEnabledInChannel(channel, preset.aggregatorModelId)) return false
  return true
}

/** 外部渠 ≥2 模：合成「默认会诊」（参考=前 2 个互异 enabled，汇总=defaultModelId 或第一个） */
function synthesizeDefaultPreset(channel: Channel, enabledModels: ChannelModel[]): MoAPreset {
  const a = enabledModels[0]!
  const b = enabledModels[1]!
  const aggregatorId =
    channel.defaultModelId && isModelEnabledInChannel(channel, channel.defaultModelId)
      ? channel.defaultModelId
      : a.id
  return {
    id: 'channel-default',
    name: '默认会诊',
    enabled: true,
    references: [
      { name: `参考·${a.name}`, modelId: a.id },
      { name: `参考·${b.name}`, modelId: b.id },
    ],
    aggregatorModelId: aggregatorId,
    timeoutMsPerSeat: 120_000,
    synthetic: 'channel-default',
  }
}

/** 外部渠仅 1 模：合成「同模多角色」（两参考同 modelId + 不同 system，汇总=同一 modelId） */
function synthesizeSameModelPreset(model: ChannelModel): MoAPreset {
  return {
    id: 'channel-same-model',
    name: '同模多角色',
    enabled: true,
    references: [
      { name: '怀疑者', modelId: model.id, systemPrompt: SAME_MODEL_SKEPTIC_SYSTEM },
      { name: '实操者', modelId: model.id, systemPrompt: SAME_MODEL_PRACTITIONER_SYSTEM },
    ],
    aggregatorModelId: model.id,
    timeoutMsPerSeat: 120_000,
    synthetic: 'channel-same-model',
  }
}

/**
 * 基于已启用模型列表合成一条**可编辑 draft**预置（设置页空态 CTA 用）。
 *
 * - ≥2 模：`channel-default` 形态（前 2 个互异 enabled 作参考，汇总=defaultModelId 或首个 enabled）。
 * - =1 模：`channel-same-model` 形态（两参考同 modelId + 怀疑者/实操者 system，汇总同 modelId）。
 * - 0 模：返回 `null`（UI 应禁用 CTA）。
 *
 * 与 `synthesizeDefaultPreset` / `synthesizeSameModelPreset` 同形态，但**不带** `synthetic` 标记、
 * 用调用方给定的 `presetId`、写入 `channelId`（保存后落盘属该档）。纯函数，便于单测。
 */
function buildDraftFromModels(
  enabledModels: ChannelModel[],
  channelId: string,
  defaultModelId: string | undefined,
  presetId: string,
): MoAPreset | null {
  if (enabledModels.length === 0) return null
  if (enabledModels.length === 1) {
    const m = enabledModels[0]!
    return {
      id: presetId,
      name: '同模多角色',
      enabled: true,
      references: [
        { name: '怀疑者', modelId: m.id, systemPrompt: SAME_MODEL_SKEPTIC_SYSTEM },
        { name: '实操者', modelId: m.id, systemPrompt: SAME_MODEL_PRACTITIONER_SYSTEM },
      ],
      aggregatorModelId: m.id,
      timeoutMsPerSeat: 120_000,
      roundLimit: 3,
      channelId,
    }
  }
  const a = enabledModels[0]!
  const b = enabledModels[1]!
  const aggregatorId =
    defaultModelId && enabledModels.some((m) => m.id === defaultModelId)
      ? defaultModelId
      : a.id
  return {
    id: presetId,
    name: '默认会诊',
    enabled: true,
    references: [
      { name: `参考·${a.name}`, modelId: a.id },
      { name: `参考·${b.name}`, modelId: b.id },
    ],
    aggregatorModelId: aggregatorId,
    timeoutMsPerSeat: 120_000,
    roundLimit: 3,
    channelId,
  }
}

/**
 * 基于**当前渠道**已启用模型合成一条可编辑 draft 预置（kscc 档空态 CTA 用）。
 * `channelId` 写入 `channel.id`（kscc 内网档）。纯函数，便于单测。
 */
export function buildChannelBasedDraftPreset(
  channel: Channel,
  presetId: string,
): MoAPreset | null {
  return buildDraftFromModels(
    channel.models.filter((m) => m.enabled),
    channel.id,
    channel.defaultModelId,
    presetId,
  )
}

/**
 * 基于**外部档合并模型列表**合成一条可编辑 draft 预置（外部渠道档空态 CTA 用）。
 *
 * 入参为「所有已启用非 kscc 渠」的 enabled 模型按 id 去重合并列表（UI 侧组装）。
 * `channelId` 写入 `MOA_EXTERNAL_SCOPE_ID`（'external' 哨兵）；无单渠 defaultModelId，
 * 汇总取合并列表首个 enabled。0 模返回 null（UI 禁用 CTA）。纯函数，便于单测。
 */
export function buildExternalScopeDraftPreset(
  mergedEnabledModels: ChannelModel[],
  presetId: string,
): MoAPreset | null {
  return buildDraftFromModels(mergedEnabledModels, MOA_EXTERNAL_SCOPE_ID, undefined, presetId)
}

/**
 * 按档过滤 stored 预置（SPEC 05 V3 · 双档：kscc | 外部）。
 *
 * - kscc-internal 渠（kscc 内网档）：`channelId === channel.id`，或旧 v1 无 `channelId`（兼容视为 kscc）。
 * - 其它 provider（外部渠道档）：仅 `channelId === MOA_EXTERNAL_SCOPE_ID`（'external' 哨兵）。
 *   旧无字段不算外部席（避免跨档混席）；遗留真实非 kscc 渠 id 由 service 迁移为 'external' 后才到此。
 */
function presetBelongsToChannel(preset: MoAPreset, channel: Channel): boolean {
  if (channel.provider === 'kscc-internal') {
    return !preset.channelId || preset.channelId === channel.id
  }
  return preset.channelId === MOA_EXTERNAL_SCOPE_ID
}

/**
 * 按当前会话渠解析「会诊本条」菜单可用预置（纯函数，渲染层与主进程共用）。
 *
 * stored 先按档过滤（`presetBelongsToChannel`），再跑可用性/合成：
 * - kscc-internal（kscc 内网档）：取 `channelId === kscc.id`（及 v1 无字段兼容）的 stored 中
 *   席位均属本渠且 enabled 者；不可用的过滤掉（不合成）。
 * - 其它 provider（外部渠道档）：取 `channelId === 'external'` 班底，再按**当前会话渠**做
 *   `presetSeatsUsableInChannel`（席位须属当前渠且 enabled，跨渠禁席天然门禁）；不可用则过滤；
 *   - 当前渠 enabled≥2：matched 优先；若无 → 合成 `channel-default`。
 *   - 当前渠 enabled=1：matched 优先；若无 → 合成 `channel-same-model`（同模多角色）。
 *   - 当前渠 enabled=0 / 渠道缺失或禁用：返回 `[]`（菜单退回单发送键）。
 *
 * 「设置可配覆盖合成」：用户保存 ≥1 条合法班底后，优先用 stored；无则合成兜底。
 * 合成预置 **ephemeral**：不写 `moa-presets.json`。
 */
export function resolveConsultPresetsForChannel(
  channel: Channel | null | undefined,
  storedPresets: MoAPreset[],
): MoAPreset[] {
  if (!channel || !channel.enabled) return []
  const enabledModels = channel.models.filter((m) => m.enabled)
  const channelPresets = storedPresets.filter((p) => presetBelongsToChannel(p, channel))
  if (channel.provider === 'kscc-internal') {
    return channelPresets.filter((p) => presetSeatsUsableInChannel(p, channel))
  }
  // 外部渠道档：取 external 班底，按当前会话渠校验席位；不可用则过滤；空 → 合成兜底
  const matched = channelPresets.filter((p) => presetSeatsUsableInChannel(p, channel))
  if (enabledModels.length >= 2) {
    return matched.length > 0 ? matched : [synthesizeDefaultPreset(channel, enabledModels)]
  }
  if (enabledModels.length === 1) {
    return matched.length > 0 ? matched : [synthesizeSameModelPreset(enabledModels[0]!)]
  }
  return []
}