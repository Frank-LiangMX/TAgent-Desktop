/**
 * 解析 kscc CLI 路径
 *
 * 从 TAgent agent-orchestrator.ts:1897-1922 抽取。
 * Windows: where 返回多个，优先 .cmd/.exe（真正可执行），避免 shim 导致 spawn 失败。
 */
import { execFileSync } from 'node:child_process'

export function resolveKsccPath(): string | undefined {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    if (process.platform === 'win32') {
      const allPaths = execFileSync(cmd, ['kscc'], { encoding: 'utf-8', timeout: 3000 })
        .trim()
        .split(/\r?\n/)
      return (
        allPaths.find((p) => p.endsWith('.cmd')) ||
        allPaths.find((p) => p.endsWith('.exe')) ||
        allPaths[0]
      )
    }
    return execFileSync(cmd, ['kscc'], { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0]
  } catch {
    return undefined
  }
}
