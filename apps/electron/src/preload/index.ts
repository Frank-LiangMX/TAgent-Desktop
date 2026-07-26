/**
 * TAgent-Desktop preload：渲染进程↔主进程桥。
 *
 * 暴露两类 IPC：
 * - 会话：发消息/收流式/停止/销毁/列会话/读历史（发消息按 channelId 绑核）
 * - 渠道：列/建/改/删/解密 apiKey/测连接/拉模型
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
  FetchModelsResult,
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
  /** 解密 apiKey（编辑时回填用；kscc 返回空串） */
  decryptKey: (id: string) =>
    ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.DECRYPT_KEY, id) as Promise<string>,
  /** 测试渠道连接 */
  testChannel: (id: string) =>
    ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.TEST, id) as Promise<ChannelTestResult>,
  /** 拉取 Provider 可用模型（占位：返回内置默认模型） */
  fetchModels: (input: FetchModelsInput) =>
    ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.FETCH_MODELS, input) as Promise<FetchModelsResult>,

  // ===== 工作区 =====
  /** 列出所有工作区 */
  listWorkspaces: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_WORKSPACES) as Promise<AgentWorkspace[]>,
  /** 创建项目工作区（弹出文件夹选择对话框 → 创建 workspace + 自动切换） */
  createProjectWorkspace: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_PROJECT_WORKSPACE) as Promise<AgentWorkspace | null>,
  /** 获取当前工作区 */
  getCurrentWorkspace: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_WORKSPACES + ':current') as Promise<AgentWorkspace | undefined>,
  /** 切换当前工作区 */
  switchWorkspace: (id: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_WORKSPACE + ':switch', id) as Promise<{ ok: boolean; error?: string }>,
  /** 更新会话元数据（重命名 title / 置顶 pinned） */
  updateSessionMeta: (id: string, patch: { title?: string; pinned?: boolean }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION_META, { id, patch }) as Promise<unknown>,
  /** 切换会话置顶 */
  togglePin: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.TOGGLE_PIN, id) as Promise<unknown>,
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
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_MCP_CONFIG, slug) as Promise<unknown>,
  saveMcpConfig: (slug: string, config: unknown) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG, { slug, config }) as Promise<{ ok: boolean }>,
  // 权限审批（主进程推请求 / renderer 回响应）
  onPermissionRequest: (cb: (req: unknown) => void) => {
    const handler = (_e: unknown, req: unknown): void => cb(req)
    ipcRenderer.on(AGENT_IPC_CHANNELS.PERMISSION_REQUEST, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.PERMISSION_REQUEST, handler)
  },
  respondToPermission: (reqId: string, behavior: 'allow' | 'deny', remember?: boolean) =>
    ipcRenderer.send(AGENT_IPC_CHANNELS.PERMISSION_RESPOND, { reqId, behavior, remember }),
} as const

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
