/**
 * TabBarItem — 单个会话标签
 *
 * 对齐 TAgent_General TabBarItem 形态（图标 + 标题 + × 关闭），自己搭精简。
 * 选中态 tab-item-selected（上圆下直玻璃填充），× hover 显隐。
 * 状态色点：与侧栏会话列表同源（完成绿 / 运行蓝脉冲 / 失败红 / 待选择黄）。
 */
import { ChatsCircle } from '@phosphor-icons/react'
import { X } from 'lucide-react'
import type { TabItem } from '../../atoms/tabs'
import type { SessionUiStatus } from '../../atoms/session-status-atoms'

interface TabBarItemProps {
  tab: TabItem
  active: boolean
  /** 合成后的 UI 状态；idle 不显示色点 */
  status?: SessionUiStatus
  onActivate: () => void
  onClose: () => void
}

const STATUS_LABEL: Record<Exclude<SessionUiStatus, 'idle'>, string> = {
  running: '运行中',
  done: '已完成',
  error: '失败',
  pending: '待选择',
}

export function TabBarItem({
  tab,
  active,
  status = 'idle',
  onActivate,
  onClose,
}: TabBarItemProps): JSX.Element {
  const showStatus = status !== 'idle'
  return (
    <div className="app-workspace-tab-shell group relative" data-active={active || undefined}>
      <button
        type="button"
        onClick={onActivate}
        className="app-workspace-tab titlebar-no-drag"
      >
        {showStatus && (
          <span
            className="app-workspace-tab-status"
            data-status={status}
            title={STATUS_LABEL[status]}
            aria-label={STATUS_LABEL[status]}
          />
        )}
        <ChatsCircle size={14} weight="regular" className="app-workspace-tab__icon shrink-0" />
        <span className="app-workspace-tab__title">{tab.title || '新会话'}</span>
      </button>
      <button
        type="button"
        // 与 DockTab 一致：按下阶段就拦住激活，避免关非当前标签时先跳过去
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
