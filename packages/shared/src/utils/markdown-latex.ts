/**
 * LaTeX 原生分隔符规范化
 *
 * 模型按 LaTeX 习惯输出 `\(...\)` 行内公式或 `\[...\]` 块级公式时，
 * react-markdown 走 CommonMark 规范会把反斜杠括号当转义吃掉，导致
 * remark-math 识别不到（它只认 `$...$` 和 `$$...$$`），公式显示成裸文本。
 *
 * 解析前把：
 *   \(...\)  →  $...$
 *   \[...\]  →  $$...$$
 *
 * 代码块（```...```）和内联代码（`...`）中的字面量用占位符保护，避免误改。
 */

interface CodePlaceholder {
  key: string
  original: string
}

/** 提取 fenced code block 和 inline code，替换为占位符 */
function extractCodeBlocks(text: string): { text: string; map: CodePlaceholder[] } {
  const map: CodePlaceholder[] = []
  // 匹配 fenced code block（```...```）和 inline code（`...`）
  // inline code 用不跨行的非贪婪匹配，避免误吞段落
  const result = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    const key = `\x00LATEX_CODE_${map.length}\x00`
    map.push({ key, original: match })
    return key
  })
  return { text: result, map }
}

/** 还原占位符为原始代码块 */
function restoreCodeBlocks(text: string, map: CodePlaceholder[]): string {
  let result = text
  for (const { key, original } of map) {
    result = result.split(key).join(original)
  }
  return result
}

/**
 * 把 LaTeX 原生分隔符规范化为 remark-math 能识别的 $...$ / $$...$$
 *
 * 注意：必须在 react-markdown 解析前调用，且保护代码块不被误改。
 */
export function normalizeLatexDelimiters(input: string): string {
  if (!input) return input
  if (!input.includes('\\(') && !input.includes('\\[')) return input

  const { text: protectedText, map } = extractCodeBlocks(input)

  // \(...\) → $...$（非贪婪，不跨行）
  let normalized = protectedText.replace(/\\\(([^\\\n]+?)\)/g, '$$$1$$')
  // \[...\] → $$...$$（非贪婪，可跨行）
  normalized = normalized.replace(/\\\[([\s\S]+?)\\\]/g, '$$$1$$')

  return restoreCodeBlocks(normalized, map)
}
