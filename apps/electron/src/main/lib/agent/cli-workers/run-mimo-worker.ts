/**
 * runMimoWorker：spawn 本机 mimo 执行子任务，逐行喂 MimoStreamObserver（经 runNdjsonCli）。
 *
 * 命令：
 *   {bin} run --dangerously-skip-permissions --format json [-m <model>] --dir <cwd> <prompt>
 *
 * 投递决策：mimo 本机为 .exe（~/.mimocode/bin/mimo.exe），直 spawn（不经 shell），
 * prompt 作 argv 末位安全（多行 prompt 作为单 argv 元素原样传递，不被分词）。
 * 故 mimo 始终走 argv 位置参数（不像 grok/codex 需 --prompt-file/stdin 兜底）。
 * 极端情况：若 mimo 解析为 .cmd / bare 兜底（非 .exe，通常意味着未正确安装），
 * cmd / c 会拆多行 prompt —— 此分支下 spawn 多半 ENOENT 兜底，记为已知限制。
 *
 * 未传 model → 不加 -m（用 mimo 默认）；传则 -m <model>。
 */
import type { CliWorkerEntry } from '@tagent/shared'
import {
  runNdjsonCli,
  resolveCliBin,
  type CliToolResultHit,
  type CliToolUseHit,
  type NdjsonSpawnPlan,
  type RunCliWorkerResult,
} from './run-ndjson-cli'
import { MimoStreamObserver } from './mimo-stream-observer'

export interface RunMimoWorkerInput {
  worker: CliWorkerEntry
  prompt: string
  cwd: string
  signal?: AbortSignal
  onProgress?: (lastToolName: string) => void
  onToolUse?: (t: CliToolUseHit) => void
  onToolResult?: (t: CliToolResultHit) => void
  onTextChunk?: (text: string) => void
}

/** 组装 mimo 标志 + prompt（prompt 作 argv 末位） */
function buildMimoArgs(worker: CliWorkerEntry, cwd: string, prompt: string): string[] {
  const args = ['run', '--dangerously-skip-permissions', '--format', 'json']
  const model = worker.defaultModel?.trim()
  if (model) args.push('-m', model)
  args.push('--dir', cwd)
  args.push(prompt)
  return args
}

/** 组装 spawn 计划（mimo 始终 argv 位置参数） */
function planMimoSpawn(worker: CliWorkerEntry, prompt: string, cwd: string): NdjsonSpawnPlan {
  const rb = resolveCliBin(worker.bin)
  const args = [...rb.cmdPrefix, ...buildMimoArgs(worker, cwd, prompt)]
  return { command: rb.command, args, delivery: 'argv' }
}

export async function runMimoWorker(input: RunMimoWorkerInput): Promise<RunCliWorkerResult> {
  const plan = planMimoSpawn(input.worker, input.prompt, input.cwd)
  console.log(
    `[cli-worker] mimo spawn command=${plan.command} argsCount=${plan.args.length} promptChars=${input.prompt.length} delivery=${plan.delivery}`,
  )
  return runNdjsonCli({
    label: 'mimo',
    plan,
    prompt: input.prompt,
    cwd: input.cwd,
    signal: input.signal,
    observer: new MimoStreamObserver(),
    onProgress: input.onProgress,
    onToolUse: input.onToolUse,
    onToolResult: input.onToolResult,
    onTextChunk: input.onTextChunk,
  })
}
