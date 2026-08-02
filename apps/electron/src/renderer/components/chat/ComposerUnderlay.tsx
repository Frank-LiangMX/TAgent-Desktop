/**
 * ComposerUnderlay — Work 模式专用功能栏
 *
 * 仅：权限 + 子代理。
 * Chat|Work 与思考强度在输入区常驻；Chat 下不展示本栏与展开按钮。
 */
import { useState } from 'react'
import { ShieldCheck, Bot, Check } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent, MenuPopoverItem } from '@tagent/ui'
import type { TAgentPermissionMode, SubagentEagerness } from '@tagent/shared'
import {
  TAGENT_PERMISSION_MODE_ORDER,
  TAGENT_PERMISSION_MODE_CONFIG,
} from '@tagent/shared'
import { cn } from '../../lib/utils'

interface ComposerUnderlayProps {
  permissionMode: TAgentPermissionMode
  onPermissionModeChange: (mode: TAgentPermissionMode) => void
  subagentEagerness: SubagentEagerness
  onSubagentEagernessChange: (level: SubagentEagerness) => void
}

const EAGERNESS_LABELS: Record<SubagentEagerness, string> = {
  never: '禁用',
  conservative: '保守',
  balanced: '均衡',
  aggressive: '激进',
}

const EAGERNESS_DESCRIPTIONS: Record<SubagentEagerness, string> = {
  never: '不主动委派，仅在你明确要求时使用',
  conservative: '明确有益才委派（默认）',
  balanced: '积极委派，保持主上下文干净',
  aggressive: '尽可能委派，主会话只做编排与决策',
}

const EAGERNESS_ORDER = ['never', 'conservative', 'balanced', 'aggressive'] as const

function UnderlayCell({
  icon,
  label,
  value,
  open,
  onOpenChange,
  children,
}: {
  icon: React.ReactNode
  label: string
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={cn('composer-underlay-cell', open && 'composer-underlay-cell--open')}
          type="button"
        >
          {icon}
          <span className="composer-underlay-cell__label">{label}</span>
          <span className="composer-underlay-cell__value">{value}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        className="agent-toolbar-popover w-auto min-w-[168px] p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

export function ComposerUnderlay({
  permissionMode,
  onPermissionModeChange,
  subagentEagerness,
  onSubagentEagernessChange,
}: ComposerUnderlayProps): JSX.Element {
  const [openKey, setOpenKey] = useState<string | null>(null)

  return (
    <div className="composer-underlay" data-cell-count="2">
      <UnderlayCell
        icon={<ShieldCheck className="composer-underlay-cell__icon" aria-hidden />}
        label="权限"
        value={TAGENT_PERMISSION_MODE_CONFIG[permissionMode]?.label ?? permissionMode}
        open={openKey === 'permission'}
        onOpenChange={(o) => setOpenKey(o ? 'permission' : null)}
      >
        <div className="flex w-56 flex-col gap-0.5">
          {TAGENT_PERMISSION_MODE_ORDER.map((mode) => {
            const cfg = TAGENT_PERMISSION_MODE_CONFIG[mode]
            return (
              <MenuPopoverItem
                key={mode}
                label={cfg.label}
                description={cfg.description}
                selected={permissionMode === mode}
                trailing={
                  permissionMode === mode && (
                    <Check className="size-3.5 text-primary" strokeWidth={2.5} />
                  )
                }
                onClick={() => {
                  onPermissionModeChange(mode)
                  setOpenKey(null)
                }}
              />
            )
          })}
        </div>
      </UnderlayCell>

      <UnderlayCell
        icon={<Bot className="composer-underlay-cell__icon" aria-hidden />}
        label="子代理"
        value={EAGERNESS_LABELS[subagentEagerness] ?? subagentEagerness}
        open={openKey === 'eagerness'}
        onOpenChange={(o) => setOpenKey(o ? 'eagerness' : null)}
      >
        <div className="flex w-52 flex-col gap-0.5">
          {EAGERNESS_ORDER.map((level) => (
            <MenuPopoverItem
              key={level}
              label={EAGERNESS_LABELS[level]}
              description={EAGERNESS_DESCRIPTIONS[level]}
              selected={subagentEagerness === level}
              trailing={
                subagentEagerness === level && (
                  <Check className="size-3.5 text-primary" strokeWidth={2.5} />
                )
              }
              onClick={() => {
                onSubagentEagernessChange(level)
                setOpenKey(null)
              }}
            />
          ))}
        </div>
      </UnderlayCell>
    </div>
  )
}
