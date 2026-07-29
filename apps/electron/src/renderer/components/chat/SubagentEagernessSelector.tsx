/**
 * SubagentEagernessSelector — 输入框尾部子代理委派积极性选择 Popover pill
 *
 * 四档：从不 / 保守 / 均衡 / 激进（subagentEagerness，per-session 持久化）。
 * 会话级持久化（meta.subagentEagerness），下次发送时主进程注入 kscc systemPrompt append 生效。
 * 形态对齐 PermissionModeSelector（图标 + 当前档位名 + ChevronDown + 下拉单选）。
 */
import { AppTooltip, Popover, PopoverTrigger, PopoverContent } from '@tagent/ui'
import {
  Prohibit,
  ShieldCheck,
  Scales,
  Lightning,
  CaretDown,
  Check,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import type { SubagentEagerness } from '@tagent/shared'
import {
  SUBAGENT_EAGERNESS_CONFIG,
  SUBAGENT_EAGERNESS_ORDER,
} from './subagent-ui-model'

interface SubagentEagernessSelectorProps {
  /** 当前会话的委派积极性（无则默认 conservative） */
  eagerness: SubagentEagerness
  /** 切换档位（持久化，下次发送生效） */
  onChange: (eagerness: SubagentEagerness) => void
}

const ICONS: Record<SubagentEagerness, typeof ShieldCheck> = {
  never: Prohibit,
  conservative: ShieldCheck,
  balanced: Scales,
  aggressive: Lightning,
}

export function SubagentEagernessSelector({
  eagerness,
  onChange,
}: SubagentEagernessSelectorProps): JSX.Element {
  const current = SUBAGENT_EAGERNESS_CONFIG[eagerness]
  const Icon = ICONS[eagerness] ?? ShieldCheck

  return (
    <Popover>
      <AppTooltip label={`子代理委派：${current.description}`} side="top" multiline>
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
              子代理·{current.label}
            </span>
            <CaretDown className="size-3 opacity-70" weight="regular" />
          </button>
        </PopoverTrigger>
      </AppTooltip>

      <PopoverContent align="end" className="w-64 p-2">
        <div className="space-y-0.5">
          {SUBAGENT_EAGERNESS_ORDER.map((level) => {
            const cfg = SUBAGENT_EAGERNESS_CONFIG[level]
            const LIcon = ICONS[level]
            return (
              <button
                key={level}
                onClick={() => onChange(level)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-glass-popover px-2 py-1.5 text-left text-xs transition-colors',
                  'hover:bg-accent',
                )}
              >
                <LIcon className="size-3.5 shrink-0 text-muted-foreground" weight="regular" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{cfg.label}</div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {cfg.description}
                  </div>
                </div>
                {level === eagerness && (
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
