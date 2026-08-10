/**
 * CLI 工人配置存储服务。
 *
 * 落盘路径：~/.tagent[-dev]/cli-workers.json（扁平 v1 JSON）
 *
 * SLICE-8 起：工人池 = 启动时自动探测本机已安装的 coding CLI + 用户手动添加的自定义工人。
 * - `listCliWorkersConfig()` 纯读（热路径不探测不写盘）：文件合法原样返回；缺失/损坏返回内存默认（不落盘）。
 * - `discoverInstalledCliWorkers()` 探测发现目录 → 返回本机已安装的目录项（按目录顺序，记命中 bin 绝对路径）。
 * - `discoverAndReconcileCliWorkers()` 启动 / 「检测本机」用：探测 + 对账落盘（增补新发现、移除未安装占位、保留自定义）。
 * - `writeCliWorkersConfig()` 设置页保存用：整单校验（`validateCliWorkersConfig`），非法即拒写、抛中文错，不脏写盘
 *   （与 moa-preset-service 同口径，SPEC 04 §2.2）。
 *
 * 不在本服务做的：
 * - spawn / observer / 运行时编排 → cli-worker-runner
 * - 是否真正走 CLI 后端由 `shouldUseCliWorker` 在 task 调度前判定
 */
import {
  CLI_WORKER_DISCOVERY_CATALOG,
  isValidCliWorkersConfig,
  syncDefaultCliId,
  validateCliWorkersConfig,
  type CliWorkerDiscoveryEntry,
  type CliWorkerEntry,
  type CliWorkersConfig,
} from '@tagent/shared'
import { getCliWorkersPath } from '../config/config-paths'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { resolveWorkerBin } from './cli-workers/probe-cli-workers'

/** 探测命中记录：目录项 + 命中的 bin 绝对路径。 */
export interface DiscoveredCliWorker {
  entry: CliWorkerDiscoveryEntry
  resolvedBin: string
}

/** 内存默认配置（文件不存在 / 损坏时的纯读兜底；不落盘）。 */
function emptyCliWorkersDefault(): CliWorkersConfig {
  return {
    version: 1,
    enabled: false,
    defaultBackend: 'in-process',
    defaultCliId: 'kscc',
    workers: [],
  }
}

/**
 * 读取 CLI 工人配置（纯读：热路径不探测不写盘）。
 *
 * - 文件不存在 / 损坏 / 结构非法（含黑名单）→ 返回内存默认（不落盘；首次落盘由 discoverAndReconcileCliWorkers 负责）。
 * - 文件合法 → 原样返回（不再 ensureSeedWorkers 占位；占位由对账在启动时移除）。
 */
export function listCliWorkersConfig(): CliWorkersConfig {
  const filePath = getCliWorkersPath()
  const parsed = readJsonSafe<CliWorkersConfig | null>(filePath, null)
  if (!parsed || !isValidCliWorkersConfig(parsed)) {
    return emptyCliWorkersDefault()
  }
  return parsed
}

/**
 * 探测目录 → 返回本机已安装的目录项（按目录顺序；每项记录命中的 bin 绝对路径）。
 *
 * 遍历 CLI_WORKER_DISCOVERY_CATALOG，每条按 bins 顺序解析 PATH，首个命中者采用。
 * 不读配置文件、不写盘；纯探测。供 discoverAndReconcileCliWorkers 与「检测本机」使用。
 */
export function discoverInstalledCliWorkers(): DiscoveredCliWorker[] {
  const installed: DiscoveredCliWorker[] = []
  for (const entry of CLI_WORKER_DISCOVERY_CATALOG) {
    for (const bin of entry.bins) {
      const resolved = resolveWorkerBin(bin)
      if (resolved) {
        installed.push({ entry, resolvedBin: resolved })
        break
      }
    }
  }
  return installed
}

/** 由目录项 + 命中 bin 构造一条启用工人（enabled true，带 defaultModel / capability）。 */
function workerFromEntry(entry: CliWorkerDiscoveryEntry, resolvedBin: string): CliWorkerEntry {
  return {
    id: entry.id,
    enabled: true,
    bin: resolvedBin,
    ...(entry.defaultModel !== undefined ? { defaultModel: entry.defaultModel } : {}),
    ...(entry.capability !== undefined ? { capability: entry.capability } : {}),
  }
}

/**
 * 由已安装目录项构造一份「首次落盘」配置：
 * 总开关 enabled:false / in-process / defaultCliId=首个已安装且 supported 的 id（无则首个已安装，再无则 'kscc'）。
 */
function buildConfigFromInstalled(installed: DiscoveredCliWorker[]): CliWorkersConfig {
  const workers = installed.map(({ entry, resolvedBin }) => workerFromEntry(entry, resolvedBin))
  const firstSupported = installed.find(({ entry }) => entry.supported)
  const defaultCliId = firstSupported?.entry.id ?? installed[0]?.entry.id ?? 'kscc'
  return {
    version: 1,
    enabled: false,
    defaultBackend: 'in-process',
    defaultCliId,
    workers,
  }
}

/**
 * 对账已有配置与已安装目录项（已有合法配置分支）：
 * - 已安装的目录项缺失 → append（enabled true，带默认能力/模型，bin=命中绝对路径）。
 * - 配置里 id ∈ 目录 且 bin 等于目录默认 bin（未改）且本机未安装 → 移除该占位行。
 * - 用户自定义 id（不在目录）/ 改过 bin 的目录工人 → 保留不动（找不到时 UI 如实显示「未找到」）。
 * - 顶层总开关 / 后端保留；defaultCliId 由 writeCliWorkersConfig 的 syncDefaultCliId 同步。
 */
function reconcileExisting(existing: CliWorkersConfig, installed: DiscoveredCliWorker[]): CliWorkersConfig {
  const catalogById = new Map(CLI_WORKER_DISCOVERY_CATALOG.map((e) => [e.id, e]))
  const installedById = new Map(installed.map(({ entry, resolvedBin }) => [entry.id, resolvedBin]))
  const existingIds = new Set(existing.workers.map((w) => w.id))

  const kept: CliWorkerEntry[] = []
  for (const w of existing.workers) {
    const cat = catalogById.get(w.id)
    if (!cat) {
      // 用户自定义 id（不在目录）→ 保留不动
      kept.push(w)
      continue
    }
    if (installedById.has(w.id)) {
      // 已安装的目录项且已在配置 → 保留不动（不覆盖用户编辑）
      kept.push(w)
      continue
    }
    // 目录项 + 未安装
    const defaultBin = cat.bins[0] ?? w.id
    if (w.bin === defaultBin) {
      // 默认 bin + 未安装 → 移除占位行（不 push）
      continue
    }
    // 用户改过 bin → 保留不动
    kept.push(w)
  }

  // 追加新发现的目录项（已安装但配置里没有该 id），按目录（探测）顺序
  const appended: CliWorkerEntry[] = []
  for (const { entry, resolvedBin } of installed) {
    if (!existingIds.has(entry.id)) {
      appended.push(workerFromEntry(entry, resolvedBin))
    }
  }

  return { ...existing, workers: [...kept, ...appended] }
}

/**
 * 启动 / 「检测本机」：探测 + 对账落盘，返回对账后的配置。
 *
 * - 无配置文件（或损坏 / 结构非法）→ 落盘 = 仅本机已安装的目录项 + 总开关 enabled:false / in-process。
 * - 已有合法配置 → 增补新发现、移除「默认 bin + 未安装」占位行、保留自定义 id / 改过 bin 的行。
 * - 写回用 writeCliWorkersConfig（整单校验 + 原子写 + syncDefaultCliId + capability 保留）。
 * - 落盘失败仅 console.warn（不阻塞调用方）；返回对账后的配置（写盘失败时返回内存对账结果）。
 *
 * @param discover 探测函数（默认 discoverInstalledCliWorkers；测试可注入 mock 控制已安装集合）
 */
export function discoverAndReconcileCliWorkers(
  discover: () => DiscoveredCliWorker[] = discoverInstalledCliWorkers,
): CliWorkersConfig {
  const installed = discover()
  const filePath = getCliWorkersPath()
  const existing = readJsonSafe<CliWorkersConfig | null>(filePath, null)

  const reconciled =
    !existing || !isValidCliWorkersConfig(existing)
      ? buildConfigFromInstalled(installed)
      : reconcileExisting(existing, installed)

  const synced = syncDefaultCliId(reconciled)
  try {
    writeCliWorkersConfig(synced)
  } catch (err) {
    console.warn('[cli-workers-service] 对账落盘失败，仍返回内存对账结果：', err)
  }
  return synced
}

/**
 * 写入整份 CLI 工人配置（覆盖式原子写，扁平 v1）。
 *
 * 整单校验失败（结构非法 / 黑名单）→ 抛中文错、**不写盘**（SPEC 04 §2.2 同口径）。
 * 合法则剥离为已知字段后原子写，丢弃未知字段。
 * 设置页保存 IPC（`agent:save-cli-workers`）经此函数；调用方捕获错误回显给用户。
 */
export function writeCliWorkersConfig(cfg: CliWorkersConfig): void {
  const err = validateCliWorkersConfig(cfg)
  if (err) throw new Error(err)
  // defaultCliId 同步为第一个 enabled（兼容旧字段；运行时以数组顺序优先级为准）
  const synced = syncDefaultCliId(cfg)
  writeJsonAtomic(getCliWorkersPath(), {
    version: 1,
    enabled: synced.enabled,
    defaultBackend: synced.defaultBackend,
    defaultCliId: synced.defaultCliId,
    workers: synced.workers.map((w) => ({
      id: w.id,
      enabled: w.enabled,
      bin: w.bin,
      ...(w.defaultModel !== undefined ? { defaultModel: w.defaultModel } : {}),
      // capability 可选：保留（已由 validateCliWorkersConfig 校验）；旧配置无则不落该字段
      ...(w.capability !== undefined ? { capability: w.capability } : {}),
    })),
  })
}
