/**
 * Rail — 左导航轨（玻璃胶囊浮岛）
 *
 * 对齐 TAgent_General FunctionalRail：phosphor 图标（size:18 weight:regular）+
 * rail-island-btn（size-9 rounded-xl）样式。上胶囊：会话/渠道/主题；下胶囊：设置。
 *
 * 品牌标不放进导航按钮列：多面体在 18px 按钮位里过密、且与功能入口抢戏。
 * 品牌露出改在关于页（带底板 appicon）与窗口/安装包图标。
 */
import { ChatsCircle, PlugsConnected, Palette, GearSix } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'

/** phosphor 图标统一参数（对齐旧版 RAIL_ICON） */
const RAIL_ICON = { size: 18, weight: 'regular' as const }

interface RailProps {
  active?: 'chat' | 'theme' | 'settings' | 'channels'
  /** 点击会话 */
  onChat?: () => void
  /** 点击渠道管理 */
  onChannels?: () => void
  /** 主题入口（渲染 ThemeSettings 等自带触发的组件，替代 onTheme） */
  themeSlot?: React.ReactNode
  /** 点击设置 */
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
      {/* 上胶囊：会话 / 渠道 / 主题（不含 logo） */}
      <div className="app-rail-island">
        <RailIcon
          icon={<ChatsCircle {...RAIL_ICON} />}
          label="会话"
          active={active === 'chat'}
          onClick={onChat}
        />
        <RailIcon
          icon={<PlugsConnected {...RAIL_ICON} />}
          label="渠道"
          active={active === 'channels'}
          onClick={onChannels}
        />
        {/* 主题：渲染 ThemeSettings（自带 Palette Popover 触发） */}
        {themeSlot ?? (
          <RailIcon icon={<Palette {...RAIL_ICON} />} label="主题" active={active === 'theme'} />
        )}
      </div>
      {/* 下胶囊：设置（最底，独立） */}
      <div className="app-rail-island">
        <RailIcon
          icon={<GearSix {...RAIL_ICON} />}
          label="设置"
          active={active === 'settings'}
          onClick={onSettings}
        />
      </div>
    </div>
  )
}

function RailIcon({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
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
