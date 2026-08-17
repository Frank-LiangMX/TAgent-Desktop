/**
 * 助手正文里的工具调用标记剥离 + 无信息 artifact 判定。
 *
 * kscc bare / 部分模型会在 text 块里夹 `<antml:invoke>`、`function_call`、`call` 等
 * 过渡词；流式 commit 后可能单独成段，简洁时间线误当 narrative.progress 展示。
 */

/** 剥离 antml / command / function_call / tool_call 等工具标记，保留自然语言 */
export function stripToolInvocationMarkup(text: string): string {
  return text
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
    // 流式尾段：未闭合的开标签（如 `<antml:invoke name="Read"`）
    .replace(/<(?:antml:[\w-]+|function_calls?|tool_calls?|command)[^>]*$/gi, '')
    .replace(/<[^>\n]*$/g, '')
    .trim()
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
