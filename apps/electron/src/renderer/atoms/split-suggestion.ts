/**
 * 分屏建议检测逻辑（纯函数，无副作用）
 *
 * 检测条件（仅当 splitDockModeAtom === false 时启用）：
 * - 时间窗口 60 秒
 * - 同两个 session 之间累计至少 4 次切换
 * - 必须明显是两个会话交替切换（无第三个会话穿插）
 * - 触发后同一对 session 有冷却时间（5 分钟）
 */

/** 切换记录：一次真实的会话激活切换 */
export interface SwitchRecord {
  sessionId: string
  timestamp: number
}

/** 检测参数 */
export const SPLIT_SUGGESTION_CONFIG = {
  /** 时间窗口（毫秒），默认 60 秒 */
  WINDOW_MS: 60_000,
  /** 最少切换次数 */
  MIN_SWITCHES: 4,
  /** 触发后冷却时间（毫秒），默认 5 分钟 */
  COOLDOWN_MS: 5 * 60_000,
} as const

/**
 * 查找最近交替切换的两个 session。
 *
 * 从最新记录向回扫描，找到最长后缀（全部在时间窗口内）满足：
 * 1. 只包含两个不同的 sessionId
 * 2. 这两个 sessionId 交替出现（无连续重复）
 * 3. 切换次数 >= MIN_SWITCHES
 *
 * @returns 满足条件的交替 pair，或 null
 */
export function findAlternatingPair(
  history: SwitchRecord[],
  now: number,
  minSwitches: number = SPLIT_SUGGESTION_CONFIG.MIN_SWITCHES,
  windowMs: number = SPLIT_SUGGESTION_CONFIG.WINDOW_MS,
): [string, string] | null {
  if (history.length < minSwitches + 1) return null

  const cutoff = now - windowMs

  // 从最新记录开始，向回扫描
  for (let start = history.length - 1; start >= 0; start--) {
    // 检查从 start 到末尾的所有记录是否都在时间窗口内
    let allInWindow = true
    for (let i = start; i < history.length; i++) {
      const record = history[i]
      if (!record || record.timestamp < cutoff) {
        allInWindow = false
        break
      }
    }
    if (!allInWindow) break

    // 收集这一段的 session 集合
    const sessions = new Set<string>()
    for (let i = start; i < history.length; i++) {
      const record = history[i]
      if (record) sessions.add(record.sessionId)
    }

    if (sessions.size === 2) {
      const pair = Array.from(sessions) as [string, string]

      // 检查是否交替切换（无连续重复）
      let alternates = true
      for (let i = start + 1; i < history.length; i++) {
        const current = history[i]
        const previous = history[i - 1]
        if (!current || !previous || current.sessionId === previous.sessionId) {
          alternates = false
          break
        }
      }

      if (alternates) {
        // 统计切换次数
        let switches = 0
        for (let i = start + 1; i < history.length; i++) {
          const previous = history[i - 1]
          const current = history[i]
          if (!previous || !current) continue
          const prev = previous.sessionId
          const curr = current.sessionId
          if (
            (prev === pair[0] && curr === pair[1]) ||
            (prev === pair[1] && curr === pair[0])
          ) {
            switches++
          }
        }

        if (switches >= minSwitches) return pair
      }
    } else if (sessions.size > 2) {
      // 超过 2 个 session，无法形成交替对
      break
    }
  }

  return null
}

/**
 * 检查指定 pair 是否在冷却期内。
 */
export function isInCooldown(
  cooldownMap: Map<string, number>,
  pair: [string, string],
  now: number,
  cooldownMs: number = SPLIT_SUGGESTION_CONFIG.COOLDOWN_MS,
): boolean {
  const key = makePairKey(pair)
  const expiry = cooldownMap.get(key)
  return expiry != null && now < expiry
}

/**
 * 设置冷却期。
 */
export function setCooldown(
  cooldownMap: Map<string, number>,
  pair: [string, string],
  now: number,
  cooldownMs: number = SPLIT_SUGGESTION_CONFIG.COOLDOWN_MS,
): void {
  cooldownMap.set(makePairKey(pair), now + cooldownMs)
}

/** 生成排序无关的 pair key */
function makePairKey([a, b]: [string, string]): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`
}
