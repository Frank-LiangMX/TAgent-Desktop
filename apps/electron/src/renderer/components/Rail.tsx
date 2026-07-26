/**
 * Rail — 左导航轨（玻璃胶囊浮岛）
 *
 * 对齐 TAgent_General FunctionalRail：phosphor 图标（size:18 weight:regular）+
 * rail-island-btn（size-9 rounded-xl）样式。上胶囊：logo/会话/主题；下胶囊：设置。
 * 功能后续接（目前点击占位），先放视觉。
 */
import { Sparkle, ChatsCircle, PlugsConnected, Palette, GearSix } from '@phosphor-icons/react'
import { cn } from '../lib/utils'

/** phosphor 图标统一参数（对齐旧版 RAIL_ICON） */
const RAIL_ICON = { size: 18, weight: 'regular' as const }

interface RailProps {
  active?: 'chat' | 'theme' | 'settings'
  /** 点击会话 */
  onChat?: () => void
  /** 点击渠道管理 */
  onChannels?: () => void
  /** 主题入口（渲染 ThemeSettings 等自带触发的组件，替代 onTheme） */
  themeSlot?: React.ReactNode
  /** 点击设置（占位） */
  onSettings?: () => void
}

export function Rail({
  active = 'chat',
  onChat,
  onChannels,
  themeSlot,
  onSettings,
}: RailProps): JSX.Element {
  return (
    <div className="app-nav-rail">
      {/* 上胶囊：logo / 会话 / 渠道 / 主题 */}
      <div className="app-rail-island">
        <RailIcon icon={<Sparkle {...RAIL_ICON} />} />
        <RailIcon
          icon={<ChatsCircle {...RAIL_ICON} />}
          active={active === 'chat'}
          onClick={onChat}
        />
        <RailIcon icon={<PlugsConnected {...RAIL_ICON} />} onClick={onChannels} />
        {/* 主题：渲染 ThemeSettings（自带 Palette Popover 触发） */}
        {themeSlot ?? (
          <RailIcon icon={<Palette {...RAIL_ICON} />} active={active === 'theme'} />
        )}
      </div>
      {/* 下胶囊：设置（最底，独立） */}
      <div className="app-rail-island">
        <RailIcon
          icon={<GearSix {...RAIL_ICON} />}
          active={active === 'settings'}
          onClick={onSettings}
        />
      </div>
    </div>
  )
}

function RailIcon({
  icon,
  active = false,
  onClick,
}: {
  icon: React.ReactNode
  active?: boolean
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rail-island-btn titlebar-no-drag flex size-9 items-center justify-center rounded-xl transition-colors',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {icon}
    </button>
  )
}
