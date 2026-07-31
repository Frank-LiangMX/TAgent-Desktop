/**
 * SessionRouter — 在稳定树位置渲染当前激活 tab 的 Chat。
 *
 * 草稿态（新建会话未发送）不再走本路由，改由 App 的 overlay 覆盖层渲染（见 App.tsx）。
 * 本组件只服务 tab：有 activeTab 渲染其 Chat，无 tab 返回 null（底层由 App 显示欢迎页）。
 *
 * 对齐 codex：新会话页不占 tab，发送首条消息后才生成 tab。tab 间切换 key=sessionId
 * 复用同一 Chat 实例，IPC 流式 handler 不卸载。
 */
import { useAtomValue } from 'jotai'
import { Chat, type SessionMeta } from '../chat/Chat'
import { activeTabAtom } from '../../atoms/tabs'

export function SessionRouter(): JSX.Element | null {
  const activeTab = useAtomValue(activeTabAtom)
  if (!activeTab) return null
  const session: SessionMeta = {
    id: activeTab.sessionId,
    title: activeTab.title,
    workspaceId: activeTab.workspaceId,
    channelId: activeTab.channelId,
    modelId: activeTab.modelId,
  }
  // 已成正式 tab：工作区已锁定、不再改；无返回钮
  return <Chat key={session.id} session={session} />
}
