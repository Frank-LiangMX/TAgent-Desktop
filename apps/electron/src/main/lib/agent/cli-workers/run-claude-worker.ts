/**
 * runClaudeWorker：spawn 本机 claude 执行子任务，逐行喂 ClaudeStreamObserver（经 runNdjsonCli）。
 *
 * 命令：
 *   {bin} -p --bare --dangerously-skip-permissions --output-format stream-json --verbose
 *         [--model {model}] <prompt>
 *
 * 与 kscc 同族（kscc 是定制版 Claude Code），flags 一致：
 * - `-p` 无位置 prompt 时从 stdin 读（实测形态，同 codex/kscc 的 stdin 投递）
 * - `--bare` 去掉欢迎/交互界面；`--dangerously-skip-permissions` 全跳过权限确认（子代理无 TTY，
 *   与 kscc/mimo 的免确认语义一致，不阻塞在权限提示上）
 * - `--output-format stream-json --verbose` → 逐行 NDJSON（assistant / user / result）
 *
 * 投递决策（Windows 优先绕开 cmd.exe /c 对 prompt 的重分词，对齐 opencode/codex）：
 * - 长 prompt / 含换行 → stdin（claude -p 支持从 stdin 读 prompt）
 * - 直 spawn（unix / win .exe）且短 prompt → prompt 作 argv 末位
 * - Windows .cmd / bare 兜底 → stdin（cmd /c 不碰 prompt，避免重分词）
 *
 * 本机 0 凭据 / 限流时 observer 会收到 result 事件 is_error:true → runNdjsonCli finalize
 * 据其 getError() 判 ok:false（summary 含错误信息，不算实现失败）。
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
import { ClaudeStreamObserver } from './claude-stream-observer'

export interface RunClaudeWorkerInput {
  worker: CliWorkerEntry
  prompt: string
  cwd: string
  signal?: AbortSignal
  onProgress?: (lastToolName: string) => void
  onToolUse?: (t: CliToolUseHit) => void
  onToolResult?: (t: CliToolResultHit) => void
  onTextChunk?: (text: string) => void
}

/** 组装 claude 标志（不含 prompt；prompt 按投递方式末位追加或走 stdin） */
function buildClaudeArgs(worker: CliWorkerEntry): string[] {
  const args = [
    '-p',
    '--bare',
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ]
  const model = worker.defaultModel?.trim()
  if (model) args.push('--model', model)
  return args
}

/** 组装 spawn 计划（投递决策：长/多行或 .cmd → stdin；否则 argv 末位） */
function planClaudeSpawn(worker: CliWorkerEntry, prompt: string): NdjsonSpawnPlan {
  const rb = resolveCliBin(worker.bin)
  const baseArgs = [...rb.cmdPrefix, ...buildClaudeArgs(worker)]
  const useStdin = isLongOrMultiline(prompt) || !rb.directSpawn
  if (!useStdin) {
    return { command: rb.command, args: [...baseArgs, prompt], delivery: 'argv' }
  }
  return { command: rb.command, args: baseArgs, delivery: 'stdin' }
}

export async function runClaudeWorker(input: RunClaudeWorkerInput): Promise<RunCliWorkerResult> {
  const plan = planClaudeSpawn(input.worker, input.prompt)
  console.log(
    `[cli-worker] claude spawn command=${plan.command} argsCount=${plan.args.length} promptChars=${input.prompt.length} delivery=${plan.delivery}`,
  )
  return runNdjsonCli({
    label: 'claude',
    plan,
    prompt: input.prompt,
    cwd: input.cwd,
    signal: input.signal,
    observer: new ClaudeStreamObserver(),
    onProgress: input.onProgress,
    onToolUse: input.onToolUse,
    onToolResult: input.onToolResult,
    onTextChunk: input.onTextChunk,
  })
}
