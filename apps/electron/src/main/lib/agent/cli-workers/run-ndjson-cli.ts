/**
 * runNdjsonCli：通用 NDJSON CLI runner（grok / codex / mimo 共用，kscc 仍走自己的 run-kscc-worker）。
 *
 * 三套 CLI 协议互不兼容，但都是「一行一事件」的 NDJSON，适合统一 Host：逐行喂 observer，
 * observer 产出 `{lastToolName / toolUse / toolResult / textChunk}` 增量，本函数按增量分发回调。
 *
 * 职责（与 run-kscc-worker 的 spawn/finalize 段对齐，抽出共用）：
 * - spawn（command/args/delivery 由 runner 组装好；delivery 决定 stdio 与 prompt 投递）
 * - abort → child.kill()（不把 signal 传进 spawn，避免 AbortError 噪声）
 * - stderr 缓冲尾部（失败摘要用）
 * - readline 逐行 → observer.onLine → onProgress/onToolUse/onToolResult/onTextChunk
 * - finalize：exit 0 → ok:true；exit≠0 但有 summary → ok:true（容忍尾部告警）；否则 ok:false 含退出码/stderr
 * - 临时 prompt 文件（delivery='file'）在结束时清理
 *
 * 不在本文件做：
 * - 各 CLI 的 argv/flag 组装与 delivery 决策 → 各 runner（run-grok/codex/mimo-worker）
 * - 行解析规则 → 各 observer（*-stream-observer）
 * - 寒暄软失败 → 仅 kscc（run-kscc-worker）有；其它 CLI 暂不做（brief：或仅 kscc）
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveBinOnPath } from './resolve-bin-on-path'
import {
  DEFAULT_CLI_WORKER_TIMEOUT_MS,
  killCliProcessTree,
} from './kill-cli-process'

/** 通用工具调用 hit（各 observer 产出，喂详情页 parentToolUseId 消息） */
export interface CliToolUseHit {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface CliToolResultHit {
  toolUseId: string
  content: string
  isError?: boolean
}

/** 单行解析增量（供进度卡 + 详情流） */
export interface CliLineHit {
  lastToolName?: string
  toolUse?: CliToolUseHit
  textChunk?: string
  toolResult?: CliToolResultHit
}

/** 各 CLI observer 实现此接口；runNdjsonCli 逐行喂 onLine 并按返回增量分发回调。 */
export interface CliStreamObserver {
  onLine(line: string): CliLineHit
  getSummary(): string
  getToolCallCount(): number
  /**
   * 流内错误（如 opencode 0 凭据 / 限流的 `error` 事件）。
   * 返回非空字符串 → finalize 在 abort/timeout 之后、exitCode 判断之前据此判 ok:false（summary 用 label 前缀 + 该错误信息）；
   * 不实现 / 返回 undefined → 行为不变（按 exitCode / observer summary 判定）。
   */
  getError?(): string | undefined
}

/** runner 统一返回（与 run-kscc-worker 的 RunKsccWorkerResult 同形，结构兼容） */
export interface RunCliWorkerResult {
  ok: boolean
  summary: string
  toolCalls: number
  durationMs: number
  exitCode: number | null
}

/** prompt 投递方式：argv 末位 / stdin / --prompt-file 临时文件 */
export type PromptDelivery = 'argv' | 'stdin' | 'file'

/** spawn 计划：runner 已组装好 command + 完整 args（含 cmd /c 前缀、flags、prompt 或 --prompt-file 路径） */
export interface NdjsonSpawnPlan {
  command: string
  args: string[]
  delivery: PromptDelivery
  /** delivery='file' 时的临时 prompt 文件路径（core 在结束/失败时负责清理） */
  promptFile?: string
}

/** prompt 超过此长度或含换行 → 不走 argv（避开 argv 长度上限与换行问题） */
const PROMPT_STDIN_THRESHOLD = 4000

/** prompt 是否过长或含换行（不宜作 argv 末位） */
export function isLongOrMultiline(prompt: string): boolean {
  return prompt.length > PROMPT_STDIN_THRESHOLD || prompt.includes('\n')
}

/** 含路径分隔符或盘符 → 视作路径而非 bare 名 */
export function isBareName(bin: string): boolean {
  return !bin.includes('/') && !bin.includes('\\') && !/^[A-Za-z]:/.test(bin)
}

export interface ResolvedCliBin {
  /** spawn 命令（unix/直 .exe 为本体；win .cmd/兜底为 'cmd.exe'） */
  command: string
  /** 需前置的 argv（win .cmd/兜底为 ['/c', <target>]；其余为 []） */
  cmdPrefix: string[]
  /** true 表示直 spawn（不经 shell），prompt 作 argv 末位安全 */
  directSpawn: boolean
  via: 'unix' | 'win-exe' | 'win-cmd' | 'win-cmd-bare'
}

/**
 * 解析 bin 到 spawn 命令（Windows 优先直 spawn .exe / 绕开 cmd 对 prompt 的重分词）。
 *
 * - 非 Windows：直跑 bin（argv 安全）。
 * - Windows .exe：直 spawn（不经 shell，argv 不被重分词）。
 * - Windows .cmd：cmd.exe /c <abs.cmd> <flags>，prompt 须走 stdin/file（cmd 会重分词）。
 * - bare 名解析失败 / 无扩展：cmd.exe /c <bare>，prompt 须走 stdin/file。
 *
 * 与 run-kscc-worker 的差异：kscc 的 .cmd 会再试 planKsccWindowsSpawn 直连 node（@seasun/kscc 专用）；
 * 本函数面向 grok/codex/mimo，.cmd 一律走 cmd /c（这些 CLI 无对应 cli-wrapper），prompt 走 stdin/file。
 */
export function resolveCliBin(bin: string): ResolvedCliBin {
  if (process.platform !== 'win32') {
    return { command: bin, cmdPrefix: [], directSpawn: true, via: 'unix' }
  }
  const resolved = isBareName(bin) ? (resolveBinOnPath(bin) ?? bin) : bin
  if (/\.exe$/i.test(resolved)) {
    return { command: resolved, cmdPrefix: [], directSpawn: true, via: 'win-exe' }
  }
  if (/\.cmd$/i.test(resolved)) {
    return { command: 'cmd.exe', cmdPrefix: ['/c', resolved], directSpawn: false, via: 'win-cmd' }
  }
  return { command: 'cmd.exe', cmdPrefix: ['/c', resolved], directSpawn: false, via: 'win-cmd-bare' }
}

/** 写 prompt 到临时文件（--prompt-file 投递用）；返回文件路径（清理时按其 dirname 删整个临时目录）。 */
export function writePromptTempFile(label: string, prompt: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tagent-${label}-`))
  const file = join(dir, 'prompt.txt')
  writeFileSync(file, prompt, 'utf8')
  return file
}

/** 删除临时 prompt 文件及其所在临时目录（失败忽略）。 */
export function removePromptTempFile(file: string | undefined): void {
  if (!file) return
  try {
    rmSync(dirname(file), { recursive: true, force: true })
  } catch {
    /* 子进程仍占用 / 已删 → 忽略 */
  }
}

/** stderr 缓冲尾部（失败摘要用），截 2000 字防溢出 */
function tailStderr(chunks: string[]): string {
  return chunks.join('').trim().slice(-2000)
}

export interface RunNdjsonCliInput {
  /** CLI 标识（grok/codex/mimo），用于日志与失败 summary */
  label: string
  /** spawn 计划（runner 已组装好 command/args/delivery/promptFile） */
  plan: NdjsonSpawnPlan
  /** 子任务 prompt（delivery='stdin' 时喂 stdin；'file' 时已由 runner 写入 promptFile） */
  prompt: string
  /** 子进程工作目录 */
  cwd: string
  /** 所属主会话：登记后台进程 */
  sessionId?: string
  /** 取消信号；abort → kill 进程树 */
  signal?: AbortSignal
  /**
   * 最长运行时间（ms）；超时强制杀进程树。
   * 默认 {@link DEFAULT_CLI_WORKER_TIMEOUT_MS}（20 分钟）；`0` 表示不超时。
   */
  timeoutMs?: number
  /** 行解析 observer */
  observer: CliStreamObserver
  onProgress?: (lastToolName: string) => void
  onToolUse?: (t: CliToolUseHit) => void
  onToolResult?: (t: CliToolResultHit) => void
  onTextChunk?: (text: string) => void
}

/**
 * spawn 并跑 NDJSON CLI；resolve 一次性返回结果（成功 / 失败 / abort 都不抛）。
 *
 * 失败语义（ok:false）：abort / 超时 / observer.getError() 有值（流内 error 事件，如 opencode 0 凭据 / 限流） /
 * spawn 抛错 / child 'error' / exit≠0 且 observer 无 summary。
 */
export async function runNdjsonCli(input: RunNdjsonCliInput): Promise<RunCliWorkerResult> {
  const startTime = Date.now()
  const observer = input.observer

  // 已取消：不起进程，直接 stopped，并清理可能已创建的 prompt 临时文件
  if (input.signal?.aborted) {
    removePromptTempFile(input.plan.promptFile)
    return {
      ok: false,
      summary: `(${input.label} 已停止)`,
      toolCalls: 0,
      durationMs: Date.now() - startTime,
      exitCode: null,
    }
  }

  const spawnOpts: SpawnOptions = {
    cwd: input.cwd,
    stdio: input.plan.delivery === 'stdin' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  }

  let child: ChildProcess
  try {
    child = spawn(input.plan.command, input.plan.args, spawnOpts)
    if (input.sessionId) {
      const { trackSessionProcess } = await import('../session-process-registry')
      trackSessionProcess({
        sessionId: input.sessionId,
        command: `${input.label} ${input.plan.command}`.trim(),
        source: 'cli-worker',
        pid: child.pid,
        child,
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    removePromptTempFile(input.plan.promptFile)
    return {
      ok: false,
      summary: `${input.label} spawn 失败: ${msg}`,
      toolCalls: 0,
      durationMs: Date.now() - startTime,
      exitCode: null,
    }
  }

  // stdin 投递：把 prompt 喂进子进程 stdin（cmd / c 不再碰 prompt，避免重分词）。
  if (input.plan.delivery === 'stdin') {
    const stdin = child.stdin
    if (stdin) {
      stdin.on('error', () => {
        /* 子进程早退 EPIPE 忽略，避免 uncaught；后续 exit/error 兜底 */
      })
      try {
        stdin.write(input.prompt)
        stdin.end()
      } catch {
        /* stdin 写失败（子进程已退出）→ 忽略，后续 exit/error 兜底 */
      }
    }
  }

  // abort / 超时 → 杀进程树（Windows taskkill /T，避免 cmd 孙进程残留）
  const onAbort = (): void => {
    killCliProcessTree(child, input.label)
  }
  if (input.signal) input.signal.addEventListener('abort', onAbort, { once: true })

  const timeoutMs =
    typeof input.timeoutMs === 'number' ? input.timeoutMs : DEFAULT_CLI_WORKER_TIMEOUT_MS
  let timedOut = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      console.warn(`[${input.label}] 超过 ${timeoutMs}ms，强制结束进程树`)
      killCliProcessTree(child, input.label)
    }, timeoutMs)
    timeoutHandle.unref?.()
  }

  const stderrChunks: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    try {
      stderrChunks.push(chunk.toString('utf8'))
    } catch {
      /* 解码失败忽略 */
    }
  })

  const rl = createInterface({ input: child.stdout! })

  return new Promise<RunCliWorkerResult>((resolve) => {
    let settled = false
    let childClosed = false
    let rlClosed = false
    let capturedExitCode: number | null = null

    const cleanup = (): void => {
      if (input.signal) input.signal.removeEventListener('abort', onAbort)
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      removePromptTempFile(input.plan.promptFile)
    }

    const finalize = (): void => {
      if (settled || !childClosed || !rlClosed) return
      settled = true
      cleanup()
      const exitCode = capturedExitCode
      const durationMs = Date.now() - startTime
      const toolCalls = observer.getToolCallCount()
      const observerSummary = observer.getSummary()
      const observerError = observer.getError?.()
      const stderr = tailStderr(stderrChunks)
      const wasAborted = input.signal?.aborted === true

      let ok: boolean
      let summary: string
      if (wasAborted) {
        ok = false
        summary = observerSummary || `(${input.label} 已停止)`
      } else if (timedOut) {
        ok = false
        summary =
          observerSummary ||
          `(${input.label} 超时 ${Math.round(timeoutMs / 1000)}s，已强制结束进程)`
      } else if (observerError) {
        // observer 报告流内错误（如 opencode 0 凭据 / 限流 error 事件）→ ok:false，summary 用 label 前缀 + 错误信息
        ok = false
        summary = `${input.label}: ${observerError}`
      } else if (exitCode === 0) {
        ok = true
        summary = observerSummary || stderr || `(${input.label} 无输出)`
      } else if (observerSummary) {
        // exit !== 0 但已收口摘要 → 视为拿到结果（个别 CLI 尾部告警 / 工具失败但仍回包）
        ok = true
        summary = observerSummary
      } else {
        ok = false
        summary = stderr
          ? `${input.label} 退出码 ${exitCode}: ${stderr}`
          : `${input.label} 退出码 ${exitCode}`
      }

      resolve({ ok, summary, toolCalls, durationMs, exitCode })
    }

    rl.on('line', (line: string) => {
      const r = observer.onLine(line)
      if (r.lastToolName) input.onProgress?.(r.lastToolName)
      if (r.toolUse) input.onToolUse?.(r.toolUse)
      if (r.toolResult) input.onToolResult?.(r.toolResult)
      if (r.textChunk) input.onTextChunk?.(r.textChunk)
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      killCliProcessTree(child, input.label)
      // spawn 后的错误（如命令不存在触发 ENOENT）
      const msg = err instanceof Error ? err.message : String(err)
      resolve({
        ok: false,
        summary: input.signal?.aborted
          ? `(${input.label} 已停止)`
          : timedOut
            ? `(${input.label} 超时 ${Math.round(timeoutMs / 1000)}s，已强制结束进程)`
            : `${input.label} 执行错误: ${msg}`,
        toolCalls: observer.getToolCallCount(),
        durationMs: Date.now() - startTime,
        exitCode: null,
      })
    })

    // child 退出 + stdout 行全部 drain 后再收口（两事件都到位才 finalize，
    // 顺序不固定，故各自置位后再调 finalize，避免漏触发挂起 promise）
    child.on('close', (code) => {
      childClosed = true
      capturedExitCode = code
      finalize()
    })
    rl.on('close', () => {
      rlClosed = true
      finalize()
    })
  })
}
