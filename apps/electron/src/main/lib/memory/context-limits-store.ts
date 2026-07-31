/**
 * 阈值自学习存储（Phase 5.3）
 *
 * per-model 存 safeLimit / burst 历史，供 resolveModelSafeContextLimit 读取。
 * 路径：~/.tagent[-dev]/projects/{slug}/memory/context-limits.json
 * 无 workspace 时用全局 memory/context-limits.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigDir, getProjectMemoryDir } from '../config/config-paths'

export interface LearnedLimitEntry {
  safeLimit: number
  burstCount: number
  lastBurst: number
  history: Array<{ burst: number; at: number }>
}

type LimitsFile = Record<string, LearnedLimitEntry>

function resolvePath(workspaceSlug?: string): string {
  if (workspaceSlug) {
    return join(getProjectMemoryDir(workspaceSlug), 'context-limits.json')
  }
  return join(getConfigDir(), 'memory', 'context-limits.json')
}

function readFile(path: string): LimitsFile {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LimitsFile
  } catch {
    return {}
  }
}

function writeFile(path: string, data: LimitsFile): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

/** 读某模型的自学习安全上限 */
export function getLearnedSafeContextLimit(
  modelId: string,
  workspaceSlug?: string,
): number | undefined {
  const entry = readFile(resolvePath(workspaceSlug))[modelId]
  return entry?.safeLimit && entry.safeLimit > 0 ? entry.safeLimit : undefined
}

/**
 * 记录爆点并回写 learnedSafeContextLimit。
 * learned = max(burst × 0.9, contextWindow × 0.5)；history>3 时取中位数×0.9。
 */
export function recordBurstAndLearn(opts: {
  modelId: string
  burstTokens: number
  contextWindow: number
  workspaceSlug?: string
}): number {
  const path = resolvePath(opts.workspaceSlug)
  const all = readFile(path)
  const prev = all[opts.modelId] ?? {
    safeLimit: 0,
    burstCount: 0,
    lastBurst: 0,
    history: [],
  }
  const history = [...prev.history, { burst: opts.burstTokens, at: Date.now() }].slice(-10)
  let base = opts.burstTokens
  if (history.length > 3) {
    const sorted = history.map((h) => h.burst).sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    base = sorted.length % 2 === 0
      ? Math.ceil(((sorted[mid - 1] ?? base) + (sorted[mid] ?? base)) / 2)
      : (sorted[mid] ?? base)
  }
  const learned = Math.max(Math.ceil(base * 0.9), Math.ceil(opts.contextWindow * 0.5))
  all[opts.modelId] = {
    safeLimit: learned,
    burstCount: prev.burstCount + 1,
    lastBurst: opts.burstTokens,
    history,
  }
  writeFile(path, all)
  return learned
}
