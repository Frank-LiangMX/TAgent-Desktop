/**
 * TabContent — 当前激活 tab 的会话内容
 *
 * 按 activeTab.sessionId 渲 Chat（key=sessionId 重建，会话状态天然隔离）。
 * 无激活 tab 时返回 null（外层显示空状态）。
 */
import { useAtomValue } from 'jotai'
import { Chat } from '../chat/Chat'
import { activeTabAtom } from '../../atoms/tabs'

export function TabContent(): JSX.Element | null {
  const activeTab = useAtomValue(activeTabAtom)
  if (!activeTab) return null
  return (
    <Chat
      key={activeTab.sessionId}
      session={{ id: activeTab.sessionId, title: activeTab.title }}
    />
  )
}
