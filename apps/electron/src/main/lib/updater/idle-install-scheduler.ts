/**
 * 空闲安装调度器
 *
 * 用户选择「空闲时更新」后，等待所有 Agent 结束再安装。
 * 状态检查留在主进程，避免渲染进程漏掉后台运行或其他窗口中的 Agent。
 */

interface SchedulerOptions {
  canInstall: () => boolean
  install: () => void
  pollIntervalMs?: number
}

export function createIdleInstallScheduler(opts: SchedulerOptions) {
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000
  let requested = false
  let timer: ReturnType<typeof setInterval> | null = null

  function tick() {
    if (!requested) return
    if (opts.canInstall()) {
      cancel()
      opts.install()
    }
  }

  function request() {
    if (requested) return
    requested = true
    // 立即检查一次，可能已经空闲
    tick()
    if (requested && !timer) {
      timer = setInterval(tick, pollIntervalMs)
    }
  }

  function cancel() {
    requested = false
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function dispose() {
    cancel()
  }

  return { request, cancel, dispose, get isActive() { return requested } }
}
