/**
 * Windows 上 kscc 子进程启动规划
 *
 * kscc.cmd 内部依赖 PATH 中的 `node`。Cursor / IDE 启动的 dev Electron 进程
 * 往往只有 npm 全局目录、没有 Node.js 安装目录，导致 cmd /c kscc 报
 * 「不是内部或外部命令」并 exit 1。打包版会从注册表补全 PATH，故 release 正常。
 *
 * 方案：用 node.exe 绝对路径直接执行 cli-wrapper.js，绕过 .cmd 与 PATH 依赖。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveNodeExecutablePath } from './node-detector'

export interface KsccWindowsSpawnPlan {
  command: string
  args: string[]
}

/** 解码 Windows 子进程 stderr（cmd 中文错误多为 GBK/GB18030） */
export function decodeWindowsChildStderr(chunk: Buffer): string {
  if (process.platform !== 'win32') {
    return chunk.toString('utf8')
  }
  try {
    return new TextDecoder('gb18030').decode(chunk)
  } catch {
    return chunk.toString('utf8')
  }
}

/**
 * 规划 kscc 在 Windows 上的 spawn 参数。
 *
 * @param ksccCmdPath orchestrator 解析到的 kscc.cmd 绝对路径
 * @param sdkArgs SDK 传入给 claude/kscc 的参数
 */
export function planKsccWindowsSpawn(
  ksccCmdPath: string,
  sdkArgs: string[]
): KsccWindowsSpawnPlan | null {
  if (process.platform !== 'win32') return null
  if (!ksccCmdPath.toLowerCase().endsWith('.cmd')) return null

  const npmGlobalDir = dirname(ksccCmdPath)
  const cliWrapper = join(npmGlobalDir, 'node_modules', '@seasun', 'kscc', 'cli-wrapper.js')
  if (!existsSync(cliWrapper)) {
    console.warn(`[kscc spawn] 未找到 cli-wrapper: ${cliWrapper}`)
    return null
  }

  const bundledNode = join(npmGlobalDir, 'node.exe')
  const nodeExe = existsSync(bundledNode) ? bundledNode : resolveNodeExecutablePath()
  if (!nodeExe || !existsSync(nodeExe)) {
    console.warn('[kscc spawn] 未找到 node.exe，无法直接启动 kscc')
    return null
  }

  console.log(`[kscc spawn] 使用 ${nodeExe} ${cliWrapper}`)
  return {
    command: nodeExe,
    args: [cliWrapper, ...sdkArgs],
  }
}
