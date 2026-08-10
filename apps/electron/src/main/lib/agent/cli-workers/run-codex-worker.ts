/**
 * runCodexWorker：spawn 本机 codex 执行子任务，逐行喂 CodexStreamObserver（经 runNdjsonCli）。
 *
 * 命令：
 *   {bin} exec --skip-git-repo-check --ephemeral -s read-only --json -C <cwd> <prompt>
 *
 * 投递决策（Windows 勿 cmd 拆 prompt，brief 指定）：
 * - 长 prompt / 含换行 → stdin（codex exec 支持 stdin）
 * - 直 spawn（unix / win .exe）→ prompt 作 argv 末位
 * - Windows .cmd / bare 兜底 → stdin（cmd / c 不碰 prompt，避免重分词）
 *
 * codex 本机为 npm .cmd（%AppData%\Roaming\npm\codex），故 Windows 常走 cmd /c + stdin；
 * 非 Windows 直跑 codex，prompt 作 argv 末位。
 * codex 的模型由其自身配置决定（FINDINGS 模板无 --model），故不传 model 标志。
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
import { CodexStreamObserver } from './codex-stream-observer'

export interface RunCodexWorkerInput {
  worker: CliWorkerEntry
  prompt: string
  cwd: string
  signal?: AbortSignal
  onProgress?: (lastToolName: string) => void
  onToolUse?: (t: CliToolUseHit) => void
  onToolResult?: (t: CliToolResultHit) => void
  onTextChunk?: (text: string) => void
}

/** 组装 codex 标志（不含 prompt；prompt 按投递方式末位追加或走 stdin） */
function buildFlags(cwd: string): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s',
    'read-only',
    '--json',
    '-C',
    cwd,
  ]
}

/** 组装 spawn 计划（command/args/delivery） */
function planCodexSpawn(worker: CliWorkerEntry, prompt: string, cwd: string): NdjsonSpawnPlan {
  const rb = resolveCliBin(worker.bin)
  const flags = buildFlags(cwd)
  const forceStdin = isLongOrMultiline(prompt)
  // 直 spawn（unix / win .exe）且短 prompt → argv 末位；否则 stdin
  const useStdin = forceStdin || !rb.directSpawn

  if (!useStdin) {
    return { command: rb.command, args: [...rb.cmdPrefix, ...flags, prompt], delivery: 'argv' }
  }
  return { command: rb.command, args: [...rb.cmdPrefix, ...flags], delivery: 'stdin' }
}

export async function runCodexWorker(input: RunCodexWorkerInput): Promise<RunCliWorkerResult> {
  const plan = planCodexSpawn(input.worker, input.prompt, input.cwd)
  console.log(
    `[cli-worker] codex spawn command=${plan.command} argsCount=${plan.args.length} promptChars=${input.prompt.length} delivery=${plan.delivery}`,
  )
  return runNdjsonCli({
    label: 'codex',
    plan,
    prompt: input.prompt,
    cwd: input.cwd,
    signal: input.signal,
    observer: new CodexStreamObserver(),
    onProgress: input.onProgress,
    onToolUse: input.onToolUse,
    onToolResult: input.onToolResult,
    onTextChunk: input.onTextChunk,
  })
}
