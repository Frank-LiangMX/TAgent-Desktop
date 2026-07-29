/**
 * PermissionModeSelector — 输入框尾部权限模式选择 Popover pill
 *
 * 三模式：自动审批（auto）/ 完全自动（bypassPermissions）/ 计划模式（plan）。
 * 会话级持久化（meta.permissionMode），运行中切换即时生效（Pi 闭包读 meta；kscc 调 SDK setPermissionMode）。
 * 对齐 TAgent_General 输入框底部形态（图标 + 当前模式名 + ChevronDown）。
 */
import { AppTooltip, Popover, PopoverTrigger, PopoverContent } from '@tagent/ui'
import {
  ShieldCheck,
  ShieldWarning,
  Eye,
  CaretDown,
  Check,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import type { TAgentPermissionMode } from '@tagent/shared'
import { TAGENT_PERMISSION_MODE_CONFIG, TAGENT_PERMISSION_MODE_ORDER } from '@tagent/shared'

interface PermissionModeSelectorProps {
  /** 当前会话的权限模式（无则默认 auto） */
  mode: TAgentPermissionMode
  /** 切换模式（持久化 + 通知运行时） */
  onChange: (mode: TAgentPermissionMode) => void
}

const ICONS: Record<TAgentPermissionMode, typeof ShieldCheck> = {
  auto: ShieldCheck,
  bypassPermissions: ShieldWarning,
  plan: Eye,
}

export function PermissionModeSelector({
  mode,
  onChange,
}: PermissionModeSelectorProps): JSX.Element {
  const current = TAGENT_PERMISSION_MODE_CONFIG[mode]
  const Icon = ICONS[mode] ?? ShieldCheck

  return (
    <Popover>
      <AppTooltip label={current.description} side="top" multiline>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors',
              'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" weight="regular" />
            <span className="max-w-[100px] truncate font-medium text-foreground/80">
              {current.label}
            </span>
            <CaretDown className="size-3 opacity-70" weight="regular" />
          </button>
        </PopoverTrigger>
      </AppTooltip>

      <PopoverContent align="end" className="w-64 p-2">
        <div className="space-y-0.5">
          {TAGENT_PERMISSION_MODE_ORDER.map((m) => {
            const cfg = TAGENT_PERMISSION_MODE_CONFIG[m]
            const MIcon = ICONS[m]
            return (
              <button
                key={m}
                onClick={() => onChange(m)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-glass-popover px-2 py-1.5 text-left text-xs transition-colors',
                  'hover:bg-accent',
                )}
              >
                <MIcon className="size-3.5 shrink-0 text-muted-foreground" weight="regular" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{cfg.label}</div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {cfg.description}
                  </div>
                </div>
                {m === mode && (
                  <Check className="size-3.5 shrink-0 text-primary" weight="bold" />
                )}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}