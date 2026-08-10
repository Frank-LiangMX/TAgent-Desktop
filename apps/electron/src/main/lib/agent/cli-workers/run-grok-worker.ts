/**
 * runGrokWorker：spawn 本机 grok 执行子任务，逐行喂 GrokStreamObserver（经 runNdjsonCli）。
 *
 * 命令：
 *   {bin} -p <prompt> --always-approve --output-format streaming-json [--model <model>]
 *   长 prompt / 含换行 → --prompt-file <临时文件>（grok 原生支持，brief 指定）
 *
 * 投递决策（Windows 优先绕开 cmd.exe /c 对 prompt 的重分词）：
 * - 长 prompt / 含换行 → --prompt-file（临时文件，避开 argv 长度上限与换行问题）
 * - 直 spawn（unix / win .exe）→ -p <prompt> 作 argv（node 直连 / .exe 直 spawn 不被分词）
 * - Windows .cmd / bare 兜底 → --prompt-file（cmd / c 不碰 prompt 文件路径以外，避免重分词）
 *
 * grok 本机为 .exe（~/.grok/bin/grok.exe），故常走 -p argv；子代理 prompt 含换行 → 走 --prompt-file。
 * 未传 model → 不加 --model（用 grok 默认）。
 */
import type { CliWorkerEntry } from '@tagent/shared'
import {
  isLongOrMultiline,
  runNdjsonCli,
  resolveCliBin,
  writePromptTempFile,
  type CliToolResultHit,
  type CliToolUseHit,
  type NdjsonSpawnPlan,
  type RunCliWorkerResult,
} from './run-ndjson-cli'
import { GrokStreamObserver } from './grok-stream-observer'

export interface RunGrokWorkerInput {
  worker: CliWorkerEntry
  prompt: string
  cwd: string
  signal?: AbortSignal
  onProgress?: (lastToolName: string) => void
  onToolUse?: (t: CliToolUseHit) => void
  onToolResult?: (t: CliToolResultHit) => void
  onTextChunk?: (text: string) => void
}

/** 组装 grok 标志（不含 -p/--prompt-file 与 prompt；投递方式由调用方决定后前置） */
function buildFlags(worker: CliWorkerEntry): string[] {
  const args = ['--always-approve', '--output-format', 'streaming-json']
  const model = worker.defaultModel?.trim()
  if (model) args.push('--model', model)
  return args
}

/** 组装 spawn 计划（command/args/delivery/promptFile） */
function planGrokSpawn(worker: CliWorkerEntry, prompt: string): NdjsonSpawnPlan {
  const rb = resolveCliBin(worker.bin)
  const flags = buildFlags(worker)
  const forceFile = isLongOrMultiline(prompt)
  // 直 spawn（unix / win .exe）且短 prompt → -p <prompt> 作 argv；否则 --prompt-file
  const useFile = forceFile || !rb.directSpawn

  if (!useFile) {
    return {
      command: rb.command,
      args: [...rb.cmdPrefix, '-p', prompt, ...flags],
      delivery: 'argv',
    }
  }
  const promptFile = writePromptTempFile('grok', prompt)
  return {
    command: rb.command,
    args: [...rb.cmdPrefix, '--prompt-file', promptFile, ...flags],
    delivery: 'file',
    promptFile,
  }
}

export async function runGrokWorker(input: RunGrokWorkerInput): Promise<RunCliWorkerResult> {
  const plan = planGrokSpawn(input.worker, input.prompt)
  console.log(
    `[cli-worker] grok spawn command=${plan.command} argsCount=${plan.args.length} promptChars=${input.prompt.length} delivery=${plan.delivery}`,
  )
  return runNdjsonCli({
    label: 'grok',
    plan,
    prompt: input.prompt,
    cwd: input.cwd,
    signal: input.signal,
    observer: new GrokStreamObserver(),
    onProgress: input.onProgress,
    onToolUse: input.onToolUse,
    onToolResult: input.onToolResult,
    onTextChunk: input.onTextChunk,
  })
}
