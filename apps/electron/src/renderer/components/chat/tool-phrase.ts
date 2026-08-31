/**
 * 工具语义化短语 — 对齐 TAgent_General tool-phrase
 *
 * 收起态/过程行不写「Bash」「结果」徽章，而用中文动宾短语：
 * 「读取 package.json」「执行 ls -la」
 */

export interface ToolPhrase {
  /** 完成态短语 */
  label: string
  /** 进行中短语 */
  loadingLabel: string
}

function filename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function phrase(label: string): ToolPhrase {
  return {
    label,
    loadingLabel: label.startsWith('正在') ? label : `正在${label}…`,
  }
}

/** 容错 JSON.parse：失败返回 null（不抛） */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 归一化知识库工具名：兼容 MCP 前缀（kscc 注入为 `mcp__kb__kb_search`）。
 * 返回 kb_search / kb_list_roots / kb_get / kb_propose_save / kb_list_available 之一，或 null。
 */
function normalizeKbToolName(name: string): string | null {
  const m = name.match(
    /(?:^|[_:])(kb_search|kb_list_roots|kb_get|kb_propose_save|kb_list_available)$/,
  )
  return m ? (m[1] as string) : null
}

/** 知识库工具短语（含 MCP 前缀） */
function kbPhrase(base: string, input: Record<string, unknown>): ToolPhrase {
  switch (base) {
    case 'kb_search': {
      const q = input.query
      if (typeof q === 'string' && q.trim()) {
        return phrase(`检索知识库「${truncate(q.trim(), 32)}」`)
      }
      return phrase('检索知识库')
    }
    case 'kb_list_roots':
      return phrase('列出知识库')
    case 'kb_list_available':
      // 刀 3：未挂库时口头荐库用的可发现元数据查询
      return phrase('查看可挂知识库')
    case 'kb_get': {
      if (typeof input.documentId === 'string' && input.documentId.trim()) {
        return phrase('读取知识文档')
      }
      if (typeof input.path === 'string' && input.path.trim()) {
        return phrase('读取知识文件')
      }
      return phrase('读取知识库')
    }
    case 'kb_propose_save': {
      const title = input.title
      if (typeof title === 'string' && title.trim()) {
        return phrase(`提议保存「${truncate(title.trim(), 32)}」`)
      }
      return phrase('提议保存到知识库')
    }
    default:
      return phrase(base)
  }
}

/**
 * 根据工具名 + 入参生成可读短语。
 * 兼容 Pi Read 的 path 字段与 Claude 的 file_path。
 */
export function getToolPhrase(toolName: string, input: Record<string, unknown>): ToolPhrase {
  const kbBase = normalizeKbToolName(toolName)
  if (kbBase) return kbPhrase(kbBase, input)
  switch (toolName) {
    case 'Read': {
      const fp = input.file_path ?? input.filePath ?? input.path
      if (typeof fp === 'string') {
        const name = filename(fp)
        const offset = typeof input.offset === 'number' ? input.offset : undefined
        const limit = typeof input.limit === 'number' ? input.limit : undefined
        if (offset !== undefined && limit !== undefined) {
          return phrase(`读取 ${name} 第 ${offset}-${offset + limit} 行`)
        }
        if (offset !== undefined) return phrase(`读取 ${name} 从第 ${offset} 行`)
        return phrase(`读取 ${name}`)
      }
      return phrase('读取文件')
    }
    case 'Edit': {
      const fp = input.file_path ?? input.filePath ?? input.path
      const name = typeof fp === 'string' ? filename(fp) : '文件'
      return phrase(`编辑 ${name}`)
    }
    case 'Write': {
      const fp = input.file_path ?? input.filePath ?? input.path
      const name = typeof fp === 'string' ? filename(fp) : '文件'
      return phrase(`写入 ${name}`)
    }
    case 'Bash': {
      const cmd = input.command
      if (typeof cmd === 'string' && cmd.trim()) {
        return phrase(`执行 ${truncate(cmd.trim(), 72)}`)
      }
      return phrase('执行命令')
    }
    case 'Grep': {
      const pattern = input.pattern
      if (typeof pattern === 'string') {
        const path = input.path
        const glob = input.glob
        if (typeof glob === 'string') return phrase(`搜索 /${truncate(pattern, 40)}/ in ${glob}`)
        if (typeof path === 'string') return phrase(`搜索 /${truncate(pattern, 40)}/ in ${path}`)
        return phrase(`搜索 /${truncate(pattern, 40)}/`)
      }
      return phrase('搜索内容')
    }
    case 'Glob': {
      const pattern = input.pattern
      if (typeof pattern === 'string') {
        const path = input.path
        if (typeof path === 'string') return phrase(`匹配文件 ${pattern} in ${path}`)
        return phrase(`匹配文件 ${pattern}`)
      }
      return phrase('匹配文件')
    }
    case 'WebFetch': {
      const url = input.url
      if (typeof url === 'string') return phrase(`抓取 ${truncate(url, 56)}`)
      return phrase('抓取网页')
    }
    case 'WebSearch': {
      const query = input.query
      if (typeof query === 'string') return phrase(`搜索 “${truncate(query, 48)}”`)
      return phrase('搜索网页')
    }
    case 'Task':
    case 'Agent': {
      const desc = input.description ?? input.prompt
      if (typeof desc === 'string') return phrase(`子任务 ${truncate(desc, 64)}`)
      return phrase('子任务')
    }
    default:
      return phrase(toolName)
  }
}

/** 从 tool_result content 解析 kb_search 的 hits 数量；非 hits 结果返回 null。
 *  kb_list_roots 用 roots（非 hits），不会被误判为「命中」。 */
function tryHitCount(content: unknown): number | null {
  const obj = parseContentJson(content)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  if (Array.isArray(o.hits)) return o.hits.length
  return null
}

/**
 * 解析 kb_list_available 结果（刀 3）：返回 { bound, count } 供摘要用；非该结构返回 null。
 * kb_list_available 返回 `{ bound, available: [...] }`，无 hits，需单独摘要。
 */
function tryAvailableSummary(content: unknown): { bound: boolean; count: number } | null {
  const obj = parseContentJson(content)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  if (!Array.isArray(o.available)) return null
  return { bound: o.bound === true, count: (o.available as unknown[]).length }
}

/** 从 tool_result content 解析为 JSON 对象（兼容 text / text blocks / 对象）；失败返回 null */
function parseContentJson(content: unknown): unknown {
  if (typeof content === 'string') return tryParseJson(content)
  if (Array.isArray(content)) {
    const text = content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b
          ? String((b as { text: unknown }).text)
          : '',
      )
      .join('\n')
      .trim()
    return tryParseJson(text)
  }
  if (content != null && typeof content === 'object') return content
  return null
}

/** 从 tool_result 抽一行摘要（展开前不占版面） */
export function summarizeToolResult(content: unknown, isError?: boolean): string {
  if (isError) return '失败'
  // kb_search 等 JSON 结果：有 hits 数组 → 命中 N 条（kb_list_roots 用 roots，不会被误判）
  const hitCount = tryHitCount(content)
  if (hitCount != null) return `命中 ${hitCount} 条`
  // kb_list_available（刀 3）：有 available 数组 → 可发现 N 个库 / 已挂库 / 无可发现库
  const avail = tryAvailableSummary(content)
  if (avail != null) {
    if (avail.bound) return '已挂库'
    return avail.count > 0 ? `可发现 ${avail.count} 个库` : '无可发现库'
  }
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('\n')
  } else if (content != null) {
    try {
      text = JSON.stringify(content)
    } catch {
      text = String(content)
    }
  }
  const line = text.trim().split(/\r?\n/).find((l) => l.trim()) ?? ''
  if (!line) return '完成'
  return truncate(line.replace(/\s+/g, ' '), 64)
}
