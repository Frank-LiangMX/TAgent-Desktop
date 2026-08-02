/**
 * Chat | Work — 输入区紧凑文本切换（非大号分段 Tab）
 *
 * @see docs/plans/multi-runtime/02-chat-work-and-permissions.md
 * @see docs/decisions/ADR-0005-user-owned-mode-switch.md
 */
import { AppTooltip } from '@tagent/ui'
import type { ExecutionMode } from '@tagent/shared'
import { EXECUTION_MODE_CONFIG, EXECUTION_MODES } from '@tagent/shared'
import { cn } from '../../lib/utils'

export interface ExecutionModeToggleProps {
  value: ExecutionMode
  onChange: (mode: ExecutionMode) => void
  disabled?: boolean
  className?: string
}

export function ExecutionModeToggle({
  value,
  onChange,
  disabled,
  className,
}: ExecutionModeToggleProps): JSX.Element {
  return (
    <div
      className={cn('execution-mode-switch', className)}
      role="radiogroup"
      aria-label="协作形态"
    >
      {EXECUTION_MODES.map((mode, i) => {
        const cfg = EXECUTION_MODE_CONFIG[mode]
        const selected = value === mode
        return (
          <span key={mode} className="execution-mode-switch__item">
            {i > 0 ? <span className="execution-mode-switch__sep" aria-hidden /> : null}
            <AppTooltip label={cfg.description} side="top" multiline>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                className={cn(
                  'execution-mode-switch__btn',
                  selected && 'execution-mode-switch__btn--active',
                  selected && mode === 'chat' && 'execution-mode-switch__btn--chat',
                  selected && mode === 'work' && 'execution-mode-switch__btn--work',
                )}
                onClick={() => {
                  if (!selected) onChange(mode)
                }}
              >
                {cfg.label}
              </button>
            </AppTooltip>
          </span>
        )
      })}
    </div>
  )
}
