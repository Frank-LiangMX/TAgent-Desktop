/**
 * TAgent-Desktop preload：渲染进程↔主进程桥。
 *
 * 暴露两类 IPC：
 * - 会话：发消息/收流式/停止/销毁/列会话/读历史（发消息按 channelId 绑核）
 * - 渠道：列/建/改/删/测连接/拉模型（密钥仅在主进程解密）
 *
 * 流式统一走 STREAM_EVENT，payload 是 TAgentDesktopStreamEvent（{ sessionId, payload }）。
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  AGENT_IPC_CHANNELS,
  AGENT_ROLE_IPC_CHANNELS,
  BALANCE_IPC_CHANNELS,
  CHANNEL_IPC_CHANNELS,
  KANBAN_IPC_CHANNELS,
  MEMORY_IPC_CHANNELS,
  USER_PROFILE_IPC_CHANNELS,
} from '@tagent/shared'
import type {
  AgentRoleProfile,
  AgentWorkspace,
  Channel,
  ChannelBalanceResult,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelTestResult,
  DeleteRolesResult,
  FetchModelsInput,
  FetchModelsForChannelInput,
  FetchModelsResult,
  ImportRoleFromMdResult,
  InstallStoreBundleResult,
  InstallStoreRoleResult,
  McpServerEntry,
  PluginStoreCatalog,
  RoleStoreCatalogResult,
  SaveAgentRoleInput,
  UserProfile,
  WorkspaceMcpConfig,
  WorkspacePluginBundleRecord,
} from '@tagent/shared'

export interface SendMessageInput {
  sessionId: string
  prompt: string
  /** 渠道 ID（决定选哪个 adapter + 绑核，kscc↔external 互斥） */
  channelId?: string
  /** 模型 ID */
  model?: string
  /** 工作区 ID（= sanitizePath(projectPath)，用于 JSONL 按项目存储） */
  workspaceId?: string
}

const electronAPI = {
  // ===== 会话 =====
  /** 发消息（首次 spawn + 起循环，后续 enqueue 复用；按 channelId 绑核） */
  sendMessage: (input: SendMessageInput) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEND_MESSAGE, input),
  /** 停止当前轮（软中断，保进程） */
  stopAgent: (sessionId: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.STOP_AGENT, sessionId),
  /** 引导 Agent（不中断当前轮，在下一轮边界注入用户消息） */
  steerAgent: (sessionId: string, message: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.STEER_AGENT, sessionId, message),
  /** 保存附件到磁盘 */
  saveAttachment: (input: { sessionId: string; filename: string; mediaType: string; data: string }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_ATTACHMENT, input),
  /** 读取附件为 base64 */
  readAttachment: (localPath: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_ATTACHMENT, localPath),
  /** 打开系统文件选择器 */
  openFileDialog: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FILE_DIALOG),
  /** 用系统默认程序打开文件（相对路径按会话工作区解析） */
  openPath: (input: { sessionId: string; path: string }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_PATH, input),
  /** 解析路径是否存在（文件 chip 存在性检查），返回存在的绝对路径或 null */
  resolveFile: (input: { sessionId: string; path: string; bases?: string[] }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.RESOLVE_FILE, input),
  /** 销毁会话（杀进程 + 删元数据/JSONL） */
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_SESSION, sessionId),
  /** 列出所有会话（元数据） */
  listSessions: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SESSIONS),
  /** 读会话历史消息（JSONL） */
  getMessages: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SDK_MESSAGES, sessionId),
  /** 监听流式事件 */
  onStreamEvent: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(AGENT_IPC_CHANNELS.STREAM_EVENT, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.STREAM_EVENT, handler)
  },

  // ===== 渠道 =====
  /** 列出所有渠道（apiKey 加密，不泄露明文） */
  listChannels: () => ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.LIST) as Promise<Channel[]>,
  /** 创建渠道（apiKey 明文，主进程加密后存储） */
  createChannel: (input: ChannelCreateInput) =>
    ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.CREATE, input) as Promise<Channel>,
  /** 更新渠道（patch.apiKey 空串=不改，非空=加密覆盖） */
  updateChannel: (id: string, patch: ChannelUpdateInput) =>
    ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.UPDATE, { id, patch }) as Promise<Channel | undefined>,
  /** 删除渠道（kscc-internal 不可删） */
  deleteChannel: (id: string) =>
    ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.DELETE, id) as Promise<{ ok: boolean; error?: string }>,
  /** 测试渠道连接 */
  testChannel: (id: string) =>
    ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.TEST, id) as Promise<ChannelTestResult>,
  /** 使用当前输入的凭据拉取 Provider 可用模型 */
  fetchModels: (input: FetchModelsInput) =>
    ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.FETCH_MODELS, input) as Promise<FetchModelsResult>,
  /** 使用已保存渠道的加密凭据拉取模型，明文密钥不进入渲染进程 */
  fetchModelsForChannel: (input: FetchModelsForChannelInput) =>
    ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.FETCH_MODELS_FOR_CHANNEL, input) as Promise<FetchModelsResult>,

  // ===== 工作区 =====
  /** 列出所有工作区 */
  listWorkspaces: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_WORKSPACES) as Promise<AgentWorkspace[]>,
  /** 创建项目工作区（弹出文件夹选择对话框） */
  createProjectWorkspace: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_PROJECT_WORKSPACE) as Promise<AgentWorkspace | null>,
  /** 删除工作区及其会话；不删除本地项目源码目录 */
  deleteWorkspace: (id: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_WORKSPACE, id) as Promise<void>,
  /** 读取工作区文件（富内容预览块用；仅限已注册工作区目录内） */
  readWorkspaceFile: (filePath: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE, filePath) as Promise<{
      content?: string
      dataUrl?: string
      mime?: string
    } | null>,
  /** 持久化工作区侧栏顺序 */
  reorderWorkspaces: (orderedIds: string[]) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.REORDER_WORKSPACES, orderedIds) as Promise<AgentWorkspace[]>,
  /** 更新会话元数据（重命名 title / 置顶 pinned / 归档 archived / 子代理委派积极性 subagentEagerness / 思考强度 reasoningEffort；status 由主进程内部写，渲染层不直接写） */
  updateSessionMeta: (id: string, patch: {
    title?: string
    pinned?: boolean
    archived?: boolean
    subagentEagerness?: 'never' | 'conservative' | 'balanced' | 'aggressive'
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_META, { id, patch }) as Promise<unknown>,
  /** 切换会话置顶 */
  togglePin: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_PIN, id) as Promise<unknown>,
  /** 切换会话归档 */
  toggleArchive: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_ARCHIVE, id) as Promise<unknown>,
  /** 清除 Chat @ 对话跟随（activeSpeaker 回默认总助） */
  clearMentionFollow: (id: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.CLEAR_MENTION_FOLLOW, id) as Promise<unknown>,
  /** 查会话生命状态（runtimes 内存 + meta 组合；running 不落盘） */
  getSessionStatus: (id: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SESSION_STATUS, id) as Promise<{
      status: 'idle' | 'running' | 'error'
      archived: boolean
    }>,
  // 窗口控制（自定义 WindowControls 用，对齐 TAgent_General）
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  onWindowResize: (cb: () => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('window:resize', handler)
    return () => ipcRenderer.removeListener('window:resize', handler)
  },
  // MCP 配置（工作区 mcp.json）
  getMcpConfig: (slug: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_MCP_CONFIG, slug) as Promise<WorkspaceMcpConfig>,
  saveMcpConfig: (slug: string, config: WorkspaceMcpConfig) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG, { slug, config }) as Promise<{ ok: boolean }>,
  /** 新增/更新单个 MCP server（启用开关即时 upsert 也走这里） */
  upsertMcpServer: (slug: string, name: string, entry: McpServerEntry) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG + ':upsert', { slug, name, entry }) as Promise<WorkspaceMcpConfig>,
  /** 删除单个 MCP server */
  deleteMcpServer: (slug: string, name: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG + ':delete', { slug, name }) as Promise<{ ok: boolean; error?: string }>,
  /** 真实测试 MCP server 连接（成功/失败顺带持久化 lastTestResult） */
  testMcpServer: (slug: string, name: string, entry: McpServerEntry) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.TEST_MCP_SERVER, { slug, name, entry }) as Promise<{ success: boolean; message: string }>,
  // 插件商店（整合包市场）
  /** 获取插件商店目录（整合包 + Skill + MCP） */
  getPluginStoreCatalog: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_PLUGIN_STORE_CATALOG) as Promise<PluginStoreCatalog>,
  /** 获取工作区已安装整合包记录（plugins-installed.json） */
  getInstalledPluginBundles: (slug: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_INSTALLED_PLUGIN_BUNDLES, slug) as Promise<WorkspacePluginBundleRecord[]>,
  /** 安装整合包（写 MCP + 可装 Skill + 写 manifest） */
  installStoreBundle: (slug: string, bundleId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.INSTALL_STORE_BUNDLE, { slug, bundleId }) as Promise<InstallStoreBundleResult>,
  /** 卸载整合包（移除 manifest 记录 + 仍匹配商店形态的 MCP + 记录的 Skill 目录） */
  uninstallStoreBundle: (slug: string, bundleId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.UNINSTALL_STORE_BUNDLE, { slug, bundleId }) as Promise<{ ok: boolean; removedMcps: string[]; removedSkills: string[]; errors: string[] }>,
  // 权限审批（主进程推请求 / renderer 回响应）
  onPermissionRequest: (cb: (req: unknown) => void) => {
    const handler = (_e: unknown, req: unknown): void => cb(req)
    ipcRenderer.on(AGENT_IPC_CHANNELS.PERMISSION_REQUEST, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.PERMISSION_REQUEST, handler)
  },
  respondToPermission: (reqId: string, behavior: 'allow' | 'deny', remember?: boolean) =>
    ipcRenderer.send(AGENT_IPC_CHANNELS.PERMISSION_RESPOND, { reqId, behavior, remember }),
  // 热切换指定会话的权限模式（持久化 meta + 通知运行时）
  setSessionPermissionMode: (sessionId: string, mode: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE, { sessionId, mode }) as Promise<{ ok: boolean; error?: string }>,

  // ===== 角色库 =====
  listAgentRoles: () =>
    ipcRenderer.invoke(AGENT_ROLE_IPC_CHANNELS.LIST) as Promise<AgentRoleProfile[]>,
  getAgentRole: (roleId: string) =>
    ipcRenderer.invoke(AGENT_ROLE_IPC_CHANNELS.GET, roleId) as Promise<AgentRoleProfile | undefined>,
  saveAgentRole: (input: SaveAgentRoleInput) =>
    ipcRenderer.invoke(AGENT_ROLE_IPC_CHANNELS.SAVE, input) as Promise<AgentRoleProfile[]>,
  deleteAgentRole: (roleId: string) =>
    ipcRenderer.invoke(AGENT_ROLE_IPC_CHANNELS.DELETE, { roleId }) as Promise<{
      roles: AgentRoleProfile[]
      deleted: boolean
      reason?: string
    }>,
  resetDefaultAgentRoles: () =>
    ipcRenderer.invoke(AGENT_ROLE_IPC_CHANNELS.RESET_DEFAULT) as Promise<AgentRoleProfile[]>,
  listRoleStoreCatalog: () =>
    ipcRenderer.invoke(AGENT_ROLE_IPC_CHANNELS.STORE_LIST) as Promise<RoleStoreCatalogResult>,
  installStoreRole: (roleId: string) =>
    ipcRenderer.invoke(AGENT_ROLE_IPC_CHANNELS.STORE_INSTALL, roleId) as Promise<InstallStoreRoleResult>,
  importAgentRoleFromMd: () =>
    ipcRenderer.invoke(AGENT_ROLE_IPC_CHANNELS.IMPORT_MD) as Promise<ImportRoleFromMdResult>,
  findSimilarAgentRoles: (displayName: string) =>
    ipcRenderer.invoke(AGENT_ROLE_IPC_CHANNELS.FIND_SIMILAR, displayName) as Promise<AgentRoleProfile[]>,
  deleteAgentRolesBatch: (roleIds: string[]) =>
    ipcRenderer.invoke(AGENT_ROLE_IPC_CHANNELS.DELETE_BATCH, roleIds) as Promise<DeleteRolesResult>,
  /**
   * 热切换 executionMode（Chat|Work）。
   * source 必须是 user | user-confirm-suggestion（ADR-0005）；Agent 不得调用。
   */
  setSessionExecutionMode: (
    sessionId: string,
    mode: 'chat' | 'work',
    source: 'user' | 'user-confirm-suggestion' = 'user',
  ) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_EXECUTION_MODE, {
      sessionId,
      mode,
      source,
    }) as Promise<{
      ok: boolean
      error?: string
      mode?: 'chat' | 'work'
      /** Work→Chat 时若班组仍有在途任务 */
      backgroundCrew?: {
        running: number
        ready: number
        pending: number
        boardId?: string
      }
    }>,
  /** 监听形态切换建议条（主进程 Chat 硬拦等推送） */
  onExecutionModeSuggestion: (cb: (suggestion: unknown) => void) => {
    const handler = (_e: unknown, suggestion: unknown): void => cb(suggestion)
    ipcRenderer.on(AGENT_IPC_CHANNELS.EXECUTION_MODE_SUGGESTION, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.EXECUTION_MODE_SUGGESTION, handler)
  },
  /** 关闭建议条（不切换 mode） */
  dismissExecutionModeSuggestion: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.DISMISS_EXECUTION_MODE_SUGGESTION, {
      sessionId,
    }) as Promise<{ ok: boolean }>,

  // ===== 通知偏好 =====
  getNotificationPrefs: () =>
    ipcRenderer.invoke('notification-prefs:get') as Promise<{
      titlebarTicker: boolean
      systemDesktop: boolean
      panelToast: boolean
    }>,
  setNotificationPrefs: (prefs: {
    titlebarTicker?: boolean
    systemDesktop?: boolean
    panelToast?: boolean
  }) =>
    ipcRenderer.invoke('notification-prefs:set', prefs) as Promise<{
      titlebarTicker: boolean
      systemDesktop: boolean
      panelToast: boolean
    }>,

  // ===== 看板 / 派工（Phase D）=====
  kanbanListBoards: (input?: { status?: string }) =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.LIST_BOARDS, input),
  kanbanGetBoard: (boardId: string) =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.GET_BOARD, boardId),
  kanbanGetTask: (taskId: string) =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.GET_TASK, taskId),
  kanbanListTasks: (boardId: string, status?: string) =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.LIST_TASKS, { boardId, status }),
  kanbanCreateBoard: (input: Record<string, unknown>) =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.CREATE_BOARD, input),
  kanbanCreateTask: (input: Record<string, unknown>) =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.CREATE_TASK, input),
  kanbanPauseBoard: (boardId: string, sessionId?: string) =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.PAUSE_BOARD, { boardId, sessionId }),
  kanbanResumeBoard: (boardId: string, sessionId?: string) =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.RESUME_BOARD, { boardId, sessionId }),
  /** 解除阻塞（blocked → ready） */
  kanbanUnblockTask: (taskId: string, reason?: string) =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.UNBLOCK_TASK, { taskId, reason }),
  /** 重试失败任务（failed → ready/pending） */
  kanbanRetryTask: (taskId: string) =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.RETRY_TASK, { taskId }),
  /** 写 blackboard 评论 */
  kanbanCommentTask: (taskId: string, comment: string, author = 'main') =>
    ipcRenderer.invoke(KANBAN_IPC_CHANNELS.COMMENT_TASK, { taskId, comment, author }),
  onKanbanChanged: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(KANBAN_IPC_CHANNELS.CHANGED, handler)
    return () => ipcRenderer.removeListener(KANBAN_IPC_CHANNELS.CHANGED, handler)
  },
  onKanbanBoardCompleted: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(KANBAN_IPC_CHANNELS.BOARD_COMPLETED, handler)
    return () => ipcRenderer.removeListener(KANBAN_IPC_CHANNELS.BOARD_COMPLETED, handler)
  },

  /** 手动压缩会话上下文（Pi 核；需会话已在本机启动） */
  compactSession: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.COMPACT_SESSION, { sessionId }) as Promise<{
      ok: boolean
      compacted: boolean
      reason?: string
      tokensBefore?: number
    }>,
  /**
   * 系统是否深色（主进程 nativeTheme.shouldUseDarkColors）。
   * 渲染层「跟随系统」应信这个，不要只靠 matchMedia。
   */
  getSystemDark: () => ipcRenderer.invoke('theme:get-system-dark') as Promise<boolean>,
  /** 系统明暗变化（nativeTheme updated） */
  onSystemThemeUpdated: (cb: (dark: boolean) => void) => {
    const handler = (_e: unknown, dark: boolean): void => cb(dark)
    ipcRenderer.on('theme:system-updated', handler)
    return () => ipcRenderer.removeListener('theme:system-updated', handler)
  },
  /**
   * 上报应用内解析后的深浅（浅色/深色/跟随系统 → 最终 dark?）。
   * 主进程用它切换窗口/Dock 的 light/dark appicon。
   */
  setResolvedDark: (dark: boolean) => ipcRenderer.send('theme:set-resolved-dark', dark),

  // ===== 记忆系统（Phase 2）=====
  initMemoryLayers: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.INIT_MEMORY_LAYERS) as Promise<unknown>,
  getMemoryStats: (mode: 'general' | 'ta') =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_MEMORY_STATS, mode) as Promise<unknown>,
  searchMemorySessions: (mode: 'general' | 'ta', query: string, limit?: number) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEARCH_MEMORY_SESSIONS, mode, query, limit) as Promise<
      unknown[]
    >,
  listRecentMemorySessions: (mode: 'general' | 'ta', limit?: number) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_RECENT_MEMORY_SESSIONS, mode, limit) as Promise<
      unknown[]
    >,
  getMemoryMdContent: (mode: 'general' | 'ta', layer: 'L0' | 'L1' | 'L2' | 'L5') =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_MEMORY_MD_CONTENT, mode, layer) as Promise<
      string | null
    >,
  getMemoryCorrections: (mode: 'general' | 'ta', limit?: number) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_MEMORY_CORRECTIONS, mode, limit) as Promise<unknown[]>,
  getPendingNudges: (sessionId: string) =>
    ipcRenderer.invoke(MEMORY_IPC_CHANNELS.GET_PENDING_NUDGES, sessionId) as Promise<unknown[]>,
  respondNudge: (
    sessionId: string,
    nudgeId: string,
    action: 'accept' | 'reject' | 'defer',
    mode: 'general' | 'ta',
  ) =>
    ipcRenderer.invoke(MEMORY_IPC_CHANNELS.RESPOND_NUDGE, {
      sessionId,
      nudgeId,
      action,
      mode,
    }) as Promise<{ ok: boolean }>,
  onNudgeEvent: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(MEMORY_IPC_CHANNELS.NUdge_EVENT, handler)
    return () => ipcRenderer.removeListener(MEMORY_IPC_CHANNELS.NUdge_EVENT, handler)
  },
  getStageQueue: (mode: 'general' | 'ta') =>
    ipcRenderer.invoke(MEMORY_IPC_CHANNELS.GET_STAGE_QUEUE, mode) as Promise<unknown[]>,
  acceptStageAll: (mode: 'general' | 'ta') =>
    ipcRenderer.invoke(MEMORY_IPC_CHANNELS.ACCEPT_STAGE_ALL, mode) as Promise<unknown[]>,
  rejectStageAll: (mode: 'general' | 'ta') =>
    ipcRenderer.invoke(MEMORY_IPC_CHANNELS.REJECT_STAGE_ALL, mode) as Promise<unknown[]>,
  acceptStageOne: (mode: 'general' | 'ta', id: string) =>
    ipcRenderer.invoke(MEMORY_IPC_CHANNELS.ACCEPT_STAGE_ONE, { mode, id }) as Promise<{
      ok: boolean
    }>,
  rejectStageOne: (mode: 'general' | 'ta', id: string) =>
    ipcRenderer.invoke(MEMORY_IPC_CHANNELS.REJECT_STAGE_ONE, { mode, id }) as Promise<{
      ok: boolean
    }>,
  getGraphData: (mode: 'general' | 'ta', workspaceSlug?: string) =>
    ipcRenderer.invoke(MEMORY_IPC_CHANNELS.GET_GRAPH_DATA, mode, workspaceSlug) as Promise<unknown>,

  // ===== 用户档案 =====
  getUserProfile: () =>
    ipcRenderer.invoke(USER_PROFILE_IPC_CHANNELS.GET) as Promise<UserProfile>,
  updateUserProfile: (updates: Partial<UserProfile>) =>
    ipcRenderer.invoke(USER_PROFILE_IPC_CHANNELS.UPDATE, updates) as Promise<UserProfile>,

  // ===== 渠道余额 =====
  getChannelBalance: (channelId: string) =>
    ipcRenderer.invoke(BALANCE_IPC_CHANNELS.GET, channelId) as Promise<ChannelBalanceResult>,
} as const

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
