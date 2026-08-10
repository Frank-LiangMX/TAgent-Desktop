/**
 * resolveTaskSubagentBackend：读 CLI 工人配置 → 决定 Pi `task` 走 in-process 还是 cli。
 *
 * 挑选规则（SLICE-5 起支持能力 require/prefer；SLICE-8 起过滤无 runner 工人）：
 * 1. 总开关关 / 后端非 cli / 无启用工人 → in-process
 * 1b. 无 runner 工人（目录 supported=false，如 opencode）永不进入候选；全 unsupported → in-process
 * 2. 显式 preferredCliId：启用 + supported + 本机可用 + 满足 require → 用之；
 *    不满足 require / 本机不可用 / 无 runner → console.warn 后回落池内（不整单失败、不报错给主 Agent）
 * 3. 候选 = supported 启用池按优先级，先 workerSupportsRequire 硬性过滤（含 prefer.costMax 硬上限），
 *    再 workerPreferScore 软性打分降序（同分保持数组顺序）
 * 4. 从排序后候选逐个找本机 bin 可用者；全挂 → in-process
 * 5. 无 require/prefer 时行为与现状完全一致（按优先级取第一个本机可用）
 *
 * 同会话多路 task（parallel）各自独立 resolve，可并发 spawn 不同 CLI。
 */
import {
  listEnabledWorkersByPriority,
  resolveWorkerCapability,
  shouldUseCliWorker,
  workerPreferScore,
  workerSupportsRequire,
  SUPPORTED_CLI_WORKER_IDS,
  type CliCapabilityPrefer,
  type CliCapabilityRequire,
  type CliWorkerEntry,
} from '@tagent/shared'
import { listCliWorkersConfig } from '../cli-workers-service'
import { isWorkerBinAvailable } from './probe-cli-workers'

export type TaskSubagentBackend =
  | { kind: 'in-process' }
  | { kind: 'cli'; worker: CliWorkerEntry }

export interface ResolveTaskSubagentBackendOptions {
  /** 主 Agent 在 task 参数里指定的 CLI id（kscc / grok / …） */
  preferredCliId?: string | null
  /** 硬性能力要求：vision / reasoningMin（不满足者剔除，含显式 cli 不满足也回落） */
  require?: CliCapabilityRequire | null
  /** 软性偏好：costMax（硬上限剔除）/ goodFor（命中加分排序）；不剔除显式 cli */
  prefer?: CliCapabilityPrefer | null
}

/**
 * 解析 task 子代理后端。每次 task 调用前调。
 */
export function resolveTaskSubagentBackend(
  options?: ResolveTaskSubagentBackendOptions,
): TaskSubagentBackend {
  let cfg
  try {
    cfg = listCliWorkersConfig()
  } catch (err) {
    console.warn('[cli-workers] 读取配置失败，回退 in-process：', err)
    return { kind: 'in-process' }
  }

  if (!shouldUseCliWorker(cfg)) return { kind: 'in-process' }

  const preferred = options?.preferredCliId?.trim() || undefined
  const require = options?.require ?? null
  const prefer = options?.prefer ?? null
  const pool = listEnabledWorkersByPriority(cfg)
  if (pool.length === 0) return { kind: 'in-process' }

  // 无 runner 工人（目录 supported=false，如 opencode）永不进入候选：仅设置页显示「已检测·暂不支持派工」，不参与路由
  const supportedPool = pool.filter((w) => SUPPORTED_CLI_WORKER_IDS.includes(w.id))
  if (supportedPool.length === 0) return { kind: 'in-process' }

  // 2. 显式 preferredCliId：启用 + supported + 本机可用 + 满足 require → 用之；否则 warn 回落池内
  if (preferred) {
    const pref = supportedPool.find((w) => w.id === preferred)
    if (pref) {
      if (!workerSupportsRequire(pref, require)) {
        console.warn(`[cli-workers] 显式 cli=${preferred} 不满足 require，回落池内`)
      } else if (!isWorkerBinAvailable(pref.bin)) {
        console.warn(`[cli-workers] 显式 cli=${preferred} 本机不可用，回落池内`)
      } else {
        return { kind: 'cli', worker: pref }
      }
    } else {
      // preferred 不在 supported 池：启用但无 runner → warn 回落（与 require 不满足同路径）；未启用 / 未知 id → 静默回落
      const enabled = pool.find((w) => w.id === preferred)
      if (enabled && !SUPPORTED_CLI_WORKER_IDS.includes(preferred)) {
        console.warn(`[cli-workers] 显式 cli=${preferred} 暂不支持派工（无 runner），回落池内`)
      }
    }
  }

  // 3. 候选 = supported 启用池按优先级，先 require 硬性过滤（含 prefer.costMax 硬上限），再 prefer 软性打分降序（同分保持数组顺序）
  let candidates = supportedPool.filter((w) => workerSupportsRequire(w, require))
  if (prefer?.costMax != null) {
    const max = prefer.costMax
    candidates = candidates.filter((w) => resolveWorkerCapability(w).cost <= max)
  }
  const ordered = candidates
    .map((w, i) => ({ w, i, score: workerPreferScore(w, prefer) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.w)

  // 4. 从排序后候选逐个找本机 bin 可用者；全挂 → in-process
  for (const worker of ordered) {
    if (isWorkerBinAvailable(worker.bin)) {
      return { kind: 'cli', worker }
    }
    console.warn(
      `[cli-workers] ${worker.id} 本机未找到（bin=${worker.bin}），试下一候选`,
    )
  }

  console.warn('[cli-workers] 启用池内无一可用 bin，回退 in-process')
  return { kind: 'in-process' }
}

/** 当前启用池 id 列表（给 task 工具描述 / 日志用；不探测 bin；仅含 supported 工人） */
export function listEnabledCliWorkerIds(): string[] {
  try {
    const cfg = listCliWorkersConfig()
    if (!shouldUseCliWorker(cfg)) return []
    return listEnabledWorkersByPriority(cfg)
      .filter((w) => SUPPORTED_CLI_WORKER_IDS.includes(w.id))
      .map((w) => w.id)
  } catch {
    return []
  }
}

/**
 * 当前启用池「能力卡」文本（注入 task 工具描述，让主 Agent 据此自选 cli + require/prefer）。
 * 复用 listCliWorkersConfig + resolveWorkerCapability；关闭 / 未启用时返回空串。
 * 格式（每启用工人一行）：
 *   CLI 工人能力卡（按优先级）：
 *     kscc — cost 3 · reasoning high · text · 跨层接线 / 编排 / 复杂实现
 *     ...
 *   可用参数：cli 指定其一；require 硬性（vision / reasoningMin）；prefer 软性（costMax / goodFor）。
 */
export function listEnabledCliWorkerCards(): string {
  let cfg
  try {
    cfg = listCliWorkersConfig()
  } catch {
    return ''
  }
  if (!shouldUseCliWorker(cfg)) return ''
  const pool = listEnabledWorkersByPriority(cfg)
  if (pool.length === 0) return ''
  // 仅注入 supported 工人能力卡（无 runner 工人不参与路由，不向主 Agent 推荐）
  const supportedPool = pool.filter((w) => SUPPORTED_CLI_WORKER_IDS.includes(w.id))
  if (supportedPool.length === 0) return ''
  const lines = supportedPool.map((w) => {
    const cap = resolveWorkerCapability(w)
    const mods = (cap.modalities ?? ['text']).join('+')
    const tail = cap.goodFor ? ` · ${cap.goodFor}` : ''
    return `  ${w.id} — cost ${cap.cost} · reasoning ${cap.reasoning} · ${mods}${tail}`
  })
  return [
    'CLI 工人能力卡（按优先级）：',
    ...lines,
    '可用参数：cli 指定其一；require 硬性（vision / reasoningMin）；prefer 软性（costMax / goodFor）。',
  ].join('\n')
}
