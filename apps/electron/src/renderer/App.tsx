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
  FetchModelsResult,
} from '@tagent/shared'
import { Button, ConversationEmptyState, TooltipProvider } from '@tagent/ui'
import { SessionSidebar } from './components/workspace/SessionSidebar'
import { ChannelManager } from './components/channel/ChannelManager'
import { SettingsDialog } from './components/settings/SettingsPage'
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
  selectedChannelAtom,
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
      decryptKey: (id: string) => Promise<string>
      testChannel: (id: string) => Promise<ChannelTestResult>
      fetchModels: (input: FetchModelsInput) => Promise<FetchModelsResult>
      // 工作区
      listWorkspaces: () => Promise<AgentWorkspace[]>
      createProjectWorkspace: () => Promise<AgentWorkspace | null>
      // 会话元数据（重命名/置顶/归档；status 由主进程内部写，渲染层不直接写）
      updateSessionMeta: (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) => Promise<unknown>
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
      getMcpConfig: (slug: string) => Promise<unknown>
      saveMcpConfig: (slug: string, config: unknown) => Promise<{ ok: boolean }>
      // 权限审批
      onPermissionRequest: (cb: (req: unknown) => void) => () => void
      respondToPermission: (reqId: string, behavior: 'allow' | 'deny', remember?: boolean) => void
      // 热切换会话权限模式
      setSessionPermissionMode: (sessionId: string, mode: string) => Promise<{ ok: boolean; error?: string }>
    }
  }
}

export function App(): JSX.Element {
  const [showChannels, setShowChannels] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false)
  const loadChannels = useSetAtom(loadChannelsAtom)
  const loadWorkspaces = useSetAtom(loadWorkspacesAtom)
  const selected = useAtomValue(selectedChannelAtom)
  const channels = useAtomValue(channelsAtom)
  const workspaces = useAtomValue(workspacesAtom)
  // 多会话 tab
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  // 启动时同时加载渠道列表 + 工作区列表
  useEffect(() => {
    void Promise.all([loadChannels(), loadWorkspaces()])
  }, [loadChannels, loadWorkspaces])

  /** 开会话进 tab：已开激活，未开加 tab + 激活 */
  const openSession = (sessionId: string, title: string, workspaceId?: string): void => {
    const { tabs: next, activeTabId: nextActive } = openTab(
      tabs,
      sessionId,
      title,
      workspaceId,
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

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell
        topbar={null}
        rail={
          <Rail
            active="chat"
            onChat={() => { if (!activeTab) newSession() }}
            onChannels={() => setShowChannels(true)}
            onSettings={() => setShowSettings((s) => !s)}
            themeSlot={<ThemeSettings />}
          />
        }
        sidebar={
          <SessionSidebar
            activeSessionId={activeTabId}
            onSelect={(s) => openSession(s.id, s.title, s.workspaceId)}
            onNew={() => newSession()}
            onOpenProject={() => void handleOpenProject()}
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

      {showChannels && <ChannelManager onClose={() => setShowChannels(false)} />}
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
      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
    </TooltipProvider>
  )
}
