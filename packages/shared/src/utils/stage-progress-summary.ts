/** 阶段进度摘要的硬上限；完整 thinking 和最终回答不受此限制。 */
export const STAGE_PROGRESS_MAX_CHARS = 80

const PROCESS_PREFIX = /^(?:我(?:先|会|将|准备|想|需要|来|再)|让我|接下来|然后|现在|换个|等等|可能|应该|不过|另外|先别)/u
const COMMAND_LINE = /^(?:[$>#]|PS>|(?:运行|执行|调用|输入|打开|查看).*(?:命令|脚本|终端|PowerShell))/iu

function normalizeLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function splitSentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/gu, '')
    .split(/\n+/u)
    .flatMap((line) => line.split(/(?<=[。！？.!?；;])/u))
    .map(normalizeLine)
    .filter(Boolean)
}

function fitToLimit(text: string): string {
  if (text.length <= STAGE_PROGRESS_MAX_CHARS) return text
  const prefix = text.slice(0, STAGE_PROGRESS_MAX_CHARS - 1)
  const punctuation = Math.max(
    prefix.lastIndexOf('。'),
    prefix.lastIndexOf('！'),
    prefix.lastIndexOf('？'),
    prefix.lastIndexOf('.'),
    prefix.lastIndexOf('!'),
    prefix.lastIndexOf('?'),
  )
  if (punctuation >= Math.floor(STAGE_PROGRESS_MAX_CHARS * 0.55)) {
    return prefix.slice(0, punctuation + 1)
  }
  return `${prefix.trimEnd()}…`
}

/** 将工具阶段的普通 assistant text 压成可落盘的阶段摘要。 */
export function compactStageProgress(text: string): string | null {
  const normalized = text
    .replace(/\r/gu, '')
    .split('\n')
    .map(normalizeLine)
    .filter(Boolean)
    .join('\n')
    .trim()
  if (!normalized) return null
  const candidates = splitSentences(text).filter((sentence) => !COMMAND_LINE.test(sentence))
  if (normalized.length <= STAGE_PROGRESS_MAX_CHARS && candidates.length <= 1) return normalized
  const informative = candidates.filter((sentence) => !PROCESS_PREFIX.test(sentence))
  const selected: string[] = []
  for (const sentence of informative.length > 0 ? informative : candidates) {
    const next = selected.length === 0 ? sentence : `${selected.join('\n')}\n${sentence}`
    if (next.length > STAGE_PROGRESS_MAX_CHARS) break
    selected.push(sentence)
    if (selected.length === 2) break
  }

  return fitToLimit(selected.join('\n') || normalized)
}
