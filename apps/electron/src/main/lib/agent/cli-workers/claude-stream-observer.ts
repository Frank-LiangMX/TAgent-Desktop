/**
 * Claude Code `-p --output-format stream-json --verbose` 行解析 observer（纯函数 / 无 IO）。
 *
 * 协议与 kscc 同源（kscc 是定制版 Claude Code），逐行输出 NDJSON：
 * - `{"type":"system","subtype":"init","session_id":"..."}` → 忽略
 * - `{"type":"assistant","message":{"content":[{"type":"text",...},{"type":"tool_use","id":"toolu_..","name":"Bash","input":{...}}]}}`
 *   → 文本块进 textChunk + 累积 summary；tool_use 计数 + lastToolName + toolUse
 * - `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_..","content":"..."}]}}`
 *   → toolResult（回显工具结果）
 * - `{"type":"result","subtype":"success","is_error":false|true,"result":"...","errors":[...]}`
 *   → `result` 字符串为最终摘要；`is_error:true` / subtype 以 error 开头 / errors[] 非空 → getError()
 *
 * 与 kscc observer 的差异：
 * - 忽略 system 事件
 * - 工具名按大小写不敏感映射到 UI 分类（Bash→command、Edit/Write/MultiEdit→file、
 *   Read/Glob/Grep→tool、WebSearch/WebFetch→web_search、Task→tool），未列出者原样透传
 * - result 事件记录错误状态（getError），供 runNdjsonCli 在 exit 0 时也判 ok:false
 *
 * 本机未装 claude：fixture 按 Claude Code stream-json 文档建模，不依赖真实调用。
 */

import type { CliLineHit, CliStreamObserver } from './run-ndjson-cli'

/** Claude Code 工具名（大写）→ UI 进度卡分类；大小写不敏感，兼容器级 kscc 的小写变体 */
function mapClaudeToolName(tool: string): string {
  switch (tool.toLowerCase()) {
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

/** 把 tool_result.content（字符串 / 文本块数组 / 对象）规整为字符串 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && (b as { type?: string }).type === 'text'
          ? String((b as { text?: string }).text ?? '')
          : '',
      )
      .join('')
  }
  if (content != null) {
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return ''
}

/** Claude Code stream-json 单行解析累积器 */
export class ClaudeStreamObserver implements CliStreamObserver {
  private finalText: string | null = null
  private readonly textChunks: string[] = []
  private toolCallCount = 0
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
      subtype?: string
      message?: { content?: unknown }
      result?: unknown
      is_error?: unknown
      errors?: unknown
    }

    if (e.type === 'system') {
      // init / 会话元数据 → 忽略
      return {}
    }
    if (e.type === 'assistant') {
      return this.onAssistant(e.message?.content)
    }
    if (e.type === 'user') {
      return this.onUser(e.message?.content)
    }
    if (e.type === 'result') {
      return this.onResult(e)
    }
    return {}
  }

  private onAssistant(content: unknown): CliLineHit {
    if (!Array.isArray(content)) return {}
    let lastToolName: string | undefined
    let toolUse: CliLineHit['toolUse']
    const texts: string[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const c = item as {
        type?: string
        name?: unknown
        text?: unknown
        id?: unknown
        input?: unknown
      }
      if (c.type === 'tool_use' && typeof c.name === 'string') {
        this.toolCallCount++
        const mapped = mapClaudeToolName(c.name)
        lastToolName = mapped
        const id =
          typeof c.id === 'string' && c.id.trim()
            ? c.id
            : `claude-tool-${this.toolCallCount}`
        const input =
          c.input && typeof c.input === 'object' && !Array.isArray(c.input)
            ? (c.input as Record<string, unknown>)
            : {}
        toolUse = { id, name: mapped, input }
      } else if (c.type === 'text' && typeof c.text === 'string') {
        this.textChunks.push(c.text)
        texts.push(c.text)
      }
    }
    const hit: CliLineHit = {}
    if (lastToolName !== undefined) hit.lastToolName = lastToolName
    if (toolUse) hit.toolUse = toolUse
    if (texts.length > 0) hit.textChunk = texts.join('')
    return hit
  }

  private onUser(content: unknown): CliLineHit {
    if (!Array.isArray(content)) return {}
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const c = item as {
        type?: string
        tool_use_id?: unknown
        toolUseId?: unknown
        content?: unknown
        is_error?: unknown
        isError?: unknown
      }
      if (c.type !== 'tool_result') continue
      const toolUseId =
        typeof c.tool_use_id === 'string'
          ? c.tool_use_id
          : typeof c.toolUseId === 'string'
            ? c.toolUseId
            : ''
      if (!toolUseId) continue
      const isError = c.is_error === true || c.isError === true
      return {
        toolResult: {
          toolUseId,
          content: stringifyToolResultContent(c.content),
          ...(isError ? { isError: true } : {}),
        },
      }
    }
    return {}
  }

  private onResult(e: {
    subtype?: string
    result?: unknown
    is_error?: unknown
    errors?: unknown
  }): CliLineHit {
    // 终态事件：result 字符串为最终文本（成功时即摘要；失败时含错误描述）
    if (typeof e.result === 'string') this.finalText = e.result

    // 失败判定：is_error=true（即使 subtype="success"，见社区实证）或 subtype 以 error 开头
    const isError =
      e.is_error === true ||
      (typeof e.subtype === 'string' && e.subtype.toLowerCase().startsWith('error'))
    if (isError) {
      const messages: string[] = []
      if (Array.isArray(e.errors)) {
        for (const err of e.errors) {
          if (typeof err === 'string' && err.trim()) {
            messages.push(err.trim())
          } else if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
            const msg = (err as { message: string }).message.trim()
            if (msg) messages.push(msg)
          }
        }
      }
      const subtype = typeof e.subtype === 'string' && e.subtype ? e.subtype : ''
      this.errorMessage = messages.length
        ? messages.join('; ')
        : `Claude Code 报告错误${subtype ? `（subtype=${subtype}）` : ''}`
    }
    return {}
  }

  getSummary(): string {
    if (this.finalText !== null) return this.finalText
    return this.textChunks.join('')
  }

  getToolCallCount(): number {
    return this.toolCallCount
  }

  getError(): string | undefined {
    return this.errorMessage
  }
}
