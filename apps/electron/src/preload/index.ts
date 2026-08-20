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
  COLLABORATION_ROOM_IPC_CHANNELS,
  KANBAN_IPC_CHANNELS,
  MEMORY_IPC_CHANNELS,
  USER_PROFILE_IPC_CHANNELS,
  SYSTEM_PROMPT_IPC_CHANNELS,
  BROWSER_IPC_CHANNELS,
} from '@tagent/shared'
import type {
  AgentRoleProfile,
  AgentWorkspace,
  AskUserRequest,
  AskUserResponse,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  BoardProjectedSummary,
  BoardProjectedTask,
  Channel,
  ChannelBalanceResult,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelTestResult,
  CollaborationMember,
  CollaborationMemberPreset,
  CollaborationMessage,
  CollaborationRoom,
  CollaborationRun,
  CollaborationMailboxEnvelope,
  CollaborationRoomTask,
  CollaborationArtifact,
  CollaborationUserApprovalRequest,
  CollaborationTextDeltaPayload,
  CreateCollaborationRoomInput,
  SaveCollaborationMemberPresetInput,
  AddCollaborationMemberInput,
  ContinueCollaborationDepthStopInput,
  ContinueCollaborationDepthStopResult,
  CreateCollaborationRoomTaskInput,
  UpdateCollaborationRoomInput,
  UpdateCollaborationMemberInput,
  UpdateCollaborationRoomTaskInput,
  AppendCollaborationUserMessageInput,
  ReadCollaborationArtifactResult,
  ResolveCollaborationUserApprovalResult,
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
  SystemPrompt,
  SystemPromptConfig,
  SystemPromptCreateInput,
  SystemPromptUpdateInput,
  WorkspaceMcpConfig,
  WorkspacePluginBundleRecord,
  MoAPreset,
  CliWorkersConfig,
  CliWorkersProbeResult,
  AgentDiscussPrefs,
  AgentCrewPrefs,
} from '@tagent/shared'

import type {
  BrowserElementActionRequest,
  BrowserNavigateRequest,
  BrowserObserveResult,
  BrowserScreenshotResult,
  BrowserScrollRequest,
  BrowserSetBoundsRequest,
  BrowserTabRequest,
  BrowserTakeoverRequest,
  BrowserWorkspaceState,
  BrowserOpenRequest,
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
  /**
   * MoA 会诊本条（one-shot）：本轮走 runMoATurn，但**不**改 `meta.modelId`。
   * 见 docs/dev/moa-roundtable/02-SESSION-UX-SPEC.md §3。
   */
  moaOneShotPresetId?: string
  /**
   * 圆桌讨论本条（one-shot）：本轮走 runMoADiscussion（多轮讨论+总结人收口），
   * 但**不**改 `meta.modelId`，会话 tab / ModelSelector 仍显示真实模型（与会诊 one-shot 一致）。
   * 见 docs/dev/moa-roundtable/02-SESSION-UX-SPEC.md §3。
   */
  moaDiscussionPresetId?: string
}

const electronAPI = {
  // ===== 会话 =====
  /** 发消息（首次 spawn + 起循环，后续 enqueue 复用；按 channelId 绑核） */
  sendMessage: (input: SendMessageInput) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEND_MESSAGE, input),
  /** 停止当前轮（软中断；主进程另推 turn_end 清 running） */
  stopAgent: (sessionId: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.STOP_AGENT, sessionId),
  /** 撤回尚未开始 Agent 处理的最后一轮 user 输入（双写 panel + SDK） */
  recallUnsentTurn: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.RECALL_UNSENT_TURN, sessionId) as Promise<{
      ok: boolean
      text?: string
      reason?: 'no_user' | 'already_started' | 'empty'
    }>,
  /**
   * 引导 Agent（不中断当前轮）。
   * 返回 `{ ok, mode: 'live' | 'pending_next_turn' }`：
   * - live：kscc 长驻 enqueue
   * - pending_next_turn：Pi 等降级，本轮结束后自动发送
   */
  steerAgent: (sessionId: string, message: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.STEER_AGENT, sessionId, message) as Promise<{
      ok: boolean
      mode?: 'live' | 'pending_next_turn'
      error?: string
    }>,
  /** 圆桌讨论：用户插话（push 到活跃讨论 pending 队列，每轮开始前 drain 注入本轮参与者 prompt） */
  discussionInterject: (input: { sessionId: string; discussionId: string; text: string }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.DISCUSSION_INTERJECT, input) as Promise<{
      ok: boolean
      error?: string
    }>,
  /** 圆桌讨论：用户喊停（abort 活跃讨论 controller → cancelled 卡 + turn_end 清 running） */
  discussionStop: (input: { sessionId: string; discussionId: string }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.DISCUSSION_STOP, input) as Promise<{
      ok: boolean
      error?: string
    }>,
  /**
   * 圆桌讨论重放（T8）：会话打开/切回、历史消息加载后调用。主进程读该会话
   * moa-discussion.jsonl，把每场已落盘讨论按原 moa_discussion 事件推回，渲染层按 discussionId
   * upsert 成入口卡 + 讨论室回看。返回重放场次（无记录/读失败为 0）。
   */
  replayMoADiscussions: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.REPLAY_MOA_DISCUSSIONS, sessionId) as Promise<{
      ok: boolean
      count: number
    }>,
  /** 保存附件到磁盘 */
  saveAttachment: (input: { sessionId: string; filename: string; mediaType: string; data: string }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_ATTACHMENT, input),
  /** 读取附件为 base64 */
  readAttachment: (localPath: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_ATTACHMENT, localPath),
  /** 解析会话附件相对路径为绝对路径 */
  resolveAttachmentPath: (localPath: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.RESOLVE_ATTACHMENT_PATH, localPath) as Promise<string>,
  /** 打开系统文件选择器 */
  openFileDialog: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_FILE_DIALOG),
  /** 用系统默认程序打开文件（相对路径按会话工作区解析） */
  openPath: (input: { sessionId: string; path: string }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.OPEN_PATH, input),
  /** 解析路径是否存在（文件 chip 存在性检查），返回存在的绝对路径或 null */
  resolveFile: (input: { sessionId: string; path: string; bases?: string[] }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.RESOLVE_FILE, input),
  /**
   * 读取文件在 git HEAD 的版本（Files Changed 审阅兜底：本轮补丁无法还原旧稿时取旧稿做 diff）。
   * 无 git / 未跟踪 / 超时 → null。payload: { sessionId, path, bases? }。
   */
  readGitHeadFile: (input: { sessionId: string; path: string; bases?: string[] }) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_GIT_HEAD_FILE, input) as Promise<string | null>,
  /** 销毁会话（杀进程 + 删元数据/JSONL） */
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_SESSION, sessionId),
  /** 列出所有会话（元数据） */
  listSessions: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SESSIONS),
  /** 列出 MoA 会诊预置（首次调用会就地 seed 默认预置） */
  listMoaPresets: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_MOA_PRESETS) as Promise<MoAPreset[]>,
  /**
   * 保存整份 MoA 预置（覆盖式写；设置页会诊班底 CRUD）。
   * 整单校验失败主进程 reject（中文错），调用方 catch 回显；成功返回重读后的列表。
   */
  saveMoaPresets: (presets: MoAPreset[]) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_MOA_PRESETS, presets) as Promise<MoAPreset[]>,
  /** 列出 CLI 工人配置（首次调用主进程就地 seed 默认：总开关 enabled=false，零行为变化） */
  listCliWorkersConfig: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_CLI_WORKERS) as Promise<CliWorkersConfig>,
  /**
   * 保存整份 CLI 工人配置（覆盖式写；设置页 CRUD）。
   * 整单校验失败主进程 reject（中文错），调用方 catch 回显；成功返回重读后的配置。
   */
  saveCliWorkersConfig: (cfg: CliWorkersConfig) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SAVE_CLI_WORKERS, cfg) as Promise<CliWorkersConfig>,
  /** 本机探测各 CLI 工人是否在 PATH / 配置路径可用（每台机器环境不同） */
  probeCliWorkers: (cfg?: CliWorkersConfig) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.PROBE_CLI_WORKERS, cfg) as Promise<CliWorkersProbeResult>,
  /** 读 No-Progress Guard 模式（effective / stored / envOverride） */
  getNoProgressGuardMode: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_NO_PROGRESS_GUARD_MODE) as Promise<{
      effective: 'off' | 'shadow' | 'enforce'
      stored: 'off' | 'shadow' | 'enforce' | null
      envOverride: 'off' | 'shadow' | 'enforce' | null
    }>,
  /** 写 No-Progress Guard 落盘偏好 */
  setNoProgressGuardMode: (mode: 'off' | 'shadow' | 'enforce') =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SET_NO_PROGRESS_GUARD_MODE, mode) as Promise<{
      effective: 'off' | 'shadow' | 'enforce'
      stored: 'off' | 'shadow' | 'enforce' | null
      envOverride: 'off' | 'shadow' | 'enforce' | null
    }>,
  /** 读圆桌（agent-discuss）偏好（缺失/损坏 → 默认） */
  getAgentDiscussPrefs: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_DISCUSS_PREFS) as Promise<AgentDiscussPrefs>,
  /**
   * 写圆桌偏好（整单校验，非法 reject 中文错；成功返回落盘后的偏好）。
   * 本期部分字段运行时闸未接（见 FINDINGS）。
   */
  setAgentDiscussPrefs: (prefs: AgentDiscussPrefs) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SET_DISCUSS_PREFS, prefs) as Promise<AgentDiscussPrefs>,
  /** 读班组（agent-crew）偏好（缺失/损坏 → 默认） */
  getAgentCrewPrefs: () =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_CREW_PREFS) as Promise<AgentCrewPrefs>,
  /**
   * 写班组偏好（整单校验，非法 reject 中文错；成功返回落盘后的偏好）。
   * 本期部分字段运行时闸未接（见 FINDINGS）。
   */
  setAgentCrewPrefs: (prefs: AgentCrewPrefs) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.SET_CREW_PREFS, prefs) as Promise<AgentCrewPrefs>,
  /** 读会话历史消息（JSONL） */
  getMessages: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SDK_MESSAGES, sessionId),
  /** 监听流式事件 */
  listSessionProcesses: (sessionId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SESSION_PROCESSES, sessionId),
  killSessionProcess: (sessionId: string, id: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.KILL_SESSION_PROCESS, { sessionId, id }),
  onSessionProcessesChanged: (cb: (payload: { sessionId: string; processes: unknown[] }) => void) => {
    const handler = (_e: unknown, payload: { sessionId: string; processes: unknown[] }): void =>
      cb(payload)
    ipcRenderer.on(AGENT_IPC_CHANNELS.SESSION_PROCESSES_CHANGED, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.SESSION_PROCESSES_CHANGED, handler)
  },
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
  /**
   * 读取文件供预览（Files Changed / chip）。
   * 兼容旧签名 string；`{ path, sessionId?, bases? }` 用于诊断日志。
   * 存在且未超 10MB 即可读——不因「工作区外」拒绝（Agent 能改则应能看）。
   */
  readWorkspaceFile: (
    input:
      | string
      | { path: string; sessionId?: string; bases?: string[] },
  ) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE, input) as Promise<{
      content?: string
      dataUrl?: string
      mime?: string
    } | null>,
  /** 持久化工作区侧栏顺序 */
  reorderWorkspaces: (orderedIds: string[]) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.REORDER_WORKSPACES, orderedIds) as Promise<AgentWorkspace[]>,
  /** 更新会话元数据（重命名 title / 模型 modelId / 置顶 pinned / 归档 archived / 子代理委派积极性 subagentEagerness / 思考强度 reasoningEffort / 会话偏好 CLI 工人 cliWorkerId；status 由主进程内部写，渲染层不直接写） */
  updateSessionMeta: (id: string, patch: {
    title?: string
    /** 模型 id：moa:* 粘性选择清回渠道默认真实模型时持久化（与 App.tsx 全局声明同口径） */
    modelId?: string
    pinned?: boolean
    archived?: boolean
    subagentEagerness?: 'never' | 'conservative' | 'balanced' | 'aggressive'
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
    /** 会话偏好 CLI 工人 id（未设置/空 = 跟随全局启用池优先级；主进程 normalize 空串→undefined） */
    cliWorkerId?: string
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
  // 权限审批（主进程推请求 / 已决回听 / renderer 回响应）
  onPermissionRequest: (cb: (req: unknown) => void) => {
    const handler = (_e: unknown, req: unknown): void => cb(req)
    ipcRenderer.on(AGENT_IPC_CHANNELS.PERMISSION_REQUEST, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.PERMISSION_REQUEST, handler)
  },
  /** 主进程超时 deny 或用户 respond 后推送，渲染层按 reqId 出队 */
  onPermissionResolved: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(AGENT_IPC_CHANNELS.PERMISSION_RESOLVED, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.PERMISSION_RESOLVED, handler)
  },
  respondToPermission: (reqId: string, behavior: 'allow' | 'deny', remember?: boolean) =>
    ipcRenderer.send(AGENT_IPC_CHANNELS.PERMISSION_RESPOND, { reqId, behavior, remember }),
  // AskUserQuestion 交互式问答（主进程推请求 / 已决回听 / renderer 回灌答案）
  onAskUserRequest: (cb: (request: AskUserRequest) => void) => {
    const handler = (_e: unknown, request: AskUserRequest): void => cb(request)
    ipcRenderer.on(AGENT_IPC_CHANNELS.ASK_USER_REQUEST, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.ASK_USER_REQUEST, handler)
  },
  /** 用户 respond / 会话清理后推送，渲染层按 requestId 出队 + 清 drafts */
  onAskUserResolved: (cb: (e: { requestId: string }) => void) => {
    const handler = (_e: unknown, payload: { requestId: string }): void => cb(payload)
    ipcRenderer.on(AGENT_IPC_CHANNELS.ASK_USER_RESOLVED, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.ASK_USER_RESOLVED, handler)
  },
  askUserRespond: (response: AskUserResponse) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.ASK_USER_RESPOND, response),
  /** 用户关闭选项卡：软 deny「用户未选择」，当前轮继续 */
  askUserDismiss: (requestId: string) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.ASK_USER_DISMISS, requestId),
  // ExitPlanMode 计划审批（主进程推请求 / 已决回听 / renderer 回用户选择）
  onExitPlanModeRequest: (cb: (request: ExitPlanModeRequest) => void) => {
    const handler = (_e: unknown, request: ExitPlanModeRequest): void => cb(request)
    ipcRenderer.on(AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_REQUEST, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_REQUEST, handler)
  },
  /** 用户 respond / 会话清理后推送，渲染层按 requestId 出队 */
  onExitPlanModeResolved: (cb: (e: { requestId: string }) => void) => {
    const handler = (_e: unknown, payload: { requestId: string }): void => cb(payload)
    ipcRenderer.on(AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESOLVED, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESOLVED, handler)
  },
  respondExitPlanMode: (response: ExitPlanModeResponse) =>
    ipcRenderer.invoke(AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESPOND, response),
  // 计划模式切换（主进程 → 渲染进程：EnterPlanMode / ExitPlanMode 审批后更新输入框 pill）
  onPlanModeChanged: (
    cb: (payload: { sessionId: string; mode: string; source: string }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { sessionId: string; mode: string; source: string },
    ): void => cb(payload)
    ipcRenderer.on(AGENT_IPC_CHANNELS.PLAN_MODE_CHANGED, handler)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.PLAN_MODE_CHANGED, handler)
  },
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

  // ===== 系统提示词（Chat 模式；设置页 CRUD）=====
  getSystemPromptConfig: () =>
    ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.GET_CONFIG) as Promise<SystemPromptConfig>,
  createSystemPrompt: (input: SystemPromptCreateInput) =>
    ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.CREATE, input) as Promise<SystemPrompt>,
  updateSystemPrompt: (id: string, input: SystemPromptUpdateInput) =>
    ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.UPDATE, id, input) as Promise<SystemPrompt>,
  deleteSystemPrompt: (id: string) =>
    ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.DELETE, id) as Promise<void>,
  updateAppendSetting: (enabled: boolean) =>
    ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.UPDATE_APPEND_SETTING, enabled) as Promise<void>,
  setDefaultPrompt: (id: string | null) =>
    ipcRenderer.invoke(SYSTEM_PROMPT_IPC_CHANNELS.SET_DEFAULT, id) as Promise<void>,

  // ===== 渠道余额 =====
  getChannelBalance: (channelId: string) =>
    ipcRenderer.invoke(BALANCE_IPC_CHANNELS.GET, channelId) as Promise<ChannelBalanceResult>,

  // ===== 协作室（Stage 1：房间壳 + 静态成员 + 静态消息，不运行 Agent） =====
  /** 列出全部协作室房间（默认不含已归档） */
  listCollaborationRooms: (input?: { includeArchived?: boolean }) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.LIST, input) as Promise<CollaborationRoom[]>,
  /** 创建协作室房间（含可选静态成员） */
  createCollaborationRoom: (input: CreateCollaborationRoomInput) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.CREATE, input) as Promise<CollaborationRoom>,
  /** 获取单个房间（不存在返回 null） */
  getCollaborationRoom: (roomId: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.GET, { roomId }) as Promise<CollaborationRoom | null>,
  /** 更新房间（rename / pause / archive / complete / resume / 调整上限） */
  updateCollaborationRoom: (input: UpdateCollaborationRoomInput) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.UPDATE, input) as Promise<CollaborationRoom>,
  /** 列出某房间全部消息（按时间升序，只显示已存消息） */
  listCollaborationMessages: (roomId: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.LIST_MESSAGES, { roomId }) as Promise<CollaborationMessage[]>,
  /** 追加静态用户消息（只落盘 + 刷新，不触发 Agent） */
  appendCollaborationUserMessage: (input: AppendCollaborationUserMessageInput) =>
    ipcRenderer.invoke(
      COLLABORATION_ROOM_IPC_CHANNELS.APPEND_USER_MESSAGE,
      input,
    ) as Promise<CollaborationMessage>,
  /** 列出某房间全部成员（静态身份 + 运行状态） */
  listCollaborationMembers: (roomId: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.LIST_MEMBERS, { roomId }) as Promise<CollaborationMember[]>,
  /** 向已有房间追加一个成员（displayName + 自动绑默认渠道，Stage 3） */
  addCollaborationMember: (input: AddCollaborationMemberInput) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.ADD_MEMBER, input) as Promise<CollaborationMember>,
  /** 更新成员（显示名 / 渠道 / 模型） */
  updateCollaborationMember: (input: UpdateCollaborationMemberInput) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.UPDATE_MEMBER, input) as Promise<CollaborationMember>,
  /** 用户保存的成员配置模板 */
  listCollaborationMemberPresets: () =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.LIST_MEMBER_PRESETS) as Promise<CollaborationMemberPreset[]>,
  saveCollaborationMemberPreset: (input: SaveCollaborationMemberPresetInput) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.SAVE_MEMBER_PRESET, input) as Promise<CollaborationMemberPreset>,
  deleteCollaborationMemberPreset: (id: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.DELETE_MEMBER_PRESET, { id }) as Promise<{ ok: boolean }>,
  /** 列出某房间全部 run（按入队顺序，Stage 2） */
  listCollaborationRuns: (roomId: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.LIST_RUNS, { roomId }) as Promise<CollaborationRun[]>,
  /** 取消某 run（abort 后端 + 置 cancelled；终态 run 返回其当前状态） */
  cancelCollaborationRun: (input: { roomId: string; runId: string }) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.CANCEL_RUN, input) as Promise<CollaborationRun | null>,
  /** 列出某房间全部 A2A 信箱信封（S4 审计视图） */
  listCollaborationMailbox: (roomId: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.LIST_MAILBOX, { roomId }) as Promise<CollaborationMailboxEnvelope[]>,
  /**
   * 继续一次已达 A2A 深度上限的交接（S4.5）。
   * 主进程校验信封属于该房间且仍可继续一次后委托 service；成功返回新信封 id，
   * 失败（已继续过 / 不属于该房间 / 硬深度上限）返回 { ok: false, reason }，不抛错。
   */
  continueCollaborationDepthStop: (input: ContinueCollaborationDepthStopInput) =>
    ipcRenderer.invoke(
      COLLABORATION_ROOM_IPC_CHANNELS.CONTINUE_DEPTH_STOP,
      input,
    ) as Promise<ContinueCollaborationDepthStopResult>,
  /** 列出某房间全部轻量 room task（S5 面板：任务真值，挂板后只读历史） */
  listCollaborationRoomTasks: (roomId: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.LIST_ROOM_TASKS, { roomId }) as Promise<
      CollaborationRoomTask[]
    >,
  /** 创建轻量 room task（S5 面板；挂板时主进程 fail-closed 抛错） */
  createCollaborationRoomTask: (input: CreateCollaborationRoomTaskInput) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.CREATE_ROOM_TASK, input) as Promise<
      CollaborationRoomTask
    >,
  /** 更新轻量 room task（改派 / 状态 / 标题等；复用 service 守卫 + 严格状态机 + CAS） */
  updateCollaborationRoomTask: (input: UpdateCollaborationRoomTaskInput) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.UPDATE_ROOM_TASK, input) as Promise<
      CollaborationRoomTask
    >,
  /** 列出某房间全部产物（S5 面板：artifact 审计真值） */
  listCollaborationArtifacts: (roomId: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.LIST_ARTIFACTS, { roomId }) as Promise<
      CollaborationArtifact[]
    >,
  /**
   * 预览产物文本（S5 面板）：只传 { roomId, artifactId }，主进程按记录反查后复用安全路径解析读盘。
   * 成功返回 content / sha256 / byteSize / truncated；失败返回 { ok: false, reason }（不抛）。
   */
  readCollaborationArtifact: (input: { roomId: string; artifactId: string }) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.READ_ARTIFACT, input) as Promise<
      ReadCollaborationArtifactResult
    >,
  /** 列出房间挂载看板的投影任务（S5 看板桥：只读，不反向覆盖看板真值） */
  listCollaborationBoardTasks: (roomId: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.LIST_BOARD_TASKS, {
      roomId,
    }) as Promise<BoardProjectedTask[]>,
  /** 获取房间挂载看板的投影统计摘要（S5 看板桥；未挂载/看板不存在返回 null） */
  getCollaborationBoardSummary: (roomId: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.GET_BOARD_SUMMARY, {
      roomId,
    }) as Promise<BoardProjectedSummary | null>,
  /** 列出成员请求用户决定的审批项。 */
  listCollaborationUserApprovals: (roomId: string) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.LIST_USER_APPROVALS, { roomId }) as Promise<
      CollaborationUserApprovalRequest[]
    >,
  /** 批准或拒绝成员的用户审批请求。 */
  resolveCollaborationUserApproval: (input: {
    roomId: string
    requestId: string
    decision: 'approved' | 'denied'
    response?: string
  }) =>
    ipcRenderer.invoke(COLLABORATION_ROOM_IPC_CHANNELS.RESOLVE_USER_APPROVAL, input) as Promise<
      ResolveCollaborationUserApprovalResult
    >,
  /** 房间数据变更事件（main → renderer，run/member/message 变更时广播） */
  onCollaborationRoomChanged: (cb: (payload: { roomId: string; kind: string; at: number }) => void) => {
    const handler = (_e: unknown, payload: { roomId: string; kind: string; at: number }): void => cb(payload)
    ipcRenderer.on(COLLABORATION_ROOM_IPC_CHANNELS.CHANGED, handler)
    return () => ipcRenderer.removeListener(COLLABORATION_ROOM_IPC_CHANNELS.CHANGED, handler)
  },
  /** 成员 turn 流式正文增量（不走 CHANGED，避免每 token 全量刷新） */
  onCollaborationTextDelta: (cb: (payload: CollaborationTextDeltaPayload) => void) => {
    const handler = (_e: unknown, payload: CollaborationTextDeltaPayload): void => cb(payload)
    ipcRenderer.on(COLLABORATION_ROOM_IPC_CHANNELS.TEXT_DELTA, handler)
    return () => ipcRenderer.removeListener(COLLABORATION_ROOM_IPC_CHANNELS.TEXT_DELTA, handler)
  },

  // ===== 受管浏览器（Dockview pane） =====
  browserEnsure: (sessionId: string) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.ENSURE, { sessionId }) as Promise<BrowserWorkspaceState>,
  browserSetBounds: (input: BrowserSetBoundsRequest) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.SET_BOUNDS, input) as Promise<BrowserWorkspaceState>,
  browserHide: (sessionId: string) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.HIDE, sessionId) as Promise<{ ok: boolean }>,
  browserNavigate: (input: BrowserNavigateRequest) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.NAVIGATE, input) as Promise<BrowserWorkspaceState>,
  browserBack: (sessionId: string) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.BACK, sessionId) as Promise<BrowserWorkspaceState>,
  browserForward: (sessionId: string) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.FORWARD, sessionId) as Promise<BrowserWorkspaceState>,
  browserReload: (sessionId: string) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.RELOAD, sessionId) as Promise<BrowserWorkspaceState>,
  browserNewTab: (input: BrowserTabRequest) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.NEW_TAB, input) as Promise<BrowserWorkspaceState>,
  browserCloseTab: (input: BrowserTabRequest) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.CLOSE_TAB, input) as Promise<BrowserWorkspaceState>,
  browserSelectTab: (input: BrowserTabRequest) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.SELECT_TAB, input) as Promise<BrowserWorkspaceState>,
  browserObserve: (sessionId: string) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.OBSERVE, sessionId) as Promise<BrowserObserveResult>,
  browserClick: (input: BrowserElementActionRequest) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.CLICK, input) as Promise<{ ok: boolean; message?: string }>,
  browserType: (input: BrowserElementActionRequest) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.TYPE, input) as Promise<{ ok: boolean; message?: string }>,
  browserScroll: (input: BrowserScrollRequest) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.SCROLL, input) as Promise<{ ok: boolean; message?: string }>,
  browserScreenshot: (sessionId: string) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.SCREENSHOT, sessionId) as Promise<BrowserScreenshotResult>,
  browserStop: (sessionId: string) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.STOP, sessionId) as Promise<{ ok: boolean; message?: string }>,
  browserTakeover: (input: BrowserTakeoverRequest) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.TAKEOVER, input) as Promise<BrowserWorkspaceState>,
  browserResume: (sessionId: string) =>
    ipcRenderer.invoke(BROWSER_IPC_CHANNELS.RESUME, sessionId) as Promise<BrowserWorkspaceState>,
  onBrowserStateChanged: (cb: (state: BrowserWorkspaceState) => void) => {
    const handler = (_e: unknown, state: BrowserWorkspaceState): void => cb(state)
    ipcRenderer.on(BROWSER_IPC_CHANNELS.STATE_CHANGED, handler)
    return () => ipcRenderer.removeListener(BROWSER_IPC_CHANNELS.STATE_CHANGED, handler)
  },
  onBrowserOpenRequest: (cb: (request: BrowserOpenRequest) => void) => {
    const handler = (_e: unknown, request: BrowserOpenRequest): void => cb(request)
    ipcRenderer.on(BROWSER_IPC_CHANNELS.OPEN_REQUEST, handler)
    return () => ipcRenderer.removeListener(BROWSER_IPC_CHANNELS.OPEN_REQUEST, handler)
  },
  // ===== 自动更新 =====
  updater: {
    checkForUpdates: () => ipcRenderer.invoke('updater:check') as Promise<void>,
    getStatus: () => ipcRenderer.invoke('updater:status') as Promise<unknown>,
    installWhenIdle: () => ipcRenderer.invoke('updater:install-when-idle') as Promise<boolean>,
    cancelIdleInstall: () => ipcRenderer.invoke('updater:cancel-idle-install') as Promise<void>,
    onStatusChanged: (cb: (status: unknown) => void) => {
      const handler = (_e: unknown, status: unknown): void => cb(status)
      ipcRenderer.on('updater:on-status-changed', handler)
      return () => ipcRenderer.removeListener('updater:on-status-changed', handler)
    },
  },
} as const

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
