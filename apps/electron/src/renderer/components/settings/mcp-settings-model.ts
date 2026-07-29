/**
 * MCP 设置 model 纯函数（校验 / draft / 解析 / 构造 entry）
 *
 * 对齐 channel-settings-model.ts 的风格：表单输入均为字符串，提交时再解析成
 * McpServerEntry。所有函数纯且无副作用，便于单测。
 */
import type { McpServerEntry, McpTransportType, WorkspaceMcpConfig } from '@tagent/shared'

/** MCP server 编辑草稿（表单输入均为字符串，提交时再解析） */
export interface McpDraft {
  /** server 名称（= mcp.json 的 key；编辑时不可改名） */
  name: string
  type: McpTransportType
  /** stdio: 可执行命令 */
  command: string
  /** stdio: 参数（空格分隔，或 JSON 数组字符串） */
  args: string
  /** stdio: 环境变量（多行 KEY=VALUE） */
  env: string
  /** http/sse: 服务端 URL */
  url: string
  /** http/sse: 请求头（多行 KEY:VALUE 或 KEY=VALUE） */
  headers: string
  /** 启动/连接超时（秒），空表示默认 30 */
  timeout: string
  /** 是否启用 */
  enabled: boolean
}

export interface McpDraftValidation {
  valid: boolean
  errors: Partial<Record<'name' | 'command' | 'url' | 'timeout', string>>
}

/** 传输类型选项（用于 Select） */
export const MCP_TRANSPORT_TYPES: readonly McpTransportType[] = ['stdio', 'http', 'sse']

/** 默认启动/连接超时（秒） */
export const MCP_DEFAULT_TIMEOUT = 30

/** 新建空草稿（默认 stdio + 启用） */
export function createMcpDraft(): McpDraft {
  return {
    name: '',
    type: 'stdio',
    command: '',
    args: '',
    env: '',
    url: '',
    headers: '',
    timeout: '',
    enabled: true,
  }
}

/** 把已保存 entry 转成草稿（编辑用；name 作为 key 单独传入） */
export function entryToDraft(name: string, entry: McpServerEntry): McpDraft {
  return {
    name,
    type: entry.type,
    command: entry.command ?? '',
    args: Array.isArray(entry.args) ? entry.args.join(' ') : '',
    env: entry.env ? Object.entries(entry.env).map(([k, v]) => `${k}=${v}`).join('\n') : '',
    url: entry.url ?? '',
    headers: entry.headers ? Object.entries(entry.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '',
    timeout: typeof entry.timeout === 'number' ? String(entry.timeout) : '',
    enabled: entry.enabled,
  }
}

/**
 * 解析参数字符串：JSON 数组优先，否则按空白分隔。
 * - `'-y fs /tmp'` → `['-y', 'fs', '/tmp']`
 * - `'["-y","fs"]'` → `['-y', 'fs']`
 * - `['["-y", 1]']` → 非字符串元素过滤 → `['-y']`
 */
export function parseArgs(raw: string): string[] {
  const text = raw.trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      }
    } catch {
      // 非法 JSON 退回空白分隔
    }
  }
  return text.split(/\s+/).filter(Boolean)
}

/** 解析多行 KEY=VALUE 为 env 对象（跳过无分隔符或 key 为空的行） */
export function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (key) env[key] = value
  }
  return env
}

/** 解析多行 KEY:VALUE 或 KEY=VALUE 为 headers 对象（按首个 : 或 = 切分） */
export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.search(/[:=]/)
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (key) headers[key] = value
  }
  return headers
}

/** 解析超时秒数；非法或为空返回 undefined（使用默认）。仅接受正整数。 */
export function parseTimeout(raw: string): number | undefined {
  const text = raw.trim()
  if (!text) return undefined
  const n = Number(text)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined
  return n
}

/** 校验草稿：name 必填；stdio 要 command；http/sse 要合法 URL；timeout 选填需正整数 */
export function validateMcpDraft(draft: McpDraft): McpDraftValidation {
  const errors: McpDraftValidation['errors'] = {}

  if (!draft.name.trim()) errors.name = '请输入名称'

  if (draft.type === 'stdio') {
    if (!draft.command.trim()) errors.command = 'stdio 类型需要 command'
  } else {
    const url = draft.url.trim()
    if (!url) {
      errors.url = `${draft.type} 类型需要 url`
    } else {
      try {
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid')
      } catch {
        errors.url = '请输入有效的 HTTP(S) 地址'
      }
    }
  }

  const timeout = draft.timeout.trim()
  if (timeout && parseTimeout(timeout) === undefined) {
    errors.timeout = '超时需为正整数（秒）'
  }

  return { valid: Object.keys(errors).length === 0, errors }
}

/**
 * 由草稿构造 McpServerEntry。
 * 可携带旧 entry 的 lastTestResult / isBuiltin，避免编辑保存时丢字段。
 */
export function buildMcpEntry(draft: McpDraft, existing?: McpServerEntry): McpServerEntry {
  const entry: McpServerEntry = {
    type: draft.type,
    enabled: draft.enabled,
  }

  if (draft.type === 'stdio') {
    const command = draft.command.trim()
    if (command) entry.command = command
    const args = parseArgs(draft.args)
    if (args.length > 0) entry.args = args
    const env = parseEnv(draft.env)
    if (Object.keys(env).length > 0) entry.env = env
  } else {
    const url = draft.url.trim()
    if (url) entry.url = url
    const headers = parseHeaders(draft.headers)
    if (Object.keys(headers).length > 0) entry.headers = headers
  }

  const timeout = parseTimeout(draft.timeout)
  if (timeout !== undefined) entry.timeout = timeout

  if (existing?.lastTestResult) entry.lastTestResult = existing.lastTestResult
  if (existing?.isBuiltin) entry.isBuiltin = existing.isBuiltin
  return entry
}

/** 列表摘要：stdio 显示 command + args，http/sse 显示 url */
export function summarizeMcpEntry(entry: McpServerEntry): string {
  if (entry.type === 'stdio') {
    const cmd = entry.command ?? ''
    const args = Array.isArray(entry.args) ? entry.args.join(' ') : ''
    return [cmd, args].filter(Boolean).join(' ').trim() || '(未配置命令)'
  }
  return entry.url?.trim() || '(未配置 URL)'
}

/** 便捷：从 config 取 server 列表（保持插入顺序） */
export function listMcpServers(
  config: WorkspaceMcpConfig
): Array<{ name: string; entry: McpServerEntry }> {
  return Object.entries(config.servers).map(([name, entry]) => ({ name, entry }))
}
