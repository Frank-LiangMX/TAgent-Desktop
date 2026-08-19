/**
 * 助手正文里的工具调用标记剥离 + 无信息 artifact 判定。
 *
 * kscc bare / 部分模型会在 text 块里夹 `<antml:invoke>`、`function_call`、`call` 等
 * 过渡词；流式 commit 后可能单独成段，简洁时间线误当 narrative.progress 展示。
 *
 * MiniMax / Pai 还会把 AskUserQuestion 打成 `< | DSML | invoke >` + `</pai_toolcalls>`，
 * 若不剥掉会整段 JSON 裸露在消息里。
 */

/** `< | DSML | tool_calls >` / `<|DSML|invoke ...>` */
const DSML_TAG_RE = /<\s*\|\s*DSML\s*\|[^>]*>/gi

/** 从第一个 DSML tool_calls/invoke 起到 pai 收尾（或文本末尾） */
const DSML_BLOCK_RE =
  /<\s*\|\s*DSML\s*\|\s*(?:tool_calls?|invoke)\b[\s\S]*?(?:<\/\s*pai_tool_?calls?\s*>|$)/gi

function stripResidualToolJson(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (looksLikeToolPayload(parsed)) return ''
    } catch {
      // 流式未闭合 JSON：AskUser 参数以 "header" / "multiSelect" 起头
      if (/"header"\s*:/.test(trimmed) && /"options"\s*:/.test(trimmed)) return ''
    }
  }
  return text
    .replace(/\s*\[\s*\{\s*"header"\s*:[\s\S]*$/g, '')
    .trim()
}

function looksLikeToolPayload(value: unknown): boolean {
  const rows = Array.isArray(value) ? value : [value]
  return rows.some((row) => {
    if (!row || typeof row !== 'object') return false
    const rec = row as Record<string, unknown>
    if (typeof rec.header === 'string' && Array.isArray(rec.options)) return true
    if (typeof rec.name === 'string' && rec.input != null) return true
    return false
  })
}

/** 剥离 antml / command / function_call / tool_call / DSML 等工具标记，保留自然语言 */
export function stripToolInvocationMarkup(text: string): string {
  const stripped = text
    .replace(/<antml:invoke\s+name\s*=\s*["']?[^"'\s>]+["']?[^>]*>[\s\S]*?<\/antml:invoke>/gi, '')
    .replace(/<antml:invoke[^>]*>/gi, '')
    .replace(/<\/antml:invoke>/gi, '')
    .replace(/<antml:parameter[^>]*>[\s\S]*?<\/antml:parameter>/gi, '')
    .replace(/<command[^>]*>[\s\S]*?<\/command>/gi, '')
    .replace(/<command[^>]*>/gi, '')
    .replace(/<\/command>/gi, '')
    .replace(/<FilesystemTool>[\s\S]*?<\/FilesystemTool>/gi, '')
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, '')
    .replace(/<function_calls?>[\s\S]*?<\/function_calls?>/gi, '')
    .replace(/<function_calls?[^>]*>/gi, '')
    .replace(/<\/function_calls?>/gi, '')
    .replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, '')
    .replace(/<tool_calls?[^>]*>/gi, '')
    .replace(/<\/tool_calls?>/gi, '')
    .replace(/<pai_tool_?calls?>[\s\S]*?<\/pai_tool_?calls?>/gi, '')
    .replace(DSML_BLOCK_RE, '')
    .replace(DSML_TAG_RE, '')
    .replace(/<\/?\s*pai_tool_?calls?\s*>/gi, '')
    // 流式尾段：未闭合的开标签（如 `<antml:invoke name="Read"`）
    .replace(/<(?:antml:[\w-]+|function_calls?|tool_calls?|pai_tool_?calls?|command)[^>]*$/gi, '')
    .replace(/<\s*\|\s*DSML\s*\|[^>]*$/gi, '')
    .replace(/<[^>\n]*$/g, '')
    .trim()
  return stripResidualToolJson(stripped)
}

/** 工具调用前的纯 artifact 短文（剥离标记后无信息）→ 不应进 narrative */
const ARTIFACT_ONLY_RE =
  /^(?:call|calling|tool_call|function_call|invoke)\s*[.…~]*$/i

export function isToolCallArtifactText(text: string): boolean {
  const stripped = stripToolInvocationMarkup(text)
  if (!stripped) return true
  return ARTIFACT_ONLY_RE.test(stripped)
}

/** 展示/落盘前清洗 text 块（去标记 + trim） */
export function sanitizeAssistantTextForDisplay(text: string): string {
  return stripToolInvocationMarkup(text)
}
