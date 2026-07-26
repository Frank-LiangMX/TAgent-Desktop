/**
 * 会话持久化服务（2.0 workspace 组织版）
 *
 * 核心改动：会话数据按 workspace 组织存储。
 * - 新会话 JSONL 存 ~/.tagent/projects/{workspaceId}/{sessionId}.jsonl
 * - 旧会话（无 workspaceId）fallback 到 ~/.tagent/agent-sessions/{sessionId}.jsonl
 * - 索引 agent-sessions.json 格式不变，每个 session meta 多了 workspaceId 字段
 *
 * 见 docs/decisions/ADR-0002-longlived-process.md。
 * 长驻下：首次 spawn 带 resumeSessionId（SDK 读 JSONL 一次），之后靠内存；
 * SDK persistSession=true 每轮追加写 JSONL，崩溃后可 resume 恢复。
 *
 * 索引格式与 TAgent_General 1.x 一致：{ version: 1, sessions: AgentSessionMeta[] }
 * —— dev 模式共享 ~/.tagent-dev/，必须对齐格式，否则 1.x 写的对象 2.0 读成数组会崩。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentSessionMeta, SDKMessage } from '@tagent/shared'
import {
  getAgentSessionsIndexPath,
  getAgentSessionMessagesPath,
  getAgentSessionsDir,
  getProjectSessionPath,
} from '../config/config-paths'

/** 索引版本号（与 1.x 一致） */
const INDEX_VERSION = 1

/** 索引文件结构 */
interface AgentSessionsIndex {
  version: number
  sessions: AgentSessionMeta[]
}

/** 读索引文件（容错：格式不符回退空索引） */
function readIndex(): AgentSessionsIndex {
  const path = getAgentSessionsIndexPath()
  if (!existsSync(path)) return { version: INDEX_VERSION, sessions: [] }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    // 1.x 是 { version, sessions } 对象；偶发纯数组（早期 2.0 误写）也兜底
    if (Array.isArray(parsed)) {
      return { version: INDEX_VERSION, sessions: parsed as AgentSessionMeta[] }
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as AgentSessionsIndex).sessions)) {
      return parsed as AgentSessionsIndex
    }
    return { version: INDEX_VERSION, sessions: [] }
  } catch {
    return { version: INDEX_VERSION, sessions: [] }
  }
}

/** 写索引文件 */
function writeIndex(index: AgentSessionsIndex): void {
  writeFileSync(getAgentSessionsIndexPath(), JSON.stringify(index, null, 2), 'utf8')
}

/** 读会话索引（全部，对外暴露纯数组） */
export function listSessions(): AgentSessionMeta[] {
  return readIndex().sessions
}

/** 获取单会话元数据 */
export function getSessionMeta(id: string): AgentSessionMeta | undefined {
  return readIndex().sessions.find((s) => s.id === id)
}

/** 创建会话 */
export function createSession(input: {
  /** 会话 ID（不传则随机生成） */
  id?: string
  title?: string
  channelId?: string
  modelId?: string
  /** 工作区 ID（= sanitizePath(projectPath)，如 'F--TAgent-General'） */
  workspaceId?: string
  mode?: 'general' | 'ta'
  /** 初始轮数（首条消息时传 1） */
  turnCount?: number
}): AgentSessionMeta {
  const meta: AgentSessionMeta = {
    id: input.id ?? randomUUID(),
    title: input.title ?? '新会话',
    mode: input.mode ?? 'general',
    channelId: input.channelId,
    modelId: input.modelId,
    workspaceId: input.workspaceId,
    turnCount: input.turnCount,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const index = readIndex()
  index.sessions.push(meta)
  writeIndex(index)
  return meta
}

/** 更新会话元数据（部分字段，合并写） */
export function updateSessionMeta(
  id: string,
  patch: Partial<AgentSessionMeta>
): AgentSessionMeta | undefined {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)
  const existing = idx === -1 ? undefined : index.sessions[idx]
  if (!existing) return undefined
  const updated: AgentSessionMeta = {
    ...existing,
    ...patch,
    id: existing.id, // id 不可改
    updatedAt: Date.now(),
  }
  index.sessions[idx] = updated
  writeIndex(index)
  return updated
}

/** 删除会话（元数据 + JSONL，兼容新旧路径） */
export function deleteSession(id: string): void {
  const index = readIndex()
  const meta = index.sessions.find((s) => s.id === id)
  index.sessions = index.sessions.filter((s) => s.id !== id)
  writeIndex(index)
  // 删除 JSONL：优先删新路径，也删旧路径（兜底迁移前残留）
  const pathsToDelete = meta?.workspaceId
    ? [getProjectSessionPath(meta.workspaceId, id), getAgentSessionMessagesPath(id)]
    : [getAgentSessionMessagesPath(id)]
  for (const msgPath of pathsToDelete) {
    if (existsSync(msgPath)) {
      try {
        const { rmSync } = require('node:fs')
        rmSync(msgPath, { force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 解析会话 JSONL 路径：有 workspaceId 走新路径，否则走旧路径 */
function resolveSessionPath(workspaceId: string | undefined, sessionId: string): string {
  if (workspaceId) {
    return getProjectSessionPath(workspaceId, sessionId)
  }
  return getAgentSessionMessagesPath(sessionId)
}

/** 追加 SDKMessage 到会话 JSONL（持久化消息） */
export function appendMessages(workspaceId: string | undefined, sessionId: string, messages: SDKMessage[]): void {
  if (messages.length === 0) return
  const path = resolveSessionPath(workspaceId, sessionId)
  // 确保目录存在（新路径下 projects/{workspaceId}/ 可能首次写入）
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
  appendFileSync(path, lines, 'utf8')
}

/** 读会话历史 JSONL（加载时用，长驻首次 spawn 前）
 *
 * 兼容旧数据：优先读新路径，不存在时 fallback 到旧路径。
 */
export function readMessages(workspaceId: string | undefined, sessionId: string): SDKMessage[] {
  // 有 workspaceId 时优先读新路径，不存在则 fallback 旧路径
  const path = workspaceId
    ? getProjectSessionPath(workspaceId, sessionId)
    : getAgentSessionMessagesPath(sessionId)
  const fallbackPath = workspaceId ? getAgentSessionMessagesPath(sessionId) : undefined

  let filePath = path
  if (!existsSync(filePath) && fallbackPath && existsSync(fallbackPath)) {
    filePath = fallbackPath
  }
  if (!existsSync(filePath)) return []
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  return lines.map((l) => {
    try {
      return JSON.parse(l) as SDKMessage
    } catch {
      return null
    }
  }).filter(Boolean) as SDKMessage[]
}
