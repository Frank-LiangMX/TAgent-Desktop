/**
 * opencode run --format json 行解析 observer（纯函数 / 无 IO）。
 *
 * opencode `run --format json --auto` 逐行输出 NDJSON，
 * 顶层 `type`：step_start / text / tool_use / step_finish / error。
 *
 * 协议与 mimo 同族（Mimo/OpenCode 风格 part 协议，见 cli-probe FINDINGS），但有三处差异：
 * - `text` 事件：`part` 是**纯字符串**文本块（mimo 为 `part.text`）→ `textChunk` + 累积 summary。
 * - `tool_use` 事件：
 *   - `part.tool` 映射到 UI 分类（bash/shell→command、edit/write/multiedit→file、
 *     read/glob/grep→tool、websearch/webfetch→web_search、task→tool）。
 *   - 调用 id 为 `part.id`（mimo 为 `part.callID`），缺省合成 `opencode-tool-N`。
 *   - `state.status=pending` → **整条忽略**（不计数、不 lastToolName、不 toolResult，避免进度闪烁）；
 *     `completed`/`failed`/`error` → 首次见该 id 时 计数 + lastToolName + toolUse，终态再补 toolResult
 *     （content=state.output 字符串/对象 JSON 化，缺省 ''；failed/error → isError）。
 *   - 按 id 去重：两段式（pending→completed）不重复计数，仅 completed 触发。
 * - `error` 事件：`{"type":"error","error":{"name":...,"data":{"message":...}}}` → 记录错误信息，
 *   `getError()` 返回 `name + message`，**不混入** textChunk summary（runNdjsonCli 据此判 ok:false）。
 *
 * `step_start` / `step_finish` → 忽略（tokens/cost 不影响 ok/summary）。
 *
 * 本机 0 凭据 / 限流是外部状态：observer 只如实解析 error 事件，不依赖真实 opencode 调用。
 */

import type { CliLineHit, CliStreamObserver } from './run-ndjson-cli'

/** opencode `part.tool` → UI 进度卡分类（未列出者原样透传，保留工具名信息） */
function mapOpencodeToolName(tool: string): string {
  switch (tool) {
    case 'bash':
    case 'shell':
      return 'command'
    case 'edit':
    case 'write':
    case 'multiedit':
      return 'file'
    case 'read':
    case 'glob':
    case 'grep':
      return 'tool'
    case 'websearch':
    case 'webfetch':
      return 'web_search'
    case 'task':
      return 'tool'
    default:
      return tool
  }
}

/** 把 state.output（字符串 / 对象 / 缺省）规整为 toolResult.content */
function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output != null) {
    try {
      return JSON.stringify(output)
    } catch {
      return String(output)
    }
  }
  return ''
}

/** opencode run --format json 单行解析累积器 */
export class OpencodeStreamObserver implements CliStreamObserver {
  private readonly textChunks: string[] = []
  private toolCallCount = 0
  private readonly seenIds = new Set<string>()
  private errorMessage: string | undefined

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
      part?: unknown
      error?: { name?: unknown; data?: unknown }
    }

    if (e.type === 'text') {
      // opencode text 事件：part 是纯字符串文本块（非逐字符对象）
      const text = e.part
      if (typeof text === 'string') {
        this.textChunks.push(text)
        return { textChunk: text }
      }
      return {}
    }

    if (e.type === 'tool_use') {
      const part = e.part as
        | {
            tool?: unknown
            id?: unknown
            state?: { status?: unknown; input?: unknown; output?: unknown }
          }
        | undefined
      if (!part || typeof part.tool !== 'string') return {}
      const mappedTool = mapOpencodeToolName(part.tool)
      const id =
        typeof part.id === 'string' && part.id.trim()
          ? part.id
          : `opencode-tool-${this.toolCallCount + 1}`
      const state = part.state ?? {}
      const status = state.status
      // pending（及其它非终态）→ 整条忽略，避免进度闪烁
      if (status !== 'completed' && status !== 'failed' && status !== 'error') return {}

      const hit: CliLineHit = {}
      if (!this.seenIds.has(id)) {
        this.seenIds.add(id)
        this.toolCallCount++
        hit.lastToolName = mappedTool
        const input =
          state.input && typeof state.input === 'object' && !Array.isArray(state.input)
            ? (state.input as Record<string, unknown>)
            : {}
        hit.toolUse = { id, name: mappedTool, input }
      }

      // 终态 → toolResult（failed/error → isError）
      const isError = status === 'failed' || status === 'error'
      hit.toolResult = {
        toolUseId: id,
        content: stringifyOutput(state.output),
        ...(isError ? { isError: true } : {}),
      }
      return hit
    }

    if (e.type === 'error') {
      // {"type":"error","error":{"name":...,"data":{"message":...}}} → 记录 name + message，不混入 summary
      const err = e.error
      if (err && typeof err === 'object') {
        const name = typeof err.name === 'string' ? err.name : ''
        const data = err.data
        const message =
          typeof data === 'string'
            ? data
            : data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
              ? (data as { message: string }).message
              : ''
        const parts: string[] = []
        if (name) parts.push(name)
        if (message) parts.push(message)
        const combined = parts.join(': ')
        if (combined) this.errorMessage = combined
      }
      return {}
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

  getError(): string | undefined {
    return this.errorMessage
  }
}
