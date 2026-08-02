/**
 * 会话持久化服务（2.0 workspace 组织版 + Phase 1.2 JSONL 分离）
 *
 * 核心改动：会话数据按 workspace 组织存储。
 * - SDK JSONL：~/.tagent/projects/{workspaceId}/{sessionId}.jsonl（可压缩重写，SDK resume）
 * - 面板消息：~/.tagent/projects/{workspaceId}/{sessionId}.messages.jsonl（只追加，永不压缩）
 * - 旧会话（无 workspaceId）fallback 到 ~/.tagent/agent-sessions/{sessionId}.jsonl(.messages.jsonl)
 * - 索引 agent-sessions.json 格式不变，每个 session meta 多了 workspaceId 字段
 *
 * 见 docs/decisions/ADR-0002-longlived-process.md、.context/memory-phase1-data-foundation.md §1.2。
 * 长驻下：首次 spawn 带 resumeSessionId（SDK 读 JSONL 一次），之后靠内存；
 * SDK persistSession=true 每轮追加写 JSONL，崩溃后可 resume 恢复。
 *
 * 索引格式与 TAgent_General 1.x 一致：{ version: 1, sessions: AgentSessionMeta[] }
 * —— dev 模式共享 ~/.tagent-dev/，必须对齐格式，否则 1.x 写的对象 2.0 读成数组会崩。
 */
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentSessionMeta } from '@tagent/shared'
import { DEFAULT_EXECUTION_MODE } from '@tagent/shared'
import {
  getAgentSessionsIndexPath,
  getAgentSessionMessagesPath,
  getAgentSessionPanelMessagesPath,
  getAgentSessionsDir,
  getProjectSessionPath,
  getProjectMessagesPath,
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

/** 看板工人 / 隐藏会话：不进侧栏 */
export function isHiddenSessionMeta(s: Pick<AgentSessionMeta, 'id' | 'hidden' | 'sourceKanbanTaskId' | 'parentBoardId'>): boolean {
  if (s.hidden === true) return true
  if (s.sourceKanbanTaskId) return true
  if (s.parentBoardId) return true
  if (typeof s.id === 'string' && s.id.startsWith('kw_')) return true
  return false
}

/**
 * 读会话索引。
 * 默认排除看板工人等 hidden 会话，避免污染侧栏。
 */
export function listSessions(opts?: { includeHidden?: boolean }): AgentSessionMeta[] {
  const all = readIndex().sessions
  if (opts?.includeHidden) return all
  return all.filter((s) => !isHiddenSessionMeta(s))
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
    /** 新建会话默认 Chat（只读讨论）；旧会话无字段读时 migrate → work */
    executionMode: DEFAULT_EXECUTION_MODE,
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

/** 删除单个会话的 SDK JSONL + 面板消息 JSONL，兼容新旧路径。 */
function deleteSessionFiles(meta: AgentSessionMeta): void {
  const pathsToDelete = meta.workspaceId
    ? [
        getProjectSessionPath(meta.workspaceId, meta.id),
        getProjectMessagesPath(meta.workspaceId, meta.id),
        getAgentSessionMessagesPath(meta.id),
        getAgentSessionPanelMessagesPath(meta.id),
      ]
    : [
        getAgentSessionMessagesPath(meta.id),
        getAgentSessionPanelMessagesPath(meta.id),
      ]
  for (const msgPath of pathsToDelete) {
    if (existsSync(msgPath)) {
      try {
        rmSync(msgPath, { force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 删除会话（元数据 + JSONL，兼容新旧路径） */
export function deleteSession(id: string): void {
  const index = readIndex()
  const meta = index.sessions.find((s) => s.id === id)
  index.sessions = index.sessions.filter((s) => s.id !== id)
  writeIndex(index)
  if (meta) deleteSessionFiles(meta)
}

/** 批量删除工作区下的全部会话，返回已删除的会话 ID。 */
export function deleteSessionsByWorkspace(workspaceId: string): string[] {
  const index = readIndex()
  const targets = index.sessions.filter((session) => session.workspaceId === workspaceId)
  if (targets.length === 0) return []

  const targetIds = new Set(targets.map((session) => session.id))
  index.sessions = index.sessions.filter((session) => !targetIds.has(session.id))
  writeIndex(index)
  for (const session of targets) deleteSessionFiles(session)
  return targets.map((session) => session.id)
}

/** 解析 SDK JSONL 路径：有 workspaceId 走项目路径，否则走旧 agent-sessions 路径 */
function resolveSdkSessionPath(workspaceId: string | undefined, sessionId: string): string {
  if (workspaceId) {
    return getProjectSessionPath(workspaceId, sessionId)
  }
  return getAgentSessionMessagesPath(sessionId)
}

/** 解析面板消息 JSONL 路径 */
function resolvePanelMessagesPath(workspaceId: string | undefined, sessionId: string): string {
  if (workspaceId) {
    return getProjectMessagesPath(workspaceId, sessionId)
  }
  return getAgentSessionPanelMessagesPath(sessionId)
}

/** 确保父目录存在后追加 JSONL 行 */
function appendJsonl(path: string, messages: unknown[]): void {
  if (messages.length === 0) return
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
  appendFileSync(path, lines, 'utf8')
}

/** 读 JSONL 文件为 unknown[]（坏行跳过） */
function readJsonlFile(filePath: string): unknown[] {
  if (!existsSync(filePath)) return []
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  return lines
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/**
 * 追加到 SDK JSONL（可压缩重写）。kscc resume / 软重置压缩用。
 */
export function appendSdkMessages(
  workspaceId: string | undefined,
  sessionId: string,
  messages: unknown[],
): void {
  appendJsonl(resolveSdkSessionPath(workspaceId, sessionId), messages)
}

/**
 * 追加到面板消息 JSONL（只追加，永不压缩）。面板历史 / L-rag 原文用。
 */
export function appendPanelMessages(
  workspaceId: string | undefined,
  sessionId: string,
  messages: unknown[],
): void {
  appendJsonl(resolvePanelMessagesPath(workspaceId, sessionId), messages)
}

/**
 * 全量重写 SDK JSONL（compactor / 软重置影子 B 用）。
 * 面板那份**没有**对应 write 方法——只追加。
 */
export function writeSdkMessages(
  workspaceId: string | undefined,
  sessionId: string,
  messages: unknown[],
): void {
  const path = resolveSdkSessionPath(workspaceId, sessionId)
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  if (messages.length === 0) {
    writeFileSync(path, '', 'utf8')
    return
  }
  const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
  writeFileSync(path, lines, 'utf8')
}

/**
 * 读 SDK JSONL（resume / 软重置压缩读 A）。
 * 兼容：workspace 新路径不存在时 fallback 旧 agent-sessions 路径。
 */
export function readSdkMessages(workspaceId: string | undefined, sessionId: string): unknown[] {
  const primary = resolveSdkSessionPath(workspaceId, sessionId)
  if (existsSync(primary)) return readJsonlFile(primary)
  if (workspaceId) {
    const legacy = getAgentSessionMessagesPath(sessionId)
    if (existsSync(legacy)) return readJsonlFile(legacy)
  }
  return []
}

/**
 * 读面板消息 JSONL（GET_SDK_MESSAGES / L-rag 原文）。
 * 兼容迁移期：面板份不存在时 fallback 读 SDK JSONL（老会话只有一份）。
 */
export function readPanelMessages(workspaceId: string | undefined, sessionId: string): unknown[] {
  const primary = resolvePanelMessagesPath(workspaceId, sessionId)
  if (existsSync(primary)) return readJsonlFile(primary)
  // 旧路径面板份
  if (workspaceId) {
    const legacyPanel = getAgentSessionPanelMessagesPath(sessionId)
    if (existsSync(legacyPanel)) return readJsonlFile(legacyPanel)
  }
  // 迁移期：只有 SDK JSONL 时读 SDK 份，避免面板空白
  return readSdkMessages(workspaceId, sessionId)
}

/**
 * @deprecated Phase 1.2 起请用 appendPanelMessages + appendSdkMessages 显式双写。
 * 保留为 appendSdkMessages 别名，避免外部遗漏调用点崩溃。
 */
export function appendMessages(
  workspaceId: string | undefined,
  sessionId: string,
  messages: unknown[],
): void {
  appendSdkMessages(workspaceId, sessionId, messages)
}

/**
 * @deprecated Phase 1.2 起请用 readPanelMessages（面板）或 readSdkMessages（SDK）。
 * 保留为 readPanelMessages 别名（面板优先 + fallback SDK）。
 */
export function readMessages(workspaceId: string | undefined, sessionId: string): unknown[] {
  return readPanelMessages(workspaceId, sessionId)
}
