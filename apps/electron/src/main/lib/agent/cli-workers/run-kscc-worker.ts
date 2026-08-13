/**
 * runKsccWorker：spawn 本机 kscc 执行子任务，逐行喂 KsccStreamObserver。
 *
 * 命令：
 *   {bin} -p --bare --dangerously-skip-permissions --output-format stream-json --verbose
 *         [--model {model}] {prompt}
 *
 * - 逐行读 stdout → observer；observer 检出 tool_use → onProgress(lastToolName)
 * - abort → kill 子进程（结果 ok:false，status 交调用方判 stopped）
 * - exit !== 0 且无 summary → ok:false，summary 含 stderr 尾部
 * - exit === 0（或虽非 0 但已拿到 summary）→ ok:true，summary 取 observer.getSummary()
 *
 * Windows prompt 投递（避免 cmd.exe /c 重分词）：
 * - 实测 `cmd.exe /c kscc ... <prompt>` 会把 prompt 拆词（短句 `Reply with exactly: PING_OK`
 *   经 cmd 后 kscc 只看到 `Reply`），故 Windows 优先绕开 cmd 对 prompt 的接触。
 * - bare 名 → resolveBinOnPath 解析出 kscc.cmd 绝对路径 → planKsccWindowsSpawn 直连
 *   node + cli-wrapper（argv 不被分词，prompt 作 argv 末位安全）。
 * - 无 cli-wrapper（如独立 kscc.exe 分发）→ cmd.exe /c <abs> <flags>，prompt 走 stdin
 *   （cmd 只见无空格的 flag，不再重分词）。
 * - 长 prompt（>4000）或含换行 → 一律 stdin（避开 argv 长度上限与换行问题）。
 * - 寒暄软失败：ok 且 toolCalls===0 且 summary 命中开场白 → ok:false（疑似 prompt 未送达）。
 *
 * 非 Windows：保持 spawn(bin, args)（argv 末位 prompt 安全）。
 *
 * 测试不在默认路径真 spawn；observer 单测覆盖解析。可选 RUN_KSCC_LIVE=1 才 live 测。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createInterface } from 'node:readline'
import { KsccStreamObserver } from './kscc-stream-observer'
import { planKsccWindowsSpawn } from '../../adapters/shared/kscc-windows-spawn'
import { resolveBinOnPath } from './resolve-bin-on-path'
import {
  DEFAULT_CLI_WORKER_TIMEOUT_MS,
  killCliProcessTree,
} from './kill-cli-process'

export interface RunKsccWorkerInput {
  /** kscc 可执行名或绝对路径 */
  bin: string
  /** 模型 id（如 'glm-5.2'），省略走 kscc 默认 */
  model?: string
  /** 子任务 prompt（已含角色 system + 任务） */
  prompt: string
  /** 子进程工作目录 */
  cwd: string
  /** 所属主会话：登记后台进程 */
  sessionId?: string
  /** 取消信号；abort → kill 进程树 */
  signal?: AbortSignal
  /**
   * 最长运行时间（ms）；超时强制杀进程树。
   * 默认 20 分钟；`0` 表示不超时。
   */
  timeoutMs?: number
  /** tool_use 进度回调（转 task_progress.lastToolName） */
  onProgress?: (lastToolName: string) => void
  /** 详情页：工具调用（parentToolUseId 消息由调用方组装） */
  onToolUse?: (t: { id: string; name: string; input: Record<string, unknown> }) => void
  /** 详情页：工具结果 */
  onToolResult?: (t: { toolUseId: string; content: string; isError?: boolean }) => void
  /** 详情页：assistant 文本增量（可选） */
  onTextChunk?: (text: string) => void
}

export interface RunKsccWorkerResult {
  /** 是否拿到正常结果（exit 0 或已收口 summary 且未 abort） */
  ok: boolean
  /** kscc 摘要（observer.getSummary），失败时含 stderr 尾部 */
  summary: string
  /** 工具调用次数 */
  toolCalls: number
  /** 总耗时 ms */
  durationMs: number
  /** 子进程退出码（被 kill / spawn 失败为 null） */
  exitCode: number | null
}

/** prompt 超过此长度（或含换行）→ 走 stdin，避开 argv 长度上限与换行问题 */
const PROMPT_STDIN_THRESHOLD = 4000

/** prompt 投递方式：argv 末位（node 直连 / .exe 直 spawn 安全）或 stdin（cmd 兜底 / 长 prompt） */
type PromptDelivery = 'argv' | 'stdin'

interface SpawnPlan {
  command: string
  /** 不含 prompt 的 argv；argv 投递时由调用方追加 prompt 到末位 */
  args: string[]
  /** 命令通道：node（planKsccWindowsSpawn 直连）/ exe（直接 spawn .exe）/ cmd（cmd.exe /c 兜底）/ unix */
  via: 'node' | 'exe' | 'cmd' | 'unix'
  /** prompt 作 argv 末位是否安全（cmd / c 兜底为 false，避免 cmd 重分词） */
  promptSafeInArgv: boolean
}

/** 组装 kscc argv 标志（不含 bin、不含 prompt；prompt 由调用方按投递方式追加或走 stdin） */
function buildFlags(input: RunKsccWorkerInput): string[] {
  const args = [
    '-p',
    '--bare',
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ]
  if (input.model) args.push('--model', input.model)
  return args
}

/** 含路径分隔符或盘符 → 视作路径而非 bare 名 */
function isBareName(bin: string): boolean {
  return !bin.includes('/') && !bin.includes('\\') && !/^[A-Za-z]:/.test(bin)
}

/**
 * 规划 spawn 命令（Windows 优先绕开 cmd.exe /c 对 prompt 的重分词）。
 *
 * - 非 Windows：直跑 bin，prompt 作 argv 末位安全。
 * - Windows .cmd：优先 planKsccWindowsSpawn 直连 node + cli-wrapper（argv 安全）；
 *   无 cli-wrapper → cmd.exe /c <abs .cmd> <flags>，prompt 必须走 stdin（promptSafeInArgv=false）。
 * - Windows .exe：直接 spawn（不经 shell），prompt 作 argv 末位安全。
 * - bare 名解析失败 → cmd.exe /c <bare> <flags>，prompt 走 stdin。
 */
function planSpawnCommand(bin: string, flagsArgs: string[]): SpawnPlan {
  if (process.platform !== 'win32') {
    return { command: bin, args: flagsArgs, via: 'unix', promptSafeInArgv: true }
  }
  const resolved = isBareName(bin) ? (resolveBinOnPath(bin) ?? bin) : bin
  if (/\.cmd$/i.test(resolved)) {
    const direct = planKsccWindowsSpawn(resolved, flagsArgs)
    if (direct) return { command: direct.command, args: direct.args, via: 'node', promptSafeInArgv: true }
    // .cmd 无 cli-wrapper → 只能 cmd / c；prompt 走 stdin，勿入 argv
    return { command: 'cmd.exe', args: ['/c', resolved, ...flagsArgs], via: 'cmd', promptSafeInArgv: false }
  }
  if (/\.exe$/i.test(resolved)) {
    // 直接 spawn .exe（Node → OS，不经 shell），argv 不被分词
    return { command: resolved, args: flagsArgs, via: 'exe', promptSafeInArgv: true }
  }
  // bare 名解析失败或无扩展 → cmd / c 兜底，prompt 走 stdin
  return { command: 'cmd.exe', args: ['/c', resolved, ...flagsArgs], via: 'cmd', promptSafeInArgv: false }
}

/**
 * 寒暄开场白检测：kscc 未执行任务、只回「请告诉我…」/「What would you like」时判软失败。
 * 命中即由调用方改 ok:false，避免把开场白当成功结果回主 Agent / 入口卡。
 */
function isGreetingSummary(summary: string): boolean {
  if (!summary) return false
  return (
    /请告诉我你需要做/.test(summary) ||
    /请告诉我您需要/.test(summary) ||
    /请告诉我你需要什么帮助/.test(summary) ||
    /What would you like/i.test(summary)
  )
}

/** stderr 缓冲尾部（失败摘要用），截 2000 字防溢出 */
function tailStderr(chunks: string[]): string {
  return chunks.join('').trim().slice(-2000)
}

/**
 * spawn 并跑 kscc；resolve 一次性返回结果（无论成功 / 失败 / abort 都不抛）。
 *
 * 失败语义（ok:false）：
 * - abort（signal.aborted）
 * - spawn 抛错（命令解析失败等）
 * - child 'error' 事件
 * - exit !== 0 且 observer 无 summary → summary 含 stderr 尾
 */
export async function runKsccWorker(
  input: RunKsccWorkerInput,
): Promise<RunKsccWorkerResult> {
  const startTime = Date.now()
  const observer = new KsccStreamObserver()

  // 已取消：不起进程，直接 stopped
  if (input.signal?.aborted) {
    return { ok: false, summary: '(kscc 已停止)', toolCalls: 0, durationMs: Date.now() - startTime, exitCode: null }
  }

  const flagsArgs = buildFlags(input)
  const plan = planSpawnCommand(input.bin, flagsArgs)

  // 投递方式：长 prompt / 含换行 → stdin；否则 argv 安全 → 末位；argv 不安全（cmd 兜底）→ 强制 stdin
  const forceStdin = input.prompt.length > PROMPT_STDIN_THRESHOLD || input.prompt.includes('\n')
  let delivery: PromptDelivery
  if (forceStdin || !plan.promptSafeInArgv) {
    delivery = 'stdin'
  } else {
    delivery = 'argv'
    plan.args = [...plan.args, input.prompt]
  }

  // spawn 前日志一行（勿打全文 prompt，仅字符数）
  console.log(
    `[cli-worker] spawn command=${plan.command} argsCount=${plan.args.length} promptChars=${input.prompt.length} via=${plan.via} delivery=${delivery}`,
  )

  const spawnOpts: SpawnOptions = {
    cwd: input.cwd,
    stdio: delivery === 'stdin' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  }

  let child: ChildProcess
  try {
    child = spawn(plan.command, plan.args, spawnOpts)
    if (input.sessionId) {
      const { trackSessionProcess } = await import('../session-process-registry')
      trackSessionProcess({
        sessionId: input.sessionId,
        command: `kscc ${plan.command}`.trim(),
        source: 'cli-worker',
        pid: child.pid,
        child,
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      summary: `kscc spawn 失败: ${msg}`,
      toolCalls: 0,
      durationMs: Date.now() - startTime,
      exitCode: null,
    }
  }

  // stdin 投递：把 prompt 喂进子进程 stdin（cmd / c 不再碰 prompt，避免重分词）。
  // kscc `-p` 无位置 prompt 时从 stdin 读 text（--input-format text 默认，已实测）。
  if (delivery === 'stdin') {
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

  // abort / 超时 → 杀进程树（Windows 含 cmd 孙进程）
  const onAbort = (): void => {
    killCliProcessTree(child, 'kscc')
  }
  if (input.signal) input.signal.addEventListener('abort', onAbort, { once: true })

  const timeoutMs =
    typeof input.timeoutMs === 'number' ? input.timeoutMs : DEFAULT_CLI_WORKER_TIMEOUT_MS
  let timedOut = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      console.warn(`[kscc] 超过 ${timeoutMs}ms，强制结束进程树`)
      killCliProcessTree(child, 'kscc')
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

  return new Promise<RunKsccWorkerResult>((resolve) => {
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
    }

    const finalize = (): void => {
      if (settled || !childClosed || !rlClosed) return
      settled = true
      cleanup()
      const exitCode = capturedExitCode
      const durationMs = Date.now() - startTime
      const toolCalls = observer.getToolCallCount()
      const observerSummary = observer.getSummary()
      const stderr = tailStderr(stderrChunks)
      const wasAborted = input.signal?.aborted === true

      let ok: boolean
      let summary: string
      if (wasAborted) {
        ok = false
        summary = observerSummary || '(kscc 已停止)'
      } else if (timedOut) {
        ok = false
        summary =
          observerSummary ||
          `(kscc 超时 ${Math.round(timeoutMs / 1000)}s，已强制结束进程)`
      } else if (exitCode === 0) {
        ok = true
        summary = observerSummary || stderr || '(kscc 无输出)'
      } else if (observerSummary) {
        // exit !== 0 但已收口摘要 → 视为拿到结果（个别 CLI 尾部告警）
        ok = true
        summary = observerSummary
      } else {
        ok = false
        summary = stderr ? `kscc 退出码 ${exitCode}: ${stderr}` : `kscc 退出码 ${exitCode}`
      }

      // 寒暄软失败：看似成功（ok）但未调用工具（toolCalls===0）且 summary 命中开场白
      // → 判 prompt 未送达，改 ok:false 并前缀说明，便于主 Agent / 入口卡显示失败。
      if (ok && toolCalls === 0 && isGreetingSummary(summary)) {
        ok = false
        summary = `[cli-worker] kscc 未执行任务（疑似 prompt 未送达）: ${summary}`
      }

      resolve({
        ok,
        summary,
        toolCalls,
        durationMs,
        exitCode,
      })
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
      // 异常时再尝试收尸，防半吊子进程
      killCliProcessTree(child, 'kscc')
      // spawn 后的错误（如命令不存在触发 ENOENT）
      const msg = err instanceof Error ? err.message : String(err)
      resolve({
        ok: false,
        summary: input.signal?.aborted
          ? '(kscc 已停止)'
          : timedOut
            ? `(kscc 超时 ${Math.round(timeoutMs / 1000)}s，已强制结束进程)`
            : `kscc 执行错误: ${msg}`,
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
