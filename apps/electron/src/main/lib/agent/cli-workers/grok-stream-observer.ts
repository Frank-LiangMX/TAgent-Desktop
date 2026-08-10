/**
 * grok streaming-json 行解析 observer（纯函数 / 无 IO）。
 *
 * grok `-p ... --always-approve --output-format streaming-json` 逐行输出 NDJSON，
 * 顶层 `type`：available_commands / thought / text / tool_call / tool_call_update / usage / end。
 *
 * 映射到通用增量（喂 runNdjsonCli → 详情页 parentToolUseId 消息）：
 * - text → textChunk（+ 累积进 summary，即最终答案）
 * - thought → 暂不透传（推理分片；只有 onTextChunk 一类回调，混入会污染流式 partial 与摘要，故忽略）
 * - tool_call → toolUse（id=toolCallId / name=toolName / input=rawInput）+ lastToolName + 计数
 * - tool_call_update(status=completed, rawOutput!=null) → toolResult（content=JSON.stringify(rawOutput)）
 * - available_commands / usage / end → 忽略（end 的 usage/cost 不影响 ok/summary，由进程退出码驱动）
 */

import type { CliLineHit, CliStreamObserver } from './run-ndjson-cli'

/** grok streaming-json 单行解析累积器 */
export class GrokStreamObserver implements CliStreamObserver {
  private readonly textChunks: string[] = []
  private toolCallCount = 0

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
      data?: unknown
      toolCallId?: unknown
      toolName?: unknown
      rawInput?: unknown
      status?: unknown
      rawOutput?: unknown
    }

    if (e.type === 'text' && typeof e.data === 'string') {
      this.textChunks.push(e.data)
      return { textChunk: e.data }
    }
    if (e.type === 'thought') {
      // 推理分片：不计入摘要、不透传 onTextChunk（避免污染流式 partial）
      return {}
    }
    if (e.type === 'tool_call' && typeof e.toolName === 'string') {
      this.toolCallCount++
      const id =
        typeof e.toolCallId === 'string' && e.toolCallId.trim()
          ? e.toolCallId
          : `grok-tool-${this.toolCallCount}`
      const input =
        e.rawInput && typeof e.rawInput === 'object' && !Array.isArray(e.rawInput)
          ? (e.rawInput as Record<string, unknown>)
          : {}
      return {
        lastToolName: e.toolName,
        toolUse: { id, name: e.toolName, input },
      }
    }
    if (e.type === 'tool_call_update') {
      if (e.status !== 'completed' || e.rawOutput == null) return {}
      const toolUseId =
        typeof e.toolCallId === 'string' && e.toolCallId.trim() ? e.toolCallId : ''
      if (!toolUseId) return {}
      let content: string
      if (typeof e.rawOutput === 'string') {
        content = e.rawOutput
      } else {
        try {
          content = JSON.stringify(e.rawOutput)
        } catch {
          content = String(e.rawOutput)
        }
      }
      return { toolResult: { toolUseId, content } }
    }
    return {}
  }

  getSummary(): string {
    return this.textChunks.join('')
  }

  getToolCallCount(): number {
    return this.toolCallCount
  }
}
