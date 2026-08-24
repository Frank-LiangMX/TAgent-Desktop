/**
 * DockTab — Dockview 自定义标签头（defaultTabComponent），完整复用 app-workspace-tab
 * 的玻璃胶囊视觉（图标 + 标题 + 关闭按钮），替代 Dockview 默认 tab 头。
 *
 * Dockview 的 .dv-tab 作为外层容器，本组件填进去渲染 app-workspace-tab-shell 那套
 * （已在 app-shell.css 定义），视觉与原 TabBar 完全一致。
 *
 * 重要：ReactPanelHeaderPart 只在 params 变更时 re-render，不会因 active/title 变化
 * 自动刷新。必须订阅 api.onDidActiveChange / onDidTitleChange 才能让 data-active
 * 与标题跟原 TabBar 一样实时更新。
 *
 * 关闭：× 在 pointerdown 上 preventDefault+stopPropagation（对齐 DockviewDefaultTab），
 * 避免 Dockview 先激活再关闭导致「关非当前标签时内容弹跳」。
 */
import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import { ChatsCircle, Eye, File, Globe, UsersThree } from '@phosphor-icons/react'
import { X } from 'lucide-react'
import type { IDockviewPanelHeaderProps } from 'dockview'
import { AppTooltip } from '@tagent/ui'
import {
  sessionStatusMapAtom,
  resolveSessionUiStatus,
  type SessionUiStatus,
} from '../../atoms/session-status-atoms'
import { sessionRunMapAtom } from '../../atoms/session-run-atoms'
import { pendingPermissionMapAtom } from '../../atoms/permission-atoms'
import { allPendingAskUserRequestsAtom } from '../../atoms/ask-user-atoms'
import { usePersistedSessionMeta } from '../../hooks/usePersistedSessionMeta'

type DockPaneType = 'chat' | 'crew' | 'file-preview' | 'rich-preview' | 'browser'

interface DockTabParams {
  /** pane 类型（addPanel 时 params 带）；缺省时按 panel id 前缀推断 */
  paneType?: DockPaneType
}

function resolvePaneType(paneId: string, params?: DockTabParams): DockPaneType {
  if (params?.paneType) return params.paneType
  if (paneId.startsWith('crew:')) return 'crew'
  if (paneId.startsWith('file-preview:')) return 'file-preview'
  if (paneId.startsWith('rich-preview:') || paneId.startsWith('mermaid-preview:')) {
    return 'rich-preview'
  }
  if (paneId.startsWith('browser:')) return 'browser'
  return 'chat'
}

const PANE_ICONS = {
  chat: ChatsCircle,
  crew: UsersThree,
  'file-preview': File,
  'rich-preview': Eye,
  browser: Globe,
} as const

const STATUS_LABEL: Record<SessionUiStatus, string> = {
  idle: '',
  running: '运行中',
  done: '已完成',
  error: '失败',
  pending: '待选择',
}

export function DockTab(props: IDockviewPanelHeaderProps<DockTabParams>): JSX.Element {
  const { api, params } = props
  const paneType = resolvePaneType(api.id, params)
  const Icon = PANE_ICONS[paneType]

  // Dockview panel id = sessionId（chat pane）
  const sessionId = api.id
  const sessionMeta = usePersistedSessionMeta(paneType === 'chat' ? sessionId : undefined)
  const isCollaboration = paneType === 'chat' && Boolean(sessionMeta?.fusionRoomId)
  const TabIcon = isCollaboration ? UsersThree : Icon
  const statusMap = useAtomValue(sessionStatusMapAtom)
  const runMap = useAtomValue(sessionRunMapAtom)
  const pendingPermissionMap = useAtomValue(pendingPermissionMapAtom)
  const pendingAskUserMap = useAtomValue(allPendingAskUserRequestsAtom)
  const awaitingUser =
    (pendingPermissionMap[sessionId]?.length ?? 0) > 0 ||
    (pendingAskUserMap.get(sessionId)?.length ?? 0) > 0
  const status = resolveSessionUiStatus({
    stored: statusMap[sessionId]?.status,
    running: runMap[sessionId]?.running === true,
    awaitingUser,
  })
  const showStatus = paneType === 'chat' && status !== 'idle'

  // 订阅 active / title：Dockview React header 不会因这些事件自动 re-render
  const [active, setActive] = useState(() => api.isActive)
  const [title, setTitle] = useState(() => api.title || '新会话')

  useEffect(() => {
    setActive(api.isActive)
    setTitle(api.title || '新会话')
    const dActive = api.onDidActiveChange((e) => setActive(e.isActive))
    const dTitle = api.onDidTitleChange((e) => setTitle(e.title || '新会话'))
    return () => {
      dActive.dispose()
      dTitle.dispose()
    }
  }, [api])

  return (
    <div
      className={'app-workspace-tab-shell group relative' + (isCollaboration ? ' app-workspace-tab-shell--collaboration' : '')}
      data-active={active || undefined}
    >
      {showStatus && (
        <span
          className="app-workspace-tab-status"
          data-status={status}
          title={STATUS_LABEL[status]}
          aria-label={STATUS_LABEL[status]}
        />
      )}
      <AppTooltip label={title} side="bottom" sideOffset={8} multiline>
        <button
          type="button"
          onClick={() => api.setActive?.()}
          className="app-workspace-tab titlebar-no-drag"
        >
          <TabIcon size={14} weight="regular" className="app-workspace-tab__icon shrink-0" />
          <span className="app-workspace-tab__title">{title}</span>
        </button>
      </AppTooltip>
      <button
        type="button"
        // 对齐 DockviewDefaultTab：× 的 pointerdown 必须 preventDefault，
        // 否则 Dockview 会先 setActive 再 close → 关非当前标签时内容/底板弹跳。
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          api.close()
        }}
        className="app-workspace-tab-close titlebar-no-drag"
        aria-label="关闭标签"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
