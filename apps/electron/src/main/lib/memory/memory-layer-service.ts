/**
 * MemoryLayerService - 记忆 5 层服务（Phase 2.1 从 TAgent_General 移植）
 *
 * 根据设计文档 §6.5 实现：
 * - L0 用户画像: L0_user.md（双视图 YAML）
 * - L1 项目画像: L1_project.md
 * - L2 稳定事实: L2_facts.md
 * - L3 纠错记录: corrections.jsonl + rules.json
 * - L4 历史会话: sessions.db（SQLite + FTS5）
 * - L5 提炼洞察: L5_insights.md
 *
 * 目录结构（Desktop 版路径见 getMemoryDir，基于 getConfigDir()）：
 * - 通用模式: ~/.tagent[-dev]/memory/
 * - TA 模式: ~/.tagent[-dev]/ta/memory/
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import Database from 'better-sqlite3'

import { getConfigDir, getProjectMemoryDir } from '../config/config-paths'
import { filterProjectMemoryMarkdown } from './memory-scope'

export { getDiscardedMemoryDir } from './discarded-memory'

/**
 * 记忆模式：通用 / TA
 */
export type MemoryMode = 'general' | 'ta'

/**
 * 获取记忆目录路径（Desktop 版）
 *
 * getConfigDir() 已处理 dev/packaged + TAGENT_CONFIG_DIR，不要用 app.isPackaged 拼 home。
 */
export function getMemoryDir(mode: MemoryMode): string {
  return mode === 'general' ? path.join(getConfigDir(), 'memory') : path.join(getConfigDir(), 'ta', 'memory')
}

/**
 * 记忆文件大小限制（P3.3，借鉴 TencentDB 5s recall 超时降级）
 *
 * 同步场景用大小限制替代超时——超过 512KB 的记忆文件跳过注入，避免卡 buildSystemPrompt。
 * 正常 L0/L1/L2 单文件 <10KB，512KB 是极端情况（比如用户手编辑或 bug 导致无限追加）。
 */
const MAX_MEMORY_FILE_SIZE = 512 * 1024 // 512KB

/** PersonaTrigger 重建用的文件 header 映射 */
const LAYER_FILE_HEADERS: Record<string, string> = {
  'L0_user.md': `# User Profile\n\n> 用户画像（半自动写入，patch-only）\n> 标签格式：- [日期] 内容 <!-- hit:N last_ref:YYYY-MM-DD src:session8 source_msgs:[msg_id] -->\n`,
  'L1_project.md': `# Project Profile & Index\n\n> 项目画像 + L1 索引层（≤30 行硬约束，<1k tokens 期望）\n> 存在性编码：只放反直觉触发词（2-4 字），禁写机制/方法/步骤\n> 详见 docs/plans/2026-07-06-silent-memory-research/TAgent_Memory_Master_Design.md §6.4.1\n`,
  'L2_facts.md': `# Facts\n\n> 稳定事实（半自动写入，patch-only）\n> 标签格式：- [日期] 内容 <!-- hit:N last_ref:YYYY-MM-DD src:session8 source_msgs:[msg_id] -->\n`,
}

/**
 * L4 会话记录类型
 *
 * 对应 sessions 表的行结构。id 由 SQLite AUTOINCREMENT 生成；
 * key_facts / tools_used 为 JSON 序列化后的字符串。
 */
export interface SessionMemoryRecord {
  id: number
  session_slug: string
  title: string
  summary: string
  key_facts: string
  tools_used: string
  mode: string | null
  workspace_slug: string | null
  created_at: number
  ended_at: number | null
}

/**
 * recordSession 写入参数
 */
export interface RecordSessionParams {
  /** 会话 UUID，写入 session_slug 列 */
  sessionId: string
  /** 会话标题（首条 user message 截断） */
  title: string
  /** 本次流的关键事件摘要（最后一条 assistant 消息截断） */
  summary: string
  /** 关键事实（v1.5 由 Reflect 提炼后回填） */
  keyFacts: string[]
  /** 本次流中使用的工具名去重列表 */
  toolsUsed: string[]
  /** 记忆模式 */
  mode: MemoryMode
  /** 工作区 slug */
  workspaceSlug: string
}

/**
 * 记忆层统计
 */
export interface MemoryLayerStats {
  l0: { exists: boolean; lines: number; lastUpdated: number | null }
  l1: { exists: boolean; lines: number; lastUpdated: number | null }
  l2: { exists: boolean; lines: number; lastUpdated: number | null }
  l3: { rawCount: number; rulesCount: number; lastUpdated: number | null }
  l4: { sessions: number; oldestDate: number | null; newestDate: number | null }
  l5: { exists: boolean; lines: number; lastUpdated: number | null }
}

/**
 * MemoryLayerService
 */
export class MemoryLayerService {
  private l4DbGeneral: Database.Database | null = null
  private l4DbTa: Database.Database | null = null

  /**
   * 初始化服务
   *
   * @param options.dbPathOverride 测试注入：覆盖默认 getMemoryDir 计算的 db 路径。
   *   生产不传，走 `~/.tagent[-dev]/memory/sessions.db`；测试可传 `:memory:` 或临时路径。
   */
  initialize(options?: { dbPathOverride?: Partial<Record<MemoryMode, string>> }): {
    success: boolean
    error?: string
  } {
    try {
      // 确保目录存在（仅在生产路径下创建；测试 :memory: 路径跳过）
      if (!options?.dbPathOverride?.general) {
        const generalDir = getMemoryDir('general')
        if (!fs.existsSync(generalDir)) {
          fs.mkdirSync(generalDir, { recursive: true })
        }
      }
      if (!options?.dbPathOverride?.ta) {
        const taDir = getMemoryDir('ta')
        if (!fs.existsSync(taDir)) {
          fs.mkdirSync(taDir, { recursive: true })
        }
      }

      // 初始化 L4 SQLite（自动建库 + schema）
      this.initL4Db('general', options?.dbPathOverride?.general)
      this.initL4Db('ta', options?.dbPathOverride?.ta)

      // eager 创建 L0/L1/L2 空文件（带 header）
      // 解决"文件从未创建"问题：原 lazy 创建依赖 Nudge toast 路径跑通，
      // 但 toast 从未真正弹过 → writeToLayer 从未触发 → 文件不存在。
      // eager 创建保证 Frozen snapshot 注入时文件存在 + 记忆页面不显示空状态。
      if (!options?.dbPathOverride?.general) {
        this.ensureLayerFiles('general')
      }
      if (!options?.dbPathOverride?.ta) {
        this.ensureLayerFiles('ta')
      }

      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[MemoryLayerService] 初始化失败:', error)
      return { success: false, error: msg }
    }
  }

  /**
   * eager 创建 L0/L1/L2 空文件（带 header）
   *
   * session 1 启动时（实际是 App 启动时）创建空 md 文件，保证：
   * 1. Frozen snapshot 注入时文件存在，不会因 fs.existsSync 返回 false 跳过注入
   * 2. 记忆页面 getStats 不返回 {exists: false}，UI 不显示空状态
   * 3. 用户可手动编辑空文件初始化偏好（不依赖 Nudge）
   *
   * 幂等：已存在的文件不覆盖（保护用户手编辑内容）。
   */
  private ensureLayerFiles(mode: MemoryMode): void {
    const dir = getMemoryDir(mode)
    const files = [
      {
        name: 'L0_user.md',
        header: `# User Profile

> 用户画像（半自动写入，patch-only）
> 标签格式：- [日期] 内容 <!-- hit:N last_ref:YYYY-MM-DD src:session8 source_msgs:[msg_id] -->
`,
      },
      {
        name: 'L1_project.md',
        header: `# Project Profile & Index

> 项目画像 + L1 索引层（≤30 行硬约束，<1k tokens 期望）
> 存在性编码：只放反直觉触发词（2-4 字），禁写机制/方法/步骤
> 详见 docs/plans/2026-07-06-silent-memory-research/TAgent_Memory_Master_Design.md §6.4.1
`,
      },
      {
        name: 'L2_facts.md',
        header: `# Facts

> 稳定事实（半自动写入，patch-only）
> 标签格式：- [日期] 内容 <!-- hit:N last_ref:YYYY-MM-DD src:session8 source_msgs:[msg_id] -->
`,
      },
    ]
    for (const { name, header } of files) {
      const filePath = path.join(dir, name)
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, header, 'utf-8')
        console.log(`[MemoryLayerService] eager 创建 ${mode}/${name}`)
      }
    }
  }

  /**
   * 初始化 L4 SQLite 数据库（可写 + 自动建库）
   *
   * - 不存在时自动创建（better-sqlite3 默认行为）
   * - 建 sessions 表 + FTS5 全文索引 + 同步触发器（幂等）
   * - WAL 模式提升并发读
   *
   * @param dbPathOverride 测试注入路径（:memory: 或临时文件）
   */
  private initL4Db(mode: MemoryMode, dbPathOverride?: string): void {
    const dbPath = dbPathOverride ?? path.join(getMemoryDir(mode), 'sessions.db')

    // 可写模式打开（不存在则创建）
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')

    // 建 schema（幂等）：sessions 主表 + FTS5 全文索引 + 触发器同步
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_slug TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        key_facts TEXT,
        tools_used TEXT,
        mode TEXT,
        workspace_slug TEXT,
        created_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_mode ON sessions(mode);

      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        title, summary, key_facts,
        content='sessions',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
        INSERT INTO sessions_fts(rowid, title, summary, key_facts)
        VALUES (new.id, new.title, new.summary, new.key_facts);
      END;

      CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, title, summary, key_facts)
        VALUES ('delete', old.id, old.title, old.summary, old.key_facts);
      END;

      CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, title, summary, key_facts)
        VALUES ('delete', old.id, old.title, old.summary, old.key_facts);
        INSERT INTO sessions_fts(rowid, title, summary, key_facts)
        VALUES (new.id, new.title, new.summary, new.key_facts);
      END;
    `)

    // 幂等加 5 个新字段（v1.5 会话合并 + 分级存储支持）
    this.addColumnIfNotExists(db, 'sessions', 'message_count', 'INTEGER DEFAULT 0')
    this.addColumnIfNotExists(db, 'sessions', 'msg_ids', "TEXT DEFAULT '[]'")
    this.addColumnIfNotExists(db, 'sessions', 'parent_session_id', 'TEXT')
    this.addColumnIfNotExists(db, 'sessions', 'is_archived', 'INTEGER DEFAULT 0')
    this.addColumnIfNotExists(db, 'sessions', 'is_old', 'INTEGER DEFAULT 0')

    if (mode === 'general') {
      this.l4DbGeneral = db
    } else {
      this.l4DbTa = db
    }
  }

  /**
   * PersonaTrigger 自修复：重建被误删的记忆文件（P3.4）
   *
   * 此方法实现"正文丢失恢复"——读 L0/L1/L2 时发现文件不存在，自动重建。
   * 只重建文件（带 header），不恢复内容。
   */
  private recreateLayerFile(mode: MemoryMode, fileName: string): void {
    const dir = getMemoryDir(mode)
    const header = LAYER_FILE_HEADERS[fileName]
    if (!header) return
    const filePath = path.join(dir, fileName)
    try {
      fs.writeFileSync(filePath, header, 'utf-8')
      console.log(`[MemoryLayerService] PersonaTrigger: ${mode}/${fileName} 重建成功`)
    } catch (e) {
      console.warn(`[MemoryLayerService] PersonaTrigger: ${mode}/${fileName} 重建失败:`, e)
    }
  }

  /**
   * 幂等加列（ALTER TABLE ADD COLUMN，已存在则跳过）
   */
  private addColumnIfNotExists(
    db: Database.Database,
    table: string,
    column: string,
    definition: string
  ): void {
    const exists = db
      .prepare(`SELECT COUNT(*) as c FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column) as { c: number }
    if (exists.c === 0) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      console.log(`[MemoryLayerService] 加列 ${table}.${column}`)
    }
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    if (this.l4DbGeneral) {
      this.l4DbGeneral.close()
      this.l4DbGeneral = null
    }
    if (this.l4DbTa) {
      this.l4DbTa.close()
      this.l4DbTa = null
    }
  }

  /**
   * 获取 L4 数据库
   */
  private getL4Db(mode: MemoryMode): Database.Database | null {
    return mode === 'general' ? this.l4DbGeneral : this.l4DbTa
  }

  /**
   * 获取记忆层统计
   */
  getStats(mode: MemoryMode): MemoryLayerStats {
    const dir = getMemoryDir(mode)

    // L0 用户画像
    const l0Path = path.join(dir, 'L0_user.md')
    const l0Exists = fs.existsSync(l0Path)
    const l0Stats = l0Exists
      ? this.getMdFileStats(l0Path)
      : { exists: false, lines: 0, lastUpdated: null }

    // L1 项目画像
    const l1Path = path.join(dir, 'L1_project.md')
    const l1Exists = fs.existsSync(l1Path)
    const l1Stats = l1Exists
      ? this.getMdFileStats(l1Path)
      : { exists: false, lines: 0, lastUpdated: null }

    // L2 稳定事实
    const l2Path = path.join(dir, 'L2_facts.md')
    const l2Exists = fs.existsSync(l2Path)
    const l2Stats = l2Exists
      ? this.getMdFileStats(l2Path)
      : { exists: false, lines: 0, lastUpdated: null }

    // L3 纠错记录
    const l3RawPath = path.join(dir, 'corrections.jsonl')
    const l3RulesPath = path.join(dir, 'rules.json')
    const l3RawExists = fs.existsSync(l3RawPath)
    const l3RulesExists = fs.existsSync(l3RulesPath)
    const l3Stats = {
      rawCount: l3RawExists ? this.countJsonlLines(l3RawPath) : 0,
      rulesCount: l3RulesExists ? this.countJsonRules(l3RulesPath) : 0,
      lastUpdated: l3RawExists ? fs.statSync(l3RawPath).mtimeMs : null,
    }

    // L4 历史会话
    const l4Stats = this.getL4Stats(mode)

    // L5 提炼洞察
    const l5Path = path.join(dir, 'L5_insights.md')
    const l5Exists = fs.existsSync(l5Path)
    const l5Stats = l5Exists
      ? this.getMdFileStats(l5Path)
      : { exists: false, lines: 0, lastUpdated: null }

    return {
      l0: { exists: l0Exists, ...l0Stats },
      l1: { exists: l1Exists, ...l1Stats },
      l2: { exists: l2Exists, ...l2Stats },
      l3: l3Stats,
      l4: l4Stats,
      l5: { exists: l5Exists, ...l5Stats },
    }
  }

  /**
   * 获取 Markdown 文件统计
   */
  private getMdFileStats(filePath: string): { lines: number; lastUpdated: number } {
    const content = fs.readFileSync(filePath, 'utf-8')
    // 只数真实条目行：排除空行、标题(#)、模板说明(>) 与分隔线(---)
    const lines = content
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('---')
      }).length
    const lastUpdated = fs.statSync(filePath).mtimeMs
    return { lines, lastUpdated }
  }

  /**
   * 计算 JSONL 行数
   */
  private countJsonlLines(filePath: string): number {
    const content = fs.readFileSync(filePath, 'utf-8')
    return content.split('\n').filter((line) => line.trim()).length
  }

  /**
   * 计算 JSON rules 数量
   */
  private countJsonRules(filePath: string): number {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const data = JSON.parse(content)
      return Array.isArray(data.rules) ? data.rules.length : 0
    } catch {
      return 0
    }
  }

  /**
   * 获取 L4 会话统计
   */
  private getL4Stats(mode: MemoryMode): {
    sessions: number
    oldestDate: number | null
    newestDate: number | null
  } {
    const db = this.getL4Db(mode)
    if (!db) {
      return { sessions: 0, oldestDate: null, newestDate: null }
    }

    try {
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM sessions')
      const countResult = countStmt.get() as { count: number }

      const dateStmt = db.prepare(
        'SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM sessions'
      )
      const dateResult = dateStmt.get() as { oldest: number | null; newest: number | null }

      return {
        sessions: countResult.count,
        oldestDate: dateResult.oldest,
        newestDate: dateResult.newest,
      }
    } catch {
      // 表可能不存在
      return { sessions: 0, oldestDate: null, newestDate: null }
    }
  }

  /**
   * 搜索 L4 会话（FTS5）
   */
  searchSessions(mode: MemoryMode, query: string, limit: number = 20, workspaceSlug?: string): SessionMemoryRecord[] {
    const db = this.getL4Db(mode)
    if (!db) {
      return []
    }

    try {
      // 检查 FTS5 表是否存在
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions_fts'"
      )
      const tableExists = tableCheck.get()
      if (!tableExists) {
        // FTS5 表不存在，fallback 到 LIKE 搜索
        return this.searchSessionsFallback(mode, query, limit, workspaceSlug)
      }

      // FTS5 搜索
      const ftsQuery = query.trim().split(/\s+/).join(' OR ')
      const stmt = db.prepare(`
        SELECT s.* FROM sessions s
        JOIN sessions_fts fts ON s.rowid = fts.rowid
        WHERE fts MATCH ?
          AND (? IS NULL OR s.workspace_slug = ? OR s.workspace_slug IS NULL OR s.workspace_slug = '')
        ORDER BY bm25(fts) ASC
        LIMIT ?
      `)
      const matches = stmt.all(ftsQuery, workspaceSlug ?? null, workspaceSlug ?? null, limit) as SessionMemoryRecord[]
      // FTS 的默认分词对中文长句召回较弱；无命中时回退到片段 LIKE 检索。
      return matches.length > 0 ? matches : this.searchSessionsFallback(mode, query, limit, workspaceSlug)
    } catch (error) {
      console.warn('[MemoryLayerService] FTS5 搜索失败，fallback:', error)
      return this.searchSessionsFallback(mode, query, limit, workspaceSlug)
    }
  }

  /**
   * LIKE 搜索（fallback）
   */
  private searchSessionsFallback(
    mode: MemoryMode,
    query: string,
    limit: number,
    workspaceSlug?: string
  ): SessionMemoryRecord[] {
    const db = this.getL4Db(mode)
    if (!db) {
      return []
    }

    try {
      const terms = buildMemoryLikeTerms(query)
      if (terms.length === 0) return []
      const predicate = terms.map(() => '(title LIKE ? OR summary LIKE ? OR key_facts LIKE ?)').join(' OR ')
      const workspacePredicate = '(? IS NULL OR workspace_slug = ? OR workspace_slug IS NULL OR workspace_slug = \'\')'
      const stmt = db.prepare(`
        SELECT * FROM sessions
        WHERE (${predicate}) AND ${workspacePredicate}
        ORDER BY created_at DESC
        LIMIT ?
      `)
      const parameters = terms.flatMap((term) => {
        const pattern = `%${term}%`
        return [pattern, pattern, pattern]
      })
      return stmt.all(...parameters, workspaceSlug ?? null, workspaceSlug ?? null, limit) as SessionMemoryRecord[]
    } catch {
      return []
    }
  }

  /**
   * 列出最近的 L4 会话
   */
  listRecentSessions(mode: MemoryMode, limit: number = 20): SessionMemoryRecord[] {
    const db = this.getL4Db(mode)
    if (!db) {
      return []
    }

    try {
      const stmt = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?')
      return stmt.all(limit) as SessionMemoryRecord[]
    } catch {
      return []
    }
  }

  /**
   * 记录一次会话到 L4 sessions.db
   *
   * 在 Agent 流结束后调用，写入会话元数据。
   * FTS5 触发器会自动同步全文索引，无需手动维护。
   *
   * 失败不抛异常，仅打印 warn —— 不影响主流程。
   */
  async recordSession(params: RecordSessionParams): Promise<void> {
    const db = this.getL4Db(params.mode)
    if (!db) {
      console.warn(`[MemoryLayerService] L4 ${params.mode} 数据库未初始化，跳过 recordSession`)
      return
    }

    try {
      const now = Date.now()

      // v1.5 会话合并：同 workspace + 同 mode + 同 session_slug + 时间间隔 <30 分钟 → UPDATE 现有会话
      const MERGE_WINDOW_MS = 30 * 60 * 1000 // 30 分钟
      const lastSession = db
        .prepare(
          `SELECT id, session_slug, tools_used, message_count, msg_ids, ended_at
           FROM sessions
           WHERE mode = ? AND workspace_slug IS ?
             AND is_archived = 0
           ORDER BY created_at DESC
           LIMIT 1`
        )
        .get(params.mode, params.workspaceSlug || null) as
        | {
            id: number
            session_slug: string
            tools_used: string
            message_count: number
            msg_ids: string
            ended_at: number
          }
        | undefined

      const canMerge =
        lastSession !== undefined &&
        lastSession.session_slug === params.sessionId &&
        now - lastSession.ended_at < MERGE_WINDOW_MS

      if (canMerge) {
        // 合并：UPDATE 现有会话
        const existingTools = JSON.parse(lastSession.tools_used || '[]') as string[]
        const mergedTools = Array.from(new Set([...existingTools, ...params.toolsUsed]))
        const existingMsgIds = JSON.parse(lastSession.msg_ids || '[]') as string[]
        const newMsgId = `msg_${now}_${Math.random().toString(36).slice(2, 8)}`
        const mergedMsgIds = [...existingMsgIds, newMsgId]

        db.prepare(
          `UPDATE sessions SET
             message_count = message_count + 1,
             msg_ids = @msg_ids,
             ended_at = @ended_at,
             summary = @summary,
             tools_used = @tools_used
           WHERE id = @id`
        ).run({
          msg_ids: JSON.stringify(mergedMsgIds),
          ended_at: now,
          summary: params.summary || null,
          tools_used: JSON.stringify(mergedTools),
          id: lastSession.id,
        })
        return
      }

      // 新建：INSERT
      const newMsgId = `msg_${now}_${Math.random().toString(36).slice(2, 8)}`
      db.prepare(
        `
        INSERT INTO sessions
          (session_slug, title, summary, key_facts, tools_used, mode, workspace_slug,
           created_at, ended_at, message_count, msg_ids)
        VALUES (@session_slug, @title, @summary, @key_facts, @tools_used, @mode, @workspace_slug,
                @created_at, @ended_at, 1, @msg_ids)
      `
      ).run({
        session_slug: params.sessionId,
        title: params.title || null,
        summary: params.summary || null,
        key_facts: JSON.stringify(params.keyFacts),
        tools_used: JSON.stringify(params.toolsUsed),
        mode: params.mode,
        workspace_slug: params.workspaceSlug || null,
        created_at: now,
        ended_at: now,
        msg_ids: JSON.stringify([newMsgId]),
      })
    } catch (error) {
      console.error('[MemoryLayerService] recordSession 失败:', error)
    }
  }

  /**
   * 读取 L0/L1/L2 记忆快照（Frozen snapshot 模式专用）
   *
   * 会话启动时由 agent 侧调用，读 L0/L1/L2 文件内容供 buildSystemPrompt 注入。
   * - 文件不存在时返回空字符串（不抛错，让上层跳过注入）
   * - 文件被误删时自动重建（PersonaTrigger P3.4 自修复）
   * - 文件过大时跳过（同步场景用大小限制替代超时降级）
   * - 只读 raw 文件内容（包含 header 注释 + 记忆条目）
   * - 不读 L3/L4/L5
   */
  readMemorySnapshot(mode: MemoryMode, workspaceSlug?: string): {
    l0User: string
    l1Project: string
    l2Facts: string
  } {
    const dir = getMemoryDir(mode)
    const readSafe = (name: string, directory = dir, recreate = true): string => {
      try {
        const filePath = path.join(directory, name)
        if (!fs.existsSync(filePath)) {
          // PersonaTrigger P3.4：文件被误删时自动重建（带 header）
          console.warn(`[MemoryLayerService] readMemorySnapshot: ${name} 不存在，自动重建`)
          if (recreate) this.recreateLayerFile(mode, name)
          return ''
        }
        const stats = fs.statSync(filePath)
        if (stats.size > MAX_MEMORY_FILE_SIZE) {
          // P3.3：文件过大跳过（避免读超大文件卡）
          console.warn(
            `[MemoryLayerService] readMemorySnapshot: ${name} 过大（${(stats.size / 1024).toFixed(1)}KB），跳过注入`
          )
          return ''
        }
        return fs.readFileSync(filePath, 'utf-8')
      } catch (e) {
        console.warn(`[MemoryLayerService] readMemorySnapshot 读 ${name} 失败:`, e)
        return ''
      }
    }
    return {
      l0User: readSafe('L0_user.md'),
      l1Project: workspaceSlug
        ? filterProjectMemoryMarkdown(
            readSafe('L1_project.md', getProjectMemoryDir(workspaceSlug), false),
            workspaceSlug,
          )
        : readSafe('L1_project.md'),
      l2Facts: readSafe('L2_facts.md'),
    }
  }

  /**
   * 按 session_slug 更新 L4 会话的 key_facts 字段
   *
   * 用于会话结束后异步回填 keyFacts（LLM 提炼完成后调）。
   * FTS5 触发器会自动同步全文索引，无需手动维护。
   *
   * 失败不抛异常，仅打印 warn —— 不影响主流程。
   */
  updateSessionKeyFacts(sessionId: string, keyFacts: string[], mode: MemoryMode): void {
    const db = this.getL4Db(mode)
    if (!db) {
      console.warn(`[MemoryLayerService] L4 ${mode} 数据库未初始化，跳过 updateSessionKeyFacts`)
      return
    }

    try {
      const result = db
        .prepare('UPDATE sessions SET key_facts = ? WHERE session_slug = ?')
        .run(JSON.stringify(keyFacts), sessionId)

      if (result.changes === 0) {
        console.warn(
          `[MemoryLayerService] updateSessionKeyFacts 未匹配到行: sessionId=${sessionId}`
        )
      }
    } catch (error) {
      console.error('[MemoryLayerService] updateSessionKeyFacts 失败:', error)
    }
  }

  /**
   * 获取 Markdown 文件内容
   */
  getMdContent(mode: MemoryMode, layer: 'L0' | 'L1' | 'L2' | 'L5'): string | null {
    const dir = getMemoryDir(mode)
    const fileName =
      layer === 'L0'
        ? 'L0_user.md'
        : layer === 'L1'
          ? 'L1_project.md'
          : layer === 'L2'
            ? 'L2_facts.md'
            : 'L5_insights.md'
    const filePath = path.join(dir, fileName)

    if (!fs.existsSync(filePath)) {
      return null
    }

    return fs.readFileSync(filePath, 'utf-8')
  }

  /**
   * 获取 L3 纠错记录
   */
  getCorrections(
    mode: MemoryMode,
    limit: number = 50
  ): Array<{ timestamp: number; correction: string; context: string; scope?: 'global' | 'project'; workspaceSlug?: string; evidenceIds?: string[]; status?: string; sourceSession?: string }> {
    const dir = getMemoryDir(mode)
    const filePath = path.join(dir, 'corrections.jsonl')

    if (!fs.existsSync(filePath)) {
      return []
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content
        .split('\n')
        .filter((line) => line.trim())
        .slice(-limit)
      return lines.map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
}

/** 为 LIKE 回退提取少量稳定片段，兼容中文连续文本和英文术语。 */
function buildMemoryLikeTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const word of query.match(/[A-Za-z0-9_./-]{3,}/g) ?? []) {
    terms.add(word.slice(0, 40))
  }
  for (const run of query.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    terms.add(run.slice(0, 12))
    if (run.length > 12) terms.add(run.slice(-12))
  }
  return [...terms].slice(0, 6)
}

// 导出单例
export const memoryLayerService = new MemoryLayerService()
