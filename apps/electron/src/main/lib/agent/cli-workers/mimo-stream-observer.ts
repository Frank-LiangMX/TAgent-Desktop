/**
 * mimo run --format json 行解析 observer（纯函数 / 无 IO）。
 *
 * mimo `run --dangerously-skip-permissions --format json` 逐行输出 NDJSON，
 * 顶层 `type`：step_start / text / tool_use / step_finish。
 *
 * 映射到通用增量（喂 runNdjsonCli → 详情页 parentToolUseId 消息）：
 * - text → textChunk（= part.text）+ 累积进 summary
 * - tool_use → 一条 completed 时同时带 input+output（brief：tool_use 可能一条 completed）：
 *   - 新 callID → toolUse（id=callID / name=part.tool / input=state.input）+ lastToolName + 计数
 *   - 终态（status=completed/failed）→ toolResult（content=state.output，failed → isError）
 *   - 按 callID 去重：两段式（先 in_progress 后 completed）不重复计数，仅补 toolResult
 * - step_start / step_finish → 忽略（step_finish 的 tokens/cost 不影响 ok/summary）
 */

import type { CliLineHit, CliStreamObserver } from './run-ndjson-cli'

/** mimo run --format json 单行解析累积器 */
export class MimoStreamObserver implements CliStreamObserver {
  private readonly textChunks: string[] = []
  private toolCallCount = 0
  private readonly seenCallIds = new Set<string>()

  onLine(line: string): CliLineHit {
    const trimmed = line.trim()
    if (!trimmed) return {}
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      return {}
    }
    if (!obj || typeof obj !== 'object') return {}
    const e = obj as {
      type?: string
      part?: {
        text?: unknown
        tool?: unknown
        callID?: unknown
        state?: {
          status?: unknown
          input?: unknown
          output?: unknown
        }
      }
    }

    if (e.type === 'text') {
      const text = e.part?.text
      if (typeof text === 'string') {
        this.textChunks.push(text)
        return { textChunk: text }
      }
      return {}
    }

    if (e.type === 'tool_use') {
      const part = e.part
      if (!part || typeof part.tool !== 'string') return {}
      const callID =
        typeof part.callID === 'string' && part.callID.trim()
          ? part.callID
          : `mimo-tool-${this.toolCallCount + 1}`
      const state = part.state ?? {}
      const status = state.status
      const hit: CliLineHit = {}

      if (!this.seenCallIds.has(callID)) {
        this.seenCallIds.add(callID)
        this.toolCallCount++
        hit.lastToolName = part.tool
        const input =
          state.input && typeof state.input === 'object' && !Array.isArray(state.input)
            ? (state.input as Record<string, unknown>)
            : {}
        hit.toolUse = { id: callID, name: part.tool, input }
      }

      if (status === 'completed' || status === 'failed') {
        const output = state.output
        let content: string
        if (typeof output === 'string') {
          content = output
        } else if (output != null) {
          try {
            content = JSON.stringify(output)
          } catch {
            content = String(output)
          }
        } else {
          content = ''
        }
        hit.toolResult = {
          toolUseId: callID,
          content,
          ...(status === 'failed' ? { isError: true } : {}),
        }
      }
      return hit
    }

    // step_start / step_finish → 忽略
    return {}
  }

  getSummary(): string {
    return this.textChunks.join('')
  }

  getToolCallCount(): number {
    return this.toolCallCount
  }
}
