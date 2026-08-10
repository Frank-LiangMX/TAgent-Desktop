/**
 * MoaDiscussionCard — 圆桌讨论入口卡（挂主时间线，standalone 渲染）。
 *
 * 主进程 runMoaDiscussion 推 moa_discussion 事件 → Chat.tsx 按 discussionId
 * 就地 upsert 本卡（同场多张状态卡只保留最新）。点击进入全屏讨论室
 * （MoaDiscussionRoom），覆盖整个 Chat 区域，顶部返回。
 *
 * 设计依据：docs/plans/multi-runtime/10-session-agent-behavior-orchestration.md
 * §5.2 / §7.1 —— 主时间线只放入口卡，讨论内容进全屏讨论室。
 *
 * 与 MoaRoundtableCard 的差别：会诊是单轮汇总（席位独立交卷），
 * 圆桌讨论是多轮互见（最后由总结人收口）；本卡只摘要最近一条发言 +
 * phase + 轮次，详细发言回放留到讨论室。
 */
import { memo, useMemo } from 'react'
import { ChatsCircle, ArrowRight } from '@phosphor-icons/react'
import { AppTooltip } from '@tagent/ui'
import type { MoADiscussionPanel, MoADiscussionPhase, MoADiscussionSpeaker } from '@tagent/shared'
import { cn } from '../../lib/utils'

interface MoaDiscussionCardProps {
  panel: MoADiscussionPanel
  /** 点击进入全屏讨论室 */
  onOpen: () => void
}

const PHASE_META: Record<MoADiscussionPhase, { text: string; cls: string }> = {
  discussing: { text: '讨论中', cls: 'bg-primary/10 text-primary' },
  finalizing: { text: '收口中', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  done: { text: '已完成', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  error: { text: '出错', cls: 'bg-destructive/10 text-destructive' },
  cancelled: { text: '已取消', cls: 'bg-muted text-muted-foreground' },
}

/** 角色显示文案 */
function roleLabel(role: MoADiscussionSpeaker['role']): string {
  if (role === 'user') return '你'
  if (role === 'moderator') return '总结人'
  return ''
}

function truncate(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= max) return t
  return `${t.slice(0, max)}…`
}

export function MoaDiscussionCard({ panel, onOpen }: MoaDiscussionCardProps): JSX.Element {
  const phaseMeta = PHASE_META[panel.phase]
  const isTerminal = panel.phase === 'done' || panel.phase === 'error' || panel.phase === 'cancelled'
  const isFinalizing = panel.phase === 'finalizing'

  // 参与席数（剔除 user/moderator 固定席），用于副标题
  const participantCount = useMemo(
    () => panel.speakers.filter((s) => s.role === 'participant').length,
    [panel.speakers],
  )

  // 最近一条发言（按 createdAt/entryId 顺序取末条）
  const latestEntry = panel.entries.length > 0 ? panel.entries[panel.entries.length - 1] : null
  const latestSpeaker = latestEntry
    ? panel.speakers.find((s) => s.speakerId === latestEntry.speakerId) ?? null
    : null
  const latestName = latestSpeaker ? latestSpeaker.name : '（暂无）'
  const latestRole = latestSpeaker ? roleLabel(latestSpeaker.role) : ''
  const latestText = latestEntry ? truncate(latestEntry.text, 80) : ''

  // done 摘要：取前 160 字（不包含总结人全文，全屏看）
  const summaryPreview = panel.summary ? truncate(panel.summary, 160) : ''

  return (
    <AppTooltip label={isTerminal ? '查看完整讨论与共识方案' : '进入全屏讨论室'}>
      <button
        type="button"
        data-message-id={`disc-${panel.discussionId}`}
        onClick={onOpen}
        className={cn(
          'session-glass-popover mx-auto my-2 block w-full max-w-[640px] rounded-xl border border-border/60 bg-background/80 p-3 text-left shadow-sm backdrop-blur-md transition-colors',
          'hover:bg-background/90',
          !isTerminal && 'is-running',
        )}
      >
        {/* 头部：圆桌讨论 + presetName + phase 徽章 */}
        <div className="flex items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <ChatsCircle className="size-3.5 text-primary/80" weight="duotone" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10.5px] font-medium uppercase tracking-wide text-primary/70">
                圆桌
              </span>
              <span className="truncate text-[12px] font-medium text-foreground">
                {panel.presetName}
              </span>
            </div>
            <div className="truncate text-[10.5px] text-muted-foreground">
              {!isTerminal
                ? `讨论中 · 第 ${panel.currentRound}/${panel.roundLimit} 轮 · ${participantCount} 席`
                : `${participantCount} 席 · ${panel.entries.length} 条发言`}
            </div>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', phaseMeta.cls)}>
            {phaseMeta.text}
          </span>
        </div>

        {/* 中段：最近一条发言 / 收口摘要 */}
        <div className="mt-2.5">
          {isFinalizing ? (
            <div className="text-[12px] leading-relaxed text-muted-foreground">
              总结人正在收口成共识方案…
            </div>
          ) : panel.phase === 'done' && summaryPreview ? (
            <div className="flex flex-col gap-1">
              <div className="text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                共识方案
              </div>
              <div className="text-[12px] leading-relaxed text-foreground/85">
                {summaryPreview}
              </div>
            </div>
          ) : latestEntry ? (
            <div className="flex flex-col gap-1">
              <div className="text-[10.5px] text-muted-foreground">
                <span className="font-medium text-foreground/80">{latestName}</span>
                {latestRole ? `（${latestRole}）` : ''} 正在发言：
              </div>
              <div className="text-[12px] leading-relaxed text-foreground/85">
                {latestText}
              </div>
            </div>
          ) : (
            <div className="text-[12px] leading-relaxed text-muted-foreground">
              圆桌即将开场…
            </div>
          )}
        </div>

        {/* 底部 CTA：进入全屏讨论室（done 时文案强调「查看完整讨论」） */}
        <div className="mt-2.5 flex items-center justify-between border-t border-border/40 pt-2">
          <span className="text-[10.5px] text-muted-foreground">
            {panel.phase === 'done' ? '点击查看完整讨论' : isTerminal ? '查看完整讨论' : '进入全屏讨论室'}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground/80">
            {panel.phase === 'done' ? '查看完整讨论' : '进入讨论室'}
            <ArrowRight size={11} weight="bold" />
          </span>
        </div>
      </button>
    </AppTooltip>
  )
}

export const MemoMoaDiscussionCard = memo(MoaDiscussionCard)