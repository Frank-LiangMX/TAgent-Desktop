/**
 * ChannelBalanceBadge — 会话 token 栏左侧的渠道余额徽章
 *
 * 展示当前渠道账户余额（如「¥110.00」），左对齐排在占用圆环之前。
 * 仅支持的供应商（目前 DeepSeek）且有余额数据时渲染；失败静默隐藏。
 */
import { useEffect, useState } from 'react'
import { Wallet } from 'lucide-react'
import type { ChannelBalanceResult } from '@tagent/shared'
import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'
import { fetchChannelBalance } from '../../atoms/channel-balance'

interface ChannelBalanceBadgeProps {
  /** 当前会话绑定的渠道 ID（空串/undefined 不查询） */
  channelId?: string
  className?: string
}

export function ChannelBalanceBadge({
  channelId,
  className,
}: ChannelBalanceBadgeProps): JSX.Element | null {
  const [result, setResult] = useState<ChannelBalanceResult | null>(null)

  useEffect(() => {
    let cancelled = false
    setResult(null)
    if (!channelId) return
    void fetchChannelBalance(channelId).then((value) => {
      if (!cancelled) setResult(value)
    })
    return () => {
      cancelled = true
    }
  }, [channelId])

  const balanceLabel = result?.supported ? result.balanceLabel : undefined
  if (!channelId || !balanceLabel) return null

  const tooltip = result?.message ?? `${result?.label ?? '余额'} ${balanceLabel}`

  return (
    <AppTooltip label={tooltip} side="top" sideOffset={4}>
      <span
        className={cn(
          'flex items-center gap-1 whitespace-nowrap tabular-nums text-muted-foreground/70',
          className,
        )}
      >
        <Wallet size={9} className="shrink-0 opacity-70" aria-hidden="true" />
        {balanceLabel}
      </span>
    </AppTooltip>
  )
}
