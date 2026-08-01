/**
 * 模型侧富内容输出校验（自研）
 *
 * 渲染层就绪后，让模型"输出对"的半环：
 * - validateRichOutput：校验最终回复的富内容围栏（闭合、JSON schema）
 * - buildRichOutputFixPrompt：生成修复指令（供自动重试）
 * - buildRichContentSystemPrompt：双核 systemPrompt 追加的输出规范（预防）
 *
 * 围栏检测逻辑的单一事实源：ui 包 streaming.ts 从此处 re-export。
 */

// ===== 围栏语言 =====

/** 富内容围栏语言（与渲染分派表一致） */
export const RICH_FENCE_LANGUAGES = new Set([
  'diff',
  'json',
  'mermaid',
  'math',
  'latex',
  'datatable',
  'spreadsheet',
  'html-preview',
  'image-preview',
  'pdf-preview',
  'markdown-preview',
])

export function isRichFenceLanguage(language: string): boolean {
  return RICH_FENCE_LANGUAGES.has(language.toLowerCase())
}

/** 从 markdown 文本提取最后一个未闭合围栏的语言；无未闭合围栏返回 null */
export function unclosedFenceLanguage(content: string): string | null {
  if (!content || typeof content !== 'string') return null

  let inFence = false
  let fenceLanguage = ''
  let lastIndex = 0

  while (lastIndex < content.length) {
    const rel = content.indexOf('```', lastIndex)
    if (rel < 0) break
    const start = rel + 3
    const lineEnd = content.indexOf('\n', start)
    const rest = lineEnd < 0 ? content.slice(start) : content.slice(start, lineEnd)

    if (!inFence) {
      fenceLanguage = rest.trim().split(/\s+/)[0] ?? ''
      inFence = true
      lastIndex = lineEnd < 0 ? content.length : lineEnd + 1
    } else {
      const after = rest.trim()
      if (after === '' || after === '```') {
        inFence = false
        fenceLanguage = ''
        lastIndex = lineEnd < 0 ? content.length : lineEnd + 1
      } else {
        lastIndex = rel + 3
      }
    }
  }

  return inFence ? fenceLanguage : null
}

// ===== 校验 =====

export interface RichOutputIssue {
  kind: 'unclosed-fence' | 'bad-json' | 'bad-datatable'
  language: string
  index: number
  message: string
}

interface FenceBlock {
  language: string
  index: number
  code: string
}

const FENCE_BLOCK_RE = /```([\w-]+)[^\n]*\n([\s\S]*?)```/g

/** 提取所有闭合围栏块 */
function extractFenceBlocks(text: string): FenceBlock[] {
  const blocks: FenceBlock[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(FENCE_BLOCK_RE.source, 'g')
  while ((match = re.exec(text)) !== null) {
    blocks.push({ language: match[1]!.toLowerCase(), index: match.index, code: match[2]! })
  }
  return blocks
}

/** datatable/spreadsheet：JSON 对象 + columns/rows 形状校验 */
function validateDataSpec(code: string): string | null {
  let value: unknown
  try {
    value = JSON.parse(code.trim())
  } catch {
    return 'JSON 解析失败（可能是括号或引号不完整）'
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '需要是 JSON 对象'
  const spec = value as Record<string, unknown>
  if (spec.rows !== undefined && !Array.isArray(spec.rows)) return 'rows 需要是数组'
  if (spec.columns !== undefined && !Array.isArray(spec.columns)) return 'columns 需要是数组'
  if (spec.columns !== undefined && spec.columns.length === 0 && Array.isArray(spec.rows) && spec.rows.length > 0) {
    return '有数据但没有 columns 列定义'
  }
  return null
}

/**
 * 校验回复中的富内容围栏。
 * 注意：只针对富语言（json/datatable/spreadsheet），diff/mermaid 等由渲染层容错。
 */
export function validateRichOutput(text: string): RichOutputIssue[] {
  if (!text || typeof text !== 'string') return []

  const issues: RichOutputIssue[] = []

  // 1) 未闭合围栏
  const unclosed = unclosedFenceLanguage(text)
  if (unclosed !== null && isRichFenceLanguage(unclosed)) {
    issues.push({
      kind: 'unclosed-fence',
      language: unclosed,
      index: -1,
      message: `\`\`\`${unclosed} 围栏未闭合`,
    })
  }

  // 2) 已闭合富围栏的内容校验
  for (const block of extractFenceBlocks(text)) {
    if (block.language === 'json') {
      try {
        JSON.parse(block.code)
      } catch {
        issues.push({
          kind: 'bad-json',
          language: 'json',
          index: block.index,
          message: `JSON 围栏内容无法解析：${block.code.slice(0, 60).trim()}…`,
        })
      }
    }
    if (block.language === 'datatable' || block.language === 'spreadsheet') {
      const error = validateDataSpec(block.code)
      if (error) {
        issues.push({
          kind: 'bad-datatable',
          language: block.language,
          index: block.index,
          message: `${block.language} 围栏数据不合法：${error}`,
        })
      }
    }
  }

  return issues
}

// ===== 修复提示 =====

/** 生成修复指令（供自动重试 / 手动触发） */
export function buildRichOutputFixPrompt(issues: RichOutputIssue[], original: string): string {
  const list = issues.map((issue, i) => `${i + 1}. ${issue.message}`).join('\n')
  return [
    '你上一条回复中的富内容格式有问题，请修正后重新输出完整回复（不要省略其他内容）：',
    '',
    list,
    '',
    '要求：',
    '- 所有富内容围栏必须闭合（``` 开头必须配对的 ``` 结束）',
    '- datatable/spreadsheet 围栏内是 JSON 对象，需要包含 columns（字符串数组）和 rows（数组）',
    '- json 围栏内必须是合法 JSON',
    '',
    '原回复：',
    '```text',
    original.slice(0, 4000),
    '```',
  ].join('\n')
}

// ===== systemPrompt 规范（预防） =====

/** 双核 systemPrompt 追加的富内容输出规范 */
export function buildRichContentSystemPrompt(): string {
  return [
    '## 富内容输出规范',
    '回复中可使用以下代码围栏触发富内容渲染（否则按普通代码块展示）：',
    '',
    '- ```diff：代码差异（unified diff 格式）',
    '- ```json：JSON 数据（渲染为可折叠树）',
    '- ```mermaid：流程图/时序图等图表',
    '- ```math 或 ```latex：数学公式',
    '- ```datatable 或 ```spreadsheet：数据表格，围栏内是 JSON 对象，例如：',
    '',
    '```datatable',
    '{"title":"资源清单","columns":["名称","类型","大小"],"rows":[["a.png","贴图",2048],["b.jpg","照片",1024]],"groupBy":"类型"}',
    '```',
    '',
    '要求：围栏必须闭合；datatable/spreadsheet 的 JSON 必须合法；数据较多时优先用 datatable 而非散列表格。',
  ].join('\n')
}
