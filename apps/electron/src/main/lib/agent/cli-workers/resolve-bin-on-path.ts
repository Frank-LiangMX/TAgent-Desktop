/**
 * Windows 上把 bare 名（如 'kscc'）解析成绝对可执行路径。
 *
 * 用途：runKsccWorker 在 Windows spawn 时，避免 `cmd.exe /c kscc ... <prompt>` 对 prompt
 * 重分词（实测短句 `Reply with exactly: PING_OK` 经 cmd 后 kscc 只看到 `Reply`）。
 * 先解析出 kscc.cmd 绝对路径，再交 planKsccWindowsSpawn 直连 node + cli-wrapper，
 * 或在 cmd 兜底时把 prompt 走 stdin（cmd / c 不再碰 prompt）。
 *
 * - 已是绝对/相对路径 → 直接 existsSync 判定返回
 * - bare 名 → `where.exe <name>` 取候选，优先 .cmd（planKsccWindowsSpawn 目标），次 .exe
 *   （无扩展的 bash shim 无法被 Node 直接 spawn，跳过）
 * - where.exe 无 .cmd/.exe 命中时，追加 WindowsApps 执行别名兜底：
 *   `%LOCALAPPDATA%\Microsoft\WindowsApps\<name>.exe` 存在即返回（Store 安装的 codex 走这里）
 * - 解析失败返回 null（调用方回退 bare 名 → cmd / c 兜底，prompt 走 stdin）
 *
 * 仅 Windows 调用；非 Windows 分支不应进入此函数。同步 execSync，spawn 前一次性开销可接受
 * （与 node-detector.resolveNodeExecutablePath 同口径，不在调度热路径上）。
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 含路径分隔符或盘符 → 视作路径而非 bare 名 */
function looksLikePath(name: string): boolean {
  return name.includes('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)
}

/**
 * 解析 bare 名到绝对路径（Windows）。
 *
 * @param bareName bare 名（如 'kscc'）或绝对/相对路径
 * @returns 绝对路径（优先 .cmd，次 .exe）；bare 名解析失败 / 路径不存在返回 null
 */
export function resolveBinOnPath(bareName: string): string | null {
  if (!bareName) return null
  // 已是路径 → 直接判定存在性，不再 where
  if (looksLikePath(bareName)) {
    return existsSync(bareName) ? bareName : null
  }
  let lines: string[] = []
  try {
    const out = execSync(`where.exe ${bareName}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    })
    lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    // where.exe 不可用 / 未找到 → lines 留空，走下方 WindowsApps 兜底
    lines = []
  }
  // 优先 .cmd：planKsccWindowsSpawn 直连 node 的目标（npm 全局 shim 的 .ps1 由 .cmd 覆盖）
  const cmd = lines.find((l) => /\.cmd$/i.test(l) && existsSync(l))
  if (cmd) return cmd
  // 次 .exe：可被 Node 直接 spawn（不经 cmd，argv 不被重分词）
  const exe = lines.find((l) => /\.exe$/i.test(l) && existsSync(l))
  if (exe) return exe
  // WindowsApps 执行别名兜底：Store 安装的 codex 等可能不在 where 输出里，但别名文件存在
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    const alias = join(localAppData, 'Microsoft', 'WindowsApps', `${bareName}.exe`)
    if (existsSync(alias)) return alias
  }
  // 仅剩无扩展 shim（bash 等）→ Node 无法直接 spawn，返回 null 走 cmd 兜底
  return null
}
