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

/**
 * 根据工具名 + 入参生成可读短语。
 * 兼容 Pi Read 的 path 字段与 Claude 的 file_path。
 */
export function getToolPhrase(toolName: string, input: Record<string, unknown>): ToolPhrase {
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

/** 从 tool_result 抽一行摘要（展开前不占版面） */
export function summarizeToolResult(content: unknown, isError?: boolean): string {
  if (isError) return '失败'
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
