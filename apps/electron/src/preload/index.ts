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
import { AGENT_IPC_CHANNELS, CHANNEL_IPC_CHANNELS } from '@tagent/shared'
import type {
  AgentWorkspace,
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelTestResult,
  FetchModelsInput,
  FetchModelsForChannelInput,
  FetchModelsResult,
  McpServerEntry,
  WorkspaceMcpConfig,
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
  /** 持久化工作区侧栏顺序 */
  reorderWorkspaces: (orderedIds: string[]) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.REORDER_WORKSPACES, orderedIds) as Promise<AgentWorkspace[]>,
  /** 更新会话元数据（重命名 title / 置顶 pinned / 归档 archived；status 由主进程内部写，渲染层不直接写） */
  updateSessionMeta: (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_META, { id, patch }) as Promise<unknown>,
  /** 切换会话置顶 */
  togglePin: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_PIN, id) as Promise<unknown>,
  /** 切换会话归档 */
  toggleArchive: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_ARCHIVE, id) as Promise<unknown>,
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
} as const

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
