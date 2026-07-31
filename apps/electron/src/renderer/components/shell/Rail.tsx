/**
 * Rail — 左导航轨（玻璃胶囊浮岛）
 *
 * 上胶囊：会话 + 插件；下胶囊：设置。
 * 对齐 TAgent_General：插件（PuzzlePiece）是一级入口，不在设置里。
 * 渠道 / 主题改走设置页；工作区在侧栏管理，不进设置。
 *
 * 品牌标不放进导航按钮列：多面体在 18px 按钮位里过密、且与功能入口抢戏。
 * 品牌露出改在关于页（带底板 appicon）与窗口/安装包图标。
 */
import { Brain, ChatsCircle, GearSix, PuzzlePiece } from '@phosphor-icons/react'
import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'

/** phosphor 图标统一参数（对齐旧版 RAIL_ICON） */
const RAIL_ICON = { size: 18, weight: 'regular' as const }

export type RailItem = 'chat' | 'plugins' | 'memory' | 'settings'

interface RailProps {
  active?: RailItem
  /** 点击会话 */
  onChat?: () => void
  /** 点击插件 */
  onPlugins?: () => void
  /** 点击记忆 */
  onMemory?: () => void
  /** 点击设置 */
  onSettings?: () => void
}

export function Rail({
  active = 'chat',
  onChat,
  onPlugins,
  onMemory,
  onSettings,
}: RailProps): JSX.Element {
  return (
    <div className="app-nav-rail">
      {/* 上胶囊：会话 + 插件 + 记忆 */}
      <div className="app-rail-island">
        <RailIcon
          railId="chat"
          icon={<ChatsCircle {...RAIL_ICON} />}
          label="会话"
          active={active === 'chat'}
          onClick={onChat}
        />
        <RailIcon
          railId="plugins"
          icon={<PuzzlePiece {...RAIL_ICON} />}
          label="插件"
          active={active === 'plugins'}
          onClick={onPlugins}
        />
        <RailIcon
          railId="memory"
          icon={<Brain {...RAIL_ICON} />}
          label="记忆"
          active={active === 'memory'}
          onClick={onMemory}
        />
      </div>
      {/* 下胶囊：设置 */}
      <div className="app-rail-island">
        <RailIcon
          railId="settings"
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
  railId,
  icon,
  label,
  active = false,
  onClick,
}: {
  /** morph 源测量用，对齐 General data-rail-id */
  railId?: string
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
}): JSX.Element {
  return (
    <AppTooltip label={label} side="right" sideOffset={10}>
      <button
        type="button"
        data-rail-id={railId}
        aria-label={label}
        onClick={onClick}
        className={cn(
          'rail-island-btn titlebar-no-drag flex size-9 items-center justify-center rounded-xl transition-colors',
          active && 'rail-island-btn--active',
          active
            ? 'bg-primary/15 text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {icon}
      </button>
    </AppTooltip>
  )
}
