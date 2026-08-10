/**
 * resolveTaskSubagentBackend：读 CLI 工人配置 → 决定 Pi `task` 走 in-process 还是 cli。
 *
 * 挑选规则：
 * 1. 总开关关 / 后端非 cli / 无启用工人 → in-process
 * 2. preferredCliId 若启用且本机可用 → 用之
 * 3. 否则按 workers 数组顺序（优先级）试启用工人，第一个本机可用者胜出
 * 4. 全部不可用 → in-process
 *
 * 同会话多路 task（parallel）各自独立 resolve，可并发 spawn 不同 CLI。
 */
import {
  listEnabledWorkersByPriority,
  shouldUseCliWorker,
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
  const pool = listEnabledWorkersByPriority(cfg)
  if (pool.length === 0) return { kind: 'in-process' }

  // preferred 优先：启用且本机可用才采纳；不可用则继续走优先级池（不整单失败）
  const ordered: CliWorkerEntry[] = []
  if (preferred) {
    const pref = pool.find((w) => w.id === preferred)
    if (pref) ordered.push(pref)
  }
  for (const w of pool) {
    if (!ordered.some((x) => x.id === w.id)) ordered.push(w)
  }

  for (const worker of ordered) {
    if (isWorkerBinAvailable(worker.bin)) {
      return { kind: 'cli', worker }
    }
    console.warn(
      `[cli-workers] ${worker.id} 本机未找到（bin=${worker.bin}），试下一优先级`,
    )
  }

  console.warn('[cli-workers] 启用池内无一可用 bin，回退 in-process')
  return { kind: 'in-process' }
}

/** 当前启用池 id 列表（给 task 工具描述 / 日志用；不探测 bin） */
export function listEnabledCliWorkerIds(): string[] {
  try {
    const cfg = listCliWorkersConfig()
    if (!shouldUseCliWorker(cfg)) return []
    return listEnabledWorkersByPriority(cfg).map((w) => w.id)
  } catch {
    return []
  }
}
