/**
 * runOpencodeWorker：spawn 本机 opencode 执行子任务，逐行喂 OpencodeStreamObserver（经 runNdjsonCli）。
 *
 * 命令：
 *   {bin} run --format json --auto --dir <cwd> [-m <model>] <prompt>
 *
 * 不加 `--share`（默认即不分享；显式关掉分享语义）。
 *
 * 投递决策（Windows 优先绕开 cmd.exe /c 对 prompt 的重分词，对齐 codex）：
 * - 长 prompt / 含换行 → stdin（opencode run 支持从 stdin 读 prompt）
 * - 直 spawn（unix / win .exe）且短 prompt → prompt 作 argv 末位
 * - Windows .cmd / bare 兜底 → stdin（cmd / c 不碰 prompt，避免重分词）
 *
 * opencode 本机为 npm 全局 shim → `AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`（实测 .exe），
 * 故 Windows 常走 .exe 直 spawn（prompt 作 argv 末位安全）；.cmd shim 兜底走 stdin。
 * 未传 model → 不加 -m（用 opencode 默认）；传则 -m <model>。
 *
 * 本机 0 凭据 / 限流时 observer 会收到 `error` 事件 → runNdjsonCli finalize 据其 getError() 判 ok:false（不算实现失败）。
 */
import type { CliWorkerEntry } from '@tagent/shared'
import {
  isLongOrMultiline,
  runNdjsonCli,
  resolveCliBin,
  type CliToolResultHit,
  type CliToolUseHit,
  type NdjsonSpawnPlan,
  type RunCliWorkerResult,
} from './run-ndjson-cli'
import { OpencodeStreamObserver } from './opencode-stream-observer'

export interface RunOpencodeWorkerInput {
  worker: CliWorkerEntry
  prompt: string
  cwd: string
  signal?: AbortSignal
  onProgress?: (lastToolName: string) => void
  onToolUse?: (t: CliToolUseHit) => void
  onToolResult?: (t: CliToolResultHit) => void
  onTextChunk?: (text: string) => void
}

/** 组装 opencode 标志（不含 prompt；prompt 按投递方式末位追加或走 stdin） */
function buildOpencodeArgs(worker: CliWorkerEntry, cwd: string): string[] {
  const args = ['run', '--format', 'json', '--auto', '--dir', cwd]
  const model = worker.defaultModel?.trim()
  if (model) args.push('-m', model)
  return args
}

/** 组装 spawn 计划（投递决策：长/多行或 .cmd → stdin；否则 argv 末位） */
function planOpencodeSpawn(worker: CliWorkerEntry, prompt: string, cwd: string): NdjsonSpawnPlan {
  const rb = resolveCliBin(worker.bin)
  const baseArgs = [...rb.cmdPrefix, ...buildOpencodeArgs(worker, cwd)]
  // 直 spawn（unix / win .exe）且短 prompt → argv 末位；否则 stdin
  const useStdin = isLongOrMultiline(prompt) || !rb.directSpawn
  if (!useStdin) {
    return { command: rb.command, args: [...baseArgs, prompt], delivery: 'argv' }
  }
  return { command: rb.command, args: baseArgs, delivery: 'stdin' }
}

export async function runOpencodeWorker(input: RunOpencodeWorkerInput): Promise<RunCliWorkerResult> {
  const plan = planOpencodeSpawn(input.worker, input.prompt, input.cwd)
  console.log(
    `[cli-worker] opencode spawn command=${plan.command} argsCount=${plan.args.length} promptChars=${input.prompt.length} delivery=${plan.delivery}`,
  )
  return runNdjsonCli({
    label: 'opencode',
    plan,
    prompt: input.prompt,
    cwd: input.cwd,
    signal: input.signal,
    observer: new OpencodeStreamObserver(),
    onProgress: input.onProgress,
    onToolUse: input.onToolUse,
    onToolResult: input.onToolResult,
    onTextChunk: input.onTextChunk,
  })
}
