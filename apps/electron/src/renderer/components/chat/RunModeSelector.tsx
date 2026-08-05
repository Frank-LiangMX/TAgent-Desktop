/**
 * RunModeSelector — 输入区唯一的「运行模式」入口
 *
 * 收编了原先分散的三处控件：Chat|Work 文本开关、Work 权限角标、功能栏滑块里的
 * 权限/子代理两格。触发器常态只占一个 pill，细项进弹层。
 *
 * 触发器本身承担状态显示：Work 下按权限档换图标与配色（绿=自动审批 /
 * 紫=计划 / 橙=完全自动），不点开也能一眼看出当前放权程度。
 */
import { useState } from 'react'
import { Check, ChevronDown, Compass, MessageCircle, ShieldCheck, Unlock } from 'lucide-react'
import { AppTooltip, MenuPopoverItem, Popover, PopoverContent, PopoverTrigger } from '@tagent/ui'
import type { ExecutionMode, SubagentEagerness, TAgentPermissionMode } from '@tagent/shared'
import {
  EXECUTION_MODE_CONFIG,
  TAGENT_PERMISSION_MODE_CONFIG,
  TAGENT_PERMISSION_MODE_ORDER,
} from '@tagent/shared'
import { cn } from '../../lib/utils'

const PERMISSION_ICONS: Record<TAgentPermissionMode, typeof ShieldCheck> = {
  auto: ShieldCheck,
  bypassPermissions: Unlock,
  plan: Compass,
}

const EAGERNESS_ORDER = ['never', 'conservative', 'balanced', 'aggressive'] as const

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

export interface RunModeSelectorProps {
  executionMode: ExecutionMode
  onExecutionModeChange: (mode: ExecutionMode) => void
  permissionMode: TAgentPermissionMode
  onPermissionModeChange: (mode: TAgentPermissionMode) => void
  subagentEagerness: SubagentEagerness
  onSubagentEagernessChange: (level: SubagentEagerness) => void
  /** 窄栏：隐藏文字只留图标 */
  compact?: boolean
  disabled?: boolean
}

export function RunModeSelector({
  executionMode,
  onExecutionModeChange,
  permissionMode,
  onPermissionModeChange,
  subagentEagerness,
  onSubagentEagernessChange,
  compact,
  disabled,
}: RunModeSelectorProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const isWork = executionMode === 'work'
  const permissionCfg = TAGENT_PERMISSION_MODE_CONFIG[permissionMode]
  const TriggerIcon = isWork ? (PERMISSION_ICONS[permissionMode] ?? ShieldCheck) : MessageCircle

  const tooltip = isWork
    ? `Work · ${permissionCfg?.label ?? permissionMode}——${permissionCfg?.description ?? ''}`
    : `Chat——${EXECUTION_MODE_CONFIG.chat.description}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AppTooltip label={tooltip} side="top" multiline>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'composer-run-mode',
              isWork
                ? `composer-run-mode--work composer-run-mode--${permissionMode}`
                : 'composer-run-mode--chat',
              open && 'composer-run-mode--open',
            )}
            aria-label={`运行模式：${tooltip}`}
          >
            <TriggerIcon className="composer-run-mode__icon" aria-hidden />
            {!compact ? (
              <span className="composer-run-mode__text">
                <span className="composer-run-mode__mode">
                  {EXECUTION_MODE_CONFIG[executionMode].label}
                </span>
                {isWork ? (
                  <span className="composer-run-mode__detail">
                    {permissionCfg?.label ?? permissionMode}
                  </span>
                ) : null}
              </span>
            ) : null}
            <ChevronDown className="composer-run-mode__caret" aria-hidden />
          </button>
        </PopoverTrigger>
      </AppTooltip>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[248px] p-1.5"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <MenuPopoverItem
          icon={<MessageCircle className="size-3.5" />}
          label={EXECUTION_MODE_CONFIG.chat.label}
          description={EXECUTION_MODE_CONFIG.chat.description}
          selected={!isWork}
          trailing={!isWork && <Check className="size-3.5 text-primary" strokeWidth={2.5} />}
          onClick={() => {
            if (isWork) onExecutionModeChange('chat')
            setOpen(false)
          }}
        />

        <div className="mx-1 my-1 h-px bg-border/40" />

        {/* Work 不是单独一行：选哪个权限档就等于进 Work，省掉「先切模式再调权限」两步 */}
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {EXECUTION_MODE_CONFIG.work.label} · 权限
        </div>
        {TAGENT_PERMISSION_MODE_ORDER.map((mode) => {
          const cfg = TAGENT_PERMISSION_MODE_CONFIG[mode]
          const ModeIcon = PERMISSION_ICONS[mode]
          const selected = isWork && permissionMode === mode
          return (
            <MenuPopoverItem
              key={mode}
              icon={<ModeIcon className="size-3.5" />}
              label={cfg.label}
              description={cfg.description}
              selected={selected}
              trailing={selected && <Check className="size-3.5 text-primary" strokeWidth={2.5} />}
              onClick={() => {
                if (!isWork) onExecutionModeChange('work')
                if (permissionMode !== mode) onPermissionModeChange(mode)
                setOpen(false)
              }}
            />
          )
        })}

        {isWork ? (
          <>
            <div className="mx-1 my-1 h-px bg-border/40" />
            <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              子代理委派
            </div>
            <div className="composer-eagerness-seg px-1 pb-0.5">
              {EAGERNESS_ORDER.map((level) => (
                <AppTooltip key={level} label={EAGERNESS_DESCRIPTIONS[level]} side="top" multiline>
                  <button
                    type="button"
                    className={cn(
                      'composer-eagerness-seg__btn',
                      subagentEagerness === level && 'composer-eagerness-seg__btn--active',
                    )}
                    aria-pressed={subagentEagerness === level}
                    onClick={() => onSubagentEagernessChange(level)}
                  >
                    {EAGERNESS_LABELS[level]}
                  </button>
                </AppTooltip>
              ))}
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
