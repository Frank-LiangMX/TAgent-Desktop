/**
 * idle / 断流看门狗 —— 纯函数超时判定
 *
 * 当渲染层长时间未收到流式事件，且主进程已确认会话 idle，
 * 应强制 UI 收敛到 idle 态（清 running / 计时 pill / 停止键）。
 *
 * 这是兜底逻辑，不替代正常的 turn_end / result / session_error 终态路径。
 * 看门狗只在「正常终态事件丢失 / 通道断流」时触发。
 */

/** 看门狗超时阈值（ms）：无流式事件超过此值且主进程 idle → 兜底收敛 */
export const IDLE_WATCHDOG_TIMEOUT_MS = 20_000 // 20s

/**
 * 纯函数：判定是否应强制 idle。
 *
 * @param lastStreamEventAt 最近一次流式事件的时间戳（ms），null 表示从未收到
 * @param now 当前时间戳（ms）
 * @param isMainProcessIdle 主进程报告的会话是否 idle
 * @param isAtomRunning 渲染层 atom 是否仍 running
 * @param hasStartedAt soft-stop 残留：running=false 但 startedAt 仍在 → UI isLiveTurn 永真，也应兜底硬清
 * @returns true → 调用 stopSessionRun 兜底收敛
 */
export function shouldForceIdle(input: {
  lastStreamEventAt: number | null
  now: number
  isMainProcessIdle: boolean
  isAtomRunning: boolean
  hasStartedAt?: boolean
  /** AskUser / 权限 / 退出计划：人还没选，不能当 idle 硬清计时 */
  awaitingUser?: boolean
}): boolean {
  const {
    lastStreamEventAt,
    now,
    isMainProcessIdle,
    isAtomRunning,
    hasStartedAt = false,
    awaitingUser = false,
  } = input

  // 既不 running、也无 startedAt 残留 → 无需兜底
  if (!isAtomRunning && !hasStartedAt) return false

  // 等用户点选：本轮没完，禁止硬清 startedAt（提交后要续计时）
  if (awaitingUser) return false

  // 主进程不是 idle → 可能真的在跑（长工具调用等），不动
  if (!isMainProcessIdle) return false

  // 从未收到流式事件（刚 adopt 但主进程已 idle → 异常态，立即兜底）
  if (lastStreamEventAt == null) return true

  // 超时判定：距离最后流式事件超过阈值
  return now - lastStreamEventAt >= IDLE_WATCHDOG_TIMEOUT_MS
}
