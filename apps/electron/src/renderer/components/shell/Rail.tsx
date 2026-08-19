/**
 * Rail — 左导航轨图标内容（仅内容，外壳由 NavIsland 包 app-nav-rail）
 * 与 General FunctionalRail 一致：children 进 app-nav-rail-content。
 */
import { Brain, ChatsCircle, IdentificationCard, PuzzlePiece, UsersThree } from '@phosphor-icons/react'
import { useAtomValue } from 'jotai'
import { AppTooltip } from '@tagent/ui'
import { userProfileAtom } from '../../atoms/user-profile'
import { cn } from '../../lib/utils'

const RAIL_ICON = { size: 18, weight: 'regular' as const }

export type RailItem = 'chat' | 'collaboration' | 'plugins' | 'memory' | 'roles' | 'settings'

interface RailProps {
  active?: RailItem
  showCollaboration?: boolean
  onChat?: () => void
  onCollaboration?: () => void
  onPlugins?: () => void
  onMemory?: () => void
  onRoles?: () => void
  onSettings?: () => void
}

export function Rail({
  active = 'chat',
  showCollaboration = true,
  onChat,
  onCollaboration,
  onPlugins,
  onMemory,
  onRoles,
  onSettings,
}: RailProps): JSX.Element {
  const userName = useAtomValue(userProfileAtom).userName
  /** 用户名首字符（中文取首字；英文转大写） */
  const avatarLetter = userName?.charAt(0)?.toUpperCase() || 'U'

  return (
    <>
      {/* 上胶囊：会话 + 协作 + 插件 + 记忆 + 角色库 */}
      <div className="app-rail-island">
        <RailIcon
          railId="chat"
          icon={<ChatsCircle {...RAIL_ICON} />}
          label="会话"
          active={active === 'chat'}
          onClick={onChat}
        />
        {showCollaboration ? (
          <RailIcon
            railId="collaboration"
            icon={<UsersThree {...RAIL_ICON} />}
            label="协作"
            active={active === 'collaboration'}
            onClick={onCollaboration}
          />
        ) : null}
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
        <RailIcon
          railId="roles"
          icon={<IdentificationCard {...RAIL_ICON} />}
          label="角色库"
          active={active === 'roles'}
          onClick={onRoles}
        />
      </div>
      {/* 下胶囊：设置（用户名首字头像，对齐 TAgent_General rail-avatar-btn） */}
      <div className="app-rail-island">
        <AppTooltip label="设置" side="right" sideOffset={10}>
          <button
            type="button"
            data-rail-id="settings"
            data-active={active === 'settings' || undefined}
            aria-label="设置"
            aria-pressed={active === 'settings' || undefined}
            onClick={onSettings}
            className="rail-avatar-btn titlebar-no-drag flex size-9 items-center justify-center rounded-full"
          >
            <span className="rail-avatar-letter">{avatarLetter}</span>
          </button>
        </AppTooltip>
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
