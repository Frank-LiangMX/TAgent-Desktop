/**
 * CLI 工人配置数据契约（本地 coding CLI 子代理后端）。
 *
 * 设计要点：
 * - 本机 coding CLI 为「可选子代理后端池」；seed 预置 4 个工人（kscc / grok / codex / mimo）。
 * - **启用 + 数组顺序 = 优先级**：主会话 task 可指定 `cli`；未指定时按顺序选第一个本机可用的。
 * - `defaultCliId` 仅兼容旧文件：运行时不再当作唯一硬默认；保存时同步为「第一个 enabled」。
 * - 默认 **关闭**（`enabled: false` + `defaultBackend: 'in-process'`），总开关 false 时 task 永远 in-process。
 * - 落盘扁平结构（`~/.tagent[-dev]/cli-workers.json`）。
 * - 旧配置仅有 1 条 kscc 时，`ensureSeedWorkers` 补齐缺的 grok/codex/mimo。
 *
 * 不在本文件做的：spawn / observer / 运行时编排、设置 UI。
 */

/** 工人后端形态：in-process（内置 Agent）/ cli（spawn 本机 CLI 当子代理） */
export type CliWorkerBackend = 'in-process' | 'cli'

/** CLI 工人推理强度档（low < medium < high） */
export type CliReasoning = 'low' | 'medium' | 'high'

/** CLI 工人输入模态：text 纯文本；vision 支持视觉输入 */
export type CliModality = 'text' | 'vision'

/**
 * CLI 工人能力画像。
 *
 * 供主 Agent 在 task 调用时按 require（硬性过滤）/ prefer（软性打分）挑选工人，
 * 而非仅按数组顺序。字段均可缺省：旧配置无 capability 仍合法，按中性折算。
 */
export interface CliWorkerCapability {
  /** 粗略相对成本档：1 最便宜 ~ 5 最贵 */
  cost: 1 | 2 | 3 | 4 | 5
  reasoning: CliReasoning
  /** 输入模态；缺省 ['text']，显式含 'vision' 才支持视觉 */
  modalities?: CliModality[]
  /** 适合场景一句话（注入能力卡给主 Agent 自选用） */
  goodFor?: string
}

/** 单个 CLI 工人条目（id 为 CLI 标识：kscc / grok / codex / mimo，或任意非黑名单 id） */
export interface CliWorkerEntry {
  /** 工人 id（kscc / grok / codex / mimo，或任意非黑名单的 id） */
  id: string
  /**
   * 是否启用。
   * 禁用者不入池；启用者按 `workers` 数组顺序参与优先级挑选。
   */
  enabled: boolean
  /** 可执行名或绝对路径；默认与 id 同名（如 'kscc'） */
  bin: string
  /** 默认模型 id（如 'glm-5.2'），可选 */
  defaultModel?: string
  /** 能力画像（可选；旧配置缺省合法，缺省时按中性折算） */
  capability?: CliWorkerCapability
}

/**
 * CLI 工人配置（落盘形态 = 扁平 v1）。
 *
 * `workers` 数组顺序 = 自动挑选优先级（越靠前越高）。
 * 主 Agent 可通过 task 参数 `cli` 显式指定某一启用工人。
 */
export interface CliWorkersConfig {
  version: 1
  /** 总开关：false 时 task 永远 in-process，不 spawn CLI */
  enabled: boolean
  defaultBackend: CliWorkerBackend
  /**
   * 兼容字段：历史「唯一默认 CLI」。
   * 运行时以 `listEnabledWorkersByPriority` 为准；保存时建议 `syncDefaultCliId` 同步为第一个 enabled。
   */
  defaultCliId: string
  /** 工人池；顺序即优先级 */
  workers: CliWorkerEntry[]
}

/**
 * CLI 工人文件 · 嵌套备选形态（`{ version, config }` 外层）。
 *
 * **不推荐**：brief 推荐扁平落盘（文件本体直接是 `CliWorkersConfig`）。
 * 保留此类型仅为记录数据契约的两种可选形态；服务实际读写扁平 `CliWorkersConfig`。
 */
export interface CliWorkersFile {
  version: 1
  config: CliWorkersConfig
}

/**
 * 默认 seed 配置（文件不存在时落盘）。
 *
 * 零行为变化：总开关 `enabled: false`、`defaultBackend: 'in-process'`、`defaultCliId: 'kscc'`，
 * 预置 4 个工人（kscc / grok / codex / mimo），kscc 带 `glm-5.2`，其余 defaultModel 留空（用 CLI 各自默认）。
 * 工人 enabled=true 仅表示「可被选中」，待总开关 + 后端就绪后才真正 spawn。
 * 每个工人带能力画像（cost / reasoning / goodFor；modalities 缺省 = text-only），
 * 供主 Agent 在 task 里按 require/prefer 挑选，避免只按数组顺序。
 */
export const CLI_WORKERS_DEFAULT_SEED: CliWorkersConfig = {
  version: 1,
  enabled: false,
  defaultBackend: 'in-process',
  defaultCliId: 'kscc',
  workers: [
    {
      id: 'kscc',
      enabled: true,
      bin: 'kscc',
      defaultModel: 'glm-5.2',
      capability: { cost: 3, reasoning: 'high', goodFor: '跨层接线 / 编排 / 复杂实现' },
    },
    {
      id: 'grok',
      enabled: true,
      bin: 'grok',
      defaultModel: undefined,
      capability: { cost: 2, reasoning: 'medium', goodFor: '探索 / 对照 / 草稿实现' },
    },
    {
      id: 'codex',
      enabled: true,
      bin: 'codex',
      defaultModel: undefined,
      capability: { cost: 4, reasoning: 'high', goodFor: '长任务 / 深改造' },
    },
    {
      id: 'mimo',
      enabled: true,
      bin: 'mimo',
      defaultModel: undefined,
      capability: { cost: 1, reasoning: 'low', goodFor: '单测 / 机械改动 / 小包' },
    },
  ],
}

/** id / bin 黑名单：basename 命中即非法（大小写不敏感）。禁配其它 reserved CLI。 */
const CLI_WORKER_DENY_LIST = ['hermes', 'openclaw'] as const

/**
 * 跨平台 basename：兼容 POSIX `/` 与 Windows `\` 分隔符。
 * 不引 `node:path`，保持本文件纯函数（renderer / 主进程共用）。
 */
function basenameOf(p: string): string {
  if (!p) return ''
  const segs = p.split(/[\\/]/)
  return segs[segs.length - 1] ?? ''
}

/** id 或 bin 的 basename 是否命中黑名单（hermes / openclaw，大小写不敏感，精确 basename 匹配） */
export function isDeniedCliName(name: string): boolean {
  const base = basenameOf(name).toLowerCase()
  return CLI_WORKER_DENY_LIST.some((d) => base === d)
}

/** reasoning 合法枚举集合 */
const CLI_REASONING_VALUES = new Set<CliReasoning>(['low', 'medium', 'high'])
/** modality 合法枚举集合 */
const CLI_MODALITY_VALUES = new Set<CliModality>(['text', 'vision'])
/** cost 合法档（1..5 整数） */
const CLI_COST_VALUES = new Set<number>([1, 2, 3, 4, 5])

/** capability 是否结构合法（capability 缺省时调用方先判空，这里假定入参非空） */
function isValidCapability(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false
  const cap = c as Partial<CliWorkerCapability>
  if (typeof cap.cost !== 'number' || !Number.isInteger(cap.cost) || !CLI_COST_VALUES.has(cap.cost)) {
    return false
  }
  if (cap.reasoning == null || !CLI_REASONING_VALUES.has(cap.reasoning)) {
    return false
  }
  if (cap.modalities != null) {
    if (!Array.isArray(cap.modalities)) return false
    for (const m of cap.modalities) {
      if (typeof m !== 'string' || !CLI_MODALITY_VALUES.has(m as CliModality)) return false
    }
  }
  if (cap.goodFor != null && typeof cap.goodFor !== 'string') return false
  return true
}

/**
 * capability 整单校验：结构非法即返回中文错误（带工人 label），全合法返回 null。
 * 与 `isValidCapability` 同口径，但产出具体中文消息供保存 IPC 拒写时回显。
 */
function validateCapability(c: unknown, label: string): string | null {
  if (!c || typeof c !== 'object') {
    return `CLI 工人条目「${label}」结构不合法：capability 须为对象`
  }
  const cap = c as Partial<CliWorkerCapability>
  if (typeof cap.cost !== 'number' || !Number.isInteger(cap.cost) || !CLI_COST_VALUES.has(cap.cost)) {
    return `CLI 工人条目「${label}」结构不合法：capability.cost 须为 1..5 的整数`
  }
  if (cap.reasoning == null || !CLI_REASONING_VALUES.has(cap.reasoning)) {
    return `CLI 工人条目「${label}」结构不合法：capability.reasoning 须为 low / medium / high`
  }
  if (cap.modalities != null) {
    if (!Array.isArray(cap.modalities)) {
      return `CLI 工人条目「${label}」结构不合法：capability.modalities 须为数组`
    }
    for (const m of cap.modalities) {
      if (typeof m !== 'string' || !CLI_MODALITY_VALUES.has(m as CliModality)) {
        return `CLI 工人条目「${label}」结构不合法：capability.modalities 元素须为 text / vision`
      }
    }
  }
  if (cap.goodFor != null && typeof cap.goodFor !== 'string') {
    return `CLI 工人条目「${label}」结构不合法：capability.goodFor 须为字符串`
  }
  return null
}

/**
 * 单条工人本机探测结果（不落盘；设置页 / 运行时按需探测）。
 * 每台机器 PATH/安装位置不同，必须以探测为准，不可写死用户环境。
 */
export interface CliWorkerProbeItem {
  /** 配置里的工人 id */
  id: string
  /** 探测时用的 bin（配置值） */
  bin: string
  /** PATH / 绝对路径是否找到可执行文件 */
  available: boolean
  /** 解析到的绝对路径（若有） */
  resolvedPath?: string
  /** `--version` / 等价输出的首行摘要（可选） */
  version?: string
  /** 不可用时的简短原因 */
  error?: string
}

/** 整表探测快照 */
export interface CliWorkersProbeResult {
  probedAt: number
  workers: CliWorkerProbeItem[]
}

/**
 * 校验配置结构是否合法（含黑名单）。
 * 用于 seed / load 后的安全检查，避免坏文件导致后续 runner 崩。
 *
 * 校验项：
 * - version === 1
 * - enabled 布尔、defaultBackend ∈ {'in-process','cli'}
 * - defaultCliId 非空字符串
 * - workers 数组；每条 id/bin 非空字符串、enabled 布尔、defaultModel 可选字符串
 * - capability（可选）：存在时 cost ∈ 1..5 整数、reasoning ∈ 枚举、modalities 数组元素 ∈ 枚举、goodFor 可选字符串
 * - 黑名单：任一工人 id 或 bin 的 basename 命中 hermes/openclaw → 非法
 */
export function isValidCliWorkersConfig(cfg: unknown): cfg is CliWorkersConfig {
  if (!cfg || typeof cfg !== 'object') return false
  const c = cfg as Partial<CliWorkersConfig>
  if (c.version !== 1) return false
  if (typeof c.enabled !== 'boolean') return false
  if (c.defaultBackend !== 'in-process' && c.defaultBackend !== 'cli') return false
  if (typeof c.defaultCliId !== 'string' || c.defaultCliId.length === 0) return false
  if (!Array.isArray(c.workers)) return false
  for (const w of c.workers) {
    if (!w || typeof w !== 'object') return false
    const e = w as Partial<CliWorkerEntry>
    if (typeof e.id !== 'string' || e.id.length === 0) return false
    if (typeof e.bin !== 'string' || e.bin.length === 0) return false
    if (typeof e.enabled !== 'boolean') return false
    if (e.defaultModel != null && typeof e.defaultModel !== 'string') return false
    // capability 可选；存在时须结构合法
    if (e.capability != null && !isValidCapability(e.capability)) return false
    // 黑名单：id 或 bin 的 basename 命中 → 非法
    if (isDeniedCliName(e.id!) || isDeniedCliName(e.bin!)) return false
  }
  return true
}

/**
 * 整单校验配置：结构非法或命中黑名单即返回中文错误，全合法返回 null。
 *
 * 与 `isValidCliWorkersConfig` 覆盖同一批校验项，但产出**具体中文消息**，
 * 供保存 IPC 拒写时回显给用户（SPEC 04 §2.2 同口径：非法整单拒写、不脏写盘）。
 */
export function validateCliWorkersConfig(cfg: unknown): string | null {
  if (!cfg || typeof cfg !== 'object') {
    return 'CLI 工人配置结构不合法：期望对象'
  }
  const c = cfg as Partial<CliWorkersConfig>
  if (c.version !== 1) {
    return 'CLI 工人配置不合法：version 须为 1'
  }
  if (typeof c.enabled !== 'boolean') {
    return 'CLI 工人配置不合法：enabled 须为布尔'
  }
  if (c.defaultBackend !== 'in-process' && c.defaultBackend !== 'cli') {
    return "CLI 工人配置不合法：defaultBackend 须为 'in-process' 或 'cli'"
  }
  if (typeof c.defaultCliId !== 'string' || c.defaultCliId.length === 0) {
    return 'CLI 工人配置不合法：defaultCliId 须为非空字符串'
  }
  if (!Array.isArray(c.workers)) {
    return 'CLI 工人配置不合法：workers 须为数组'
  }
  for (const w of c.workers) {
    if (!w || typeof w !== 'object') {
      return 'CLI 工人条目结构不合法：期望对象'
    }
    const e = w as Partial<CliWorkerEntry>
    const label =
      typeof e.id === 'string' && e.id.length > 0 ? e.id : typeof e.bin === 'string' ? e.bin : '未知'
    if (typeof e.id !== 'string' || e.id.length === 0) {
      return `CLI 工人条目「${label}」结构不合法：id 须为非空字符串`
    }
    if (typeof e.bin !== 'string' || e.bin.length === 0) {
      return `CLI 工人条目「${label}」结构不合法：bin 须为非空字符串`
    }
    if (typeof e.enabled !== 'boolean') {
      return `CLI 工人条目「${label}」结构不合法：enabled 须为布尔`
    }
    if (e.defaultModel != null && typeof e.defaultModel !== 'string') {
      return `CLI 工人条目「${label}」结构不合法：defaultModel 须为字符串`
    }
    if (e.capability != null) {
      const capErr = validateCapability(e.capability, label)
      if (capErr) return capErr
    }
    if (isDeniedCliName(e.id) || isDeniedCliName(e.bin)) {
      return `CLI 工人条目「${label}」非法：id 或 bin 的 basename 命中黑名单（hermes / openclaw），禁止配置`
    }
  }
  return null
}

/**
 * 启用中的工人，按数组顺序（优先级从高到低）。
 * 禁用的跳过；不探测本机 bin（探测在 resolve 层）。
 */
export function listEnabledWorkersByPriority(cfg: CliWorkersConfig): CliWorkerEntry[] {
  if (!cfg?.workers?.length) return []
  return cfg.workers.filter((w) => w.enabled)
}

/**
 * 按优先级解析工人：
 * 1. preferredId 若在启用池中 → 用之
 * 2. 否则取启用池第一个（数组序）
 * 3. 池空 → null
 *
 * 不探测 bin 是否在本机；调用方对候选再 `isWorkerBinAvailable`，失败则试下一个。
 */
export function resolveWorkerByPreference(
  cfg: CliWorkersConfig,
  preferredId?: string | null,
): CliWorkerEntry | null {
  const pool = listEnabledWorkersByPriority(cfg)
  if (pool.length === 0) return null
  if (preferredId) {
    const hit = pool.find((w) => w.id === preferredId)
    if (hit) return hit
  }
  return pool[0] ?? null
}

/**
 * 兼容旧名：等价于「无 preferred 时按优先级取第一个 enabled」。
 * 不再强绑 `defaultCliId`（该字段可能与当前顺序/启用态不一致）。
 */
export function resolveDefaultWorker(cfg: CliWorkersConfig): CliWorkerEntry | null {
  return resolveWorkerByPreference(cfg, null)
}

/**
 * 是否应尝试 CLI 工人（总开关 + backend=cli + 至少一名 enabled）。
 * 具体选哪个、本机是否有 bin，由 resolve-backend 再判定。
 */
export function shouldUseCliWorker(cfg: CliWorkersConfig): boolean {
  if (!cfg?.enabled) return false
  if (cfg.defaultBackend !== 'cli') return false
  return listEnabledWorkersByPriority(cfg).length > 0
}

/**
 * 把 `defaultCliId` 同步为第一个 enabled 工人 id（无 enabled 则保留原值）。
 * 设置页保存 / 排序 / 启停后调用，保持旧读者不炸。
 */
export function syncDefaultCliId(cfg: CliWorkersConfig): CliWorkersConfig {
  const first = listEnabledWorkersByPriority(cfg)[0]
  if (!first) return cfg
  if (cfg.defaultCliId === first.id) return cfg
  return { ...cfg, defaultCliId: first.id }
}

/** 上移/下移工人（改数组顺序 = 改优先级）。越靠前优先级越高。 */
export function moveWorkerPriority(
  cfg: CliWorkersConfig,
  id: string,
  direction: 'up' | 'down',
): CliWorkersConfig {
  const workers = [...cfg.workers]
  const i = workers.findIndex((w) => w.id === id)
  if (i < 0) return cfg
  const j = direction === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= workers.length) return cfg
  const tmp = workers[i]!
  workers[i] = workers[j]!
  workers[j] = tmp
  return syncDefaultCliId({ ...cfg, workers })
}

/**
 * 把 seed 里缺的工人 id 补进 `cfg.workers`（不覆盖用户已有的任何条目字段）。
 *
 * 用于旧配置升级：早期 seed 只有 1 条 kscc，升级到 4 工人时，list 阶段补齐缺的
 * grok / codex / mimo（按 id 追加 seed 默认，保留用户已编辑的 kscc 字段不动）。
 * 若 workers 已含全部 seed id 则原样返回（无拷贝）。
 *
 * 仅按 id 去重；不校验黑名单（调用方 `isValidCliWorkersConfig` 已保证整单合法）。
 */
export function ensureSeedWorkers(cfg: CliWorkersConfig): CliWorkersConfig {
  if (!cfg?.workers) return cfg
  const have = new Set(cfg.workers.map((w) => w.id))
  const missing = CLI_WORKERS_DEFAULT_SEED.workers.filter((w) => !have.has(w.id))
  if (missing.length === 0) return cfg
  return { ...cfg, workers: [...cfg.workers, ...missing.map((w) => ({ ...w }))] }
}

/**
 * task 工具 `require` 参数：硬性能力要求。
 * - vision: true 需工人 modalities 含 'vision'
 * - reasoningMin: 工人 reasoning 档须 ≥ 此值（low < medium < high）
 */
export interface CliCapabilityRequire {
  vision?: boolean
  reasoningMin?: CliReasoning
}

/**
 * task 工具 `prefer` 参数：软性偏好（仅影响同合格候选排序，不剔除）。
 * - costMax: 视为硬上限（见 C2 候选过滤，cost > costMax 剔除），不参与打分
 * - goodFor: 关键词命中 worker.goodFor 时打分加 3
 */
export interface CliCapabilityPrefer {
  costMax?: 1 | 2 | 3 | 4 | 5
  goodFor?: string
}

/** reasoning 档位排序：low < medium < high */
const CLI_REASONING_RANK: Record<CliReasoning, number> = { low: 0, medium: 1, high: 2 }

/**
 * 解析工人的有效能力画像。
 * 有 capability 直接返回；缺省按中性折算 `{ cost: 3, reasoning: 'medium', modalities: ['text'] }`，
 * 避免旧文件（无 capability）整体垫底或顶格。
 */
export function resolveWorkerCapability(w: CliWorkerEntry): CliWorkerCapability {
  return (
    w.capability ?? { cost: 3, reasoning: 'medium', modalities: ['text'] }
  )
}

/**
 * 硬性过滤：工人是否满足 require。
 * - 无 require → 恒 true
 * - require.vision=true 需 modalities 含 'vision'
 * - require.reasoningMin 按 low<medium<high 比较，工人档 < 要求 → false
 */
export function workerSupportsRequire(
  w: CliWorkerEntry,
  require?: CliCapabilityRequire | null,
): boolean {
  if (!require) return true
  const cap = resolveWorkerCapability(w)
  if (require.vision) {
    const mods = cap.modalities ?? ['text']
    if (!mods.includes('vision')) return false
  }
  if (require.reasoningMin) {
    if (CLI_REASONING_RANK[cap.reasoning] < CLI_REASONING_RANK[require.reasoningMin]) {
      return false
    }
  }
  return true
}

/**
 * 软性打分：工人对 prefer 的偏好分（越高越优选）。
 * - 无 prefer → 返回 0（不参与重排，保持数组顺序）
 * - cost 越低分越高（6 - cost）
 * - prefer.goodFor 关键词命中 worker.goodFor 加 3 分
 * - costMax 不参与打分（它是上限约束，见 C2 候选过滤）
 */
export function workerPreferScore(
  w: CliWorkerEntry,
  prefer?: CliCapabilityPrefer | null,
): number {
  if (!prefer) return 0
  const cap = resolveWorkerCapability(w)
  let score = 6 - cap.cost
  if (prefer.goodFor && cap.goodFor && cap.goodFor.includes(prefer.goodFor)) {
    score += 3
  }
  return score
}
