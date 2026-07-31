/**
 * Rail — 左导航轨图标内容（仅内容，外壳由 NavIsland 包 app-nav-rail）
 * 与 General FunctionalRail 一致：children 进 app-nav-rail-content。
 */
import { Brain, ChatsCircle, GearSix, PuzzlePiece } from '@phosphor-icons/react'
import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'

const RAIL_ICON = { size: 18, weight: 'regular' as const }

export type RailItem = 'chat' | 'plugins' | 'memory' | 'settings'

interface RailProps {
  active?: RailItem
  onChat?: () => void
  onPlugins?: () => void
  onMemory?: () => void
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
    <>
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
    </>
  )
}

function RailIcon({
  railId,
  icon,
  label,
  active = false,
  onClick,
}: {
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
