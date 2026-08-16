/**
 * runCliWorker：CLI 工人统一入口，按 worker.id 路由到对应薄 runner。
 *
 * switch(worker.id)：
 * - kscc → runKsccWorker（自有 spawn/finalize + 寒暄软失败，SLICE-2 既有）
 * - grok → runGrokWorker（经 runNdjsonCli + GrokStreamObserver）
 * - codex → runCodexWorker（经 runNdjsonCli + CodexStreamObserver）
 * - mimo → runMimoWorker（经 runNdjsonCli + MimoStreamObserver）
 * - opencode → runOpencodeWorker（经 runNdjsonCli + OpencodeStreamObserver）
 * - claude → runClaudeWorker（经 runNdjsonCli + ClaudeStreamObserver；与 kscc 同族协议）
 * - 未知 id → ok:false 中文 summary（不 spawn）
 *
 * 调用方（subagent-task-tool）只与此入口交互；详情 emitPayload / 进度回调签名四者一致。
 */
import type { CliWorkerEntry } from '@tagent/shared'
import { SUPPORTED_CLI_WORKER_IDS } from '@tagent/shared'
import { runKsccWorker } from './run-kscc-worker'
import { runGrokWorker } from './run-grok-worker'
import { runCodexWorker } from './run-codex-worker'
import { runMimoWorker } from './run-mimo-worker'
import { runOpencodeWorker } from './run-opencode-worker'
import { runClaudeWorker } from './run-claude-worker'
import type { CliToolResultHit, CliToolUseHit, RunCliWorkerResult } from './run-ndjson-cli'

export interface RunCliWorkerInput {
  worker: CliWorkerEntry
  prompt: string
  cwd: string
  /** 所属主会话：登记后台进程，摘要里可停 */
  sessionId?: string
  signal?: AbortSignal
  onProgress?: (lastToolName: string) => void
  onToolUse?: (t: CliToolUseHit) => void
  onToolResult?: (t: CliToolResultHit) => void
  onTextChunk?: (text: string) => void
}

export async function runCliWorker(input: RunCliWorkerInput): Promise<RunCliWorkerResult> {
  switch (input.worker.id) {
    case 'kscc':
      // kscc 自有 runner（bin/model 单独取，结构同形）
      return runKsccWorker({
        bin: input.worker.bin,
        model: input.worker.defaultModel,
        prompt: input.prompt,
        cwd: input.cwd,
        sessionId: input.sessionId,
        signal: input.signal,
        onProgress: input.onProgress,
        onToolUse: input.onToolUse,
        onToolResult: input.onToolResult,
        onTextChunk: input.onTextChunk,
      })
    case 'grok':
      return runGrokWorker(input)
    case 'codex':
      return runCodexWorker(input)
    case 'mimo':
      return runMimoWorker(input)
    case 'opencode':
      return runOpencodeWorker(input)
    case 'claude':
      return runClaudeWorker(input)
    default:
      return {
        ok: false,
        summary: `[cli-worker] 未知 CLI 工人 id「${input.worker.id}」，无法 spawn（仅支持 ${SUPPORTED_CLI_WORKER_IDS.join(' / ')}）`,
        toolCalls: 0,
        durationMs: 0,
        exitCode: null,
      }
  }
}
