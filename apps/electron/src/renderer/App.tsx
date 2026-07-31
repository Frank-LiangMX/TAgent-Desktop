/**
 * TAgent-Desktop App 根组件
 *
 * 浮岛壳（Rail：会话 / 插件 / 设置 + Sidebar + main）。
 * 插件为一级入口（对齐 General）；渠道 / 主题在设置页；工作区在侧栏。
 * 无 workspace 时显示引导界面。
 */
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type {
  AgentWorkspace,
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelTestResult,
  FetchModelsInput,
  FetchModelsForChannelInput,
  FetchModelsResult,
  GraphPayload,
  InstallStoreBundleResult,
  McpServerEntry,
  NudgeCandidate,
  PluginStoreCatalog,
  StageEntry,
  WorkspaceMcpConfig,
  WorkspacePluginBundleRecord,
} from '@tagent/shared'
import { Button, ConversationEmptyState, Toaster, TooltipProvider } from '@tagent/ui'
import { MemoryMonitorPanel, showNudgeToasts } from './components/memory'
import { SessionSidebar } from './components/workspace/SessionSidebar'
import { PluginStoreSettings } from './components/settings/PluginStoreSettings'
import { SettingsDialog, type SettingsTab } from './components/settings/SettingsPage'
import { AppShell } from './components/shell/AppShell'
import { Rail, type RailItem } from './components/shell/Rail'
import { TabBar } from './components/shell/TabBar'
import { SessionRouter } from './components/shell/SessionRouter'
import { Chat, type SessionMeta } from './components/chat/Chat'
import { WelcomeStart } from './components/shell/WelcomeStart'
import { NewConversationLanding } from './components/chat/NewConversationLanding'
import { tabsAtom, activeTabIdAtom, activeTabAtom, openTab } from './atoms/tabs'
import { pendingSuggestionAtom } from './atoms/pending-suggestion'
import {
  loadChannelsAtom,
} from './atoms/channel-atoms'
import {
  workspacesAtom,
  loadWorkspacesAtom,
} from './atoms/workspace-atoms'

declare global {
  interface Window {
    electronAPI: {
      sendMessage: (input: {
        sessionId: string
        prompt: string
        channelId?: string
        model?: string
        workspaceId?: string
      }) => Promise<{ ok: boolean; error?: string }>
      stopAgent: (sessionId: string) => Promise<{ ok: boolean }>
      deleteSession: (sessionId: string) => Promise<{ ok: boolean }>
      listSessions: () => Promise<unknown[]>
      getMessages: (sessionId: string) => Promise<unknown[]>
      onStreamEvent: (cb: (payload: unknown) => void) => () => void
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
      // 会话元数据（重命名/置顶/归档/子代理委派积极性/思考强度；status 由主进程内部写，渲染层不直接写）
      updateSessionMeta: (id: string, patch: {
        title?: string
        pinned?: boolean
        archived?: boolean
        subagentEagerness?: 'never' | 'conservative' | 'balanced' | 'aggressive'
        reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
      }) => Promise<unknown>
      togglePin: (id: string) => Promise<unknown>
      toggleArchive: (id: string) => Promise<unknown>
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
      respondToPermission: (reqId: string, behavior: 'allow' | 'deny', remember?: boolean) => void
      // 热切换会话权限模式
      setSessionPermissionMode: (sessionId: string, mode: string) => Promise<{ ok: boolean; error?: string }>
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
    }
  }
}

export function App(): JSX.Element {
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general')
  /** 主区导航：会话 | 插件 | 记忆（设置走对话框，打开时 rail 高亮 settings） */
  const [activeRail, setActiveRail] = useState<Exclude<RailItem, 'settings'>>('chat')
  /**
   * 会话侧栏展开态（对齐 General navigationSidebarOpen + deriveRailSelection）：
   * - 仅 chat 支持侧栏；plugins / memory 强制收起
   * - 再点当前 chat rail → 切换展开/收起
   * - 从其它页切回 chat → 自动展开
   */
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const loadChannels = useSetAtom(loadChannelsAtom)
  const loadWorkspaces = useSetAtom(loadWorkspacesAtom)
  const workspaces = useAtomValue(workspacesAtom)

  /** 仅会话页需要 SessionSidebar（插件/记忆为 rail-only） */
  const railSupportsSidebar = (item: Exclude<RailItem, 'settings'>): boolean => item === 'chat'

  const selectRail = (next: Exclude<RailItem, 'settings'>): void => {
    setShowSettings(false)
    if (next === activeRail) {
      // 再点当前项：chat 可折叠侧栏；rail-only 页无操作
      if (railSupportsSidebar(next)) {
        setSidebarOpen((v) => !v)
      }
      return
    }
    setActiveRail(next)
    setSidebarOpen(railSupportsSidebar(next))
  }

  // Phase 2：全局 Nudge 事件 → sonner toast
  useEffect(() => {
    return window.electronAPI.onNudgeEvent((payload: unknown) => {
      const p = payload as {
        type?: string
        sessionId?: string
        mode?: 'general' | 'ta'
        nudges?: NudgeCandidate[]
      }
      if (p?.type === 'nudge_candidates' && p.sessionId && Array.isArray(p.nudges) && p.nudges.length > 0) {
        showNudgeToasts(p.nudges, p.sessionId, p.mode === 'ta' ? 'ta' : 'general')
      }
    })
  }, [])
  // 多会话 tab
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setPendingSuggestion = useSetAtom(pendingSuggestionAtom)
  /** 草稿会话（无 tab 的新会话页）：点「新建会话」设置，发送首条消息时由 Chat 物化为 tab */
  const [draftSession, setDraftSession] = useState<SessionMeta | null>(null)

  const openSettings = (tab: SettingsTab): void => {
    setSettingsInitialTab(tab)
    setShowSettings(true)
  }

  const railActive: RailItem = showSettings ? 'settings' : activeRail

  // 启动时同时加载渠道列表 + 工作区列表
  useEffect(() => {
    void Promise.all([loadChannels(), loadWorkspaces()])
  }, [loadChannels, loadWorkspaces])

  /** 开会话进 tab：已开激活，未开加 tab + 激活 */
  const openSession = (
    sessionId: string,
    title: string,
    workspaceId?: string,
    channelId?: string,
    modelId?: string,
  ): void => {
    const { tabs: next, activeTabId: nextActive } = openTab(
      tabs,
      sessionId,
      title,
      workspaceId,
      channelId,
      modelId,
    )
    setTabs(next)
    setActiveTabId(nextActive)
  }

  /** 打开项目目录并注册为工作区；从新建会话入口调用时直接绑定新会话 */
  const handleOpenProject = async (startSession = false): Promise<void> => {
    const workspace = await window.electronAPI.createProjectWorkspace()
    if (!workspace) return

    await loadWorkspaces()
    if (startSession) {
      // 注册工作区后开新会话：进入草稿（无 tab），发送首条消息才物化为 tab
      setDraftSession({ id: 'session-' + Date.now(), title: '新会话', workspaceId: workspace.id })
    }
  }

  const newSession = (workspaceId?: string): void => {
    // 没有工作区 → 先打开项目目录（注册工作区后直接开新会话）
    if (workspaces.length === 0) {
      void handleOpenProject(true)
      return
    }
    // 已在草稿页（未发送）→ 复用，不另开（避免丢弃已输入内容）
    if (draftSession && !activeTab) return
    // 默认绑最近工作区（侧栏按 recency 排序，workspaces[0] 即最近）；
    // 工作区可在新会话页的选择器里再改，发送首条消息时主进程才落盘绑定。
    const workspace = workspaceId
      ? workspaces.find((item) => item.id === workspaceId) ?? workspaces[0]
      : workspaces[0]
    // workspaces.length===0 已 early return，此处 workspace 必存在；兜底给 TS
    if (!workspace) return
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

    setTabs(remaining)
    if (activeBelongsToWorkspace) {
      const rightNeighbor = tabs
        .slice(activeIndex + 1)
        .find((tab) => tab.workspaceId !== workspaceId)
      const leftNeighbor = tabs
        .slice(0, activeIndex)
        .reverse()
        .find((tab) => tab.workspaceId !== workspaceId)
      setActiveTabId(rightNeighbor?.id ?? leftNeighbor?.id ?? null)
    }
  }

  /**
   * 标签栏显隐：多会话始终显示；单会话在已物化为 tab（channelId 非空）后显示。
   * 草稿态（未发送、无 tab）不显示——对齐「新建会话阶段无标签」。
   */
  const showTabBar = tabs.length > 1 || Boolean(activeTab?.channelId)

  return (
    <TooltipProvider delayDuration={280} skipDelayDuration={120}>
      <AppShell
        topbar={null}
        sidebarOpen={activeRail === 'chat' && sidebarOpen}
        activeRailItem={activeRail === 'chat' ? 'chat' : activeRail}
        rail={
          <Rail
            active={railActive}
            onChat={() => {
              const wasChat = activeRail === 'chat'
              const willOpenSidebar = wasChat ? !sidebarOpen : true
              selectRail('chat')
              // 从其它页进入会话且无 tab/草稿 → 新会话；再点 chat 仅折叠侧栏时不打断
              if (!wasChat && !activeTab && !draftSession) newSession()
              // 侧栏从收起点开、且没有任何会话页时，也给草稿入口
              if (wasChat && willOpenSidebar && !activeTab && !draftSession) newSession()
            }}
            onPlugins={() => selectRail('plugins')}
            onMemory={() => selectRail('memory')}
            onSettings={() => openSettings('general')}
          />
        }
        sidebar={
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
            onNew={() => {
              setShowSettings(false)
              setActiveRail('chat')
              setSidebarOpen(true)
              newSession()
            }}
            onOpenProject={() => void handleOpenProject()}
            onWorkspaceDeleted={handleWorkspaceDeleted}
          />
        }
      >
        {/* main：插件页 | 会话页/欢迎页（底层）+ 新会话草稿 overlay（覆盖层）。
            欢迎页 / 新会话页的入场动画由 NewConversationLanding 内各元素自行承担
            （标题逐词模糊渐现、输入框上滑淡入、提示词错落淡入），非整页位移；
            故此处不做整页过渡，直接切换，新页元素各自重新入场。 */}
        {activeRail === 'plugins' ? (
          <div className="plugins-main-view scrollbar-thin">
            <PluginStoreSettings />
          </div>
        ) : activeRail === 'memory' ? (
          <div className="app-shell-content-stage relative h-full min-h-0 animate-in fade-in duration-300">
            <MemoryMonitorPanel />
          </div>
        ) : workspaces.length === 0 ? (
          <ConversationEmptyState
            title="打开项目目录开始"
            description="选择一个本地代码目录作为工作区，Agent 将在该目录下工作"
          >
            <div className="flex flex-col items-center gap-3">
              <Button size="lg" onClick={() => void handleOpenProject()}>
                打开项目目录
              </Button>
              <p className="text-muted-foreground text-xs">
                选择包含代码的本地文件夹即可开始
              </p>
            </div>
          </ConversationEmptyState>
        ) : draftSession && draftSession.id !== activeTab?.sessionId ? (
          // 新会话草稿态：优先渲染草稿 Chat（NewConversationLanding compose 形态）。
          // tab 状态保留在 atoms（activeTabId 不清），返回键关草稿 → 回到下方会话页/欢迎页。
          // 物化成 tab 后 draftSession.id === activeTab.sessionId → 条件不成立，自动切到会话页。
          <Chat
            key={draftSession.id}
            session={draftSession}
            onDraftWorkspaceChange={(id) =>
              setDraftSession((prev) => (prev ? { ...prev, workspaceId: id } : prev))
            }
            onBack={() => setDraftSession(null)}
          />
        ) : activeTab ? (
          <div className="flex h-full flex-col">
            {showTabBar && <TabBar />}
            <div className="min-h-0 flex-1">
              <SessionRouter />
            </div>
          </div>
        ) : (
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
        )}
      </AppShell>

      <SettingsDialog
        open={showSettings}
        initialTab={settingsInitialTab}
        onOpenChange={setShowSettings}
      />
      <Toaster position="top-center" richColors closeButton />
    </TooltipProvider>
  )
}
