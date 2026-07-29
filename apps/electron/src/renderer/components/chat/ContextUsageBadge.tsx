/**
 * ContextUsageBadge — 输入框底部上下文占用指示（仅外部 / Pi 核）
 *
 * TAgent 自研 UI：圆环百分比 + hover 详情面板。
 * 数据：流式 result / assistant.usage（input + cache_read + cache_write）/ contextWindow。
 * 不做 Claude SDK getContextUsage 分项；Pi 无同等 API。
 * kscc 渠道不渲染（占用不可信）。
 */
import { useMemo, useState } from 'react'
import {
  calculateContextUsageRatio,
  sumContextUsedTokens,
  getCompactBoundaryLabel,
} from '@tagent/shared'

/** 与 packages/pi-core 自动压缩阈值一致（展示用，不跨包引用 pi-core） */
const AUTO_COMPACT_THRESHOLD_RATIO = 0.8
import { Popover, PopoverContent, PopoverTrigger, Button } from '@tagent/ui'
import { Shrink } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface ContextUsageSnapshotView {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  contextWindow: number
}

interface ContextUsageBadgeProps {
  usage: ContextUsageSnapshotView | null
  /** 是否正在压缩 */
  isCompacting?: boolean
  onCompact?: () => void
  className?: string
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

function ringColor(ratio: number): string {
  if (ratio >= 0.9) return 'stroke-destructive'
  if (ratio >= 0.8) return 'stroke-amber-500'
  return 'stroke-primary'
}

export function ContextUsageBadge({
  usage,
  isCompacting,
  onCompact,
  className,
}: ContextUsageBadgeProps): JSX.Element | null {
  const [open, setOpen] = useState(false)

  const stats = useMemo(() => {
    if (!usage || usage.inputTokens <= 0 || usage.contextWindow <= 0) return null
    // 主进程已把「当前上下文占用」写入 inputTokens（含 totalTokens 优先）；
    // 环用 max(input, input+cache) 避免双计，也兼容只回 cache 的端点。
    const summed = sumContextUsedTokens({
      input_tokens: usage.inputTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: usage.cacheCreationTokens,
    })
    const used = Math.max(usage.inputTokens, summed)
    const ratio = calculateContextUsageRatio(used, usage.contextWindow) ?? 0
    const percent = Math.min(100, Math.round(ratio * 100))
    return { used, ratio, percent, window: usage.contextWindow }
  }, [usage])

  if (!stats) return null

  // 比初版再小一点，贴近 General 底栏 11–12px 环
  const size = 12
  const stroke = 1.75
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const dash = c * Math.min(1, stats.ratio)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'token-stats-ring inline-flex items-center gap-1 rounded-full px-0.5 py-0',
            'text-[9px] leading-none text-muted-foreground',
            'hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
            stats.ratio >= 0.9 && 'text-destructive',
            stats.ratio >= 0.8 && stats.ratio < 0.9 && 'text-amber-600 dark:text-amber-400',
            className,
          )}
          title="Context 占用（外部渠道 / Pi）"
          aria-label={`上下文占用 ${stats.percent}%`}
        >
          <svg width={size} height={size} className="-rotate-90 shrink-0" aria-hidden>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              className="stroke-muted-foreground/20"
              strokeWidth={stroke}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              className={cn(ringColor(stats.ratio), isCompacting && 'animate-pulse')}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeLinecap="round"
            />
          </svg>
          <span className="tabular-nums font-medium">{stats.percent}%</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-[280px] overflow-hidden p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b border-border/60 px-3 py-2.5">
          <div className="text-[12px] font-medium">Context 占用</div>
          <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
            基于最近一轮 API usage（input + cache）。Pi 无 Claude SDK 级分项明细。
          </p>
        </div>

        <div className="space-y-2.5 px-3 py-3">
          <div className="flex items-end justify-between gap-2">
            <div>
              <div className="text-[20px] font-semibold tabular-nums leading-none">
                {stats.percent}%
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                {formatTokens(stats.used)} / {formatTokens(stats.window)}
              </div>
            </div>
            <div
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                stats.ratio >= 0.9
                  ? 'bg-destructive/15 text-destructive'
                  : stats.ratio >= 0.8
                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                    : 'bg-primary/10 text-primary',
              )}
            >
              {stats.ratio >= 0.9 ? '危险' : stats.ratio >= 0.8 ? '接近上限' : '正常'}
            </div>
          </div>

          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                stats.ratio >= 0.9
                  ? 'bg-destructive'
                  : stats.ratio >= 0.8
                    ? 'bg-amber-500'
                    : 'bg-primary',
              )}
              style={{ width: `${Math.min(100, stats.percent)}%` }}
            />
          </div>

          <dl className="space-y-1 text-[11px]">
            <Row label="Input" value={formatTokens(usage!.inputTokens)} />
            {usage?.cacheReadTokens != null && usage.cacheReadTokens > 0 && (
              <Row label="Cache read" value={formatTokens(usage.cacheReadTokens)} />
            )}
            {usage?.cacheCreationTokens != null && usage.cacheCreationTokens > 0 && (
              <Row label="Cache write" value={formatTokens(usage.cacheCreationTokens)} />
            )}
            {usage?.outputTokens != null && usage.outputTokens > 0 && (
              <Row label="Output（本轮）" value={formatTokens(usage.outputTokens)} />
            )}
            <Row
              label="自动压缩阈值"
              value={`${Math.round(AUTO_COMPACT_THRESHOLD_RATIO * 100)}%`}
            />
          </dl>

          {isCompacting && (
            <p className="text-[11px] text-muted-foreground">
              {getCompactBoundaryLabel({ trigger: 'auto' }).replace('已', '正在')}…
            </p>
          )}
        </div>

        {onCompact && (
          <div className="border-t border-border/60 px-3 py-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-full gap-1.5 text-[12px]"
              onClick={() => {
                setOpen(false)
                onCompact()
              }}
            >
              <Shrink className="size-3.5" />
              手动压缩上下文
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums font-medium text-foreground">{value}</dd>
    </div>
  )
}
