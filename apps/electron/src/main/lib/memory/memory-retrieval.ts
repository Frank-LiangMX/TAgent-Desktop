import type { SessionMemoryRecord } from './memory-layer-service'

const MAX_RECALL_HITS = 3
const MAX_RECALL_CHARS_PER_HIT = 420

function parseKeyFacts(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const facts = JSON.parse(raw)
    return Array.isArray(facts) ? facts.filter((fact): fact is string => typeof fact === 'string') : []
  } catch {
    return []
  }
}

/**
 * 将跨会话 L4 命中整理为受控上下文。只在问题具有足够语义信息时注入，
 * 且永远排除当前会话，避免模型把自己的上一轮摘要反复当作新事实。
 */
export function buildMemoryRecallContext(
  query: string,
  records: readonly SessionMemoryRecord[],
  currentSessionId: string,
): string {
  if (query.trim().length < 6) return ''

  const entries = records
    .filter((record) => record.session_slug !== currentSessionId)
    .map((record) => {
      const facts = parseKeyFacts(record.key_facts)
      const text = [record.title, record.summary, facts.length > 0 ? `关键事实：${facts.join('；')}` : '']
        .filter(Boolean)
        .join('\n')
        .slice(0, MAX_RECALL_CHARS_PER_HIT)
      return { source: record.session_slug || String(record.id), text }
    })
    .filter((entry) => entry.text.length > 0)
    .slice(0, MAX_RECALL_HITS)

  if (entries.length === 0) return ''
  const body = entries.map((entry, index) => `${index + 1}. [L4:${entry.source}] ${entry.text}`).join('\n\n')
  return `## 相关记忆（按需检索）\n\n${body}\n\n以上内容来自已完成会话，仅在与当前问题相关时参考；如与当前要求冲突，以当前要求为准。`
}
