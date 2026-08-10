/**
 * codex exec --json 行解析 observer（纯函数 / 无 IO）。
 *
 * codex `exec --skip-git-repo-check --ephemeral -s read-only --json` 逐行输出 NDJSON，
 * 顶层 `type`：thread.started / turn.started / item.started / item.completed / turn.completed。
 *
 * 映射到通用增量（喂 runNdjsonCli → 详情页 parentToolUseId 消息）：
 * - item.started(type=command_execution) → toolUse（id=item.id / name='command_execution' / input={command}）+ lastToolName + 计数
 * - item.completed(type=command_execution) → toolResult（content=aggregated_output，status=failed → isError）
 * - item.completed(type=agent_message) → textChunk（= item.text）+ 累积进 summary
 * - thread.started / turn.started / turn.completed → 忽略（turn.completed 的 usage 不影响 ok/summary）
 *
 * codex 的「工具」是 shell 命令（command_execution），无命名工具概念，故 name 固定 'command_execution'，
 * 真实命令放 input.command；详情页按 name+input 渲染。
 */

import type { CliLineHit, CliStreamObserver } from './run-ndjson-cli'

/** codex exec --json 单行解析累积器 */
export class CodexStreamObserver implements CliStreamObserver {
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
      item?: {
        id?: unknown
        type?: unknown
        text?: unknown
        command?: unknown
        aggregated_output?: unknown
        status?: unknown
      }
    }

    if (e.type === 'item.started') {
      const item = e.item
      if (item && item.type === 'command_execution') {
        this.toolCallCount++
        const id =
          typeof item.id === 'string' && item.id.trim() ? item.id : `codex-tool-${this.toolCallCount}`
        const command = typeof item.command === 'string' ? item.command : ''
        return {
          lastToolName: 'command_execution',
          toolUse: { id, name: 'command_execution', input: { command } },
        }
      }
      return {}
    }
    if (e.type === 'item.completed') {
      const item = e.item
      if (!item) return {}
      if (item.type === 'command_execution') {
        const toolUseId =
          typeof item.id === 'string' && item.id.trim() ? item.id : ''
        if (!toolUseId) return {}
        const content = typeof item.aggregated_output === 'string' ? item.aggregated_output : ''
        const isError = item.status === 'failed'
        return {
          toolResult: {
            toolUseId,
            content,
            ...(isError ? { isError: true } : {}),
          },
        }
      }
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        this.textChunks.push(item.text)
        return { textChunk: item.text }
      }
      return {}
    }
    // thread.started / turn.started / turn.completed → 忽略
    return {}
  }

  getSummary(): string {
    return this.textChunks.join('')
  }

  getToolCallCount(): number {
    return this.toolCallCount
  }
}
