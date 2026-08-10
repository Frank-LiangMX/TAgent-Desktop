/**
 * kscc stream-json 行解析 observer（纯函数 / 无 IO）。
 *
 * kscc `-p --output-format stream-json --verbose` 逐行输出 NDJSON。
 * 供 runKsccWorker 进度 + 详情页 parentToolUseId 消息构造。
 */

export type KsccToolUseHit = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type KsccToolResultHit = {
  toolUseId: string
  content: string
  isError?: boolean
}

/** 单行解析增量（供进度卡 + 详情流） */
export type KsccLineHit = {
  lastToolName?: string
  toolUse?: KsccToolUseHit
  textChunk?: string
  toolResult?: KsccToolResultHit
}

/** kscc stream-json 单行解析累积器 */
export class KsccStreamObserver {
  private finalText: string | null = null
  private readonly textChunks: string[] = []
  private toolCallCount = 0

  /**
   * 喂一行 stream-json。
   * JSON 失败 / 空行 → 空对象。
   */
  onLine(line: string): KsccLineHit {
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
      message?: { content?: unknown; role?: string }
      result?: unknown
    }

    if (e.type === 'assistant') {
      return this.onAssistant(e.message?.content)
    }
    if (e.type === 'user') {
      return this.onUser(e.message?.content)
    }
    if (e.type === 'result') {
      if (typeof e.result === 'string') this.finalText = e.result
      return {}
    }
    return {}
  }

  private onAssistant(content: unknown): KsccLineHit {
    if (!Array.isArray(content)) return {}
    let lastToolName: string | undefined
    let toolUse: KsccToolUseHit | undefined
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
        lastToolName = c.name
        const id =
          typeof c.id === 'string' && c.id.trim()
            ? c.id
            : `cli-tool-${this.toolCallCount}`
        const input =
          c.input && typeof c.input === 'object' && !Array.isArray(c.input)
            ? (c.input as Record<string, unknown>)
            : {}
        toolUse = { id, name: c.name, input }
      } else if (c.type === 'text' && typeof c.text === 'string') {
        this.textChunks.push(c.text)
        texts.push(c.text)
      }
    }
    const hit: KsccLineHit = {}
    if (lastToolName !== undefined) hit.lastToolName = lastToolName
    if (toolUse) hit.toolUse = toolUse
    if (texts.length > 0) hit.textChunk = texts.join('')
    return hit
  }

  private onUser(content: unknown): KsccLineHit {
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
      let text = ''
      if (typeof c.content === 'string') text = c.content
      else if (Array.isArray(c.content)) {
        text = c.content
          .map((b) =>
            b && typeof b === 'object' && (b as { type?: string }).type === 'text'
              ? String((b as { text?: string }).text ?? '')
              : '',
          )
          .join('')
      } else if (c.content != null) {
        try {
          text = JSON.stringify(c.content)
        } catch {
          text = String(c.content)
        }
      }
      const isError = c.is_error === true || c.isError === true
      return {
        toolResult: {
          toolUseId,
          content: text,
          ...(isError ? { isError: true } : {}),
        },
      }
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
}
