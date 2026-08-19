/**
 * 协作室头像：成员 = 模型 logo（兜底首字色块）；用户 = 用户名首字圆形渐变（对齐会话/设置入口）。
 */
import { useAtomValue } from 'jotai'
import { AppTooltip } from '@tagent/ui'
import { DEFAULT_USER_NAME, type Channel, type CollaborationMember } from '@tagent/shared'
import { userProfileAtom } from '../../atoms/user-profile'
import { getModelLogo } from '../../lib/model-logo'
import { cn } from '../../lib/utils'

/** 成员头像：优先模型 logo，兜底显示名首字 + 按成员 ID 稳定的主题色 */
export function MemberAvatar({
  member,
  channels,
  size = 32,
}: {
  member: CollaborationMember
  channels: Channel[]
  size?: number
}): JSX.Element {
  const channel = channels.find((c) => c.id === member.channelId)
  const logo =
    member.modelId && channel?.provider
      ? getModelLogo(member.modelId, channel.provider)
      : undefined
  const box = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.42),
  }
  if (logo) {
    return (
      <img
        src={logo}
        alt={member.displayName}
        className="shrink-0 rounded-full border-[0.5px] border-foreground/10 object-cover"
        style={box}
      />
    )
  }
  const palette = [
    'bg-primary/15 text-primary',
    'bg-sky-500/15 text-sky-600',
    'bg-amber-500/15 text-amber-600',
    'bg-emerald-500/15 text-emerald-600',
    'bg-violet-500/15 text-violet-600',
  ]
  const idx =
    Array.from(member.id).reduce((acc, ch) => acc + ch.charCodeAt(0), 0) %
    palette.length
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border-[0.5px] border-foreground/10 font-semibold',
        palette[idx],
      )}
      style={box}
    >
      {member.displayName.slice(0, 1)}
    </div>
  )
}

/** 用户消息头像：与设置左下角/会话一致，用户名首字圆形渐变头像 */
export function UserMessageAvatar(): JSX.Element {
  const profile = useAtomValue(userProfileAtom)
  const userName = (profile.userName || DEFAULT_USER_NAME).trim() || DEFAULT_USER_NAME
  const avatarLetter = userName.charAt(0).toUpperCase() || 'U'
  return (
    <AppTooltip label={userName}>
      <span
        className="flex size-9 shrink-0 select-none items-center justify-center rounded-full border-2 border-background/90 text-sm font-bold leading-none text-primary-foreground"
        style={{
          background:
            'linear-gradient(145deg, color-mix(in srgb, hsl(var(--primary)) 82%, white), hsl(var(--primary) / 0.62))',
          boxShadow:
            '0 1px 2px hsl(var(--foreground) / 0.08), 0 4px 12px -2px hsl(var(--foreground) / 0.12)',
        }}
        aria-label={userName}
      >
        {avatarLetter}
      </span>
    </AppTooltip>
  )
}
