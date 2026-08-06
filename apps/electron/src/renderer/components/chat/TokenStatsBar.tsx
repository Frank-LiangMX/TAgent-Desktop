/**
 * TokenStatsBar — 输入框下方统计条（对齐 TAgent_General TokenStatsPanel 布局）
 *
 * - 独立一条 token-stats-bar，不塞进输入 footer 工具行
 * - 左侧：ContextUsageBadge 圆环（占用）
 * - 右侧：本会话累计 input/output、轮数
 * - 全部已绑定渠道显示；kscc 渠道隐藏占用圆环（占用不可信），累计统计仍显示
 */
import { Database, TrendingDown, TrendingUp } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ContextUsageBadge, type ContextUsageSnapshotView } from './ContextUsageBadge'
import { ChannelBalanceBadge } from './ChannelBalanceBadge'

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
  /** 当前会话绑定的渠道 ID（用于左侧余额徽章） */
  channelId?: string
  isCompacting?: boolean
  onCompact?: () => void
  /** 隐藏上下文占用圆环（kscc 渠道占用不可信），累计统计仍显示 */
  hideContext?: boolean
  /** 窄宽：仅圆环 + 关键数字，隐藏中文标签与缓存细项 */
  compact?: boolean
  className?: string
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${tokens}`
}

/** 缓存命中率：缓存读 token 占全部输入（含缓存命中）的比例，保证 ≤100% */
function calcCacheHitRate(totals: SessionTokenTotals): number | null {
  // usage.inputTokens 不含 cacheRead（Anthropic 口径分离），分母必须加回缓存读，
  // 否则多轮会话命中率会 >100%（如旧会话 8381%）。
  const denominator = totals.totalInput + totals.totalCacheRead
  if (denominator <= 0) return null
  return totals.totalCacheRead / denominator
}

function formatHitRate(rate: number | null): string {
  if (rate === null) return '—'
  return `${Math.round(rate * 100)}%`
}

export function TokenStatsBar({
  usage,
  totals,
  channelId,
  isCompacting,
  onCompact,
  hideContext = false,
  compact = false,
  className,
}: TokenStatsBarProps): JSX.Element {
  const hasContext = (usage?.inputTokens ?? 0) > 0 || (usage?.cacheReadTokens ?? 0) > 0
  const hasTotals = totals.totalInput > 0 || totals.totalOutput > 0
  const empty = !hasContext && !hasTotals
  const cacheHitRate = calcCacheHitRate(totals)
  // hideContext（kscc）：占用不可信，圆环与占位文案一并隐藏，仅保留累计统计
  const showContext = !hideContext && hasContext && usage !== null

  return (
    <div
      className={cn(
        'token-stats-bar',
        empty && 'token-stats-bar--empty',
        compact && 'token-stats-bar--compact',
        className,
      )}
      aria-label="Token 与上下文占用"
    >
      {/* 窄宽隐藏余额徽章（最占横向） */}
      {!compact ? <ChannelBalanceBadge channelId={channelId} className="mr-auto" /> : null}

      {showContext ? (
        <>
          <ContextUsageBadge
            usage={usage}
            isCompacting={isCompacting}
            onCompact={onCompact}
          />
          {hasTotals && <div className="token-stats-bar__sep h-2.5 w-px shrink-0 bg-border/40" />}
        </>
      ) : (
        !hideContext &&
        !compact && (
          <span className="text-[10px] text-muted-foreground/40">
            {empty ? '发送消息后显示占用' : null}
          </span>
        )
      )}

      {hasTotals && (
        <>
          <StatItem
            icon={<TrendingDown size={10} />}
            label="输入"
            value={formatTokens(totals.totalInput)}
            compact={compact}
          />
          <StatItem
            icon={<TrendingUp size={10} />}
            label="输出"
            value={formatTokens(totals.totalOutput)}
            compact={compact}
          />
          {!compact && (totals.totalCacheRead > 0 || totals.totalCacheWrite > 0) && (
            <>
              <div className="h-2.5 w-px shrink-0 bg-border/40" />
              <StatItem
                icon={<Database size={10} />}
                label="缓存"
                value={formatHitRate(cacheHitRate)}
              />
            </>
          )}
          {totals.turnCount > 0 && (
            <>
              <div className="token-stats-bar__sep h-2.5 w-px shrink-0 bg-border/40" />
              <span className="tabular-nums text-muted-foreground/70 whitespace-nowrap">
                {totals.turnCount}
                {compact ? '' : ' 轮'}
              </span>
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
  compact,
}: {
  icon: React.ReactNode
  label: string
  value: string
  compact?: boolean
}): JSX.Element {
  return (
    <div
      className="token-stats-item flex items-center gap-1 whitespace-nowrap"
      title={compact ? `${label} ${value}` : undefined}
    >
      <span className="opacity-70">{icon}</span>
      {!compact ? <span className="token-stats-item__label text-muted-foreground/70">{label}</span> : null}
      <span className="font-medium tabular-nums text-muted-foreground">{value}</span>
    </div>
  )
}
