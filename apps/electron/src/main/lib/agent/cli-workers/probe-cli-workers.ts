/**
 * 本机 CLI 工人探测（PATH / 绝对路径 + 可选 --version）。
 *
 * 每台机器安装位置不同，设置页与路由均应依赖本结果，不可写死「用户一定有 kscc」。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { CliWorkerEntry, CliWorkersConfig, CliWorkersProbeResult, CliWorkerProbeItem } from '@tagent/shared'
import { listCliWorkersConfig } from '../cli-workers-service'
import { resolveBinOnPath } from './resolve-bin-on-path'

/** 非 Windows：which / command -v 解析 bare 名 */
function resolveBinUnix(bareName: string): string | null {
  if (!bareName) return null
  if (bareName.includes('/')) {
    return existsSync(bareName) ? bareName : null
  }
  try {
    const out = execFileSync('/bin/sh', ['-c', `command -v -- ${JSON.stringify(bareName)}`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const p = out.trim().split(/\r?\n/)[0]?.trim()
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

/** 跨平台解析 bin → 绝对路径或 null */
export function resolveWorkerBin(bin: string): string | null {
  if (!bin?.trim()) return null
  const b = bin.trim()
  if (process.platform === 'win32') {
    return resolveBinOnPath(b)
  }
  return resolveBinUnix(b)
}

/** 短超时拉 --version 首行（失败不抛） */
function tryVersion(resolvedPath: string): string | undefined {
  try {
    const out = execFileSync(resolvedPath, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const line = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
    return line ? line.slice(0, 120) : undefined
  } catch {
    // 部分 CLI 用 -v
    try {
      const out = execFileSync(resolvedPath, ['-v'], {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const line = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
      return line ? line.slice(0, 120) : undefined
    } catch {
      return undefined
    }
  }
}

function probeOne(entry: CliWorkerEntry): CliWorkerProbeItem {
  const bin = (entry.bin || entry.id || '').trim()
  if (!bin) {
    return { id: entry.id, bin: '', available: false, error: '未配置可执行名' }
  }
  const resolved = resolveWorkerBin(bin)
  if (!resolved) {
    return {
      id: entry.id,
      bin,
      available: false,
      error: '本机未找到（请检查 PATH 或填写绝对路径）',
    }
  }
  const version = tryVersion(resolved)
  return {
    id: entry.id,
    bin,
    available: true,
    resolvedPath: resolved,
    ...(version ? { version } : {}),
  }
}

/** bin 可用性短缓存（task 热路径）；设置页探测后 clear */
const binProbeCache = new Map<string, { ok: boolean; at: number }>()
const BIN_PROBE_TTL_MS = 30_000

export function clearCliBinProbeCache(): void {
  binProbeCache.clear()
}

/** 带缓存的 bin 是否可用（resolve-backend 用） */
export function isWorkerBinAvailable(bin: string): boolean {
  if (!bin) return false
  const now = Date.now()
  const hit = binProbeCache.get(bin)
  if (hit && now - hit.at < BIN_PROBE_TTL_MS) return hit.ok
  const ok = resolveWorkerBin(bin) != null
  binProbeCache.set(bin, { ok, at: now })
  return ok
}

/**
 * 探测配置中全部工人。
 * @param cfg 可选；缺省读当前落盘配置（含 seed merge）
 */
export function probeCliWorkers(cfg?: CliWorkersConfig): CliWorkersProbeResult {
  clearCliBinProbeCache()
  const config = cfg ?? listCliWorkersConfig()
  const workers = (config.workers ?? []).map(probeOne)
  return { probedAt: Date.now(), workers }
}
