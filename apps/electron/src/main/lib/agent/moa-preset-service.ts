/**
 * MoA 会诊预置存储服务。
 *
 * 落盘路径：~/.tagent[-dev]/moa-presets.json（版本化 JSON，当前 v2）
 * - 缺省文件时首次读取 → 就地 seed 默认预置（default / cheap，绑到 kscc-internal 渠道 id）
 * - 文件存在但解析失败 → 用 atomic-json 的 readJsonSafe 自愈（备份恢复）
 * - seed 后的预置不再覆盖用户编辑（用户删 custom 后只剩 default 也保留）
 * - v1 → v2 迁移：读到 version<2 或条目缺 channelId → 绑到当前唯一 kscc-internal 渠道 id，写回 v2
 *   （SPEC 05 §3：班底按 channelId 落盘，避免跨渠混席）
 * - 外部渠合并迁移（SPEC 05 V3）：读到遗留非 kscc 真实渠 id（旧「一供应商一会诊」）→ 改写为
 *   `MOA_EXTERNAL_SCOPE_ID`（'external' 哨兵），所有非 kscc 渠合并为外部档，写回 v2
 *
 * UI CRUD（SPEC 04 · Agent 行为 / 会诊班底；SPEC 05 · 双核 channelId）：
 * - `listMoaPresets` 供设置页读 + ModelSelector 读；`writeMoaPresets` 供设置页保存。
 * - 保存走整单校验（`validateMoAPresetList`）：任一条目非法即拒写、抛中文错，不脏写盘。
 * - 只编辑 stored 预置；synthetic / channel-default / channel-same-model 由外部渠现场合成，
 *   不进设置列表、不落盘（写入时防御性剥离 `synthetic` 字段）。
 *
 * 设计取舍（与 SPEC §5 E1 一致）：
 * - 通道校验延迟到发送前 runMoaTurn 阶段，本服务不做"modelId 是否真实存在"的二次校验，
 *   这样新建 kscc-internal 渠道 + 默认预置就绪后立即可用，无需重启。
 */
import {
  MOA_DEFAULT_PRESETS,
  MOA_EXTERNAL_SCOPE_ID,
  isValidMoAPreset,
  migrateMoAPresetsV1toV2,
  type MoAPreset,
  type MoAPresetsFile,
} from '@tagent/shared'
import { getMoaPresetsPath } from '../config/config-paths'
import { getKsccChannelId } from '../channel/channel-store'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'

/** 无渠道配置时（测试 / 未 seed）回落到内置 kscc 渠道 id（fresh 安装口径，见 channel-store KSCC_BUILTIN_CHANNEL_ID） */
const KSCC_FALLBACK_CHANNEL_ID = 'kscc-internal'

/** 解析当前 kscc-internal 渠道 id；无渠道配置时回落内置 id */
function resolveKsccChannelId(): string {
  return getKsccChannelId() ?? KSCC_FALLBACK_CHANNEL_ID
}

/** 默认文件结构：首次 seed 时落盘（v2，预置绑到 kscc 渠道 id） */
function buildSeed(ksccChannelId: string): MoAPresetsFile {
  return {
    version: 2,
    presets: MOA_DEFAULT_PRESETS.map((p) => ({
      ...p,
      references: p.references.map((r) => ({ ...r })),
      channelId: ksccChannelId,
    })),
  }
}

/**
 * 旧版内置模板的精确席位签名。只命中未改过席位的 default / cheap，
 * 只为 Kscc 更新内置班底（新增模型、快速省并发）时升级；自定义班底绝不覆盖。
 */
interface BuiltinSeatSignature {
  name: string
  references: ReadonlyArray<{ name: string; modelId: string }>
  aggregatorModelId: string
}

const LEGACY_BUILTIN_SEAT_SIGNATURES: Record<'default' | 'cheap', readonly BuiltinSeatSignature[]> = {
  default: [{
    name: '默认会诊',
    references: [
      { name: '架构师', modelId: 'glm-5.2' },
      { name: '实战派', modelId: 'kimi-k2.5' },
    ],
    aggregatorModelId: 'glm-5.2',
  }],
  cheap: [
    {
      name: '省并发',
      references: [
        { name: '省并发·甲', modelId: 'glm-5.1' },
        { name: '省并发·乙', modelId: 'mimo-v2.5' },
      ],
      aggregatorModelId: 'glm-5.2',
    },
    {
      name: '省并发',
      references: [
        { name: '省并发·甲', modelId: 'glm-5.1' },
        { name: '省并发·乙', modelId: 'kimi-k2.5' },
      ],
      aggregatorModelId: 'mimo-v2.5',
    },
  ],
}

function hasExactSeatSignature(
  preset: MoAPreset,
  signature: BuiltinSeatSignature,
): boolean {
  return (
    preset.name === signature.name &&
    preset.aggregatorModelId === signature.aggregatorModelId &&
    preset.references.length === signature.references.length &&
    preset.references.every(
      (seat, index) =>
        seat.name === signature.references[index]?.name &&
        seat.modelId === signature.references[index]?.modelId &&
        seat.systemPrompt == null,
    )
  )
}

/** 只升级保留旧内置席位的 kscc 预置；配置过的预置原样返回。 */
function migrateLegacyBuiltinSeats(presets: MoAPreset[], ksccChannelId: string): MoAPreset[] {
  return presets.map((preset) => {
    if (preset.channelId !== ksccChannelId || (preset.id !== 'default' && preset.id !== 'cheap')) {
      return preset
    }
    const signatures = LEGACY_BUILTIN_SEAT_SIGNATURES[preset.id]
    const nextTemplate = MOA_DEFAULT_PRESETS.find((item) => item.id === preset.id)
    if (!nextTemplate || !signatures.some((signature) => hasExactSeatSignature(preset, signature))) return preset
    return {
      ...preset,
      references: nextTemplate.references.map((seat) => ({ ...seat })),
      aggregatorModelId: nextTemplate.aggregatorModelId,
    }
  })
}

/**
 * 读取预置列表；首次访问（文件不存在）就地 seed 默认预置并落盘。
 *
 * 返回的预置列表保留文件里的原始顺序，便于 UI 稳定展示。
 * 若文件里有无效条目（用户手动改坏）则丢弃，仅保留通过 `isValidMoAPreset` 的。
 * 双档归一迁移：读到 version<2、条目缺 channelId、或遗留非 kscc 真实渠 id → 绑到 kscc /
 * 改写为 external 哨兵，写回 version 2（SPEC 05 V3 · 外部渠合并）。synthetic 合成预置不落盘，不进此列表。
 */
export function listMoaPresets(): MoAPreset[] {
  const filePath = getMoaPresetsPath()
  const ksccChannelId = resolveKsccChannelId()
  const seed = buildSeed(ksccChannelId)
  const parsed = readJsonSafe<MoAPresetsFile | null>(filePath, null)

  // 文件不存在 → 就地 seed（v2，带 channelId）
  if (!parsed) {
    try {
      writeJsonAtomic(filePath, seed)
    } catch (err) {
      console.warn('[moa-preset-service] seed 落盘失败，仍返回内存默认：', err)
    }
    return seed.presets
  }

  // 文件存在但非法（非对象 / 无 presets 数组）→ 当 seed 覆盖
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.presets)) {
    console.warn('[moa-preset-service] 文件格式不识别，触发 seed 覆盖')
    try {
      writeJsonAtomic(filePath, seed)
    } catch (err) {
      console.warn('[moa-preset-service] seed 重写失败：', err)
    }
    return seed.presets
  }

  // 双档归一迁移（SPEC 05 V3 · 外部渠合并）：version<2、条目缺 channelId、或存在遗留非 kscc 真实渠 id
  // → 绑到 kscc-internal 渠 id / 改写为 external 哨兵，写回 v2
  let presets: MoAPreset[] = parsed.presets
  let needsWrite = parsed.version !== 2
  const needsScopeMigration = presets.some(
    (p) =>
      p &&
      typeof p === 'object' &&
      (!p.channelId ||
        (p.channelId !== ksccChannelId && p.channelId !== MOA_EXTERNAL_SCOPE_ID)),
  )
  if (parsed.version !== 2 || needsScopeMigration) {
    presets = migrateMoAPresetsV1toV2(presets, ksccChannelId)
    needsWrite = true
  }

  // 过滤合法条目（顺序按文件原序）；isValidMoAPreset 现要求非空 channelId（synthetic 除外）
  const valid = presets.filter((p) => isValidMoAPreset(p))
  if (valid.length !== presets.length) {
    console.warn(`[moa-preset-service] ${presets.length - valid.length} 条非法预置已丢弃`)
    needsWrite = true
  }

  // K2.6 / MiMo Pro 入库后的内置班底升级：仅改精确匹配旧模板的 kscc 预置。
  const upgraded = migrateLegacyBuiltinSeats(valid, ksccChannelId)
  if (upgraded.some((preset, index) => preset !== valid[index])) {
    needsWrite = true
  }

  if (needsWrite) {
    try {
      writeJsonAtomic(filePath, { version: 2, presets: stripEphemeral(upgraded) })
    } catch (err) {
      console.warn('[moa-preset-service] v2 迁移写回失败：', err)
    }
  }
  return upgraded
}

/**
 * 整单校验预置列表：任一条目结构非法或 id 重复即返回中文错误，全合法返回 null。
 *
 * SPEC 04 §2.2：保存时「整单校验失败则 reject 中文错，不写盘」。
 * 结构校验复用 `isValidMoAPreset`（参考≥2、id/name 非空、modelId 非 moa: 前缀等），
 * 额外保证 id 唯一（虚拟 modelId 后缀撞车会让 ModelSelector / dispatch 误命中）。
 */
export function validateMoAPresetList(presets: unknown): string | null {
  if (!Array.isArray(presets)) {
    return '预置列表格式不合法：期望数组'
  }
  const ids = new Set<string>()
  for (const p of presets) {
    if (!isValidMoAPreset(p)) {
      const obj = p && typeof p === 'object' ? (p as Record<string, unknown>) : null
      const name = obj && typeof obj.name === 'string' ? obj.name : '未知'
      const id = obj && typeof obj.id === 'string' ? obj.id : '—'
      return `会诊预置「${name}」（${id}）结构不合法：须含合法 id、非空 name、enabled 布尔、≥2 个参考席、非空汇总 modelId、非空 channelId（synthetic 除外），且 modelId 不以 moa: 开头`
    }
    if (ids.has(p.id)) {
      return `预置 id 重复：「${p.id}」，请为新建预置使用唯一 id`
    }
    ids.add(p.id)
  }
  return null
}

/** 写入前防御性剥离 ephemeral 字段（synthetic 不落盘）。 */
function stripEphemeral(presets: MoAPreset[]): MoAPreset[] {
  return presets.map((p) => {
    if (p.synthetic === undefined) return p
    const { synthetic: _synthetic, ...rest } = p
    return rest
  })
}

/**
 * 写入整份预置文件（覆盖式原子写）。
 *
 * 整单校验失败（任一条目非法 / id 重复）→ 抛中文错、**不写盘**（SPEC 04 §2.2）。
 * 合法则剥离 synthetic 等 ephemeral 字段后原子写。
 * 设置页保存 IPC（`agent:save-moa-presets`）经此函数；调用方捕获错误回显给用户。
 */
export function writeMoaPresets(presets: MoAPreset[]): void {
  const err = validateMoAPresetList(presets)
  if (err) throw new Error(err)
  writeJsonAtomic(getMoaPresetsPath(), {
    version: 2,
    presets: stripEphemeral(presets),
  })
}
