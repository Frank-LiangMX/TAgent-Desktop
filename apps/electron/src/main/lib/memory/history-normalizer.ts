/**
 * 跨核历史归一化（Phase 5.2）
 *
 * 面板消息可能是 SDKMessage（kscc）或 TAgentMessage IR（pi）。
 * 统一成 role + contentText，供 Nudge / L-rag / 压缩 LLM 输入。
 * 只处理完整消息，不处理流式 delta。
 */
export interface TextMessage {
  role: 'user' | 'assistant'
  contentText: string
}

/** 把面板/SDK/IR 原始行归一成 role+text */
export function normalizeToTextMessages(raw: unknown[]): TextMessage[] {
  const out: TextMessage[] = []
  for (const item of raw) {
    const m = item as {
      type?: string
      role?: string
      message?: { role?: string; content?: unknown }
      content?: unknown
    }
    const roleRaw =
      m.message?.role ??
      (m.type === 'user' || m.type === 'assistant' ? m.type : m.role)
    if (roleRaw !== 'user' && roleRaw !== 'assistant') continue
    const text = contentToText(m.message?.content ?? m.content)
    if (!text.trim()) continue
    out.push({ role: roleRaw, contentText: text })
  }
  return out
}

/** content 字段 → 纯文本 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return ''
      const block = b as { type?: string; text?: string; content?: unknown; name?: string }
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (block.type === 'tool_use' && block.name) return `[tool:${block.name}]`
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') return block.content
        if (Array.isArray(block.content)) return contentToText(block.content)
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** 粗 token 估算（CHARS_PER_TOKEN=4） */
export function estimateTextTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4)
}

export function estimateMessagesTokens(messages: TextMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTextTokens(m.contentText), 0)
}
