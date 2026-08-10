/**
 * 剥掉 markdown 结构位上的装饰性 emoji（标题 / 列表 / 引用行首）。
 * 对齐 Codex/Cursor：结构靠层级与加粗，不用 emoji 当章节贴纸。
 * 保护围栏与行内代码；句中 emoji 不动。
 */

interface CodePlaceholder {
  key: string
  original: string
}

/** 一个 emoji（含 ZWJ 序列、可选 VS16/肤色）+ 后随空白 */
const LEADING_EMOJI_RUN =
  /^(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*(?:\u{1F3FB}-\u{1F3FF})?\s*)+/u

function extractCodeBlocks(text: string): { text: string; map: CodePlaceholder[] } {
  const map: CodePlaceholder[] = []
  const result = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    const key = `\x00EMOJI_CODE_${map.length}\x00`
    map.push({ key, original: match })
    return key
  })
  return { text: result, map }
}

function restoreCodeBlocks(text: string, map: CodePlaceholder[]): string {
  let result = text
  for (const { key, original } of map) {
    result = result.split(key).join(original)
  }
  return result
}

function stripLeadingEmojiRun(text: string): string {
  return text.replace(LEADING_EMOJI_RUN, '')
}

/**
 * 若行是标题 / 无序·有序列表 / 引用，则剥掉标记后的行首 emoji 串。
 * 例：`## 📌 周六` → `## 周六`；`- 🎯 目标` → `- 目标`
 */
function stripLineStructuralEmoji(line: string): string {
  const heading = /^(#{1,6}\s+)(.*)$/.exec(line)
  if (heading) {
    return heading[1]! + stripLeadingEmojiRun(heading[2]!)
  }

  const list = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(line)
  if (list) {
    return list[1]! + stripLeadingEmojiRun(list[2]!)
  }

  const quote = /^(\s*>\s+)(.*)$/.exec(line)
  if (quote) {
    return quote[1]! + stripLeadingEmojiRun(quote[2]!)
  }

  return line
}

/** 渲染前调用：结构位去 emoji，代码块原样保留 */
export function stripStructuralEmojiFromMarkdown(input: string): string {
  if (!input) return input
  // 快速路径：无 emoji 量级字符时跳过（Extended_Pictographic 检测成本高，用粗筛）
  if (!/\p{Extended_Pictographic}/u.test(input)) return input

  const { text: protectedText, map } = extractCodeBlocks(input)
  const stripped = protectedText
    .split('\n')
    .map(stripLineStructuralEmoji)
    .join('\n')
  return restoreCodeBlocks(stripped, map)
}
