export interface WebToolCallLike {
  tool_name: string
  tool_input: unknown
  tool_response?: unknown
}

export interface WebFallbackDecision {
  toolName: string
  reason: string
  targetUrl: string
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function inputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function firstString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function isWebSearchTool(name: string): boolean {
  return /^(websearch|web_search)$/i.test(name)
}

function isWebFetchTool(name: string): boolean {
  return /^(webfetch|web_fetch)$/i.test(name)
}

function hasError(response: unknown, text: string): boolean {
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>
    if (record.isError === true || record.is_error === true || record.error != null) return true
  }
  return /\b(error|failed|failure|unavailable|blocked|captcha|challenge|timed out)\b|失败|不可用|被阻止|验证码|挑战|超时|无结果|没有结果/i.test(text)
}

function searchTarget(input: Record<string, unknown>): string {
  const query = firstString(input, ['query', 'q', 'search_query', 'searchQuery'])
  if (query) return 'https://www.bing.com/search?q=' + encodeURIComponent(query)
  const url = firstString(input, ['url', 'uri', 'link'])
  return /^https?:\/\//i.test(url) ? url : 'https://www.bing.com/'
}

export function assessWebSearchFallback(toolCalls: WebToolCallLike[]): WebFallbackDecision | undefined {
  for (const call of toolCalls) {
    const toolName = String(call.tool_name || '')
    if (!isWebSearchTool(toolName) && !isWebFetchTool(toolName)) continue
    const input = inputRecord(call.tool_input)
    const text = stringify(call.tool_response).trim()
    const emptyResponse = Array.isArray(call.tool_response) && call.tool_response.length === 0
    if (!text || emptyResponse) {
      return { toolName, reason: '网页工具没有返回内容', targetUrl: searchTarget(input) }
    }
    if (hasError(call.tool_response, text)) {
      return { toolName, reason: '网页工具返回失败、拦截或验证码状态', targetUrl: searchTarget(input) }
    }
    if (isWebSearchTool(toolName)) {
      const hasResultShape = /https?:\/\/|title|source|result|snippet|摘要|标题|来源/i.test(text)
      if (text.length < 120 || !hasResultShape) {
        return { toolName, reason: '搜索结果为空、过短或缺少可核验来源', targetUrl: searchTarget(input) }
      }
    } else if (text.length < 240) {
      return { toolName, reason: '网页正文过短，可能是动态页面或受限页面', targetUrl: searchTarget(input) }
    }
  }
  return undefined
}

export function buildBrowserFallbackContext(decision: WebFallbackDecision): string {
  return [
    '受管浏览器回退策略已触发。',
    `刚才的 ${decision.toolName} 结果不足：${decision.reason}。`,
    '不要仅凭这个结果直接回答，也不要声称已经完成可靠查询。',
    `请立即调用 browser_open 打开：${decision.targetUrl}`,
    '打开后调用 browser_observe，必要时使用 browser_click、browser_type、browser_scroll 或 browser_screenshot；完成网页核验后再回答用户。',
  ].join('\n')
}