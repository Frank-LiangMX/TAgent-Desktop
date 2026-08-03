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
 * 注意：原 TabBar 有运行状态点（sessionRunMapAtom），但该 atom 在 feat/run-timer 分支
 * 未合并到此分支；此处暂不显状态点，合并后补。
 */
import { useEffect, useState } from 'react'
import { ChatsCircle, UsersThree } from '@phosphor-icons/react'
import { X } from 'lucide-react'
import type { IDockviewPanelHeaderProps } from 'dockview'

interface DockTabParams {
  /** pane 类型（addPanel 时 params 带），决定图标：chat → ChatsCircle，crew → UsersThree */
  paneType?: 'chat' | 'crew'
}

export function DockTab(props: IDockviewPanelHeaderProps<DockTabParams>): JSX.Element {
  const { api, params } = props
  const paneType = params?.paneType ?? 'chat'
  const Icon = paneType === 'crew' ? UsersThree : ChatsCircle

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
      className="app-workspace-tab-shell group relative"
      data-active={active || undefined}
    >
      <button
        type="button"
        onClick={() => api.setActive?.()}
        className="app-workspace-tab titlebar-no-drag"
      >
        <Icon size={14} weight="regular" className="app-workspace-tab__icon shrink-0" />
        <span className="app-workspace-tab__title">{title}</span>
      </button>
      <button
        type="button"
        onClick={(e) => {
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
