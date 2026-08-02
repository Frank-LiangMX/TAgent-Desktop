/**
 * 用户消息 → 快速填入输入框（不自动发送，便于改写后重发）
 */
import { ArrowBendUpLeft } from '@phosphor-icons/react'
import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'

export function MessageRefillButton({
  text,
  onRefill,
  className,
}: {
  text: string
  onRefill: (text: string) => void
  className?: string
}): JSX.Element | null {
  const plain = text.trim()
  if (!plain) return null

  return (
    <AppTooltip label="填入输入框" side="top">
      <button
        type="button"
        className={cn('msg-icon-btn', className)}
        onClick={() => onRefill(plain)}
        aria-label="填入输入框"
      >
        <ArrowBendUpLeft className="size-3.5 shrink-0" weight="bold" />
      </button>
    </AppTooltip>
  )
}
