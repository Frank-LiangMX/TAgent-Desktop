/**
 * CLI 工人配置存储服务。
 *
 * 落盘路径：~/.tagent[-dev]/cli-workers.json（扁平 v1 JSON）
 * - 缺省文件时首次读取 → 就地 seed 默认配置（总开关 enabled=false，零行为变化）
 * - 文件存在但解析失败 → 用 atomic-json 的 readJsonSafe 自愈（备份恢复）
 * - 文件存在但结构非法（含黑名单）→ 当 seed 覆盖，避免坏文件导致后续 runner 崩
 * - seed 后的配置不再覆盖用户编辑
 * - 旧配置（早期 seed 只有 1 条 kscc）→ list 时 `ensureSeedWorkers` 补齐缺的 grok/codex/mimo
 *   （仅在内存补齐、不覆盖用户已有字段；落盘升级发生在用户下次保存整表时）
 *
 * UI CRUD（SLICE-3 设置页用；本 slice 只打通配置层 + IPC）：
 * - `listCliWorkersConfig` 供设置页读；`writeCliWorkersConfig` 供设置页保存。
 * - 保存走整单校验（`validateCliWorkersConfig`）：非法即拒写、抛中文错，不脏写盘
 *   （与 moa-preset-service 同口径，SPEC 04 §2.2）。
 *
 * 不在本服务做的：
 * - spawn / observer / 运行时编排 → 后续 runner（cli-worker-runner）
 * - 是否真正走 CLI 后端由 `shouldUseCliWorker` 在 task 调度前判定
 */
import {
  CLI_WORKERS_DEFAULT_SEED,
  ensureSeedWorkers,
  isValidCliWorkersConfig,
  syncDefaultCliId,
  validateCliWorkersConfig,
  type CliWorkersConfig,
} from '@tagent/shared'
import { getCliWorkersPath } from '../config/config-paths'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'

/** 默认 seed 的深拷贝（落盘 / 返回均用拷贝，避免调用方改到导出常量） */
function cloneSeed(): CliWorkersConfig {
  return {
    ...CLI_WORKERS_DEFAULT_SEED,
    version: 1,
    workers: CLI_WORKERS_DEFAULT_SEED.workers.map((w) => ({ ...w })),
  }
}

/**
 * 读取 CLI 工人配置；首次访问（文件不存在）就地 seed 默认配置并落盘。
 *
 * 文件存在但结构非法（含黑名单命中）→ 当 seed 覆盖并返回 seed。
 * 返回的配置即文件里的扁平 v1 结构。
 */
export function listCliWorkersConfig(): CliWorkersConfig {
  const filePath = getCliWorkersPath()
  const parsed = readJsonSafe<CliWorkersConfig | null>(filePath, null)

  // 文件不存在（或损坏到 fallback=null）→ 就地 seed
  if (!parsed) {
    const seed = cloneSeed()
    try {
      writeJsonAtomic(filePath, seed)
    } catch (err) {
      console.warn('[cli-workers-service] seed 落盘失败，仍返回内存默认：', err)
    }
    return seed
  }

  // 文件存在但结构非法（含黑名单）→ 当 seed 覆盖
  if (!isValidCliWorkersConfig(parsed)) {
    console.warn('[cli-workers-service] 文件格式不识别或命中黑名单，触发 seed 覆盖')
    const seed = cloneSeed()
    try {
      writeJsonAtomic(filePath, seed)
    } catch (err) {
      console.warn('[cli-workers-service] seed 重写失败：', err)
    }
    return seed
  }

  // 合法旧配置：补齐缺的 seed 工人（grok/codex/mimo），不覆盖用户已有字段。
  // 仅在内存补齐（不回写盘）；用户在设置页保存整表时自然落盘升级。
  return ensureSeedWorkers(parsed)
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
    })),
  })
}
