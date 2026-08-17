/**
 * 面板 / SDK JSONL 落盘行的 user 消息识别（主进程撤回未开始轮次用）。
 * 与 renderer `session-turn-model.isRealUserInput` 语义对齐。
 */

function isControlUserText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/^\[Request interrupted by user/i.test(t)) return true
  if (/^\[Request cancelled/i.test(t)) return true
  if (/^The user doesn't want to proceed with this tool use/i.test(t)) return true
  if (/^Permission for .{0,80} (was|has been) denied/i.test(t)) return true
  return false
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && typeof b.text === 'string') out += b.text
  }
  return out
}

function isRealUserContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  const hasToolResult = content.some(
    (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result',
  )
  const text = textFromContent(content).trim()
  if (!text) return false
  if (
    hasToolResult &&
    !content.some((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
  ) {
    return false
  }
  if (isControlUserText(text)) return false
  return true
}

/** 落盘行是否为主线 assistant（非子代理） */
export function isPersistedMainAssistantMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false
  const r = msg as Record<string, unknown>
  if (r.type !== 'assistant') return false
  if (r.parentToolUseId || r.parent_tool_use_id) return false
  return true
}

/** 落盘行是否为真实用户输入（非 steer / 控制文 / tool_result-only） */
export function isPersistedRealUserMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false
  const r = msg as Record<string, unknown>
  if (r.isSteer === true) return false
  if (r.parentToolUseId || r.parent_tool_use_id) return false

  if (r.type === 'user' && r.message && typeof r.message === 'object') {
    const inner = r.message as { role?: string; content?: unknown }
    if (inner.role !== 'user') return false
    return isRealUserContent(inner.content)
  }

  if (r.type === 'user') {
    return isRealUserContent(r.content)
  }

  return false
}

/** 从落盘 user 行提取纯文本（供撤回回填输入框） */
export function extractPersistedUserText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const r = msg as Record<string, unknown>
  if (r.type === 'user' && r.message && typeof r.message === 'object') {
    const inner = r.message as { content?: unknown }
    return textFromContent(inner.content).trim()
  }
  if (r.type === 'user' && Array.isArray(r.content)) {
    return textFromContent(r.content).trim()
  }
  return ''
}

/** user 控制文检测（供 renderer 复用） */
export function isControlUserTextBlock(text: string): boolean {
  return isControlUserText(text)
}
