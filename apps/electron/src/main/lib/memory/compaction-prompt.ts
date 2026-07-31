/**
 * 压缩分流 prompt（Phase 5.1 / Phase 3/4 共用）
 *
 * 一次 LLM 请求产出 summary / facts / retrievable_spans。
 */
export const COMPACTION_SPLIT_SYSTEM = `你是对话压缩助手。对用户给出的对话片段做结构化压缩，只返回 JSON，不要 markdown 围栏。`

export function buildCompactionSplitUserPrompt(dialogText: string): string {
  return `对以下对话片段做结构化压缩，返回 JSON：
{
  "summary": "逻辑骨架摘要（保留脉络，模糊细节）",
  "facts": ["关键事实1", "事实2"],
  "retrievable_spans": [{"keywords": ["k1","k2"], "anchor": "原文片段标识"}]
}

对话片段：
---
${dialogText.slice(0, 80_000)}
---`
}

export interface CompactionSplitResult {
  summary: string
  facts: string[]
  retrievable_spans: Array<{ keywords: string[]; anchor: string }>
}

/** 从 LLM 文本解析分流 JSON（容错） */
export function parseCompactionSplitResult(raw: string): CompactionSplitResult {
  const fallback: CompactionSplitResult = {
    summary: raw.slice(0, 2000) || '（摘要为空）',
    facts: [],
    retrievable_spans: [],
  }
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return fallback
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<CompactionSplitResult>
    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : fallback.summary,
      facts: Array.isArray(parsed.facts)
        ? parsed.facts.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        : [],
      retrievable_spans: Array.isArray(parsed.retrievable_spans)
        ? parsed.retrievable_spans
            .filter((s) => s && typeof s === 'object')
            .map((s) => ({
              keywords: Array.isArray((s as { keywords?: unknown }).keywords)
                ? ((s as { keywords: unknown[] }).keywords.filter((k) => typeof k === 'string') as string[])
                : [],
              anchor: String((s as { anchor?: unknown }).anchor ?? ''),
            }))
        : [],
    }
  } catch {
    return fallback
  }
}
