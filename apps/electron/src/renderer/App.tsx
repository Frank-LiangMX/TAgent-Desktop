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
import { Button, ConversationEmptyState } from '@tagent/ui'
import { Chat } from './Chat'
import { SessionSidebar } from './components/SessionSidebar'
import { ChannelManager } from './components/ChannelManager'
import { WorkspaceSelector } from './components/WorkspaceSelector'
import {
  channelsAtom,
  loadChannelsAtom,
  selectedChannelAtom,
} from './atoms/channel-atoms'
import {
  workspacesAtom,
  currentWorkspaceIdAtom,
  currentWorkspaceAtom,
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
      getCurrentWorkspace: () => Promise<AgentWorkspace | undefined>
      switchWorkspace: (id: string) => Promise<{ ok: boolean; error?: string }>
    }
  }
}

interface SessionMeta {
  id: string
  title: string
  modelId?: string
  channelId?: string
}

export function App(): JSX.Element {
  const [activeSession, setActiveSession] = useState<SessionMeta | null>(null)
  const [showChannels, setShowChannels] = useState(false)
  const loadChannels = useSetAtom(loadChannelsAtom)
  const loadWorkspaces = useSetAtom(loadWorkspacesAtom)
  const selected = useAtomValue(selectedChannelAtom)
  const channels = useAtomValue(channelsAtom)
  const workspaces = useAtomValue(workspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)

  // 启动时同时加载渠道列表 + 工作区列表
  useEffect(() => {
    void Promise.all([loadChannels(), loadWorkspaces()])
  }, [loadChannels, loadWorkspaces])

  const newSession = (): void => {
    // 新会话用临时 meta（发首条消息时主进程建持久 meta + 绑定渠道 + 绑定 workspace）
    setActiveSession({ id: 'session-' + Date.now(), title: '新会话' })
  }

  /** 打开项目目录 → 创建 workspace */
  const handleOpenProject = async (): Promise<void> => {
    const ws = await window.electronAPI.createProjectWorkspace()
    if (ws) {
      await loadWorkspaces()
    }
  }

  return (
    <div className="flex flex-col h-screen">
      {/* 顶栏 */}
      <div className="h-11 shrink-0 border-b flex items-center px-3 gap-3">
        {/* 工作区选择器 */}
        <WorkspaceSelector />

        {/* 分隔 */}
        <div className="w-px h-4 bg-border" />

        <Button variant="outline" size="sm" onClick={() => setShowChannels(true)}>
          渠道管理
        </Button>
        <div className="text-xs text-muted-foreground">
          当前渠道：{selected ? `${selected.name} / ${selected.defaultModelId ?? '无默认模型'}` : '未选择'}
          {channels.length === 0 && '（加载中…）'}
        </div>
      </div>

      {/* 主区：侧栏 + Chat */}
      <div className="flex flex-1 min-h-0">
        <SessionSidebar
          activeSessionId={activeSession?.id ?? null}
          onSelect={(s) => setActiveSession(s)}
          onNew={newSession}
        />
        <div className="flex-1 min-w-0">
          {/* 无 workspace 时显示引导 */}
          {workspaces.length === 0 ? (
            <ConversationEmptyState
              title="打开项目目录开始"
              description="选择一个本地代码目录作为工作区，Agent 将在该目录下工作"
            >
              <div className="flex flex-col items-center gap-3">
                <Button
                  size="lg"
                  onClick={() => void handleOpenProject()}
                >
                  打开项目目录
                </Button>
                <p className="text-muted-foreground text-xs">
                  选择包含代码的本地文件夹即可开始
                </p>
              </div>
            </ConversationEmptyState>
          ) : activeSession ? (
            <Chat key={activeSession.id} session={activeSession} />
          ) : (
            <ConversationEmptyState
              title="选择左侧会话，或点「新建会话」开始"
              description="创建新会话即可开始对话"
            />
          )}
        </div>
      </div>

      {showChannels && <ChannelManager onClose={() => setShowChannels(false)} />}
    </div>
  )
}
