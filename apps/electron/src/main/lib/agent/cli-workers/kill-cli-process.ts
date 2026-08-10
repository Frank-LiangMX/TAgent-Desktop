/**
 * CLI 子进程强制收口（含子进程树）。
 *
 * Windows 上 `cmd.exe /c kscc ...` 时，只 kill 父进程可能留下孙进程。
 * 用 taskkill /T 杀整棵树；其它平台 SIGTERM → 短延迟后 SIGKILL。
 */
import type { ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'

/** 默认单次 CLI 工人最长运行时间（ms）。超时强制杀进程，防管生不管关。 */
export const DEFAULT_CLI_WORKER_TIMEOUT_MS = 20 * 60 * 1000

/**
 * 尽量杀掉 child 及其子进程树。
 * 不抛错；进程已死则忽略。
 */
export function killCliProcessTree(child: ChildProcess, label = 'cli-worker'): void {
  const pid = child.pid
  if (pid == null || pid <= 0) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    return
  }

  if (process.platform === 'win32') {
    // /T 子树 /F 强制；失败再退回 child.kill()
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 8000 },
      (err) => {
        if (err) {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
          console.warn(`[${label}] taskkill 失败，已尝试 kill():`, err.message)
        }
      },
    )
    return
  }

  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  // 1.5s 仍未退出则 SIGKILL
  setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }, 1500).unref?.()
}
