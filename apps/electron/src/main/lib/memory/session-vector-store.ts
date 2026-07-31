/**
 * 本会话向量存储（Phase 3.3 / 增强）
 *
 * 纯 JS JSON + 余弦相似度；embedding 走渠道 API（memory-llm-client.embedTexts）。
 * 路径：projects/{slug}/{sessionId}.vectors.json；无 workspace 时 agent-sessions/{id}.vectors.json
 * 短会话（< 阈值条数）不建库。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentSessionsDir, getProjectDir } from '../config/config-paths'
import { embedTexts } from './memory-llm-client'

const MIN_CHUNKS_TO_INDEX = 4
const MAX_CHUNKS = 200

export interface VectorChunk {
  id: string
  text: string
  turnHint?: string
  embedding: number[]
  createdAt: number
}

interface VectorFile {
  sessionId: string
  chunks: VectorChunk[]
}

function resolvePath(workspaceId: string | undefined, sessionId: string): string {
  if (workspaceId) {
    return join(getProjectDir(workspaceId), `${sessionId}.vectors.json`)
  }
  return join(getAgentSessionsDir(), `${sessionId}.vectors.json`)
}

function readFile(path: string): VectorFile | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as VectorFile
  } catch {
    return null
  }
}

function writeFile(path: string, data: VectorFile): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data), 'utf8')
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d > 0 ? dot / d : 0
}

/**
 * 将压出窗口的原文段写入本会话向量库。
 * embedding 失败时静默跳过（不抛）。
 */
export async function indexSessionChunks(opts: {
  workspaceId?: string
  sessionId: string
  chunks: Array<{ id: string; text: string; turnHint?: string }>
}): Promise<number> {
  const fresh = opts.chunks
    .map((c) => ({ ...c, text: c.text.trim().slice(0, 2000) }))
    .filter((c) => c.text.length > 20)
  if (fresh.length === 0) return 0

  const path = resolvePath(opts.workspaceId, opts.sessionId)
  const existing = readFile(path) ?? { sessionId: opts.sessionId, chunks: [] }
  const known = new Set(existing.chunks.map((c) => c.id))
  const toAdd = fresh.filter((c) => !known.has(c.id))
  if (toAdd.length === 0) return 0

  // 累计过少则等下一轮
  if (existing.chunks.length + toAdd.length < MIN_CHUNKS_TO_INDEX && existing.chunks.length === 0) {
    // 仍写入无向量占位？跳过，等够数再 embed
    if (existing.chunks.length + toAdd.length < MIN_CHUNKS_TO_INDEX) {
      // 暂存纯文本，embedding 空，检索时过滤
      for (const c of toAdd) {
        existing.chunks.push({
          id: c.id,
          text: c.text,
          turnHint: c.turnHint,
          embedding: [],
          createdAt: Date.now(),
        })
      }
      existing.chunks = existing.chunks.slice(-MAX_CHUNKS)
      writeFile(path, existing)
      return 0
    }
  }

  const needEmbed = [
    ...existing.chunks.filter((c) => c.embedding.length === 0),
    ...toAdd.map((c) => ({
      id: c.id,
      text: c.text,
      turnHint: c.turnHint,
      embedding: [] as number[],
      createdAt: Date.now(),
    })),
  ]
  // 合并 toAdd 到 existing（无 embedding 的）
  for (const c of toAdd) {
    if (!known.has(c.id)) {
      existing.chunks.push({
        id: c.id,
        text: c.text,
        turnHint: c.turnHint,
        embedding: [],
        createdAt: Date.now(),
      })
    }
  }

  const pending = existing.chunks.filter((c) => c.embedding.length === 0)
  if (pending.length === 0) {
    writeFile(path, existing)
    return 0
  }

  const vectors = await embedTexts(pending.map((p) => p.text))
  if (!vectors) {
    writeFile(path, { sessionId: opts.sessionId, chunks: existing.chunks.slice(-MAX_CHUNKS) })
    return 0
  }
  for (let i = 0; i < pending.length; i++) {
    const emb = vectors[i]
    if (emb) pending[i]!.embedding = emb
  }
  existing.chunks = existing.chunks.slice(-MAX_CHUNKS)
  writeFile(path, existing)
  return pending.filter((p) => p.embedding.length > 0).length
  void needEmbed
}

/** 本会话向量检索 top-k */
export async function searchSessionVectors(opts: {
  workspaceId?: string
  sessionId: string
  query: string
  topK?: number
}): Promise<Array<{ id: string; text: string; score: number; turnHint?: string }>> {
  const path = resolvePath(opts.workspaceId, opts.sessionId)
  const file = readFile(path)
  if (!file?.chunks.length) return []
  const withEmb = file.chunks.filter((c) => c.embedding.length > 0)
  if (withEmb.length === 0) {
    // 无向量：关键词降级
    const q = opts.query.toLowerCase()
    return file.chunks
      .filter((c) => c.text.toLowerCase().includes(q.slice(0, 20)))
      .slice(0, opts.topK ?? 3)
      .map((c) => ({ id: c.id, text: c.text, score: 0.5, turnHint: c.turnHint }))
  }
  const qv = await embedTexts([opts.query.slice(0, 2000)])
  if (!qv?.[0]) {
    return []
  }
  const queryVec = qv[0]
  const scored = withEmb
    .map((c) => ({
      id: c.id,
      text: c.text,
      turnHint: c.turnHint,
      score: cosine(queryVec, c.embedding),
    }))
    .filter((c) => c.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK ?? 3)
  return scored
}
