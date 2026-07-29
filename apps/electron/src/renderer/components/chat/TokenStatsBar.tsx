/**
 * TokenStatsBar — 输入框下方统计条（对齐 TAgent_General TokenStatsPanel 布局）
 *
 * - 独立一条 token-stats-bar，不塞进输入 footer 工具行
 * - 左侧：ContextUsageBadge 圆环（占用）
 * - 右侧：本会话累计 input/output、轮数
 * - 仅外部 / Pi 核显示；kscc 整栏不挂
 */
import { Database, TrendingDown, TrendingUp } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ContextUsageBadge, type ContextUsageSnapshotView } from './ContextUsageBadge'

export interface SessionTokenTotals {
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheWrite: number
  turnCount: number
}

interface TokenStatsBarProps {
  usage: ContextUsageSnapshotView | null
  totals: SessionTokenTotals
  isCompacting?: boolean
  onCompact?: () => void
  className?: string
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${tokens}`
}

export function TokenStatsBar({
  usage,
  totals,
  isCompacting,
  onCompact,
  className,
}: TokenStatsBarProps): JSX.Element {
  const hasContext = (usage?.inputTokens ?? 0) > 0 || (usage?.cacheReadTokens ?? 0) > 0
  const hasTotals = totals.totalInput > 0 || totals.totalOutput > 0
  const empty = !hasContext && !hasTotals

  return (
    <div
      className={cn(
        'token-stats-bar flex min-h-[18px] items-center justify-end gap-2.5 px-1 py-0.5',
        'text-[10px] leading-none text-muted-foreground/60',
        empty && 'opacity-40',
        className,
      )}
      aria-label="Token 与上下文占用"
    >
      {/* 左侧：占用圆环（有 usage 才出；无数据时仍占位保持栏高） */}
      {hasContext && usage ? (
        <>
          <ContextUsageBadge
            usage={usage}
            isCompacting={isCompacting}
            onCompact={onCompact}
          />
          {hasTotals && <div className="h-2.5 w-px shrink-0 bg-border/40" />}
        </>
      ) : (
        <span className="text-[10px] text-muted-foreground/40">
          {empty ? '发送消息后显示占用' : null}
        </span>
      )}

      {hasTotals && (
        <>
          <StatItem
            icon={<TrendingDown size={10} />}
            label="输入"
            value={formatTokens(totals.totalInput)}
          />
          <StatItem
            icon={<TrendingUp size={10} />}
            label="输出"
            value={formatTokens(totals.totalOutput)}
          />
          {(totals.totalCacheRead > 0 || totals.totalCacheWrite > 0) && (
            <>
              <div className="h-2.5 w-px shrink-0 bg-border/40" />
              <StatItem
                icon={<Database size={10} />}
                label="缓存读"
                value={formatTokens(totals.totalCacheRead)}
              />
            </>
          )}
          {totals.turnCount > 0 && (
            <>
              <div className="h-2.5 w-px shrink-0 bg-border/40" />
              <span className="tabular-nums text-muted-foreground/70">{totals.turnCount} 轮</span>
            </>
          )}
        </>
      )}
    </div>
  )
}

function StatItem({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}): JSX.Element {
  return (
    <div className="flex items-center gap-1 whitespace-nowrap">
      <span className="opacity-70">{icon}</span>
      <span className="text-muted-foreground/70">{label}</span>
      <span className="font-medium tabular-nums text-muted-foreground">{value}</span>
    </div>
  )
}
