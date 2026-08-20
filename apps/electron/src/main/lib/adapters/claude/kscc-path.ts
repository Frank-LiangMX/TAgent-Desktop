/**
 * 解析 kscc CLI 路径
 *
 * 从 TAgent agent-orchestrator.ts:1897-1922 抽取。
 * Windows: where 返回多个，优先 .cmd/.exe（真正可执行），避免 shim 导致 spawn 失败。
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

function isUsableExecutable(filePath: string): boolean {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false
    if (process.platform !== 'win32') accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveFromPath(pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue || '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'kscc')
    if (isUsableExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Finder/Dock 启动的 macOS GUI 不会自动继承用户 shell 的 PATH。
 * 用 login+interactive zsh 读取用户实际配置，再从输出中挑真实可执行文件。
 */
function resolveFromMacShell(): string | undefined {
  const shells = ['/bin/zsh', '/bin/bash']
  for (const shell of shells) {
    if (!existsSync(shell)) continue
    try {
      const output = execFileSync(
        shell,
        ['-ilc', 'whence -p kscc 2>/dev/null || command -v kscc 2>/dev/null'],
        {
          encoding: 'utf-8',
          timeout: 3000,
          env: process.env,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
      for (const line of output.split(/\r?\n/)) {
        const candidate = line.trim()
        if (candidate.startsWith('/') && isUsableExecutable(candidate)) return candidate
      }
    } catch {
      // 某些用户 shell 配置包含交互式命令；继续尝试下一个 shell/候选目录。
    }
  }
  return undefined
}

function resolveFromMacWellKnownDirs(): string | undefined {
  const home = homedir()
  const dirs = [
    process.env.NVM_BIN,
    process.env.VOLTA_HOME ? join(process.env.VOLTA_HOME, 'bin') : undefined,
    process.env.PNPM_HOME,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    join(home, '.npm-global/bin'),
    join(home, '.local/bin'),
    join(home, '.volta/bin'),
    join(home, '.bun/bin'),
    join(home, 'Library/pnpm'),
  ].filter((dir): dir is string => Boolean(dir))

  return resolveFromPath(dirs.join(delimiter))
}

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
    const fromCurrentPath = resolveFromPath(process.env.PATH)
    if (fromCurrentPath) return fromCurrentPath

    if (process.platform === 'darwin') {
      return resolveFromMacShell() ?? resolveFromMacWellKnownDirs()
    }

    return execFileSync(cmd, ['kscc'], { encoding: 'utf-8', timeout: 3000 })
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .find((line) => isUsableExecutable(line))
  } catch {
    if (process.platform === 'darwin') {
      return resolveFromMacShell() ?? resolveFromMacWellKnownDirs()
    }
    return undefined
  }
}
