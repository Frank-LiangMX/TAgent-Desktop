/**
 * TAgent-Desktop App 根组件
 *
 * 浮岛壳（Rail：会话 / 插件 / 设置 + Sidebar + main）。
 * 插件为一级入口（对齐 General）；渠道 / 主题在设置页；工作区在侧栏。
 * 无 workspace 时显示引导界面。
 */
import { useCallback, useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type {
  AgentWorkspace,
  AskUserRequest,
  AskUserResponse,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
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
  FetchModelsInput,
  FetchModelsForChannelInput,
  FetchModelsResult,
  GraphPayload,
  InstallStoreBundleResult,
  McpServerEntry,
  MoAPreset,
  CliWorkersConfig,
  CliWorkersProbeResult,
  AgentDiscussPrefs,
  AgentCrewPrefs,
  NudgeCandidate,
  PluginStoreCatalog,
  StageEntry,
  UserProfile,
  SystemPrompt,
  SystemPromptConfig,
  SystemPromptCreateInput,
  SystemPromptUpdateInput,
  WorkspaceMcpConfig,
  WorkspacePluginBundleRecord,
} from '@tagent/shared'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  RichSourceContext,
  Toaster,
  TooltipProvider,
} from '@tagent/ui'
import { toast } from 'sonner'
import { MemoryMonitorPanel, showNudgeToasts } from './components/memory'
import { SessionSidebar } from './components/workspace/SessionSidebar'
import { PluginStoreSettings } from './components/settings/PluginStoreSettings'
import { RolesPage } from './components/roles/RolesPage'
import { CollaborationRoomSidebar } from './components/collaboration/CollaborationRoomSidebar'
import { CollaborationRoomsPage } from './components/collaboration/CollaborationRoomsPage'
import { CollaborationCreateRoomDialog } from './components/collaboration/CollaborationCreateRoomDialog'
import {
  SettingsDialog,
  normalizeSettingsTab,
  type SettingsTab,
} from './components/settings/SettingsPage'
import { AppShell } from './components/shell/AppShell'
import { Rail, type RailItem } from './components/shell/Rail'
import { TabBar } from './components/shell/TabBar'
import { SessionRouter } from './components/shell/SessionRouter'
import { WorkspaceDock } from './components/dock/WorkspaceDock'
import { Chat, type SessionMeta } from './components/chat/Chat'
import { WelcomeStart } from './components/shell/WelcomeStart'
import { NewConversationLanding } from './components/chat/NewConversationLanding'
import { ProjectOnboarding } from './components/chat/ProjectOnboarding'
import {
  MAX_SESSION_TABS,
  tabsAtom,
  activeTabIdAtom,
  activeTabAtom,
  openTabWithLimit,
  trimTabsToLimit,
  type TabItem,
} from './atoms/tabs'
import { crewOpenRequestAtom, dockApiAtom } from './atoms/dock-api'
import { splitDockModeAtom } from './atoms/feature-flags'
import { pendingSuggestionAtom } from './atoms/pending-suggestion'
import {
  makeStatusTickerItem,
  pushStatusTickerAtom,
} from './atoms/status-ticker'
import {
  getNotificationPrefsSnapshot,
  notificationPrefsAtom,
  syncNotificationPrefsToMain,
} from './atoms/notification-prefs'
import { loadUserProfileAtom } from './atoms/user-profile'
import {
  loadChannelsAtom,
} from './atoms/channel-atoms'
import {
  workspacesAtom,
  loadWorkspacesAtom,
  lastActiveWorkspaceIdAtom,
} from './atoms/workspace-atoms'
import { useGlobalSessionRunSync } from './hooks/useGlobalSessionRunSync'
import { useGlobalPermissionSync } from './hooks/useGlobalPermissionSync'
import { useAskUserSync } from './hooks/useAskUserSync'
import { useExitPlanSync } from './hooks/useExitPlanSync'
import { useInitUpdaterListener } from './atoms/updater'
import { acknowledgeSessionStatusAtom } from './atoms/session-status-atoms'
import { sessionRunMapAtom } from './atoms/session-run-atoms'

declare global {
  interface Window {
    electronAPI: {
      sendMessage: (input: {
        sessionId: string
        prompt: string
        channelId?: string
        model?: string
        workspaceId?: string
        /** MoA 会诊本条（one-shot）：本轮走 runMoATurn，不改 meta.modelId。SPEC §3 */
        moaOneShotPresetId?: string
      }) => Promise<{ ok: boolean; error?: string }>
      stopAgent: (sessionId: string) => Promise<{ ok: boolean }>
      recallUnsentTurn: (sessionId: string) => Promise<{
        ok: boolean
        text?: string
        reason?: 'no_user' | 'already_started' | 'empty'
      }>
      listSessionProcesses: (sessionId: string) => Promise<
        Array<{
          id: string
          sessionId: string
          pid?: number
          command: string
          source: 'bash' | 'cli-worker'
          startedAt: number
        }>
      >
      killSessionProcess: (
        sessionId: string,
        id: string,
      ) => Promise<{ ok: boolean; error?: string }>
      onSessionProcessesChanged: (
        cb: (payload: {
          sessionId: string
          processes: Array<{
            id: string
            sessionId: string
            pid?: number
            command: string
            source: 'bash' | 'cli-worker'
            startedAt: number
          }>
        }) => void,
      ) => () => void
      steerAgent: (
        sessionId: string,
        message: string,
      ) => Promise<{ ok: boolean; mode?: 'live' | 'pending_next_turn'; error?: string }>
      /** 圆桌讨论：用户插话（push 到活跃讨论 pending，每轮开始前 drain 注入本轮参与者 prompt） */
      discussionInterject: (input: {
        sessionId: string
        discussionId: string
        text: string
      }) => Promise<{ ok: boolean; error?: string }>
      /** 圆桌讨论：用户喊停（abort 活跃讨论 controller → cancelled 卡 + turn_end 清 running） */
      discussionStop: (input: { sessionId: string; discussionId: string }) => Promise<{ ok: boolean; error?: string }>
      /**
       * 圆桌讨论重放（T8）：会话打开/切回、历史消息加载后调用。主进程读该会话
       * moa-discussion.jsonl，把每场已落盘讨论按原 moa_discussion 事件推回，渲染层按
       * discussionId upsert 成入口卡 + 讨论室回看。返回重放场次（无记录/读失败为 0）。
       */
      replayMoADiscussions: (sessionId: string) => Promise<{ ok: boolean; count: number }>
      deleteSession: (sessionId: string) => Promise<{ ok: boolean }>
      listSessions: () => Promise<unknown[]>
      getMessages: (sessionId: string) => Promise<unknown[]>
      /** 列出 MoA 会诊预置（首次调用主进程就地 seed 默认预置） */
      listMoaPresets: () => Promise<MoAPreset[]>
      /** 保存整份 MoA 预置（设置页 CRUD；校验失败 reject 中文错；成功返回重读列表） */
      saveMoaPresets: (presets: MoAPreset[]) => Promise<MoAPreset[]>
      /** 列出 CLI 工人配置（首次调用主进程就地 seed 默认：总开关 enabled=false，零行为变化） */
      listCliWorkersConfig: () => Promise<CliWorkersConfig>
      /** 保存整份 CLI 工人配置（设置页 CRUD；校验失败 reject 中文错；成功返回重读配置） */
      saveCliWorkersConfig: (cfg: CliWorkersConfig) => Promise<CliWorkersConfig>
      /** 本机探测 CLI 工人是否可用 */
      probeCliWorkers: (cfg?: CliWorkersConfig) => Promise<CliWorkersProbeResult>
      getNoProgressGuardMode: () => Promise<{
        effective: 'off' | 'shadow' | 'enforce'
        stored: 'off' | 'shadow' | 'enforce' | null
        envOverride: 'off' | 'shadow' | 'enforce' | null
      }>
      setNoProgressGuardMode: (mode: 'off' | 'shadow' | 'enforce') => Promise<{
        effective: 'off' | 'shadow' | 'enforce'
        stored: 'off' | 'shadow' | 'enforce' | null
        envOverride: 'off' | 'shadow' | 'enforce' | null
      }>
      /** 读圆桌（agent-discuss）偏好（缺失/损坏 → 默认） */
      getAgentDiscussPrefs: () => Promise<AgentDiscussPrefs>
      /** 写圆桌偏好（整单校验，非法 reject 中文错；成功返回落盘后的偏好） */
      setAgentDiscussPrefs: (prefs: AgentDiscussPrefs) => Promise<AgentDiscussPrefs>
      /** 读班组（agent-crew）偏好（缺失/损坏 → 默认） */
      getAgentCrewPrefs: () => Promise<AgentCrewPrefs>
      /** 写班组偏好（整单校验，非法 reject 中文错；成功返回落盘后的偏好） */
      setAgentCrewPrefs: (prefs: AgentCrewPrefs) => Promise<AgentCrewPrefs>
      onStreamEvent: (cb: (payload: unknown) => void) => () => void
      openPath: (input: { sessionId: string; path: string }) => Promise<{ ok: boolean; error?: string }>
      resolveFile: (input: {
        sessionId: string
        path: string
        bases?: string[]
      }) => Promise<string | null>
      /**
       * 读取文件在 git HEAD 的版本（Files Changed 审阅兜底：本轮补丁无法还原旧稿时取旧稿做 diff）。
       * 无 git / 未跟踪 / 超时 → null。
       */
      readGitHeadFile: (input: { sessionId: string; path: string; bases?: string[] }) => Promise<string | null>
      /** 读取会话附件为 base64（localPath 相对 ~/.tagent/attachments/） */
      readAttachment: (localPath: string) => Promise<string>
      /** 解析会话附件相对路径为绝对路径 */
      resolveAttachmentPath: (localPath: string) => Promise<string>
      // 渠道
      listChannels: () => Promise<Channel[]>
      createChannel: (input: ChannelCreateInput) => Promise<Channel>
      updateChannel: (id: string, patch: ChannelUpdateInput) => Promise<Channel | undefined>
      deleteChannel: (id: string) => Promise<{ ok: boolean; error?: string }>
      testChannel: (id: string) => Promise<ChannelTestResult>
      fetchModels: (input: FetchModelsInput) => Promise<FetchModelsResult>
      fetchModelsForChannel: (input: FetchModelsForChannelInput) => Promise<FetchModelsResult>
      // 工作区
      listWorkspaces: () => Promise<AgentWorkspace[]>
      createProjectWorkspace: () => Promise<AgentWorkspace | null>
      deleteWorkspace: (id: string) => Promise<void>
      reorderWorkspaces: (orderedIds: string[]) => Promise<AgentWorkspace[]>
      readWorkspaceFile: (
        input: string | { path: string; sessionId?: string; bases?: string[] },
      ) => Promise<{
        content?: string
        dataUrl?: string
        mime?: string
      } | null>
      // 会话元数据（重命名/置顶/归档/模型 modelId/子代理委派积极性/思考强度/会话偏好 CLI 工人；status 由主进程内部写，渲染层不直接写）
      updateSessionMeta: (id: string, patch: {
        title?: string
        /** 模型 id：moa:* 粘性选择清回渠道默认真实模型时持久化（主进程 updateSessionMeta 已支持合并写） */
        modelId?: string
        pinned?: boolean
        archived?: boolean
        subagentEagerness?: 'never' | 'conservative' | 'balanced' | 'aggressive'
        reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
        /** 会话偏好 CLI 工人 id（未设置/空 = 跟随全局启用池优先级；主进程 normalize 空串→undefined） */
        cliWorkerId?: string
        /** 各轮完成耗时（key = 该轮最后一条主线 assistant 消息 createdAt） */
        turnDurations?: Record<string, number>
      }) => Promise<unknown>
      togglePin: (id: string) => Promise<unknown>
      toggleArchive: (id: string) => Promise<unknown>
      /** 清除 Chat @ 对话跟随（activeSpeaker 回默认总助） */
      clearMentionFollow: (id: string) => Promise<unknown>
      /** 查会话生命状态（runtimes 内存 + meta 组合；running 不落盘） */
      getSessionStatus: (id: string) => Promise<{ status: 'idle' | 'running' | 'error'; archived: boolean }>
      // 窗口控制（自定义 WindowControls 用）
      windowIsMaximized: () => Promise<boolean>
      windowMinimize: () => void
      windowMaximize: () => void
      windowClose: () => void
      onWindowResize: (cb: () => void) => () => void
      // MCP 配置
      getMcpConfig: (slug: string) => Promise<WorkspaceMcpConfig>
      saveMcpConfig: (slug: string, config: WorkspaceMcpConfig) => Promise<{ ok: boolean }>
      /** 新增/更新单个 MCP server（启用开关即时 upsert 也走这里） */
      upsertMcpServer: (slug: string, name: string, entry: McpServerEntry) => Promise<WorkspaceMcpConfig>
      /** 删除单个 MCP server */
      deleteMcpServer: (slug: string, name: string) => Promise<{ ok: boolean; error?: string }>
      /** 真实测试 MCP server 连接（成功/失败顺带持久化 lastTestResult） */
      testMcpServer: (slug: string, name: string, entry: McpServerEntry) => Promise<{ success: boolean; message: string }>
      // 插件商店（整合包市场）
      /** 获取插件商店目录（整合包 + Skill + MCP） */
      getPluginStoreCatalog: () => Promise<PluginStoreCatalog>
      /** 获取工作区已安装整合包记录（plugins-installed.json） */
      getInstalledPluginBundles: (slug: string) => Promise<WorkspacePluginBundleRecord[]>
      /** 安装整合包（写 MCP + 可装 Skill + 写 manifest） */
      installStoreBundle: (slug: string, bundleId: string) => Promise<InstallStoreBundleResult>
      /** 卸载整合包（移除 manifest 记录 + 仍匹配商店形态的 MCP + 记录的 Skill 目录） */
      uninstallStoreBundle: (slug: string, bundleId: string) => Promise<{ ok: boolean; removedMcps: string[]; removedSkills: string[]; errors: string[] }>
      // 权限审批
      onPermissionRequest: (cb: (req: unknown) => void) => () => void
      /** 主进程超时 deny / 用户 respond 后推送，渲染层按 reqId 出队 */
      onPermissionResolved: (cb: (payload: unknown) => void) => () => void
      respondToPermission: (reqId: string, behavior: 'allow' | 'deny', remember?: boolean) => void
      // AskUserQuestion 交互式问答
      onAskUserRequest: (cb: (request: AskUserRequest) => void) => () => void
      onAskUserResolved: (cb: (e: { requestId: string }) => void) => () => void
      askUserRespond: (response: AskUserResponse) => Promise<void>
      /** 关闭 AskUser 选项卡（软 deny「用户未选择」，不停止当前轮） */
      askUserDismiss: (requestId: string) => Promise<void>
      // ExitPlanMode 计划审批（主进程推请求 / 已决回听 / renderer 回用户选择）
      onExitPlanModeRequest: (cb: (request: ExitPlanModeRequest) => void) => () => void
      onExitPlanModeResolved: (cb: (e: { requestId: string }) => void) => () => void
      respondExitPlanMode: (response: ExitPlanModeResponse) => Promise<void>
      // 计划模式切换（主进程 → 渲染进程：EnterPlanMode / ExitPlanMode 审批后更新输入框 pill）
      onPlanModeChanged: (
        cb: (payload: { sessionId: string; mode: string; source: string }) => void,
      ) => () => void
      // 热切换会话权限模式
      setSessionPermissionMode: (sessionId: string, mode: string) => Promise<{ ok: boolean; error?: string }>
      /** 热切换 Chat|Work（仅用户源） */
      setSessionExecutionMode: (
        sessionId: string,
        mode: 'chat' | 'work',
        source?: 'user' | 'user-confirm-suggestion',
      ) => Promise<{
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
      }>
      onExecutionModeSuggestion: (cb: (suggestion: unknown) => void) => () => void
      dismissExecutionModeSuggestion: (sessionId: string) => Promise<{ ok: boolean }>
      getNotificationPrefs: () => Promise<{
        titlebarTicker: boolean
        systemDesktop: boolean
        panelToast: boolean
      }>
      setNotificationPrefs: (prefs: {
        titlebarTicker?: boolean
        systemDesktop?: boolean
        panelToast?: boolean
      }) => Promise<{
        titlebarTicker: boolean
        systemDesktop: boolean
        panelToast: boolean
      }>
      // 看板 / 班组
      kanbanListBoards: (input?: { status?: string }) => Promise<unknown>
      kanbanGetBoard: (boardId: string) => Promise<unknown>
      kanbanGetTask?: (taskId: string) => Promise<unknown>
      kanbanListTasks: (boardId: string, status?: string) => Promise<unknown>
      kanbanCreateBoard: (input: Record<string, unknown>) => Promise<unknown>
      kanbanCreateTask: (input: Record<string, unknown>) => Promise<unknown>
      kanbanPauseBoard: (boardId: string, sessionId?: string) => Promise<unknown>
      kanbanResumeBoard: (boardId: string, sessionId?: string) => Promise<unknown>
      kanbanUnblockTask: (taskId: string, reason?: string) => Promise<unknown>
      kanbanRetryTask: (taskId: string) => Promise<unknown>
      kanbanCommentTask?: (
        taskId: string,
        comment: string,
        author?: string,
      ) => Promise<{ ok: boolean; error?: string; result?: string }>
      onKanbanChanged: (cb: (payload: unknown) => void) => () => void
      onKanbanBoardCompleted: (cb: (payload: unknown) => void) => () => void
      // 角色库
      listAgentRoles: () => Promise<import('@tagent/shared').AgentRoleProfile[]>
      getAgentRole: (roleId: string) => Promise<import('@tagent/shared').AgentRoleProfile | undefined>
      saveAgentRole: (input: import('@tagent/shared').SaveAgentRoleInput) => Promise<import('@tagent/shared').AgentRoleProfile[]>
      deleteAgentRole: (roleId: string) => Promise<{
        roles: import('@tagent/shared').AgentRoleProfile[]
        deleted: boolean
        reason?: string
      }>
      resetDefaultAgentRoles: () => Promise<import('@tagent/shared').AgentRoleProfile[]>
      listRoleStoreCatalog: () => Promise<import('@tagent/shared').RoleStoreCatalogResult>
      installStoreRole: (roleId: string) => Promise<import('@tagent/shared').InstallStoreRoleResult>
      importAgentRoleFromMd: () => Promise<import('@tagent/shared').ImportRoleFromMdResult>
      findSimilarAgentRoles: (displayName: string) => Promise<import('@tagent/shared').AgentRoleProfile[]>
      deleteAgentRolesBatch: (roleIds: string[]) => Promise<import('@tagent/shared').DeleteRolesResult>
      /** 手动压缩会话上下文（Pi） */
      compactSession: (sessionId: string) => Promise<{
        ok: boolean
        compacted: boolean
        reason?: string
        tokensBefore?: number
      }>
      /** 系统是否深色（nativeTheme） */
      getSystemDark: () => Promise<boolean>
      /** 系统明暗变化 */
      onSystemThemeUpdated: (cb: (dark: boolean) => void) => () => void
      /** 上报应用内解析后的深浅（驱动窗口/Dock 图标） */
      setResolvedDark: (dark: boolean) => void
      // 记忆系统（类型对齐 General preload，供记忆页组件直接消费）
      initMemoryLayers: () => Promise<unknown>
      getMemoryStats: (mode: 'general' | 'ta') => Promise<{
        l0: { exists: boolean; lines: number; lastUpdated: number | null }
        l1: { exists: boolean; lines: number; lastUpdated: number | null }
        l2: { exists: boolean; lines: number; lastUpdated: number | null }
        l3: { rawCount: number; rulesCount: number; lastUpdated: number | null }
        l4: { sessions: number; oldestDate: number | null; newestDate: number | null }
        l5: { exists: boolean; lines: number; lastUpdated: number | null }
      }>
      searchMemorySessions: (
        mode: 'general' | 'ta',
        query: string,
        limit?: number,
      ) => Promise<Array<{ id: number; title: string; summary: string; created_at: number }>>
      listRecentMemorySessions: (
        mode: 'general' | 'ta',
        limit?: number,
      ) => Promise<Array<{ id: number; title: string; summary: string; created_at: number }>>
      getMemoryMdContent: (
        mode: 'general' | 'ta',
        layer: 'L0' | 'L1' | 'L2' | 'L5',
      ) => Promise<string | null>
      getMemoryCorrections: (
        mode: 'general' | 'ta',
        limit?: number,
      ) => Promise<Array<{ timestamp: number; correction: string; context: string }>>
      getPendingNudges: (sessionId: string) => Promise<NudgeCandidate[]>
      respondNudge: (
        sessionId: string,
        nudgeId: string,
        action: 'accept' | 'reject' | 'defer',
        mode: 'general' | 'ta',
      ) => Promise<{ ok: boolean }>
      onNudgeEvent: (cb: (payload: unknown) => void) => () => void
      getStageQueue: (mode: 'general' | 'ta') => Promise<StageEntry[]>
      acceptStageAll: (mode: 'general' | 'ta') => Promise<StageEntry[]>
      rejectStageAll: (mode: 'general' | 'ta') => Promise<StageEntry[]>
      acceptStageOne: (mode: 'general' | 'ta', id: string) => Promise<{ ok: boolean }>
      rejectStageOne: (mode: 'general' | 'ta', id: string) => Promise<{ ok: boolean }>
      getGraphData: (mode: 'general' | 'ta', workspaceSlug?: string) => Promise<GraphPayload>
      // 用户档案
      getUserProfile: () => Promise<UserProfile>
      updateUserProfile: (updates: Partial<UserProfile>) => Promise<UserProfile>
      getSystemPromptConfig: () => Promise<SystemPromptConfig>
      createSystemPrompt: (input: SystemPromptCreateInput) => Promise<SystemPrompt>
      updateSystemPrompt: (id: string, input: SystemPromptUpdateInput) => Promise<SystemPrompt>
      deleteSystemPrompt: (id: string) => Promise<void>
      updateAppendSetting: (enabled: boolean) => Promise<void>
      setDefaultPrompt: (id: string | null) => Promise<void>
      // 渠道余额
      getChannelBalance: (channelId: string) => Promise<ChannelBalanceResult>
      // 协作室（Stage 1：房间壳 + 静态成员 + 静态消息，不运行 Agent）
      listCollaborationRooms: (input?: { includeArchived?: boolean }) => Promise<CollaborationRoom[]>
      createCollaborationRoom: (input: CreateCollaborationRoomInput) => Promise<CollaborationRoom>
      getCollaborationRoom: (roomId: string) => Promise<CollaborationRoom | null>
      updateCollaborationRoom: (input: UpdateCollaborationRoomInput) => Promise<CollaborationRoom>
      listCollaborationMessages: (roomId: string) => Promise<CollaborationMessage[]>
      appendCollaborationUserMessage: (
        input: AppendCollaborationUserMessageInput,
      ) => Promise<CollaborationMessage>
      listCollaborationMembers: (roomId: string) => Promise<CollaborationMember[]>
      // 协作室（Stage 2：run 状态机 + 取消 + CHANGED 广播；Stage 3：多成员并行 + 添加成员）
      listCollaborationRuns: (roomId: string) => Promise<CollaborationRun[]>
      cancelCollaborationRun: (input: { roomId: string; runId: string }) => Promise<CollaborationRun | null>
      addCollaborationMember: (input: AddCollaborationMemberInput) => Promise<CollaborationMember>
      updateCollaborationMember: (input: UpdateCollaborationMemberInput) => Promise<CollaborationMember>
      listCollaborationMemberPresets: () => Promise<CollaborationMemberPreset[]>
      saveCollaborationMemberPreset: (input: SaveCollaborationMemberPresetInput) => Promise<CollaborationMemberPreset>
      deleteCollaborationMemberPreset: (id: string) => Promise<{ ok: boolean }>
      listCollaborationMailbox: (roomId: string) => Promise<CollaborationMailboxEnvelope[]>
      continueCollaborationDepthStop: (
        input: ContinueCollaborationDepthStopInput,
      ) => Promise<ContinueCollaborationDepthStopResult>
      // 协作室（S5 室级任务/产物面板：复用已落盘 room task / artifact 真值）
      listCollaborationRoomTasks: (roomId: string) => Promise<CollaborationRoomTask[]>
      createCollaborationRoomTask: (input: CreateCollaborationRoomTaskInput) => Promise<CollaborationRoomTask>
      updateCollaborationRoomTask: (
        input: UpdateCollaborationRoomTaskInput,
      ) => Promise<CollaborationRoomTask>
      listCollaborationArtifacts: (roomId: string) => Promise<CollaborationArtifact[]>
      readCollaborationArtifact: (input: {
        roomId: string
        artifactId: string
      }) => Promise<ReadCollaborationArtifactResult>
      listCollaborationUserApprovals: (roomId: string) => Promise<CollaborationUserApprovalRequest[]>
      resolveCollaborationUserApproval: (input: {
        roomId: string
        requestId: string
        decision: 'approved' | 'denied'
        response?: string
      }) => Promise<{ ok: true; request: CollaborationUserApprovalRequest; runId?: string } | { ok: false; reason: string }>
      onCollaborationRoomChanged: (cb: (payload: { roomId: string; kind: string; at: number }) => void) => () => void
      onCollaborationTextDelta: (cb: (payload: CollaborationTextDeltaPayload) => void) => () => void
      // 自动更新
      updater?: {
        checkForUpdates: () => Promise<void>
        getStatus: () => Promise<unknown>
        installWhenIdle: () => Promise<boolean>
        cancelIdleInstall: () => Promise<void>
        onStatusChanged: (cb: (status: unknown) => void) => () => void
      }
    }
  }
}

export function App(): JSX.Element {
  const reducedMotion = useReducedMotion()
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general')
  /** 主区导航：会话 | 插件 | 记忆 | 角色库（设置走对话框，打开时 rail 高亮 settings） */
  const [activeRail, setActiveRail] = useState<Exclude<RailItem, 'settings'>>('chat')
  /**
   * 会话侧栏展开态（对齐 General navigationSidebarOpen + deriveRailSelection）：
   * - 仅 chat 支持侧栏；plugins / memory / roles 强制收起
   * - 再点当前 chat rail → 切换展开/收起
   * - 从其它页切回 chat → 自动展开
   */
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // 协作室：当前选中房间 + 列表刷新版本（rename/pause/archive/send 后 bump 重新拉取）
  const [activeCollaborationRoomId, setActiveCollaborationRoomId] = useState<string | null>(null)
  const [collabRefreshKey, setCollabRefreshKey] = useState(0)
  const [collaborationCreateDialogOpen, setCollaborationCreateDialogOpen] = useState(false)
  const bumpCollab = useCallback(() => setCollabRefreshKey((k) => k + 1), [])
  const loadChannels = useSetAtom(loadChannelsAtom)
  const loadWorkspaces = useSetAtom(loadWorkspacesAtom)
  const loadUserProfile = useSetAtom(loadUserProfileAtom)
  const workspaces = useAtomValue(workspacesAtom)

  /** 会话 / 协作室页需要侧栏（插件/记忆/角色库为 rail-only 主区页） */
  const railSupportsSidebar = (item: Exclude<RailItem, 'settings'>): boolean =>
    item === 'chat' || item === 'collaboration'

  const selectRail = (next: Exclude<RailItem, 'settings'>): void => {
    setShowSettings(false)
    if (next === activeRail) {
      // 再点当前项：chat/collaboration 可折叠侧栏；rail-only 页无操作
      if (railSupportsSidebar(next)) {
        setSidebarOpen((v) => !v)
      }
      return
    }
    setActiveRail(next)
    setSidebarOpen(railSupportsSidebar(next))
  }

  /** 选中协作室房间 → 记住并展开侧栏 */
  const selectCollaborationRoom = useCallback((room: CollaborationRoom): void => {
    setActiveCollaborationRoomId(room.id)
    setSidebarOpen(true)
  }, [])

  const clearArchivedCollaborationRoom = useCallback((roomId: string): void => {
    setActiveCollaborationRoomId((current) => (current === roomId ? null : current))
  }, [])

  /** 新建协作室（默认只有协调者；其余成员创建后用「添加成员」弹窗选内核/渠道 + 模型加入） */
  const newCollaborationRoom = useCallback((): void => {
    setCollaborationCreateDialogOpen(true)
  }, [])

  const createCollaborationRoom = useCallback(async (input: CreateCollaborationRoomInput): Promise<void> => {
    try {
      const created = await window.electronAPI.createCollaborationRoom(input)
      setActiveCollaborationRoomId(created.id)
      setSidebarOpen(true)
      setCollaborationCreateDialogOpen(false)
      bumpCollab()
    } catch (err) {
      toast.error('创建协作室失败', { description: err instanceof Error ? err.message : String(err) })
    }
  }, [bumpCollab])

  // 协作室 CHANGED 广播：run/member/message 变更时 bump，侧栏 + 主区重新拉取（实时刷新）
  useEffect(() => {
    const off = window.electronAPI.onCollaborationRoomChanged(() => {
      bumpCollab()
    })
    return off
  }, [bumpCollab])

  const pushTicker = useSetAtom(pushStatusTickerAtom)
  const notificationPrefs = useAtomValue(notificationPrefsAtom)
  const acknowledgeSessionStatus = useSetAtom(acknowledgeSessionStatusAtom)
  const requestCrewOpen = useSetAtom(crewOpenRequestAtom)

  // 启动时把通知偏好同步到主进程
  useEffect(() => {
    syncNotificationPrefsToMain()
  }, [])

  // 全局运行计时 atom 同步（离开会话仍消费 result/delta，切回不丢计时）
  useGlobalSessionRunSync()
  // 全局权限队列同步（REQUEST 入队 / RESOLVED 出队，切会话不丢横幅）
  useGlobalPermissionSync()
  // 全局 AskUserQuestion 队列同步（REQUEST 入队 / RESOLVED 出队，切会话不丢选项卡）
  useAskUserSync()
  // 全局 ExitPlanMode 审批队列同步（REQUEST 入队 / RESOLVED 出队，切会话不丢审批横幅）
  useExitPlanSync()
  // 自动更新状态监听（主进程推送 → atom → 顶栏 UpdateBanner）
  useInitUpdaterListener()

  // Phase 2：全局 Nudge → 按设置：顶栏 ticker / 面板 toast
  useEffect(() => {
    return window.electronAPI.onNudgeEvent((payload: unknown) => {
      const p = payload as {
        type?: string
        sessionId?: string
        mode?: 'general' | 'ta'
        nudges?: NudgeCandidate[]
      }
      if (p?.type === 'nudge_candidates' && p.sessionId && Array.isArray(p.nudges) && p.nudges.length > 0) {
        const prefs = getNotificationPrefsSnapshot()
        const first = p.nudges[0]
        if (prefs.titlebarTicker && first?.userMessage) {
          pushTicker(
            makeStatusTickerItem(
              `记忆提示：${first.userMessage.slice(0, 80)}${first.userMessage.length > 80 ? '…' : ''}`,
              'info',
              8000,
            ),
          )
        }
        if (prefs.panelToast) {
          showNudgeToasts(p.nudges, p.sessionId, p.mode === 'ta' ? 'ta' : 'general')
        }
      }
    })
  }, [pushTicker])

  // 多会话 tab
  const tabs = useAtomValue(tabsAtom)
  const sessionRunMap = useAtomValue(sessionRunMapAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const lastActiveWorkspaceId = useAtomValue(lastActiveWorkspaceIdAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setLastActiveWorkspaceId = useSetAtom(lastActiveWorkspaceIdAtom)
  const setPendingSuggestion = useSetAtom(pendingSuggestionAtom)
  const dockApi = useAtomValue(dockApiAtom)
  // 分屏工作台：on → 主区用 Dockview，拖会话 tab 到边缘自动分屏（默认开）
  const splitDockMode = useAtomValue(splitDockModeAtom)
  /** 草稿会话（无 tab 的新会话页）：点「新建会话」设置，发送首条消息时由 Chat 物化为 tab */
  const [draftSession, setDraftSession] = useState<SessionMeta | null>(null)
  const [tabCapacityDialogOpen, setTabCapacityDialogOpen] = useState(false)

  // 旧版本的 Dockview 恢复布局可直接回填 tabsAtom，绕过新开会话时的四标签限制。
  // 启动和布局恢复后统一收口：仅逐出最早的已停止 tab，绝不为了清理历史状态停止任务。
  useEffect(() => {
    const result = trimTabsToLimit(
      tabs,
      (sessionId) => sessionRunMap[sessionId]?.running === true,
    )
    if (result.evictedTabs.length === 0) return

    const retainedIds = new Set(result.tabs.map((tab) => tab.id))
    setTabs(result.tabs)
    setActiveTabId((current) =>
      current && retainedIds.has(current) ? current : (result.tabs.at(-1)?.id ?? null),
    )
    // 同步关掉被逐出的 Dockview pane，防止其被布局恢复逻辑再次收编进 tabsAtom。
    result.evictedTabs.forEach((tab) => dockApi?.getPanel(tab.sessionId)?.api.close())
  }, [dockApi, sessionRunMap, setActiveTabId, setTabs, tabs])

  // 离开会话页（插件/记忆/角色库/设置）→ 当前会话绿点清灰
  useEffect(() => {
    if (activeRail === 'chat' && !showSettings) return
    if (activeTabId) acknowledgeSessionStatus(activeTabId)
  }, [activeRail, showSettings, activeTabId, acknowledgeSessionStatus])

  const openSettings = (tab: SettingsTab): void => {
    setSettingsInitialTab(normalizeSettingsTab(tab))
    setShowSettings(true)
  }

  const railActive: RailItem = showSettings ? 'settings' : activeRail

  // 启动时同时加载渠道列表 + 工作区列表 + 用户档案
  useEffect(() => {
    void Promise.all([
      loadChannels(),
      loadWorkspaces(),
      loadUserProfile(),
      // 校验持久化的 tabs：主进程可能已删某些会话，去掉孤儿 tab + 修 activeTabId
      (async () => {
        try {
          const sessions = (await window.electronAPI.listSessions()) as Array<{
            id: string
          }>
          const liveIds = new Set(sessions.map((s) => s.id))
          setTabs((prev) => prev.filter((t) => liveIds.has(t.sessionId)))
          setActiveTabId((prev) => (prev && liveIds.has(prev) ? prev : null))
        } catch {
          /* 校验失败不影响启动 */
        }
      })(),
    ])
  }, [loadChannels, loadWorkspaces, loadUserProfile, setTabs, setActiveTabId])

  // tab 切换（包括 TabBar / Dockview 内切换）就是工作区被激活，跨重启记住它。
  useEffect(() => {
    if (activeTab?.workspaceId) {
      setLastActiveWorkspaceId(activeTab.workspaceId)
    }
  }, [activeTab?.workspaceId, setLastActiveWorkspaceId])

  const showTabCapacityDialog = useCallback(() => {
    setTabCapacityDialogOpen(true)
  }, [])

  /** 草稿在发送前预检容量，避免四个运行任务时创建一个无法打开的新会话。 */
  const canMaterializeTab = useCallback((): boolean => {
    if (tabs.length < MAX_SESSION_TABS) return true
    if (tabs.some((tab) => !sessionRunMap[tab.sessionId]?.running)) return true
    showTabCapacityDialog()
    return false
  }, [sessionRunMap, showTabCapacityDialog, tabs])

  /** 开会话进 tab：已开激活；满四个时替换最早的非运行标签。 */
  const openSession = (
    sessionId: string,
    title: string,
    workspaceId?: string,
    channelId?: string,
    modelId?: string,
  ): void => {
    if (workspaceId) setLastActiveWorkspaceId(workspaceId)
    // 函数式更新：避免闭包 tabs 过期覆盖并发 openTab
    let blocked = false
    let evictedTab: TabItem | undefined
    setTabs((prev) => {
      const result = openTabWithLimit(
        prev,
        sessionId,
        title,
        (id) => sessionRunMap[id]?.running === true,
        workspaceId,
        channelId,
        modelId,
      )
      if (result.blocked) {
        blocked = true
        return prev
      }
      evictedTab = result.evictedTab
      setActiveTabId(result.activeTabId)
      return result.tabs
    })
    if (blocked) {
      showTabCapacityDialog()
      return
    }
    if (evictedTab) {
      const evictedSessionId = evictedTab.sessionId
      queueMicrotask(() => dockApi?.getPanel(evictedSessionId)?.api.close())
    }
  }

  /** 顶栏班组通知 → 定位所属会话，并打开该会话的班组面板。 */
  const openCrewFromNotification = (input: {
    taskId?: string
    boardId?: string
    parentSessionId?: string
  }): void => {
    void (async () => {
      try {
        let boardId = input.boardId
        if (!boardId && input.taskId) {
          const task = (await window.electronAPI.kanbanGetTask?.(input.taskId)) as
            | { boardId?: string }
            | null
            | undefined
          boardId = task?.boardId
        }
        const board = boardId
          ? ((await window.electronAPI.kanbanGetBoard(boardId)) as
              | { parentSessionId?: string; title?: string }
              | null)
          : null
        const sessionId = input.parentSessionId ?? board?.parentSessionId
        if (!sessionId) {
          pushTicker(makeStatusTickerItem('该班组未绑定会话，无法打开会话面板', 'warn', 4500))
          return
        }

        const sessions = (await window.electronAPI.listSessions()) as Array<SessionMeta>
        const session = sessions.find((item) => item.id === sessionId)
        if (!session) {
          pushTicker(makeStatusTickerItem('关联会话已不存在', 'warn', 4500))
          return
        }

        setShowSettings(false)
        setActiveRail('chat')
        setSidebarOpen(true)
        setDraftSession(null)
        openSession(session.id, session.title, session.workspaceId, session.channelId, session.modelId)
        requestCrewOpen({
          sessionId: session.id,
          sessionTitle: board?.title ?? session.title,
          requestId: Date.now(),
        })
      } catch {
        pushTicker(makeStatusTickerItem('打开班组失败，请稍后重试', 'error', 4500))
      }
    })()
  }

  // 班组状态 → 顶栏 ticker（若开启）；点击通知会直接打开对应班组。
  useEffect(() => {
    const action = (input: { taskId?: string; boardId?: string; parentSessionId?: string }) => ({
      onClick: () => openCrewFromNotification(input),
      actionLabel: '点击打开对应班组面板',
      coalesceKey: input.taskId ? `kanban-task:${input.taskId}` : `kanban-board:${input.boardId ?? ''}`,
    })
    const off1 = window.electronAPI.onKanbanChanged?.((payload: unknown) => {
      if (!getNotificationPrefsSnapshot().titlebarTicker) return
      const p = payload as { taskId?: string; status?: string }
      if (!p?.status || !p.taskId) return
      if (p.status === 'running') {
        pushTicker(makeStatusTickerItem('班组：任务开始执行', 'info', 4000, action(p)))
      } else if (p.status === 'done') {
        pushTicker(makeStatusTickerItem('班组：任务已完成', 'success', 5000, action(p)))
      } else if (p.status === 'failed') {
        pushTicker(makeStatusTickerItem('班组：任务失败', 'error', 7000, action(p)))
      } else if (p.status === 'blocked') {
        pushTicker(makeStatusTickerItem('班组：任务阻塞，需处理', 'warn', 7000, action(p)))
      }
    })
    const off2 = window.electronAPI.onKanbanBoardCompleted?.((payload: unknown) => {
      if (!getNotificationPrefsSnapshot().titlebarTicker) return
      const p = payload as {
        boardId?: string
        parentSessionId?: string
        summary?: { done?: number; total?: number; failed?: number }
      }
      const s = p?.summary
      const text = s
        ? `班组全部结束：${s.done ?? 0}/${s.total ?? 0} 完成${s.failed ? `，${s.failed} 失败` : ''}`
        : '班组全部结束'
      pushTicker(
        makeStatusTickerItem(
          text,
          (s?.failed ?? 0) > 0 ? 'warn' : 'success',
          8000,
          action(p),
        ),
      )
    })
    return () => {
      off1?.()
      off2?.()
    }
  }, [pushTicker, requestCrewOpen])

  /** 打开项目目录并注册为工作区；从新建会话入口调用时直接绑定新会话 */
  const handleOpenProject = async (startSession = false): Promise<AgentWorkspace | null> => {
    const workspace = await window.electronAPI.createProjectWorkspace()
    if (!workspace) return null

    await loadWorkspaces()
    setLastActiveWorkspaceId(workspace.id)
    if (startSession) {
      // 注册工作区后开新会话：进入草稿（无 tab），发送首条消息才物化为 tab
      setDraftSession({ id: 'session-' + Date.now(), title: '新会话', workspaceId: workspace.id })
    }
    return workspace
  }

  const newSession = (workspaceId?: string): void => {
    // 没有工作区 → 先打开项目目录（注册工作区后直接开新会话）
    if (workspaces.length === 0) {
      void handleOpenProject(true)
      return
    }
    // 已在草稿页（未发送）→ 复用，不另开（避免丢弃已输入内容）
    if (draftSession && !activeTab) return
    // 默认绑定最近真正激活过的工作区。工作区列表本身不保证按活跃时间排序，
    // 因此不能把 workspaces[0] 当作“最近”。当前 tab 是持久化值尚未回填时的兜底。
    const preferredWorkspaceId =
      workspaceId ?? lastActiveWorkspaceId ?? activeTab?.workspaceId
    const workspace =
      workspaces.find((item) => item.id === preferredWorkspaceId) ?? workspaces[0]
    // workspaces.length===0 已 early return，此处 workspace 必存在；兜底给 TS
    if (!workspace) return
    setLastActiveWorkspaceId(workspace.id)
    // 进入草稿（无 tab）：发送首条消息时主进程建持久 meta + 绑定渠道 + 绑定 workspace
    // 草稿以 overlay 覆盖当前页（tab 激活态保持），返回键关掉蒙版回原页
    setDraftSession({ id: 'session-' + Date.now(), title: '新会话', workspaceId: workspace.id })
  }

  /** 删除工作区后同步关闭其全部标签，并为当前标签选择最近邻。 */
  const handleWorkspaceDeleted = (workspaceId: string): void => {
    const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId)
    const activeBelongsToWorkspace =
      activeIndex >= 0 && tabs[activeIndex]?.workspaceId === workspaceId
    const remaining = tabs.filter((tab) => tab.workspaceId !== workspaceId)
    const rightNeighbor = tabs
      .slice(activeIndex + 1)
      .find((tab) => tab.workspaceId !== workspaceId)
    const leftNeighbor = tabs
      .slice(0, activeIndex)
      .reverse()
      .find((tab) => tab.workspaceId !== workspaceId)

    if (lastActiveWorkspaceId === workspaceId) {
      const nextWorkspaceId =
        rightNeighbor?.workspaceId ??
        leftNeighbor?.workspaceId ??
        workspaces.find((workspace) => workspace.id !== workspaceId)?.id ??
        null
      setLastActiveWorkspaceId(nextWorkspaceId)
    }

    const removed = tabs.filter((tab) => tab.workspaceId === workspaceId)
    setTabs(remaining)
    for (const tab of removed) {
      dockApi?.getPanel(tab.sessionId)?.api.close()
    }
    if (activeBelongsToWorkspace) {
      setActiveTabId(rightNeighbor?.id ?? leftNeighbor?.id ?? null)
    }
  }

  /**
   * 标签栏显隐：多会话始终显示；单会话在已物化为 tab（channelId 非空）后显示。
   * 草稿态（未发送、无 tab）不显示——对齐「新建会话阶段无标签」。
   */
  const showTabBar = tabs.length > 1 || Boolean(activeTab?.channelId)

  // 富内容预览数据源：主进程鉴权读工作区文件（仅限已注册工作区目录内）
  const richSourceResolver = useCallback(async (src: string) => {
    return window.electronAPI.readWorkspaceFile(src)
  }, [])

  return (
    <TooltipProvider delayDuration={280} skipDelayDuration={120}>
      <RichSourceContext.Provider value={{ resolve: richSourceResolver }}>
        <AppShell
        topbar={null}
        sidebarOpen={railSupportsSidebar(activeRail) && sidebarOpen}
        activeRailItem={activeRail === 'chat' ? 'chat' : activeRail}
        onOpenLiveSession={(sessionId, title) => {
          const tab = tabs.find((item) => item.sessionId === sessionId)
          setShowSettings(false)
          setActiveRail('chat')
          setSidebarOpen(true)
          setDraftSession(null)
          openSession(sessionId, title, tab?.workspaceId, tab?.channelId, tab?.modelId)
        }}
        rail={
          <Rail
            active={railActive}
            onChat={() => {
              // 会话 rail 只负责：切到会话页 / 展开收起侧栏，不创建会话
              selectRail('chat')
            }}
            onCollaboration={() => selectRail('collaboration')}
            onPlugins={() => selectRail('plugins')}
            onMemory={() => selectRail('memory')}
            onRoles={() => selectRail('roles')}
            onSettings={() => openSettings(settingsInitialTab)}
          />
        }
        sidebar={
          activeRail === 'collaboration' ? (
            <CollaborationRoomSidebar
              activeRoomId={activeCollaborationRoomId}
              onSelectRoom={selectCollaborationRoom}
              onNewRoom={() => void newCollaborationRoom()}
              refreshKey={collabRefreshKey}
              onRoomsChanged={bumpCollab}
              onRoomArchived={clearArchivedCollaborationRoom}
            />
          ) : (
            <SessionSidebar
              activeSessionId={activeTabId}
              onSelect={(s) => {
                setShowSettings(false)
                setActiveRail('chat')
                setSidebarOpen(true)
                // 选中已有会话 → 清掉草稿（避免关掉所有 tab 后复活旧草稿）
                setDraftSession(null)
                openSession(s.id, s.title, s.workspaceId, s.channelId, s.modelId)
              }}
              onNew={(workspaceId) => {
                setShowSettings(false)
                setActiveRail('chat')
                setSidebarOpen(true)
                newSession(workspaceId)
              }}
              onOpenProject={() => void handleOpenProject()}
              onWorkspaceDeleted={handleWorkspaceDeleted}
            />
          )
        }
      >
        {/* main：插件页 | 会话页/欢迎页（底层）+ 新会话草稿 overlay（覆盖层）。
            欢迎页 / 新会话页的入场动画由 NewConversationLanding 内各元素自行承担
            （标题逐词模糊渐现、输入框上滑淡入、提示词错落淡入），非整页位移；
            故此处不做整页过渡，直接切换，新页元素各自重新入场。 */}
        {activeRail === 'collaboration' ? (
          <CollaborationRoomsPage
            roomId={activeCollaborationRoomId}
            refreshKey={collabRefreshKey}
            onRoomsChanged={bumpCollab}
            onRoomArchived={clearArchivedCollaborationRoom}
            onNewRoom={() => void newCollaborationRoom()}
            onOpenSettings={(tab) => openSettings(tab)}
          />
        ) : activeRail === 'plugins' ? (
          <div
            key="plugins"
            className="plugins-main-view scrollbar-thin animate-in fade-in duration-300"
          >
            <PluginStoreSettings />
          </div>
        ) : activeRail === 'memory' ? (
          <div
            key="memory"
            className="app-shell-content-stage relative h-full min-h-0 animate-in fade-in duration-300"
          >
            <MemoryMonitorPanel />
          </div>
        ) : activeRail === 'roles' ? (
          <div
            key="roles"
            className="plugins-main-view scrollbar-thin animate-in fade-in duration-300"
          >
            <RolesPage />
          </div>
        ) : workspaces.length === 0 ? (
          <ProjectOnboarding onOpenProject={() => void handleOpenProject()} />
        ) : (draftSession && draftSession.id !== activeTab?.sessionId) || !activeTab ? (
          // 欢迎页和草稿会话共享同一舞台，保证它们在切换时可以交叉过渡。
          <div className="relative h-full min-h-0">
            <AnimatePresence initial={false} mode="sync">
              {draftSession && draftSession.id !== activeTab?.sessionId ? (
                <motion.div
                  key={draftSession.id}
                  className="absolute inset-0"
                  initial={reducedMotion ? false : { opacity: 0, y: 12, scale: 0.99 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.99 }}
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }
                  }
                >
                  <Chat
                    session={draftSession}
                    onDraftWorkspaceChange={(id) => {
                      setLastActiveWorkspaceId(id)
                      setDraftSession((prev) => (prev ? { ...prev, workspaceId: id } : prev))
                    }}
                    onBack={() => setDraftSession(null)}
                    onMaterialized={() => setDraftSession(null)}
                    canMaterializeTab={canMaterializeTab}
                    onTabEvicted={(tab) => {
                      queueMicrotask(() => dockApi?.getPanel(tab.sessionId)?.api.close())
                    }}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="new-session-welcome"
                  className="absolute inset-0"
                  initial={false}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.985 }}
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { duration: 0.18, ease: [0.4, 0, 1, 1] }
                  }
                >
                  <NewConversationLanding
                    composer={
                      <WelcomeStart
                        onNewSession={() => newSession()}
                        onOpenProject={() => void handleOpenProject()}
                      />
                    }
                    onPickSuggestion={(text) => {
                      setPendingSuggestion(text)
                      newSession()
                    }}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : activeTab ? (
          splitDockMode ? (
            <WorkspaceDock />
          ) : (
            <div className="flex h-full flex-col">
              {showTabBar && <TabBar />}
              <div className="min-h-0 flex-1">
                <SessionRouter />
              </div>
            </div>
          )
        ) : null}
      </AppShell>

      <SettingsDialog
        open={showSettings}
        initialTab={settingsInitialTab}
        onOpenChange={setShowSettings}
        onTabChange={setSettingsInitialTab}
      />
      <CollaborationCreateRoomDialog
        open={collaborationCreateDialogOpen}
        onOpenChange={setCollaborationCreateDialogOpen}
        defaultWorkspaceId={lastActiveWorkspaceId ?? workspaces[0]?.id}
        onSubmit={createCollaborationRoom}
        onOpenProject={async () => {
          const workspace = await handleOpenProject(false)
          return workspace?.id
        }}
      />
      <Dialog open={tabCapacityDialogOpen} onOpenChange={setTabCapacityDialogOpen}>
        <DialogContent className="w-[min(380px,calc(100vw-32px))] gap-5 p-5 sm:max-w-none" hideClose>
          <DialogHeader className="space-y-2 text-left">
            <DialogTitle className="text-[15px]">正在运行的会话已占满标签栏</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-5">
              最多可打开 {MAX_SESSION_TABS} 个会话。请等待任一会话完成或停止后，再打开新的会话。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" onClick={() => setTabCapacityDialogOpen(false)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 面板 Toast：受通用设置「面板悬浮」开关；进度类默认走顶栏 */}
      {notificationPrefs.panelToast ? (
        <Toaster position="top-center" richColors closeButton visibleToasts={2} />
      ) : null}
      </RichSourceContext.Provider>
    </TooltipProvider>
  )
}
