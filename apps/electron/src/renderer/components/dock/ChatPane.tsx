/**
 * ChatPane — Dockview 面板适配器，把现有 <Chat> 塞进 Dockview 面板。
 *
 * 镜像 SessionRouter：从 panel params 取 sessionId，查 tabsAtom 拿 TabItem 构造
 * SessionMeta，渲染 <Chat key={sessionId}>。不传 draft 回调（分屏只显已物化 tab）。
 *
 * 多 Chat 并存安全：Chat.tsx 流式事件按 sessionIdRef 过滤（:868），各 Chat 各收各的。
 */
import { useAtomValue } from 'jotai'
import type { IDockviewPanelProps } from 'dockview'
import { Chat, type SessionMeta } from '../chat/Chat'
import { tabsAtom, type TabItem } from '../../atoms/tabs'

/** 本面板的 params（addPanel 时传入） */
interface ChatPaneParams {
  sessionId: string
}

export function ChatPane(props: IDockviewPanelProps<ChatPaneParams>): JSX.Element {
  const { params } = props
  const sessionId = params?.sessionId
  const tabs = useAtomValue(tabsAtom)
  const tab = tabs.find((t: TabItem) => t.sessionId === sessionId)

  if (!sessionId || !tab) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        会话未打开
      </div>
    )
  }

  const session: SessionMeta = {
    id: tab.sessionId,
    title: tab.title,
    workspaceId: tab.workspaceId,
    modelId: tab.modelId,
    channelId: tab.channelId,
  }

  return <Chat key={sessionId} session={session} />
}
