/**
 * 会话服务：管理 SessionRuntime 集合 + 注册 IPC handler
 *
 * 2.0 长驻改造核心。见 docs/plans/2026-07-25-longlived-event-loop-rewrite-design.md。
 * 职责：
 * - 创建/销毁 SessionRuntime（一个会话一个）
 * - 注册 IPC handler（SEND_MESSAGE/STOP_AGENT/STEER_AGENT/DELETE_SESSION）
 * - 流式消息推给渲染进程（STREAM_EVENT / turn_end / session_error）
 * - 按 channelId 选核（kscc-internal→kscc 核，其余→Pi 核）+ 会话绑核（互斥）
 *
 * 会话绑定：首条消息锁定运行内核（KSCC / 外部）；同内核内渠道和模型可继续切换。
 *
 * stop / steer 双核差异（收口）：
 * - **STOP**：interrupt + 显式 turn_end + meta idle（渲染层 userStopRun 硬停 running）
 * - **STEER**：kscc 长驻 live enqueue；Pi（或无 live loop）→ pending_next_turn，
 *   本轮 onTurnEnd 后 auto handleSend，避免静默无操作
 */
import { ipcMain, type BrowserWindow } from 'electron'
import type {
  AgentProviderAdapter,
  SDKMessage,
  SDKUserMessageInput,
  TAgentDesktopStreamPayload,
  TAgentMessage,
  Channel,
  AgentSessionMeta,
} from '@tagent/shared'
import { AGENT_IPC_CHANNELS, MEMORY_IPC_CHANNELS, msysPathToWindowsDrivePath } from '@tagent/shared'
import { SessionRuntime } from '../agent/runtime/session-runtime'
import { getAdapter, PiAgentAdapter, type ChannelKind } from '../adapters'
import { resolveKsccPath } from '../adapters/claude/kscc-path'
import {
  buildOutputStylePrompt,
  buildRichContentSystemPrompt,
  buildChatModeBlockUserError,
  classifyUserFacingError,
  sdkMessageToIR,
} from '@tagent/shared'
import type { KsccQueryOptions } from '../adapters/claude/claude-agent-adapter'
import {
  getSessionMeta,
  updateSessionMeta,
  appendSdkMessages,
  appendPanelMessages,
  createSession,
  listSessions,
  readPanelMessages,
  deleteSession as deleteSessionMeta,
  deleteSessionsByWorkspace,
} from '../agent/session-store'
import { getChannel, getDecryptedApiKey, getKsccChannelId } from '../channel/channel-store'
import { KSCC_DEFAULT_MODEL_ID } from '../channel/default-models'
import { resolveModelContextWindow } from '../channel/model-window'
import {
  buildMemoryPromptSections,
  memoryLayerService,
  memoryEvidenceSink,
  nudgeService,
  normalizeToTextMessages,
  type MemoryMode,
} from '../memory'
import { ksccSoftReset } from '../agent/kscc-soft-reset'
import { resolveWorkspaceForSession } from '../workspace/workspace-manager'
import { findFileByNameCached } from './file-search'
import { getEnabledMcpServers } from '../mcp/mcp-store'
import {
  PermissionService,
  dismissModeSuggestion,
  clearModeSuggestionDismissal,
  setOnChatModeBlock,
} from '../permission/permission-service'
import { buildBuiltinSubagentDefinitions, buildSubagentDelegationPrompt } from '../agent/subagent-definitions'
import { buildExecutionModePrompt } from '../agent/execution-mode-prompt'
import {
  buildPiKanbanTools,
  injectKanbanMcpServer,
} from '../kanban/kanban-agent-tools'
import { listBoards, listTasksByBoard } from '../kanban/kanban-store'
import type { ExecutionMode, TAgentPermissionMode } from '@tagent/shared'
import {
  TAGENT_DEFAULT_PERMISSION_MODE,
  migratePermissionMode,
  DEFAULT_SUBAGENT_EAGERNESS,
  migrateSubagentEagerness,
  resolveSdkPermissionModeForTAgent,
  migrateExecutionMode,
  LEGACY_EXECUTION_MODE,
  DEFAULT_EXECUTION_MODE,
  isExecutionModeChangeSource,
  type ExecutionModeChangeSource,
  parseMentions,
} from '@tagent/shared'
import { loadRoles, resolveRole } from '../role/agent-role-service'
import { composeRoleSystemPrompt } from '../role/role-projection'

interface SendMessageInput {
  sessionId: string
  prompt: string
  /** 渠道 ID（决定选哪个 adapter + 绑核）。不传默认 kscc-internal */
  channelId?: string
  /** 模型 ID */
  model?: string
  /** 工作区 ID（= sanitizePath(projectPath)，用于 JSONL 按项目存储） */
  workspaceId?: string
  /** 附件（已持久化到磁盘的 FileAttachment） */
  attachments?: Array<{ id: string; filename: string; mediaType: string; localPath: string; size: number }>
  /**
   * Chat @ 提及的角色 id（按发言顺序）。
   * 可不传：主进程会从 prompt 文本再 parse 一次。
   */
  mentionRoleIds?: string[]
  /**
   * 渲染层本地的 executionMode（草稿会话首条时传入，主进程创建 meta 时带上）。
   * 非草稿会话已有 meta，此字段忽略。
   */
  executionMode?: ExecutionMode
}

export class SessionService {
  private runtimes = new Map<string, SessionRuntime>()
  /**
   * Pi 等非长驻 loop：steer 降级队列。
   * 本轮结束后（onTurnEnd）拼接为一条用户消息 auto handleSend。
   * STOP / 删会话时丢弃，避免停后仍自动开跑。
   */
  private pendingSteerBySession = new Map<string, string[]>()

  private constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly permissionService: PermissionService | null,
  ) {}

  /** 会话当前绑定的运行内核；无 meta/渠道时 null */
  private resolveAdapterKindForSession(sessionId: string): ChannelKind | null {
    const meta = getSessionMeta(sessionId)
    if (!meta?.channelId) return null
    const channel = getChannel(meta.channelId)
    if (!channel) return null
    return channel.provider === 'kscc-internal' ? 'kscc' : 'external'
  }

  /** 入队 steer 文本（Pi pending_next_turn） */
  private enqueuePendingSteer(sessionId: string, text: string): void {
    const list = this.pendingSteerBySession.get(sessionId) ?? []
    list.push(text)
    this.pendingSteerBySession.set(sessionId, list)
  }

  /** 丢弃 pending steer（STOP / 删会话） */
  private clearPendingSteer(sessionId: string): void {
    this.pendingSteerBySession.delete(sessionId)
  }

  /**
   * 本轮正常结束后：若有 pending steer，自动作为下一轮用户消息发送。
   * 仅 Pi 降级路径写入 pending；kscc live enqueue 不经此 Map。
   */
  private flushPendingSteer(sessionId: string): void {
    const pending = this.pendingSteerBySession.get(sessionId)
    if (!pending?.length) return
    this.pendingSteerBySession.delete(sessionId)
    const meta = getSessionMeta(sessionId)
    if (!meta?.channelId) {
      console.warn(`[session-service] pending steer 丢弃（无 meta）: ${sessionId}`)
      return
    }
    const prompt = pending.join('\n\n')
    console.log(
      `[会话 ${sessionId}] pending steer → 自动下一轮（${pending.length} 条合并）`,
    )
    void this.handleSend({
      sessionId,
      prompt,
      channelId: meta.channelId,
      model: meta.modelId,
      workspaceId: meta.workspaceId,
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[session-service] pending steer flush 失败: ${msg}`)
      // 回填，避免静默丢；用户可再发或再点引导
      const cur = this.pendingSteerBySession.get(sessionId) ?? []
      this.pendingSteerBySession.set(sessionId, [...pending, ...cur])
      this.sendPayload(sessionId, {
        kind: 'tagent_event',
        event: {
          type: 'session_error',
          message: `引导消息自动发送失败：${msg}`,
          error: classifyUserFacingError(msg),
        },
      })
    })
  }

  /**
   * Chat 模式拦截写操作：终止当前 run + 通知渲染层清运行态。
   * 用户视角：「都在运行了还问我干啥」——被拦即停，等用户确认切 Work 后再继续。
   */
  private handleChatModeBlock(sessionId: string, toolName: string): void {
    // 先清 pending，再 interrupt（与 STOP_AGENT 同序，防 onTurnEnd 误 flush）
    this.clearPendingSteer(sessionId)
    const rt = this.runtimes.get(sessionId)
    if (rt) {
      void rt.interrupt().catch(() => {})
    }
    // 清流式占位 + running 停止（turn_end 语义；interrupt 后 adapter 可能不再发事件，兜底）
    this.sendPayload(sessionId, { kind: 'tagent_event', event: { type: 'turn_end' } })
    // 用户可见引导：SessionErrorBanner（非 assistant 气泡里的工具失败原文）
    const userError = buildChatModeBlockUserError(toolName)
    this.sendPayload(sessionId, {
      kind: 'tagent_event',
      event: {
        type: 'session_error',
        message: userError.message,
        error: userError,
      },
    })
  }

  static create(
    getWindow: () => BrowserWindow | null,
    permissionService: PermissionService | null = null,
  ): SessionService {
    const svc = new SessionService(getWindow, permissionService)
    if (permissionService) {
      setOnChatModeBlock((sessionId, toolName) => svc.handleChatModeBlock(sessionId, toolName))
    }
    // Phase 4：软重置钩子
    ksccSoftReset.setHooks({
      abortSession: (sessionId) => {
        const rt = svc.runtimes.get(sessionId)
        rt?.destroy()
        svc.runtimes.delete(sessionId)
        try {
          getAdapter('kscc').abort?.(sessionId)
        } catch {
          /* ignore */
        }
      },
      onStatus: (sessionId, status) => {
        const win = getWindow()
        win?.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId,
          payload: {
            kind: 'tagent_event',
            event: {
              type:
                status === 'switching' || status === 'compacting'
                  ? 'memory_organizing'
                  : 'memory_status',
              status,
            },
          },
        })
      },
    })
    svc.registerIpc()
    return svc
  }

  /** 注册 IPC handler */
  private registerIpc(): void {
    ipcMain.handle(AGENT_IPC_CHANNELS.SEND_MESSAGE, async (_e, input: SendMessageInput) => {
      try {
        await this.handleSend(input)
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.sendPayload(input.sessionId, {
          kind: 'tagent_event',
          event: { type: 'session_error', message: msg, error: classifyUserFacingError(msg) },
        })
        return { ok: false, error: msg }
      }
    })

    ipcMain.handle(AGENT_IPC_CHANNELS.STOP_AGENT, async (_e, sessionId: string) => {
      // 先丢 pending steer，再 interrupt：abort 可能同步触发 result→onTurnEnd，
      // 若先 interrupt 再 clear，会误 auto-send 用户刚想放弃的引导。
      this.clearPendingSteer(sessionId)
      const rt = this.runtimes.get(sessionId)
      if (rt) await rt.interrupt()
      // 软停兜底：interrupt 不调 onTurnEnd，且 Pi abort 不保证再推 result。
      // 显式推 turn_end + meta idle → 侧栏 idle / 流式占位收（与 handleChatModeBlock 一致）。
      // 渲染层另有 userStopRun 硬停 running+startedAt；后续 result→onTurnEnd 再发 turn_end 幂等可接受。
      // 注意：此处 sendPayload(turn_end) **不**走 onTurnEnd 回调，故不会 flushPendingSteer。
      try {
        updateSessionMeta(sessionId, { status: 'idle' })
      } catch {
        /* meta 缺失时忽略 */
      }
      this.sendPayload(sessionId, { kind: 'tagent_event', event: { type: 'turn_end' } })
      return { ok: true }
    })

    /**
     * 引导 Agent（不中断当前轮）。
     * - kscc + live loop → enqueue，mode:'live'
     * - Pi / 无 live loop → pending_next_turn，本轮 onTurnEnd 后 auto 发送
     * 绝不静默 {ok:true} 却无任何效果。
     */
    ipcMain.handle(
      AGENT_IPC_CHANNELS.STEER_AGENT,
      async (
        _e,
        sessionId: string,
        message: string,
      ): Promise<{ ok: boolean; mode?: 'live' | 'pending_next_turn'; error?: string }> => {
        const text = typeof message === 'string' ? message.trim() : ''
        if (!text) return { ok: false, error: '消息为空' }

        const kind = this.resolveAdapterKindForSession(sessionId)
        const rt = this.runtimes.get(sessionId)

        // kscc 真长驻：loop 存活时 enqueue 到下一轮边界
        if (kind === 'kscc' && rt?.hasLiveProcess()) {
          const mode = await rt.steerMessage(text)
          if (mode === 'live') return { ok: true, mode: 'live' }
          // live 判定竞态失败 → 降级 pending
        }

        // Pi 核（或 kscc 已无 live）：下一轮注入，避免 agent.steer 静默失效
        this.enqueuePendingSteer(sessionId, text)
        // 若当前已不在跑（用户停后点引导 / 空闲误触），立刻 flush
        if (!rt || !rt.isTurnInFlight()) {
          this.flushPendingSteer(sessionId)
        }
        return { ok: true, mode: 'pending_next_turn' }
      },
    )

    // 附件管理
    ipcMain.handle(AGENT_IPC_CHANNELS.SAVE_ATTACHMENT, async (_e, input: {
      sessionId: string; filename: string; mediaType: string; data: string
    }) => {
      const { saveAttachment } = await import('../attachment-service')
      return saveAttachment(input)
    })

    ipcMain.handle(AGENT_IPC_CHANNELS.READ_ATTACHMENT, async (_e, localPath: string) => {
      const { readAttachmentAsBase64 } = await import('../attachment-service')
      return readAttachmentAsBase64(localPath)
    })

    ipcMain.handle(AGENT_IPC_CHANNELS.OPEN_FILE_DIALOG, async () => {
      const { dialog } = await import('electron')
      const win = this.getWindow()
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'] },
          { name: '文档', extensions: ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'json'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { files: [] as Array<{ path: string; filename: string; mediaType: string; data: string; size: number }> }
      }
      const { readFileSync, statSync } = await import('node:fs')
      const { basename } = await import('node:path')
      const MIME_MAP: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp', '.pdf': 'application/pdf', '.txt': 'text/plain',
        '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
        '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }
      const MAX_INLINE = 10 * 1024 * 1024 // 10MB 以内读 base64
      const files: Array<{ path: string; filename: string; mediaType: string; data: string; size: number }> = []
      for (const fp of result.filePaths) {
        const stat = statSync(fp)
        const ext = '.' + fp.split('.').pop()?.toLowerCase()
        const mime = MIME_MAP[ext] ?? 'application/octet-stream'
        if (stat.size <= MAX_INLINE) {
          const buf = readFileSync(fp)
          files.push({ path: fp, filename: basename(fp), mediaType: mime, data: buf.toString('base64'), size: stat.size })
        } else {
          // 大文件只返回路径，由主进程后续按需读取
          files.push({ path: fp, filename: basename(fp), mediaType: mime, data: '', size: stat.size })
        }
      }
      return { files }
    })

    // 用系统默认程序打开文件（消息内文件 chip 点击）。相对路径基于会话工作区解析。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.OPEN_PATH,
      async (
        _e,
        input: { sessionId: string; path: string },
      ): Promise<{ ok: boolean; error?: string }> => {
        const { shell } = await import('electron')
        const { isAbsolute, resolve, basename } = await import('node:path')
        const { existsSync } = await import('node:fs')
        const target = input.path.trim()
        if (!target) return { ok: false, error: '路径为空' }
        const workspace = resolveWorkspaceForSession(input.sessionId)
        let abs = target
        if (!isAbsolute(abs)) {
          const base = workspace?.projectDirectory
          if (!base) return { ok: false, error: '会话未绑定工作区，无法解析相对路径' }
          abs = resolve(base, abs)
        } else if (process.platform === 'win32') {
          // MSYS/Git Bash 挂载形态（/f/...）：win32 会解析到盘根 f 目录，先试盘符路径
          const drive = msysPathToWindowsDrivePath(abs)
          if (drive && existsSync(drive)) abs = drive
        }
        if (!existsSync(abs)) {
          // 裸文件名（如 `Chat.tsx`）常规解析失败 → 项目内按文件名查找（与 resolveFile 同一兜底）
          if (workspace?.projectDirectory) {
            const found = findFileByNameCached(workspace.projectDirectory, basename(target))
            if (found) abs = found
          }
          if (!existsSync(abs)) return { ok: false, error: `文件不存在：${abs}` }
        }
        const err = await shell.openPath(abs)
        return err ? { ok: false, error: err } : { ok: true }
      }
    )

    // 解析文件路径是否存在（文件 chip 存在性检查）。候选 base 优先，无则回退会话工作区。
    ipcMain.handle(
      AGENT_IPC_CHANNELS.RESOLVE_FILE,
      async (
        _e,
        input: { sessionId: string; path: string; bases?: string[] },
      ): Promise<string | null> => {
        const { isAbsolute, resolve, basename, dirname } = await import('node:path')
        const { existsSync } = await import('node:fs')
        const target = input.path.trim()
        if (!target) return null
        const candidates: string[] = []
        const workspace = resolveWorkspaceForSession(input.sessionId)
        const bases = (input.bases ?? []).filter(Boolean)
        if (isAbsolute(target)) {
          candidates.push(target)
          // MSYS/Git Bash 挂载形态（/f/...）：win32 会解析到盘根 f 目录，按盘符路径再试
          if (process.platform === 'win32') {
            const drive = msysPathToWindowsDrivePath(target)
            if (drive) candidates.push(drive)
          }
        } else {
          // 带项目名前缀的相对路径（如 `j3_statics/preview.js`）：首段匹配 base 名时
          // 用 base 的父目录拼接（与渲染层 displayPath、1.0 resolveTargetPath 同款）
          const firstSegment = target.split(/[\\/]/)[0]
          if (firstSegment) {
            for (const base of bases) {
              if (basename(base) === firstSegment) {
                candidates.push(resolve(dirname(base), target))
              }
            }
          }
          for (const base of bases) candidates.push(resolve(base, target))
          if (workspace?.projectDirectory) {
            candidates.push(resolve(workspace.projectDirectory, target))
          }
        }
        for (const abs of candidates) {
          if (existsSync(abs)) return abs
        }
        // 兜底：裸文件名/短路径（如 `Chat.tsx`）常规解析失败 → 项目内按文件名递归查找。
        // 排除依赖/产物目录、限深度与扫描量，命中结果带模块级缓存（见 file-search）。
        // 绝对路径也走这里：MSYS 形态解析不到时按名找回（对齐 TAgent_General 1.0 行为）。
        // 草稿会话还没落 meta，反查不到 workspace，此时用渲染层注入的 base 当扫描根。
        const searchRoot = workspace?.projectDirectory ?? bases[0]
        if (searchRoot) {
          const found = findFileByNameCached(searchRoot, basename(target))
          if (found) return found
        }
        return null
      }
    )

    // 热切换会话权限模式：持久化 meta → 通知 runtime（kscc 走 SDK setPermissionMode；Pi 靠闭包读 meta）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE,
      async (_e, args: { sessionId: string; mode: TAgentPermissionMode }): Promise<{ ok: boolean; error?: string }> => {
        const normalized = migratePermissionMode(args.mode)
        updateSessionMeta(args.sessionId, { permissionMode: normalized })
        const rt = this.runtimes.get(args.sessionId)
        if (rt) {
          try {
            await rt.setPermissionMode(normalized)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[会话 ${args.sessionId}] setPermissionMode 失败:`, msg)
            return { ok: false, error: msg }
          }
        }
        return { ok: true }
      }
    )

    // 热切换 executionMode（Chat|Work）：仅用户源；Agent 工具不得调用
    // @see docs/decisions/ADR-0005-user-owned-mode-switch.md
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_SESSION_EXECUTION_MODE,
      async (
        _e,
        args: {
          sessionId: string
          mode: string
          source?: string
        },
      ): Promise<{
        ok: boolean
        error?: string
        mode?: ExecutionMode
        backgroundCrew?: {
          running: number
          ready: number
          pending: number
          boardId?: string
        }
      }> => {
        if (!args?.sessionId) return { ok: false, error: 'missing sessionId' }
        if (!isExecutionModeChangeSource(args.source)) {
          return {
            ok: false,
            error: 'executionMode 仅允许用户切换（source 须为 user 或 user-confirm-suggestion）',
          }
        }
        const source: ExecutionModeChangeSource = args.source
        if (args.mode !== 'chat' && args.mode !== 'work') {
          return { ok: false, error: `非法 executionMode: ${String(args.mode)}` }
        }
        const next = args.mode as ExecutionMode
        const meta = getSessionMeta(args.sessionId)
        if (!meta) return { ok: false, error: '会话不存在' }
        const prev = migrateExecutionMode(meta.executionMode)

        // Work→Chat（或切到 chat）时：检测会话看板 / parentSession 看板是否仍有在途任务
        const backgroundCrew =
          next === 'chat'
            ? (() => {
                try {
                  let boardId = meta.boardId
                  if (!boardId) {
                    boardId = listBoards({ status: 'active' }).find(
                      (b) => b.parentSessionId === args.sessionId,
                    )?.id
                  }
                  if (!boardId) return undefined
                  const tasks = listTasksByBoard(boardId)
                  const running = tasks.filter((t) => t.status === 'running').length
                  const ready = tasks.filter((t) => t.status === 'ready').length
                  const pending = tasks.filter((t) => t.status === 'pending').length
                  if (running + ready + pending <= 0) return undefined
                  return { running, ready, pending, boardId }
                } catch {
                  return undefined
                }
              })()
            : undefined

        if (prev === next) {
          return { ok: true, mode: next, ...(backgroundCrew ? { backgroundCrew } : {}) }
        }

        const history = [...(meta.executionModeHistory ?? [])]
        history.push({ at: Date.now(), from: prev, to: next, source })
        // 只保留最近 20 条
        const trimmed = history.length > 20 ? history.slice(-20) : history
        updateSessionMeta(args.sessionId, {
          executionMode: next,
          executionModeHistory: trimmed,
          // 确认/切换后清掉建议条
          pendingExecutionModeSuggestion: null,
        })
        // 用户主动切换 = 新意图：解除 dismiss 抑制，之后被拦可再建议
        clearModeSuggestionDismissal(args.sessionId)
        // 运行中切换：先软中断当前 turn（用户决策优先，不留半截任务继续跑）
        try {
          await this.runtimes.get(args.sessionId)?.interrupt()
        } catch (err) {
          console.warn(`[会话 ${args.sessionId}] 切换 executionMode 前中断失败:`, err)
        }
        // 长驻进程在首条消息时锁定 MCP/systemPrompt；Chat↔Work 后须丢弃 kscc 进程，
        // 下次发送 re-spawn 才会出现 kanban_*；Pi 核则在下次 query 热重建 Agent。
        try {
          this.runtimes
            .get(args.sessionId)
            ?.dropLiveProcessForConfigChange(`executionMode ${prev}→${next}`)
        } catch (err) {
          console.warn(`[会话 ${args.sessionId}] dropLiveProcess 失败:`, err)
        }
        console.log(`[会话 ${args.sessionId}] executionMode ${prev} → ${next} (${source})`)
        return { ok: true, mode: next, ...(backgroundCrew ? { backgroundCrew } : {}) }
      },
    )

    // 关闭形态切换建议条（不改 mode）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.DISMISS_EXECUTION_MODE_SUGGESTION,
      async (_e, args: { sessionId: string }): Promise<{ ok: boolean }> => {
        if (!args?.sessionId) return { ok: false }
        const meta = getSessionMeta(args.sessionId)
        if (!meta) return { ok: false }
        if (meta.pendingExecutionModeSuggestion) {
          updateSessionMeta(args.sessionId, { pendingExecutionModeSuggestion: null })
        }
        // 用户点「留在 Chat」→ 本会话不再自动推建议（防工具循环反复弹）
        dismissModeSuggestion(args.sessionId)
        return { ok: true }
      },
    )

    ipcMain.handle(AGENT_IPC_CHANNELS.LIST_SESSIONS, async () => {
      const sessions = listSessions()
      console.log(`[会话] listSessions 返回 ${sessions.length} 个会话，isArray=${Array.isArray(sessions)}`)
      return sessions
    })

    ipcMain.handle(AGENT_IPC_CHANNELS.GET_SDK_MESSAGES, async (_e, sessionId: string) => {
      // 从 session meta 查 workspaceId，兼容旧数据（无 workspaceId 传 undefined）
      // Phase 1.2：面板历史读只追加那份，不受 SDK JSONL 压缩影响
      const meta = getSessionMeta(sessionId)
      return readPanelMessages(meta?.workspaceId, sessionId)
    })

    ipcMain.handle(AGENT_IPC_CHANNELS.DELETE_SESSION, async (_e, sessionId: string) => {
      const rt = this.runtimes.get(sessionId)
      if (rt) {
        rt.destroy()
        this.runtimes.delete(sessionId)
      }
      this.clearPendingSteer(sessionId)
      // 清会话权限白名单（「始终允许」状态）
      PermissionService.clearWhitelist(sessionId)
      deleteSessionMeta(sessionId)
      // Phase 2.5：记忆层标记会话已删（L0/L2/L3/L5 行加 deleted:1）
      void nudgeService.markSessionDeleted(sessionId).catch((err) => {
        console.warn('[session-service] markSessionDeleted failed:', err)
      })
      return { ok: true }
    })

    // 更新会话元数据（重命名 title / 置顶 pinned / 归档 archived / 子代理委派积极性 subagentEagerness 等；
    // status 仅主进程内部写 error/idle，渲染层不直接写）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.UPDATE_SESSION_META,
      async (
        _e,
        args: {
          id: string
          patch: Pick<
            Partial<AgentSessionMeta>,
            | 'title'
            | 'pinned'
            | 'archived'
            | 'subagentEagerness'
            | 'reasoningEffort'
            | 'turnDurations'
          >
        }
      ) => {
        // 规范化 subagentEagerness（非法值回退默认），其余字段透传 updateSessionMeta 合并写
        const patch: Partial<AgentSessionMeta> = { ...args.patch }
        if (patch.subagentEagerness !== undefined) {
          patch.subagentEagerness = migrateSubagentEagerness(patch.subagentEagerness)
        }
        return updateSessionMeta(args.id, patch)
      }
    )

    // 置顶切换
    ipcMain.handle(AGENT_IPC_CHANNELS.TOGGLE_PIN, async (_e, id: string) => {
      const meta = getSessionMeta(id)
      return updateSessionMeta(id, { pinned: !meta?.pinned })
    })

    // 归档切换
    ipcMain.handle(AGENT_IPC_CHANNELS.TOGGLE_ARCHIVE, async (_e, id: string) => {
      const meta = getSessionMeta(id)
      return updateSessionMeta(id, { archived: !meta?.archived })
    })

    // 查会话生命状态（runtimes 内存 turnInFlight 优先 → meta.error → idle；archived 一并返回）
    ipcMain.handle(AGENT_IPC_CHANNELS.GET_SESSION_STATUS, async (_e, id: string) => {
      return this.getStatus(id)
    })

    // 清除 Chat @ 对话跟随（activeSpeaker；回默认总助）。pendingMentionRoleIds 置 undefined。
    ipcMain.handle(AGENT_IPC_CHANNELS.CLEAR_MENTION_FOLLOW, async (_e, id: string) => {
      return updateSessionMeta(id, { pendingMentionRoleIds: undefined })
    })

    // 手动压缩会话上下文（Pi 核；kscc 暂不支持返回 reason）
    ipcMain.handle(
      AGENT_IPC_CHANNELS.COMPACT_SESSION,
      async (
        _e,
        args: { sessionId: string },
      ): Promise<{ ok: boolean; compacted: boolean; reason?: string; tokensBefore?: number }> => {
        const sessionId = args?.sessionId
        if (!sessionId) return { ok: false, compacted: false, reason: 'missing sessionId' }
        const meta = getSessionMeta(sessionId)
        const channelId = meta?.channelId
        const channel = channelId ? getChannel(channelId) : undefined
        const kind: ChannelKind = channel?.provider === 'kscc-internal' ? 'kscc' : 'external'
        const adapter = getAdapter(kind)
        if (typeof adapter.compactSession !== 'function') {
          return { ok: false, compacted: false, reason: '当前运行核不支持手动压缩' }
        }
        // 确保 Agent 已创建：无 runtime 时用户仅打开历史也可能未 spawn
        if (!adapter.hasActiveChannel?.(sessionId)) {
          return { ok: false, compacted: false, reason: '会话尚未在本机启动，请先发送一条消息' }
        }
        const result = await adapter.compactSession(sessionId, { force: true, trigger: 'manual' })
        // 立即把 pending system 事件推给 UI（不等下一轮 query）
        this.flushPiPendingSystemMessages(sessionId, adapter, meta?.workspaceId)
        return {
          ok: result.ok,
          compacted: result.compacted,
          reason: result.reason,
          tokensBefore: result.tokensBefore,
        }
      },
    )
  }

  /** 排出 Pi compactSession 暂存的 system 事件到渲染层（已是 TAgentDesktopStreamPayload） */
  private flushPiPendingSystemMessages(
    sessionId: string,
    adapter: AgentProviderAdapter,
    workspaceId?: string,
  ): void {
    const pi = adapter as PiAgentAdapter
    if (typeof pi.drainPendingSystemMessages !== 'function') return
    const payloads = pi.drainPendingSystemMessages(sessionId)
    for (const p of payloads) {
      this.handlePiStreamPayload(sessionId, workspaceId, p)
    }
  }

  /**
   * 组合会话生命状态（侧栏状态色点用）。
   * - runtimes 内存 turnInFlight → 'running'（不落盘，重启即失）
   * - meta.status === 'error' → 'error'（落盘，重启保留）
   * - 其余 → 'idle'
   * 用 isTurnInFlight() 而非 isRunning()：长驻进程 isRunning 恒 true，不表达"当前轮在跑"。
   */
  private getStatus(id: string): { status: 'idle' | 'running' | 'error'; archived: boolean } {
    const meta = getSessionMeta(id)
    const rt = this.runtimes.get(id)
    if (rt && rt.isTurnInFlight()) return { status: 'running', archived: !!meta?.archived }
    if (meta?.status === 'error') return { status: 'error', archived: !!meta?.archived }
    return { status: 'idle', archived: !!meta?.archived }
  }

  /** 处理发消息：解析渠道→锁定运行内核→首次 spawn / 后续同内核切换模型 */
  private async handleSend(input: SendMessageInput): Promise<void> {
    const channelId = input.channelId ?? getKsccChannelId()
    if (!channelId) {
      throw new Error('未选择渠道，且未找到 kscc 内置渠道（请在渠道管理中添加）')
    }
    const channel = getChannel(channelId)
    if (!channel) {
      throw new Error(`渠道不存在：${channelId}（请在渠道管理中添加）`)
    }
    if (!channel.enabled) {
      throw new Error(`渠道「${channel.name}」已禁用，请先启用`)
    }

    const meta = getSessionMeta(input.sessionId)
    const adapterKind: ChannelKind = channel.provider === 'kscc-internal' ? 'kscc' : 'external'

    // Phase 2.5：每轮 turn 开始统一跑 Nudge（双核共用，读面板消息）
    this.runNudgeOnTurnStart(input.sessionId, meta)

    // 会话只锁定运行内核：KSCC 内网与外部运行时不可互切；
    // 同一内核里的渠道和模型都允许在后续轮次继续选择。
    if (meta?.channelId) {
      const boundChannel = getChannel(meta.channelId)
      if (!boundChannel) {
        throw new Error('该会话原绑定渠道已不存在，无法确认运行内核')
      }
      const boundKind: ChannelKind = boundChannel.provider === 'kscc-internal' ? 'kscc' : 'external'
      if (boundKind !== adapterKind) {
        throw new Error(
          `该会话已锁定${boundKind === 'kscc' ? 'KSCC 内网' : '外部'}运行时，不能跨运行内核切换`,
        )
      }
    }
    const modelId = this.resolveModel(
      channel,
      input.model ?? (meta?.channelId === channelId ? meta.modelId : undefined),
    )
    const normalizedInput: SendMessageInput = { ...input, channelId, model: modelId }

    // Chat @：解析提及并写入 pendingMentionRoleIds（Work 默认不启用多角色乱 @）
    const execMode = migrateExecutionMode(meta?.executionMode ?? getSessionMeta(input.sessionId)?.executionMode)
    if (execMode === 'chat') {
      try {
        const roles = loadRoles()
        const fromText = parseMentions(
          input.prompt,
          roles.map((r: { id: string; displayName: string }) => ({
            id: r.id,
            displayName: r.displayName,
          })),
        ).map((h) => h.roleId)
        const fromInput = Array.isArray(input.mentionRoleIds)
          ? input.mentionRoleIds.map(String).filter(Boolean)
          : []
        const ordered = [...fromInput]
        for (const id of fromText) {
          if (!ordered.includes(id)) ordered.push(id)
        }
        // followMode：有 @ → 切换/设置 activeSpeaker；无 @ → 保留上一轮的 pendingMentionRoleIds（连续追问同一角色）
        if (ordered.length > 0) {
          updateSessionMeta(input.sessionId, { pendingMentionRoleIds: ordered })
        }
      } catch (err) {
        console.warn('[会话] 解析 @ 提及失败:', err)
      }
    }

    // 解析 workspaceId：优先用 input 传入，否则从已有 meta 读
    const workspaceId = input.workspaceId ?? meta?.workspaceId

    const adapter = getAdapter(adapterKind)
    let rt = this.runtimes.get(input.sessionId)
    const isFirst = !rt || !rt.hasLiveProcess()

    console.log(`[会话 ${input.sessionId}] ${isFirst ? '首次：spawn + 起循环' : '后续：复用长驻进程 enqueue'}（渠道=${channel.name} 核=${adapterKind} workspaceId=${workspaceId ?? '(无)'}）`)

    // KSCC 是真正的长驻 Query，同内核切模型时先调用 SDK 热切接口。
    if (!isFirst && adapterKind === 'kscc' && meta?.modelId !== modelId) {
      await rt!.setModel(modelId)
      console.log(`[会话 ${input.sessionId}] KSCC 热切模型：${meta?.modelId ?? '(未记录)'} → ${modelId}`)
    }

    // 持久化用户消息到 JSONL 并推渲染层。按核分流：
    // - kscc：落盘 SDKMessage（resume 读 JSONL 要此格式）+ sdkMessageToIR 推 IR
    // - pi：直接落盘 IR（pi 自管上下文，不靠 SDK resume）+ 直推 IR
    if (adapterKind === 'kscc') {
      const now = Date.now()
      const userMsg: SDKMessage = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: input.prompt }] },
        parent_tool_use_id: null,
        createdAt: now,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      } as unknown as SDKMessage
      // Phase 1.2 双写：先面板（保可见）再 SDK（resume）
      try {
        appendPanelMessages(workspaceId, input.sessionId, [userMsg])
      } catch (err) {
        console.warn('[session-service] appendPanelMessages failed (user):', err)
      }
      try {
        appendSdkMessages(workspaceId, input.sessionId, [userMsg])
      } catch (err) {
        console.error('[session-service] appendSdkMessages failed (user):', err)
      }
      const { message: userIR } = sdkMessageToIR(userMsg)
      if (userIR) {
        if (input.attachments?.length) (userIR as any).attachments = input.attachments
        this.sendPayload(input.sessionId, { kind: 'sdk_message', message: userIR })
      }
    } else {
      const userIR: TAgentMessage = {
        type: 'user',
        createdAt: Date.now(),
        content: [{ type: 'text', text: input.prompt }],
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      }
      // pi 只写面板份（无 SDK resume；L-rag / 历史统一读面板）
      try {
        appendPanelMessages(workspaceId, input.sessionId, [userIR])
      } catch (err) {
        console.warn('[session-service] appendPanelMessages failed (pi user):', err)
      }
      this.sendPayload(input.sessionId, { kind: 'sdk_message', message: userIR })
    }

    if (isFirst) {
      // 首条或进程重建：记录本轮真实使用的渠道和模型。
      if (!meta) {
        createSession({
          id: input.sessionId,
          title: input.prompt.slice(0, 20) || '新会话',
          channelId,
          modelId,
          workspaceId,
          turnCount: 1,
          executionMode: input.executionMode,
        })
        console.log(`[会话 ${input.sessionId}] 已创建会话元数据，运行内核=${adapterKind}，workspaceId=${workspaceId ?? '(无)'}`)
      } else {
        updateSessionMeta(input.sessionId, {
          channelId,
          modelId,
          workspaceId,
          turnCount: (meta.turnCount ?? 0) + 1,
        })
      }
      // 建 SessionRuntime + 起循环
      rt = new SessionRuntime(input.sessionId, adapter)
      this.runtimes.set(input.sessionId, rt)
      rt.setCallbacks({
        onMessage: (msg: SDKMessage) => {
          // 按核分流：kscc 产 SDKMessage → sdkMessageToIR；pi 实际产 TAgentDesktopStreamPayload（经 as 适配契约）
          if (adapterKind === 'kscc') {
            this.handleSdkStreamMessage(input.sessionId, workspaceId, msg)
          } else {
            this.handlePiStreamPayload(input.sessionId, workspaceId, msg as unknown as TAgentDesktopStreamPayload)
          }
        },
        onTurnEnd: () => {
          // 轮成功结束 → 清除可能的 error，落盘 idle。
          // 注意：不再清空 pendingMentionRoleIds —— 它现在是持久的 activeSpeaker（followMode），
          // 连续追问同一角色时下一轮无 @ 仍由该角色接；用户在输入框 ✕ 清除走 CLEAR_MENTION_FOLLOW。
          updateSessionMeta(input.sessionId, {
            status: 'idle',
          })
          this.sendPayload(input.sessionId, { kind: 'tagent_event', event: { type: 'turn_end' } })
          // Phase 2.5：L4 recordSession + evidence sink
          this.recordSessionToMemory(input.sessionId, input.prompt)
          // Pi pending steer：本轮结束后自动开下一轮（kscc live enqueue 不经此路径）
          this.flushPendingSteer(input.sessionId)
        },
        onError: (err: Error) => {
          // 出错 → 落盘 error（重启保留，下轮成功回 idle）
          updateSessionMeta(input.sessionId, { status: 'error' })
          const msg = err.message
          this.sendPayload(input.sessionId, {
            kind: 'tagent_event',
            event: { type: 'session_error', message: msg, error: classifyUserFacingError(msg) },
          })
        },
      })

      await rt.sendMessage(await this.buildQueryOptions(normalizedInput, channel, workspaceId))
    } else {
      updateSessionMeta(input.sessionId, {
        channelId,
        modelId,
        turnCount: (meta?.turnCount ?? 0) + 1,
      })
      // 后续：enqueue
      const userMessage: SDKUserMessageInput = {
        type: 'user',
        message: { role: 'user', content: input.prompt },
        parent_tool_use_id: null,
      } as unknown as SDKUserMessageInput
      await rt!.sendMessage(
        await this.buildQueryOptions(normalizedInput, channel, workspaceId),
        userMessage,
      )
    }
  }

  /** 解析模型 ID：input > 渠道默认 > 第一个启用模型 > kscc 兜底 */
  private resolveModel(channel: Channel, inputModel?: string): string {
    const modelId = inputModel
      ?? channel.defaultModelId
      ?? channel.models.find((model) => model.enabled)?.id
      ?? (channel.provider === 'kscc-internal' ? KSCC_DEFAULT_MODEL_ID : '')
    const configured = channel.models.find((model) => model.id === modelId)
    if (!configured) {
      throw new Error(`模型「${modelId}」不属于渠道「${channel.name}」`)
    }
    if (!configured.enabled) {
      throw new Error(`模型「${configured.name}」已停用，请选择同一运行区域内的可用模型`)
    }
    return modelId
  }

  /** 构建 query 选项（按渠道 provider 选核） */
  private async buildQueryOptions(
    input: SendMessageInput,
    channel: Channel,
    workspaceId?: string
  ): Promise<Parameters<AgentProviderAdapter['query']>[0]> {
    const model = this.resolveModel(channel, input.model)

    // 解析 workspace：始终按 session meta 反查（权限 cwd 必须用项目目录，不能靠 process.cwd()）
    const workspace = resolveWorkspaceForSession(input.sessionId)
    const cwd = workspace?.projectDirectory ?? process.cwd()
    const sanitizedPath = workspace?.slug ?? ''
    void workspaceId // 调用方仍传 workspaceId 用于落盘路径；cwd 以 session meta 为准

    // 权限模式：会话 meta 持久化（默认 bypassPermissions）
    const metaForMode = getSessionMeta(input.sessionId)
    const permissionMode: TAgentPermissionMode = metaForMode?.permissionMode
      ? migratePermissionMode(metaForMode.permissionMode)
      : TAGENT_DEFAULT_PERMISSION_MODE

    // 工作区 MCP 配置（无 workspace → 空，pi-core buildMcpTools 自动跳过）
    const enabledMcpServers = sanitizedPath ? getEnabledMcpServers(sanitizedPath) : {}
    const mcpConfig = { servers: enabledMcpServers }

    if (channel.provider === 'kscc-internal') {
      const ksccPath = resolveKsccPath()
      if (!ksccPath) {
        throw new Error('未检测到 kscc 命令，请先安装 kscc（内网渠道）')
      }
      const meta = getSessionMeta(input.sessionId)
      // 子代理委派积极性：读会话 meta（持久化，默认 conservative），注入 kscc systemPrompt append。
      // 每次发送都重新读取，UI 改完下次发送即生效（kscc 长驻进程 system prompt 在 spawn 时定稿，
      // 切换积极性需重建进程才完全生效；非首次发送走 resume，沿用上一次注入的策略）。
      const eagerness = migrateSubagentEagerness(meta?.subagentEagerness)
      // Phase 2.2：记忆管理规则 + Frozen 记忆快照（createSession/spawn 时注入，会话内不刷新）
      const sessionMode: MemoryMode = meta?.mode === 'ta' ? 'ta' : 'general'
      const snap = memoryLayerService.readMemorySnapshot(sessionMode)
      const mem = buildMemoryPromptSections({
        mode: sessionMode,
        memorySnapshot: { l0: snap.l0User, l1: snap.l1Project, l2: snap.l2Facts },
      })
      // KsccQueryOptions：canUseTool/mcpServers/permissionMode/allowDangerouslySkipPermissions
      // canUseTool 透传 PermissionService.createCanUseTool（permissionMode + executionMode 闭包读 meta）
      const canUseTool = this.permissionService
        ? this.permissionService.createCanUseTool(
            input.sessionId,
            () => this.getPermissionMode(input.sessionId),
            cwd,
            () => this.getExecutionMode(input.sessionId),
          )
        : undefined
      const executionMode = this.getExecutionMode(input.sessionId)
      // Work：注入看板 MCP（create/add/list）；Chat 不注入
      const mcpServers: Record<string, unknown> = {
        ...(Object.keys(enabledMcpServers).length > 0
          ? (enabledMcpServers as Record<string, unknown>)
          : {}),
      }
      if (executionMode === 'work') {
        try {
          await injectKanbanMcpServer(mcpServers, {
            sessionId: input.sessionId,
            channelId: channel.id,
            agentCwd: cwd,
            workspaceId: workspace?.slug,
            toolMode: 'full',
          })
        } catch (err) {
          console.warn('[会话] 注入看板 MCP 失败:', err)
        }
      }
      const opts: KsccQueryOptions = {
        sessionId: input.sessionId,
        prompt: input.prompt,
        model,
        cwd,
        executionMode,
        sdkCliPath: ksccPath,
        env: { ...process.env } as Record<string, string | undefined>,
        maxTurns: 50,
        // 接上 resolveSdkPermissionModeForTAgent：auto/bypassPermissions → 'default'，
        // 让 SDK 把每次工具调用都交给 TAgent canUseTool 审批，而非叠 SDK 自己的权限闸
        // （之前硬编码 'bypassPermissions' + allowDangerouslySkipPermissions:false 的组合，
        //   SDK 会拒绝「危险跳过」并启用内置审批，导致 cwd 内读操作也弹权限确认）。
        sdkPermissionMode: resolveSdkPermissionModeForTAgent(permissionMode),
        // 有 canUseTool 时交给我们的服务全权审批；无 canUseTool（无 PermissionService）时才让 SDK 自行跳过
        allowDangerouslySkipPermissions: !canUseTool,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          // 执行形态 +（Work 才）子代理委派 + 看板工具说明 + 富内容 + 记忆
          // Chat 下 Task/SubAgent/看板写 硬拦，不注入委派/看板工具
          append: [
            // Chat/Work 策略须尽早出现，压过 claude_code preset 的动手/Plan 默认习惯
            buildExecutionModePrompt(executionMode),
            '## 身份与自我介绍\n你是一个专业的编程助手，帮助用户完成软件开发任务。回复时不要自我介绍，也不要提及你所属的 CLI 工具名或出品方品牌；直接以助手姿态回答用户的问题。',
            // W8：输出风格沟通红线（与 Pi 核 buildOutputStylePrompt 同文）
            buildOutputStylePrompt(),
            executionMode === 'work' ? buildSubagentDelegationPrompt(eagerness) : '',
            executionMode === 'work'
              ? '## 看板派工工具\nWork 模式可用：kanban_create_board、kanban_add_task、kanban_list_boards、kanban_list_tasks。长任务拆成看板任务并指定 roleId；调度器会派 headless 工人。'
              : '',
            this.buildMentionPromptAppend(input.sessionId, executionMode),
            buildRichContentSystemPrompt(),
            mem.managementRules,
            mem.memorySnapshotSection,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
        persistSession: true,
        mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
        // 子代理定义：仅 Work 注册（Chat 硬拦 Task，注册无意义）
        agents: executionMode === 'work' ? buildBuiltinSubagentDefinitions(true) : undefined,
        // 权限钩子（bypass 模式不挂）
        ...(canUseTool ? { canUseTool } : {}),
        // 长驻首次 spawn 带 resume 续历史（SDK 读 JSONL 一次），之后靠内存
        resumeSessionId: meta?.sdkSessionId,
        onSessionId: (sdkSessionId: string) => {
          if (sdkSessionId && sdkSessionId !== meta?.sdkSessionId) {
            updateSessionMeta(input.sessionId, { sdkSessionId })
            console.log(`[会话 ${input.sessionId}] 已保存 sdkSessionId: ${sdkSessionId}`)
          }
        },
        onStderr: (data: string) => {
          console.error(`[kscc stderr] ${data}`)
          // 喂给 runtime：累积 stderr 供过长上下文识别（见 session-runtime.runLoop）
          this.runtimes.get(input.sessionId)?.reportStderr(data)
        },
      }
      return opts as unknown as Parameters<AgentProviderAdapter['query']>[0]
    }

    // 外部渠道：Pi 核，构造 PiQueryOptions
    // PiAgentAdapter.query() 解构 channelConfig（嵌套对象），不是扁平字段。
    // 对应 PiExternalChannelConfig：type/provider/apiKey/baseUrl/modelId/thinking*
    // 注：subagentEagerness 当前仅注入 kscc 核。Pi 核的 systemPrompt 是「整体替换」
    // （systemPrompt ?? DEFAULT_SYSTEM_PROMPT）而非 append，且 DEFAULT_SYSTEM_PROMPT 未导出，
    // 直接注入委派策略会覆盖默认 system prompt，故暂不接；如需支持需先给 Pi 核加 append 点。
    const apiKey = getDecryptedApiKey(channel.id)
    if (!apiKey) {
      // apiKey 解密失败（Windows DPAPI 跨实例不可互通）或未设置 → 早点报错，别让空 key 打到 HTTP
      throw new Error(
        `渠道「${channel.name}」的 apiKey 未设置或解密失败，请在「渠道管理」中重新输入 apiKey`,
      )
    }
    // beforeToolCall：pi-agent-core 签名，包 PermissionService.createBeforeToolCall
    const beforeToolCall = this.permissionService
      ? this.permissionService.createBeforeToolCall(
          input.sessionId,
          () => this.getPermissionMode(input.sessionId),
          cwd,
          () => this.getExecutionMode(input.sessionId),
        )
      : undefined
    const piMeta = getSessionMeta(input.sessionId)
    // Pi 核 systemPrompt 为整体替换：注入执行形态段落（避免仅靠工具层无文案）
    const piExecutionMode = this.getExecutionMode(input.sessionId)
    const piExecutionPrompt = [
      buildExecutionModePrompt(piExecutionMode),
      piExecutionMode === 'work'
        ? '## 看板派工工具\n可用 kanban_create_board / kanban_add_task / kanban_list_*。长任务拆任务并指定 roleId。'
        : '',
      this.buildMentionPromptAppend(input.sessionId, piExecutionMode),
    ]
      .filter(Boolean)
      .join('\n\n')
    const kanbanExtra =
      piExecutionMode === 'work'
        ? buildPiKanbanTools({
            sessionId: input.sessionId,
            channelId: channel.id,
            agentCwd: cwd,
            workspaceId: workspace?.slug,
            toolMode: 'full',
          })
        : []
    const opts = {
      sessionId: input.sessionId,
      prompt: input.prompt,
      model,
      cwd,
      executionMode: piExecutionMode,
      // MCP 配置（无 server 时 pi-core 跳过）
      mcpConfig,
      // 权限钩子（含 Chat 硬拦；始终挂上以便 Chat 下 bypass 也无法写）
      ...(beforeToolCall ? { beforeToolCall } : {}),
      // 执行形态 + Work 看板说明
      systemPromptAppend: piExecutionPrompt,
      // Work：看板 AgentTool
      ...(kanbanExtra.length > 0 ? { extraTools: kanbanExtra } : {}),
      // Phase 2.2：记忆模式透传（Frozen 快照 / L-rag）
      sessionMode: (piMeta?.mode === 'ta' ? 'ta' : 'general') as MemoryMode,
      // Pi 核专属：渠道凭证 + provider，pi-ai streamFn 用
      channelConfig: {
        type: 'external' as const,
        provider: channel.provider,
        apiKey,
        baseUrl: channel.baseUrl,
        modelId: model,
        // thinking 控制：默认关闭，后续可加 UI toggle
        thinkingEnabled: false,
        thinkingLevel: 'medium' as const,
        // Phase 1.1：注入真实 contextWindow（替代 buildPlaceholderModel 旧的 128k 硬编码）
        contextWindow: resolveModelContextWindow(channel, model),
      },
    }
    void permissionMode
    return opts as unknown as Parameters<AgentProviderAdapter['query']>[0]
  }

  /** 读会话当前权限模式（permissionMode getter，供 PermissionService 闭包调用，实现运行中切换） */
  private getPermissionMode(sessionId: string): TAgentPermissionMode {
    const meta = getSessionMeta(sessionId)
    return meta?.permissionMode
      ? migratePermissionMode(meta.permissionMode)
      : TAGENT_DEFAULT_PERMISSION_MODE
  }

  /** 读会话 executionMode（Chat|Work）；缺省按新会话默认 work（与 DEFAULT_EXECUTION_MODE 一致） */
  private getExecutionMode(sessionId: string): ExecutionMode {
    const meta = getSessionMeta(sessionId)
    return migrateExecutionMode(
      meta?.executionMode,
      // 有 meta 但缺字段 → 旧会话回退 work；无 meta → 新会话默认 work
      meta ? LEGACY_EXECUTION_MODE : DEFAULT_EXECUTION_MODE,
    )
  }

  /**
   * Chat @ 提及：把点名角色投影进 system prompt（顺序发言）。
   * Work 下默认不注入（避免乱 @ 与派工打架）。
   */
  private buildMentionPromptAppend(sessionId: string, executionMode: ExecutionMode): string {
    if (executionMode !== 'chat') return ''
    const meta = getSessionMeta(sessionId)
    const ids = meta?.pendingMentionRoleIds
    if (!ids || ids.length === 0) return ''
    try {
      const blocks: string[] = [
        '## Chat @ 点名发言',
        '用户本轮用 @ 点名了下列岗位。请**按列表顺序**以各岗位视角依次回复（可分段标明角色名）。',
        '规则：不创建看板、不写本地文件、不委派 SubAgent；只做讨论与方案。',
        '',
      ]
      for (const roleId of ids) {
        const role = resolveRole(roleId)
        blocks.push(
          composeRoleSystemPrompt(role, {
            purpose: 'mention-turn',
            maxRolePromptChars: 2400,
            runtimeConstraints:
              '本段仅讨论；禁止声称已改代码或已派工。用中文。',
          }),
        )
        blocks.push('')
      }
      return blocks.join('\n')
    } catch (err) {
      console.warn('[会话] buildMentionPromptAppend 失败:', err)
      return ''
    }
  }

  /** kscc 路径：转译 SDKMessage → IR，发 TAgentDesktopStreamPayload 给 renderer，并双写 JSONL */
  private handleSdkStreamMessage(sessionId: string, workspaceId: string | undefined, msg: SDKMessage): void {
    // 注入 createdAt（落盘带上，加载时 sdkMessageToIR 读回 → 渲染层显示时间）
    ;(msg as any).createdAt = (msg as any).createdAt ?? Date.now()
    const { message, event } = sdkMessageToIR(msg)
    if (message) {
      // Phase 1.2 双写：先面板（保可见）再 SDK；流式 delta 不落盘
      try {
        appendPanelMessages(workspaceId, sessionId, [msg])
      } catch (err) {
        console.warn('[session-service] appendPanelMessages failed:', err)
      }
      try {
        appendSdkMessages(workspaceId, sessionId, [msg])
      } catch (err) {
        console.error('[session-service] appendSdkMessages failed:', err)
      }
      this.sendPayload(sessionId, { kind: 'sdk_message', message })
    }
    if (event) {
      this.sendPayload(sessionId, event)
    }
    // Phase 4：result 后跑软重置阈值（廉价清理 / 影子 / 切换）
    if ((msg as { type?: string }).type === 'result') {
      const meta = getSessionMeta(sessionId)
      const usage = (msg as { usage?: { input_tokens?: number; inputTokens?: number } }).usage
      const inputTokens = usage?.input_tokens ?? usage?.inputTokens
      void ksccSoftReset
        .onTurnResult({
          sessionId,
          inputTokens,
          modelId: meta?.modelId,
          channelId: meta?.channelId,
        })
        .catch((e) => console.warn('[session-service] soft-reset onTurnResult failed:', e))
    }
  }

  /** pi 路径：已是 IR（TAgentDesktopStreamPayload），落盘面板 IR + 推 IPC，不经 sdkMessageToIR。
   *  完整消息（sdk_message）落盘 IR；控制事件（result/stream_*_delta/tagent_event）不落盘。
   *  单真源流式（S1）：partial assistant（`_partial`）只推渲染层原地 upsert，**不落盘**——
   *  落盘只留 final（同 uuid 替换 partial），避免 partial 堆积污染历史 / L-rag。 */
  private handlePiStreamPayload(sessionId: string, workspaceId: string | undefined, p: TAgentDesktopStreamPayload): void {
    if (p.kind === 'sdk_message') {
      const msg = p.message
      ;(msg as any).createdAt = (msg as any).createdAt ?? Date.now()
      const isPartial =
        msg.type === 'assistant' && (msg as { _partial?: boolean })._partial === true
      if (!isPartial) {
        try {
          appendPanelMessages(workspaceId, sessionId, [msg])
        } catch (err) {
          console.warn('[session-service] appendPanelMessages failed (pi):', err)
        }
      }
      this.sendPayload(sessionId, p)
    } else {
      this.sendPayload(sessionId, p)
    }
  }

  /** 发流式事件给 renderer */
  private sendPayload(sessionId: string, payload: TAgentDesktopStreamPayload): void {
    const win = this.getWindow()
    win?.webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload })
  }

  /**
   * Phase 2.5：turn 开始 Nudge 检测（双核统一入口）。
   * 读面板消息 → onTurnStart → 有候选则推 NUdge_EVENT。
   */
  private runNudgeOnTurnStart(sessionId: string, meta: AgentSessionMeta | undefined): void {
    try {
      // switching 时提示 UI，不打断 Nudge（仍可记）
      if (meta?.shadowState === 'switching') {
        this.sendPayload(sessionId, {
          kind: 'tagent_event',
          event: { type: 'memory_organizing', status: 'switching' },
        })
      }
      const mode: MemoryMode = meta?.mode === 'ta' ? 'ta' : 'general'
      // Phase 5.2：跨核归一化
      const recentMsgs = normalizeToTextMessages(
        readPanelMessages(meta?.workspaceId, sessionId).slice(-10),
      ).map((m) => ({ role: m.role, content: m.contentText }))
      const candidates = nudgeService.onTurnStart(sessionId, recentMsgs, mode)
      if (candidates.length > 0) {
        const win = this.getWindow()
        win?.webContents.send(MEMORY_IPC_CHANNELS.NUdge_EVENT, {
          type: 'nudge_candidates',
          sessionId,
          mode,
          nudges: candidates,
        })
      }
    } catch (err) {
      console.warn('[session-service] runNudgeOnTurnStart failed:', err)
    }
  }

  /**
   * Phase 2.5：turn 结束后写 L4 + evidence sink。
   * 失败仅 warn，不阻塞主流程。
   */
  private recordSessionToMemory(sessionId: string, userPrompt: string): void {
    try {
      const meta = getSessionMeta(sessionId)
      const mode: MemoryMode = meta?.mode === 'ta' ? 'ta' : 'general'
      const workspaceSlug = meta?.workspaceId ?? ''
      const panel = readPanelMessages(meta?.workspaceId, sessionId)
      const { toolsUsed, lastAssistantText } = this.extractToolsAndAssistant(panel.slice(-20))
      const title = (userPrompt || meta?.title || '会话').slice(0, 100)
      const summary = lastAssistantText.slice(0, 500)
      void memoryLayerService
        .recordSession({
          sessionId,
          title,
          summary,
          keyFacts: [],
          toolsUsed,
          mode,
          workspaceSlug,
        })
        .catch((e) => console.warn('[session-service] recordSession failed:', e))

      // 将会话证据写入 sink，供空闲 consolidation 批量处理
      try {
        memoryEvidenceSink.writeSessionEvidence(mode, sessionId, title, summary, toolsUsed)
      } catch (e) {
        console.warn('[session-service] writeSessionEvidence failed:', e)
      }
    } catch (err) {
      console.warn('[session-service] recordSessionToMemory failed:', err)
    }
  }

  /** 面板消息 → Nudge 用的 role/content 列表（兼容 SDKMessage 与 IR） */
  private panelMessagesToRoleContent(
    messages: unknown[],
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const raw of messages) {
      const m = raw as {
        type?: string
        role?: string
        message?: { role?: string; content?: unknown }
        content?: unknown
      }
      const roleRaw =
        m.message?.role ??
        (m.type === 'user' || m.type === 'assistant' ? m.type : m.role)
      if (roleRaw !== 'user' && roleRaw !== 'assistant') continue
      const content = m.message?.content ?? m.content
      const text = this.contentToText(content)
      if (!text.trim()) continue
      out.push({ role: roleRaw, content: text })
    }
    return out
  }

  private contentToText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .map((b) => {
        if (b && typeof b === 'object' && 'type' in b && (b as { type: string }).type === 'text') {
          return String((b as { text?: string }).text ?? '')
        }
        return ''
      })
      .join('')
  }

  private extractToolsAndAssistant(messages: unknown[]): {
    toolsUsed: string[]
    lastAssistantText: string
  } {
    const tools = new Set<string>()
    let lastAssistantText = ''
    for (const raw of messages) {
      const m = raw as {
        type?: string
        role?: string
        message?: { role?: string; content?: unknown }
        content?: unknown
      }
      const content = m.message?.content ?? m.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            'type' in block &&
            (block as { type: string }).type === 'tool_use' &&
            'name' in block &&
            typeof (block as { name: unknown }).name === 'string'
          ) {
            tools.add((block as { name: string }).name)
          }
        }
      }
      const role =
        m.message?.role ??
        (m.type === 'assistant' || m.type === 'user' ? m.type : m.role)
      if (role === 'assistant') {
        const text = this.contentToText(content)
        if (text) lastAssistantText = text
      }
    }
    return { toolsUsed: Array.from(tools), lastAssistantText }
  }

  /** 停止并删除指定工作区的全部会话，供工作区删除流程复用。 */
  deleteWorkspaceSessions(workspaceId: string): number {
    const sessionIds = listSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.id)

    for (const sessionId of sessionIds) {
      const runtime = this.runtimes.get(sessionId)
      if (runtime) {
        runtime.destroy()
        this.runtimes.delete(sessionId)
      }
    }

    return deleteSessionsByWorkspace(workspaceId).length
  }

  /** 销毁所有会话（应用退出） */
  disposeAll(): void {
    for (const rt of this.runtimes.values()) rt.destroy()
    this.runtimes.clear()
  }

  /**
   * 是否有运行中的 Agent（自动更新安装前检查用）。
   * 用 isTurnInFlight() 而非 isRunning()：长驻进程 isRunning 恒 true。
   */
  hasActiveAgents(): boolean {
    for (const rt of this.runtimes.values()) {
      if (rt.isTurnInFlight()) return true
    }
    return false
  }
}
