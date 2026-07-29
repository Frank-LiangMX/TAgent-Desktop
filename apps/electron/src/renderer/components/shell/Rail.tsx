/**
 * Rail — 左导航轨（玻璃胶囊浮岛）
 *
 * 精简入口：上胶囊仅「会话」；下胶囊「设置」。
 * 渠道 / 主题改走设置页（渠道、外观），不再占 rail。
 *
 * 品牌标不放进导航按钮列：多面体在 18px 按钮位里过密、且与功能入口抢戏。
 * 品牌露出改在关于页（带底板 appicon）与窗口/安装包图标。
 */
import { ChatsCircle, GearSix } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'

/** phosphor 图标统一参数（对齐旧版 RAIL_ICON） */
const RAIL_ICON = { size: 18, weight: 'regular' as const }

interface RailProps {
  active?: 'chat' | 'settings'
  /** 点击会话 */
  onChat?: () => void
  /** 点击设置 */
  onSettings?: () => void
}

export function Rail({
  active = 'chat',
  onChat,
  onSettings,
}: RailProps): JSX.Element {
  return (
    <div className="app-nav-rail">
      {/* 上胶囊：会话 */}
      <div className="app-rail-island">
        <RailIcon
          icon={<ChatsCircle {...RAIL_ICON} />}
          label="会话"
          active={active === 'chat'}
          onClick={onChat}
        />
      </div>
      {/* 下胶囊：设置 */}
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
