import * as fs from 'node:fs'
import * as path from 'node:path'

import type { SessionMemoryRecord } from './memory-layer-service'
import { getMemoryDir, type MemoryMode } from './memory-layer-service'
import { getProjectMemoryDir } from '../config/config-paths'

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


export interface MemoryRecallHit {
  source: string
  text: string
  score?: number
}

interface MemoryRecallEntry extends MemoryRecallHit {
  source: 'L3' | 'L5'
}

const MAX_LONG_TERM_FILE_BYTES = 512 * 1024

function readMemoryFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size > MAX_LONG_TERM_FILE_BYTES) return ''
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function queryTerms(query: string): string[] {
  const terms: string[] = []
  for (const part of query.toLocaleLowerCase().match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (/^[\u4e00-\u9fff]+$/.test(part)) {
      for (let i = 0; i < part.length - 1; i++) terms.push(part.slice(i, i + 2))
    } else {
      terms.push(part)
    }
  }
  return [...new Set(terms)]
}

/** 对 L3/L5 做轻量词面召回；没有命中时不向模型注入全局记忆。 */
export function rankMemoryRecallEntries(
  query: string,
  entries: readonly MemoryRecallEntry[],
  limit = 3,
): MemoryRecallHit[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return []

  return entries
    .map((entry) => {
      const text = entry.text.toLocaleLowerCase()
      const matched = terms.filter((term) => text.includes(term))
      const score = matched.reduce((sum, term) => sum + (term.length >= 3 ? 2 : 1), 0)
      return { ...entry, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.source === b.source ? 0 : a.source === 'L3' ? -1 : 1))
    .slice(0, limit)
    .map(({ source, text, score }) => ({ source, text, score }))
}

/** 从持久化的 L3/L5 读取候选，再按当前问题相关性召回。 */
export function searchLongTermMemory(
  mode: MemoryMode,
  query: string,
  limit = 3,
  options?: { workspaceSlug?: string },
): MemoryRecallHit[] {
  if (query.trim().length < 6) return []
  const dir = getMemoryDir(mode)
  const memoryDirs = [
    dir,
    ...(options?.workspaceSlug ? [getProjectMemoryDir(options.workspaceSlug)] : []),
  ]
  const entries: MemoryRecallEntry[] = []

  for (const memoryDir of memoryDirs) {
    for (const [index, line] of readMemoryFile(path.join(memoryDir, 'corrections.jsonl')).split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as { correction?: unknown; context?: unknown; timestamp?: unknown; scope?: unknown; workspaceSlug?: unknown; status?: unknown }
      if (record.status && record.status !== 'active') continue
      if (options?.workspaceSlug && record.scope === 'project' && record.workspaceSlug !== options.workspaceSlug) continue
      if (typeof record.correction !== 'string' || !record.correction.trim()) continue
      const context = typeof record.context === 'string' ? `\n依据：${record.context.slice(0, 260)}` : ''
      entries.push({ source: 'L3', text: `${record.correction.trim()}${context}`, score: index })
    } catch {
      // 忽略历史损坏行，不能让记忆检索影响当前会话。
  }
    }
  }

  for (const memoryDir of memoryDirs) {
    const lines = readMemoryFile(path.join(memoryDir, 'L5_insights.md')).split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      const match = line.match(/^[-*]\s+(?:\[[^\]]+\]\s+)?(.+?)\s*$/)
      const text = match?.[1]
      if (!text || text.startsWith('<!--')) continue

      const metadataLine = lines[index + 1] ?? ''
      const metadataMatch = metadataLine.match(/^\s*<!--\s*(\{.*\})\s*-->\s*$/)
      let metadata: { scope?: unknown; workspaceSlug?: unknown } = {}
      if (metadataMatch?.[1]) {
        try {
          metadata = JSON.parse(metadataMatch[1]) as typeof metadata
        } catch {
          // Ignore malformed optional metadata.
        }
      }
      if (
        options?.workspaceSlug &&
        metadata.scope === 'project' &&
        metadata.workspaceSlug !== options.workspaceSlug
      ) {
        continue
      }
      entries.push({ source: 'L5', text: text.trim() })
    }
  }

  return rankMemoryRecallEntries(query, entries, limit)
}
/**
 * 将跨会话 L4 命中整理为受控上下文。只在问题具有足够语义信息时注入，
 * 且永远排除当前会话，避免模型把自己的上一轮摘要反复当作新事实。
 */
export function buildMemoryRecallContext(
  query: string,
  records: readonly SessionMemoryRecord[],
  currentSessionId: string,
  options?: { mode?: MemoryMode; workspaceSlug?: string },
): string {
  if (query.trim().length < 6) return ''

  const l4Entries = records
    .filter((record) => record.session_slug !== currentSessionId && (!options?.workspaceSlug || !record.workspace_slug || record.workspace_slug === options.workspaceSlug))
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

  const entries = [
    ...(options?.mode ? searchLongTermMemory(options.mode, query, 2, { workspaceSlug: options.workspaceSlug }) : []),
    ...l4Entries.map((entry) => ({ ...entry, source: `L4:${entry.source}` })),
  ].slice(0, MAX_RECALL_HITS)

  if (entries.length === 0) return ''
  const body = entries.map((entry, index) => `${index + 1}. [${entry.source}] ${entry.text}`).join('\n\n')
  return `## 相关记忆（按需检索）\n\n${body}\n\n以上内容来自已完成会话或已确认记忆，仅在与当前问题相关时参考；如与当前要求冲突，以当前要求为准。`
}
