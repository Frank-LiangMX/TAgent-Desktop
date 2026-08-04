/**
 * Windows 文件系统健壮性工具
 *
 * 中文 Windows 上 fs.watch 递归监听持有的句柄释放是毫秒级延迟，
 * 删除目录/文件可能抛 EBUSY / EPERM / ENOTEMPTY。提供带指数退避的重试封装：
 * 仅在可重试错误码上重试，其他错误（真实权限拒绝等）直接抛出。
 * EPERM/EACCES 在非 Windows 平台通常是真实权限问题，不重试，故按平台区分。
 */
import { rmSync, type RmOptions } from 'node:fs'

const RETRYABLE_CODES: ReadonlySet<string> = new Set(
  process.platform === 'win32'
    ? ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']
    : ['EBUSY', 'ENOTEMPTY'],
)

/** 同步休眠（不占 CPU；SharedArrayBuffer 不可用时 busy-wait 兜底） */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const start = Date.now()
    while (Date.now() - start < ms) {
      /* busy-wait 兜底 */
    }
  }
}

/**
 * 删除文件/目录：Windows 句柄占用（EBUSY/EPERM/ENOTEMPTY）时带指数退避重试
 * （50 → 100 → 200 → 400ms，最多 5 次，累计约 750ms）。
 * 其他错误码原样抛出。
 */
export function rmSyncRobust(target: string, options: RmOptions): void {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      rmSync(target, options)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException)?.code
      if (!code || !RETRYABLE_CODES.has(code)) throw err
      if (attempt < 5) sleepSync(50 * 2 ** (attempt - 1))
    }
  }
  throw lastErr
}
