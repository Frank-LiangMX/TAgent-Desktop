/**
 * kscc 子进程 spawn（kscc 核特有）
 *
 * 从 TAgent claude-agent-adapter.ts 的 spawnClaudeCodeProcess hook 抽取。
 * Windows 上 kscc 是 .cmd 脚本，需特殊处理（cmd.exe /c 或 planKsccWindowsSpawn 直连 node）。
 */
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { planKsccWindowsSpawn, decodeWindowsChildStderr } from '../shared/kscc-windows-spawn'

export interface KsccSpawnResult {
  child: ChildProcess
  /** 实际执行的 command（日志用） */
  command: string
  /** 实际执行的 args（日志用） */
  args: string[]
}

/**
 * spawn kscc 子进程。
 * @param sdkCliPath kscc 路径
 * @param spawnOpts SDK 传来的 spawn 选项
 * @param onStderr stderr 回调（可为空，但仍会消费流防缓冲满）
 */
export function spawnKscc(
  sdkCliPath: string,
  spawnOpts: SpawnOptions,
  onStderr?: (data: string) => void
): KsccSpawnResult {
  const isWinCmd = process.platform === 'win32'

  let spawnCommand = isWinCmd ? 'cmd.exe' : spawnOpts.command
  let spawnArgs = isWinCmd ? ['/c', 'kscc', ...spawnOpts.args] : spawnOpts.args

  if (isWinCmd) {
    const direct = planKsccWindowsSpawn(sdkCliPath, spawnOpts.args)
    if (direct) {
      spawnCommand = direct.command
      spawnArgs = direct.args
    }
  }

  const child = spawnChild(spawnCommand, spawnArgs, {
    cwd: spawnOpts.cwd,
    env: spawnOpts.env,
    signal: spawnOpts.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // 手动转发 stderr（自定义 spawn 需自己做），同时消费流防缓冲满
  if (onStderr) {
    child.stderr?.on('data', (chunk: Buffer) => {
      try {
        const text =
          process.platform === 'win32'
            ? decodeWindowsChildStderr(chunk)
            : chunk.toString('utf8')
        onStderr(text)
      } catch {
        /* 回调异常不影响流 */
      }
    })
  } else {
    child.stderr?.resume()
  }

  return { child, command: spawnCommand, args: spawnArgs }
}
