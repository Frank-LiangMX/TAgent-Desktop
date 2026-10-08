/** 阶段进度摘要的硬上限；完整 thinking 和最终回答不受此限制。 */
export const STAGE_PROGRESS_MAX_CHARS = 80

/**
 * 文案比较用的停用词。阶段摘要允许模型带一点连接词，但这些词不应该
 * 让“根因很像……”和“根因很清楚……”被误判成两条新进展。
 */
const PROGRESS_COMPARISON_STOP_WORDS = new Set([
  '然后',
  '接着',
  '接下来',
  '现在',
  '目前',
  '已经',
  '已',
  '很像',
  '很清楚',
  '清楚了',
  '看起来',
  '我先',
  '我再',
  '再',
  '也',
  '被',
  '算进',
  '当成',
  '就会',
  '开始',
  '准备',
])

const PROCESS_PREFIX = /^(?:我(?:先|会|将|准备|想|需要|来|再)|让我|接下来|然后|现在|换个|等等|可能|应该|不过|另外|先别)/u
const COMMAND_LINE = /^(?:[$>#]|PS>|(?:运行|执行|调用|输入|打开|查看).*(?:命令|脚本|终端|PowerShell))/iu
const PROGRESS_NEGATION = /(?:还没|尚未|没有|没进展|没通|没能|未(?:能|返回|通|显示)?|不(?:能|通|见)|只是)/u

/** 中文阶段文案常把同一事实换成“查询/查到/解析”或“视口/显示/看见”。 */
const PROGRESS_SEMANTIC_GROUPS = [
  {
    key: 'query',
    terms: ['查询', '查阅', '查到', '查得', '解析', '链路', '返回', '读取', '读', '检索', '搜索', '文件'],
  },
  {
    key: 'entity',
    terms: ['标签', 'actor', '场景', '网格', '对象', '实体', '节点'],
  },
  {
    key: 'viewport',
    terms: ['视口', 'viewport', '显示', '看见', '看得到', '看到', '可见', '画面', '渲染', 'details'],
  },
  {
    key: 'loop',
    terms: ['软提醒', '复盘', '没进展', '强制'],
  },
] as const

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

function normalizeForProgressComparison(text: string): string {
  let value = text
    .toLocaleLowerCase()
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/[「」『』【】()[\]{}<>《》“”‘’"'`*_#:：,，。.!！？?；;、/\\|+：-]/gu, '')
    .replace(/\s+/gu, '')

  for (const word of PROGRESS_COMPARISON_STOP_WORDS) {
    value = value.replaceAll(word, '')
  }
  return value
}

function semanticProgressGroups(text: string): Set<string> {
  const normalized = text.toLocaleLowerCase()
  return new Set(
    PROGRESS_SEMANTIC_GROUPS
      .filter((group) => group.terms.some((term) => normalized.includes(term)))
      .map((group) => group.key),
  )
}

/** 文件名、数字等具体证据改变时，阶段摘要必须保留。 */
function concreteProgressMarkers(text: string): Set<string> {
  const normalized = text.toLocaleLowerCase()
  return new Set([
    ...(normalized.match(/[a-z0-9_./\\-]+\.[a-z0-9]{1,8}/giu) ?? []),
    // “第 3 批 / 2 次”是循环叙述，不是新证据；文件版本、端口和结果数字仍保留。
    ...(normalized.match(/\d+(?:\.\d+)?(?!\s*[批次个条])/gu) ?? []),
  ])
}

function bigrams(value: string): Set<string> {
  const result = new Set<string>()
  for (let i = 0; i < value.length - 1; i++) {
    result.add(value.slice(i, i + 2))
  }
  return result
}

/**
 * 判断两条阶段进度是否只是同一结论的改写。
 *
 * 不做全文 includes：文件名、数字或验证结果变化时仍应保留新进展。
 * 这里用归一化后的二元片段重合度，只作为“阶段进度”的抑噪器，最终回答
 * 不调用它。短句必须精确相同或前缀包含，避免把“读取 a.ts / 读取 b.ts”吞掉。
 */
export function isNearDuplicateStageProgress(left: string, right: string): boolean {
  const a = normalizeForProgressComparison(left)
  const b = normalizeForProgressComparison(right)
  if (!a || !b) return false
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true

  const leftMarkers = concreteProgressMarkers(left)
  const rightMarkers = concreteProgressMarkers(right)
  if (leftMarkers.size > 0 || rightMarkers.size > 0) {
    const sameMarkers =
      leftMarkers.size === rightMarkers.size &&
      [...leftMarkers].every((marker) => rightMarkers.has(marker))
    if (!sameMarkers) return false
  }

  const leftIsNegative = PROGRESS_NEGATION.test(left)
  const rightIsNegative = PROGRESS_NEGATION.test(right)
  // “视口没通”到“视口已正常显示”是新证据，不是改写；先挡住后面的
  // 片段相似度和语义分组，避免只因主体名词相同而去重。
  if (leftIsNegative !== rightIsNegative) return false

  // 比二元片段更能覆盖中文同义改写，例如“标签能查到，但视口没通”与
  // “查询链路有了，视口显示还没有”。两边都在说同一个未打通的视口事实，
  // 且没有新的文件/数字证据时，只保留第一条导航摘要。
  const leftGroups = semanticProgressGroups(left)
  const rightGroups = semanticProgressGroups(right)
  const sharedGroups = [...leftGroups].filter((group) => rightGroups.has(group))
  if (
    leftIsNegative &&
    rightIsNegative &&
    (sharedGroups.includes('viewport') || sharedGroups.length >= 2)
  ) {
    return true
  }

  if (Math.min(a.length, b.length) < 12) return false

  const leftPairs = bigrams(a)
  const rightPairs = bigrams(b)
  if (leftPairs.size === 0 || rightPairs.size === 0) return false
  let shared = 0
  for (const pair of leftPairs) {
    if (rightPairs.has(pair)) shared++
  }
  const overlap = shared / Math.min(leftPairs.size, rightPairs.size)
  return shared >= 4 && overlap >= 0.5
}
