/**
 * SessionRouter — 在稳定树位置渲染当前会话的 Chat（草稿态 + 已激活 tab 共用）。
 *
 * 对齐 codex：新会话页不占 tab，发送首条消息后才生成 tab。为避免「草稿 Chat
 * → tab Chat」切换时 Chat 重挂（IPC 流式无缓冲，重挂窗口期 stream delta 会丢），
 * 草稿态与 tab 态的 Chat 都由本组件在同一父节点下渲染、用相同 key=sessionId，
 * 使 React 复用同一实例——sessionId 不变则不重挂，流式 handler 全程不卸载。
 */
import { useAtomValue } from 'jotai'
import { Chat, type SessionMeta } from '../chat/Chat'
import { activeTabAtom } from '../../atoms/tabs'

interface SessionRouterProps {
  /** 草稿会话（无 tab 时的新会话页）；tab 存在时由 activeTab 接管 */
  draftSession: SessionMeta | null
  /** 草稿态改工作区（改 App 的 draftSession）；已有 tab 时本回调不传 */
  onDraftWorkspaceChange?: (id: string) => void
  /** 草稿态返回欢迎页（丢弃草稿）；已有 tab 时本回调不传 */
  onDraftBack?: () => void
}

export function SessionRouter({
  draftSession,
  onDraftWorkspaceChange,
  onDraftBack,
}: SessionRouterProps): JSX.Element | null {
  const activeTab = useAtomValue(activeTabAtom)
  // tab 优先；草稿态（无 tab）用 draftSession。草稿→tab 物化时 sessionId 相同 → Chat 不重挂。
  const session: SessionMeta | null = activeTab
    ? {
        id: activeTab.sessionId,
        title: activeTab.title,
        workspaceId: activeTab.workspaceId,
        channelId: activeTab.channelId,
        modelId: activeTab.modelId,
      }
    : draftSession
  if (!session) return null
  // 已有 tab 时不再暴露工作区选择 / 返回（首条发送后工作区锁定、已成正式会话）→ 不传
  return (
    <Chat
      key={session.id}
      session={session}
      onDraftWorkspaceChange={activeTab ? undefined : onDraftWorkspaceChange}
      onBack={activeTab ? undefined : onDraftBack}
    />
  )
}
