/**
 * workspace_run_command 命令执行器（受控命令桥）
 *
 * 只允许白名单内的项目开发命令，绝不经过 shell 拼接：
 * - `spawn(..., { shell: false })` 直接派发可执行文件，参数按数组逐项传递，不经 shell
 *   解释——因此参数里的分号/管道/重定向字符不会被当作操作符执行。
 * - 作为纵深防御，校验层仍显式拒绝 shell 控制字符（`;` `&` `|` `<` `>` 反引号/换行/NUL），
 *   防止误改实现时把受控命令回退成 shell 拼接而引入注入面。
 * - args 以 JSON 字符串传递（模型只能给出字符串数组），宿主解析校验，杜绝类型混淆。
 *
 * 纯模块：不依赖 DB / service / 时间之外的外部状态，便于分层单测（命令白名单 / 参数安全 /
 * 超时 / 输出上限）。路径边界（cwd 必须在工作区内）由调用方（service）先行校验。
 */
import { spawn } from 'node:child_process'
import {
  COLLABORATION_WORKSPACE_COMMAND_ALLOWLIST,
  COLLABORATION_WORKSPACE_COMMAND_MAX_ARGS,
  COLLABORATION_WORKSPACE_COMMAND_TIMEOUT_MS,
  COLLABORATION_WORKSPACE_COMMAND_TOTAL_OUTPUT_BYTES,
} from '@tagent/shared'

/**
 * 判为 shell 控制字符：命令分隔符（`;`）、管道（`|`）、重定向（`<` `>`）、
 * 后台/分隔（`&`）、命令替换（反引号）、换行/回车/NUL。命中即拒绝。
 */
const SHELL_META = /[;&|<>`\r\n\0]/

export type WorkspaceCommandValidation =
  | { ok: true; command: string; args: string[] }
  | { ok: false; reason: string }

/**
 * 校验命令名 + args JSON + shell 控制字符。纯函数（不 spawn、不读盘）。
 *
 * - command：必须命中白名单的可执行名（拒绝路径、拒绝 shell 字符、拒绝空）。
 * - args：必须是 JSON 字符串数组，元素数不超上限，元素不含 shell 控制字符。
 */
export function validateWorkspaceCommand(
  commandRaw: string,
  argsJson?: string,
): WorkspaceCommandValidation {
  const command = (commandRaw ?? '').trim()
  if (!command) return { ok: false, reason: '命令不能为空' }
  if (command.includes('/') || command.includes('\\')) {
    return { ok: false, reason: '命令必须是白名单内的可执行名，不能是路径' }
  }
  if (SHELL_META.test(command)) {
    return { ok: false, reason: '命令名含 shell 控制字符' }
  }
  if (!COLLABORATION_WORKSPACE_COMMAND_ALLOWLIST.includes(command as (typeof COLLABORATION_WORKSPACE_COMMAND_ALLOWLIST)[number])) {
    return { ok: false, reason: `命令不在白名单内：${command}` }
  }

  const args: string[] = []
  if (argsJson !== undefined && argsJson !== null && argsJson.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(argsJson)
    } catch {
      return { ok: false, reason: 'args 必须是 JSON 字符串数组' }
    }
    if (!Array.isArray(parsed)) return { ok: false, reason: 'args 必须是 JSON 字符串数组' }
    if (parsed.length > COLLABORATION_WORKSPACE_COMMAND_MAX_ARGS) {
      return {
        ok: false,
        reason: `参数数量超过上限（${COLLABORATION_WORKSPACE_COMMAND_MAX_ARGS}）`,
      }
    }
    for (const item of parsed) {
      if (typeof item !== 'string') return { ok: false, reason: 'args 数组元素必须是字符串' }
      if (SHELL_META.test(item)) return { ok: false, reason: '参数含 shell 控制字符' }
    }
    args.push(...(parsed as string[]))
  }
  return { ok: true, command, args }
}

export interface WorkspaceCommandRunOptions {
  /** 工作目录（已由调用方校验落在工作区内） */
  cwd: string
  /** 取消信号（abort 即终止子进程） */
  signal?: AbortSignal
  /** 墙钟超时（ms），调用方可收紧但不可超过共享上限 */
  timeoutMs?: number
  /** stdout+stderr 合计上限（字节），超过截断并标记 truncated */
  maxOutputBytes?: number
}

export type WorkspaceCommandRunResult =
  | {
      ok: true
      stdout: string
      stderr: string
      exitCode: number | null
      timedOut: boolean
      truncated: boolean
    }
  | { ok: false; reason: string }

/**
 * 执行一条白名单命令。spawn shell:false + 数组参数；超时 SIGKILL、输出合计截断。
 * 子进程启动失败（命令不存在）→ { ok:false }。
 */
export function runWorkspaceCommand(
  commandRaw: string,
  argsJson: string | undefined,
  opts: WorkspaceCommandRunOptions,
): Promise<WorkspaceCommandRunResult> {
  const v = validateWorkspaceCommand(commandRaw, argsJson)
  if (!v.ok) return Promise.resolve(v)

  const timeoutMs = Math.min(
    opts.timeoutMs ?? COLLABORATION_WORKSPACE_COMMAND_TIMEOUT_MS,
    COLLABORATION_WORKSPACE_COMMAND_TIMEOUT_MS,
  )
  const maxOutputBytes =
    opts.maxOutputBytes ?? COLLABORATION_WORKSPACE_COMMAND_TOTAL_OUTPUT_BYTES

  return new Promise<WorkspaceCommandRunResult>((resolve) => {
    // Windows 将 npm/pnpm/yarn/npx 安装为 .cmd；shell:false 下不能依赖 cmd.exe 的
    // 自动解析，否则会退化成 shell 拼接。显式补后缀仍保持 shell:false 与参数数组语义。
    const executable = process.platform === 'win32' && ['npm', 'pnpm', 'yarn', 'npx'].includes(v.command)
      ? `${v.command}.cmd`
      : v.command
    const child = spawn(executable, v.args, { cwd: opts.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let totalBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const abort = () => child.kill('SIGKILL')
    if (opts.signal?.aborted) abort()
    else opts.signal?.addEventListener('abort', abort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return
      const s = chunk.toString('utf8')
      if (totalBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - totalBytes
        const take = Math.min(remaining, s.length)
        stdout += s.slice(0, take)
        totalBytes += take
        if (totalBytes >= maxOutputBytes) truncated = true
      } else {
        truncated = true
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (truncated) return
      const s = chunk.toString('utf8')
      if (totalBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - totalBytes
        const take = Math.min(remaining, s.length)
        stderr += s.slice(0, take)
        totalBytes += take
        if (totalBytes >= maxOutputBytes) truncated = true
      } else {
        truncated = true
      }
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abort)
      if (timedOut) {
        resolve({ ok: true, stdout, stderr, exitCode: null, timedOut: true, truncated })
      } else {
        resolve({ ok: false, reason: `命令启动失败：${err.message}` })
      }
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abort)
      if (timedOut) {
        resolve({ ok: true, stdout, stderr, exitCode: null, timedOut: true, truncated })
      } else {
        resolve({
          ok: true,
          stdout,
          stderr,
          exitCode: child.exitCode ?? (timedOut ? null : child.exitCode ?? null),
          timedOut: false,
          truncated,
        })
      }
    })
  })
}
