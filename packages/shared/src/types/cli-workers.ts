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
 */
export const CLI_WORKERS_DEFAULT_SEED: CliWorkersConfig = {
  version: 1,
  enabled: false,
  defaultBackend: 'in-process',
  defaultCliId: 'kscc',
  workers: [
    { id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' },
    { id: 'grok', enabled: true, bin: 'grok', defaultModel: undefined },
    { id: 'codex', enabled: true, bin: 'codex', defaultModel: undefined },
    { id: 'mimo', enabled: true, bin: 'mimo', defaultModel: undefined },
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
