/**
 * TabBarItem — 单个会话标签
 *
 * 对齐 TAgent_General TabBarItem 形态（图标 + 标题 + × 关闭），自己搭精简。
 * 选中态 tab-item-selected（上圆下直玻璃填充），× hover 显隐。
 */
import { ChatsCircle } from '@phosphor-icons/react'
import { X } from 'lucide-react'
import type { TabItem } from '../../atoms/tabs'

interface TabBarItemProps {
  tab: TabItem
  active: boolean
  running?: boolean
  onActivate: () => void
  onClose: () => void
}

export function TabBarItem({
  tab,
  active,
  running,
  onActivate,
  onClose,
}: TabBarItemProps): JSX.Element {
  return (
    <div className="app-workspace-tab-shell group relative" data-active={active || undefined}>
      <button
        type="button"
        onClick={onActivate}
        className="app-workspace-tab titlebar-no-drag"
      >
        {/* 流式状态点 */}
        {running && <span className="app-workspace-tab-status" />}
        <ChatsCircle size={14} weight="regular" className="app-workspace-tab__icon shrink-0" />
        <span className="app-workspace-tab__title">{tab.title || '新会话'}</span>
      </button>
      {/* 关闭按钮 */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="app-workspace-tab-close titlebar-no-drag"
        aria-label="关闭标签"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
