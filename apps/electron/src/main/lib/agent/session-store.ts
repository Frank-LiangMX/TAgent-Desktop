/**
 * 会话持久化服务（精简版，从 TAgent agent-session-manager.ts 按需搬移）
 *
 * 不搬 TAgent 的 1642 行（含 fork/rewind/TA 隔离等），只做核心：
 * - 会话索引（~/.tagent/agent-sessions.json）读写
 * - 会话元数据 CRUD（AgentSessionMeta 核心字段）
 * - 消息 JSONL 追加（~/.tagent/agent-sessions/{id}.jsonl）
 * - resume session_id 存取（长驻首次 spawn 时读历史）
 *
 * 见 docs/decisions/ADR-0002-longlived-process.md。
 * 长驻下：首次 spawn 带 resumeSessionId（SDK 读 JSONL 一次），之后靠内存；
 * SDK persistSession=true 每轮追加写 JSONL，崩溃后可 resume 恢复。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AgentSessionMeta, SDKMessage } from '@tagent/shared'
import {
  getAgentSessionsIndexPath,
  getAgentSessionMessagesPath,
  getAgentSessionsDir,
} from '../config/config-paths'

/** 读会话索引（全部） */
export function listSessions(): AgentSessionMeta[] {
  const path = getAgentSessionsIndexPath()
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgentSessionMeta[]
  } catch {
    return []
  }
}

/** 写会话索引（全部） */
function writeSessions(sessions: AgentSessionMeta[]): void {
  writeFileSync(getAgentSessionsIndexPath(), JSON.stringify(sessions, null, 2), 'utf8')
}

/** 获取单会话元数据 */
export function getSessionMeta(id: string): AgentSessionMeta | undefined {
  return listSessions().find((s) => s.id === id)
}

/** 创建会话 */
export function createSession(input: {
  /** 会话 ID（不传则随机生成） */
  id?: string
  title?: string
  channelId?: string
  modelId?: string
  workspaceId?: string
  mode?: 'general' | 'ta'
}): AgentSessionMeta {
  const meta: AgentSessionMeta = {
    id: input.id ?? randomUUID(),
    title: input.title ?? '新会话',
    mode: input.mode ?? 'general',
    channelId: input.channelId,
    modelId: input.modelId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const sessions = listSessions()
  sessions.push(meta)
  writeSessions(sessions)
  return meta
}

/** 更新会话元数据（部分字段，合并写） */
export function updateSessionMeta(
  id: string,
  patch: Partial<AgentSessionMeta>
): AgentSessionMeta | undefined {
  const sessions = listSessions()
  const idx = sessions.findIndex((s) => s.id === id)
  const existing = idx === -1 ? undefined : sessions[idx]
  if (!existing) return undefined
  const updated: AgentSessionMeta = {
    ...existing,
    ...patch,
    id: existing.id, // id 不可改
    updatedAt: Date.now(),
  }
  sessions[idx] = updated
  writeSessions(sessions)
  return updated
}

/** 删除会话（元数据 + JSONL） */
export function deleteSession(id: string): void {
  const sessions = listSessions().filter((s) => s.id !== id)
  writeSessions(sessions)
  const msgPath = getAgentSessionMessagesPath(id)
  if (existsSync(msgPath)) {
    try {
      const { rmSync } = require('node:fs')
      rmSync(msgPath, { force: true })
    } catch {
      /* 忽略 */
    }
  }
}

/** 追加 SDKMessage 到会话 JSONL（持久化消息） */
export function appendMessages(sessionId: string, messages: SDKMessage[]): void {
  if (messages.length === 0) return
  const path = getAgentSessionMessagesPath(sessionId)
  const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
  appendFileSync(path, lines, 'utf8')
}

/** 读会话历史 JSONL（加载时用，长驻首次 spawn 前） */
export function readMessages(sessionId: string): SDKMessage[] {
  const path = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  return lines.map((l) => {
    try {
      return JSON.parse(l) as SDKMessage
    } catch {
      return null
    }
  }).filter(Boolean) as SDKMessage[]
}
