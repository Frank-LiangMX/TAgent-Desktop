/**
 * TAgent-Desktop App 根组件
 *
 * 顶栏（WorkspaceSelector + 渠道管理入口 + 当前渠道）
 * + 侧栏（按 workspace 分组的会话列表）
 * + Chat（消息区）。
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
  InstallStoreBundleResult,
  McpServerEntry,
  PluginStoreCatalog,
  WorkspaceMcpConfig,
  WorkspacePluginBundleRecord,
} from '@tagent/shared'
import { Button, ConversationEmptyState, TooltipProvider } from '@tagent/ui'
import { SessionSidebar } from './components/workspace/SessionSidebar'
import { SettingsDialog, type SettingsTab } from './components/settings/SettingsPage'
import { ThemeSettings } from './components/theme/ThemeSettings'
import { AppShell } from './components/shell/AppShell'
import { Rail } from './components/shell/Rail'
import { TabBar } from './components/shell/TabBar'
import { TabContent } from './components/shell/TabContent'
import { WelcomePage } from './components/shell/WelcomePage'
import { WorkspacePickerDialog } from './components/shell/WorkspacePickerDialog'
import { tabsAtom, activeTabIdAtom, activeTabAtom, openTab } from './atoms/tabs'
import {
  channelsAtom,
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
      // 会话元数据（重命名/置顶/归档/子代理委派积极性；status 由主进程内部写，渲染层不直接写）
      updateSessionMeta: (id: string, patch: {
        title?: string
        pinned?: boolean
        archived?: boolean
        subagentEagerness?: 'never' | 'conservative' | 'balanced' | 'aggressive'
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
      /** 系统是否深色（nativeTheme） */
      getSystemDark: () => Promise<boolean>
      /** 系统明暗变化 */
      onSystemThemeUpdated: (cb: (dark: boolean) => void) => () => void
      /** 上报应用内解析后的深浅（驱动窗口/Dock 图标） */
      setResolvedDark: (dark: boolean) => void
    }
  }
}

export function App(): JSX.Element {
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general')
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false)
  const loadChannels = useSetAtom(loadChannelsAtom)
  const loadWorkspaces = useSetAtom(loadWorkspacesAtom)
  const channels = useAtomValue(channelsAtom)
  const workspaces = useAtomValue(workspacesAtom)
  // 多会话 tab
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const openSettings = (tab: SettingsTab): void => {
    setSettingsInitialTab(tab)
    setShowSettings(true)
  }

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
      openSession('session-' + Date.now(), '新会话', workspace.id)
    }
  }

  const newSession = (workspaceId?: string): void => {
    const workspace = workspaceId
      ? workspaces.find((item) => item.id === workspaceId)
      : workspaces.length === 1
        ? workspaces[0]
        : undefined

    if (!workspace) {
      if (workspaces.length === 0) {
        void handleOpenProject(true)
        return
      }
      setShowWorkspacePicker(true)
      return
    }

    // 新会话用临时 id（发首条消息时主进程建持久 meta + 绑定渠道 + 绑定 workspace）
    openSession('session-' + Date.now(), '新会话', workspace.id)
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

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell
        topbar={null}
        rail={
          <Rail
            active="chat"
            onChat={() => { if (!activeTab) newSession() }}
            onChannels={() => openSettings('channels')}
            onSettings={() => openSettings('general')}
            themeSlot={<ThemeSettings />}
          />
        }
        sidebar={
          <SessionSidebar
            activeSessionId={activeTabId}
            onSelect={(s) => openSession(s.id, s.title, s.workspaceId, s.channelId, s.modelId)}
            onNew={() => newSession()}
            onOpenProject={() => void handleOpenProject()}
            onWorkspaceDeleted={handleWorkspaceDeleted}
          />
        }
      >
        {/* main：会话页或空状态 */}
        {workspaces.length === 0 ? (
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
        ) : activeTab ? (
          <div className="flex h-full flex-col">
            <TabBar />
            <div className="min-h-0 flex-1">
              <TabContent />
            </div>
          </div>
        ) : (
          <WelcomePage
            onNewSession={() => newSession()}
            onOpenProject={() => void handleOpenProject()}
          />
        )}
      </AppShell>

      <WorkspacePickerDialog
        open={showWorkspacePicker}
        workspaces={workspaces}
        onOpenChange={setShowWorkspacePicker}
        onSelect={(workspace) => {
          setShowWorkspacePicker(false)
          newSession(workspace.id)
        }}
        onOpenProject={() => {
          setShowWorkspacePicker(false)
          void handleOpenProject(true)
        }}
      />
      <SettingsDialog
        open={showSettings}
        initialTab={settingsInitialTab}
        onOpenChange={setShowSettings}
      />
    </TooltipProvider>
  )
}
