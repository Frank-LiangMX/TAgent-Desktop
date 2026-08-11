/**
 * No-Progress Guard 用户偏好（主进程落盘）
 *
 * 优先级：环境变量 TAGENT_NO_PROGRESS_GUARD_MODE > 本文件 > 默认 enforce。
 * 路径：~/.tagent[-dev]/no-progress-guard.json（与其它 tagent 配置同根）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  NO_PROGRESS_GUARD_DEFAULT_MODE,
  type NoProgressGuardMode,
} from '@tagent/shared'

const FILE_NAME = 'no-progress-guard.json'

function prefsPath(): string {
  const base =
    process.env.TAGENT_HOME?.trim() ||
    join(homedir(), process.env.TAGENT_DEV ? '.tagent-dev' : '.tagent')
  return join(base, FILE_NAME)
}

let cache: NoProgressGuardMode | null = null

function isMode(v: unknown): v is NoProgressGuardMode {
  return v === 'off' || v === 'shadow' || v === 'enforce'
}

/** 读落盘偏好；缺省 / 损坏 → null（交给 resolve 回落默认） */
export function readNoProgressGuardModePref(): NoProgressGuardMode | null {
  if (cache) return cache
  try {
    const p = prefsPath()
    if (!existsSync(p)) return null
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { mode?: unknown }
    if (!isMode(raw.mode)) return null
    cache = raw.mode
    return cache
  } catch {
    return null
  }
}

/** 写入偏好并刷新缓存 */
export function writeNoProgressGuardModePref(mode: NoProgressGuardMode): void {
  if (!isMode(mode)) throw new Error(`非法守卫模式：${String(mode)}`)
  const p = prefsPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify({ mode }, null, 2)}\n`, 'utf8')
  cache = mode
}

export function peekNoProgressGuardDefault(): NoProgressGuardMode {
  return NO_PROGRESS_GUARD_DEFAULT_MODE
}
