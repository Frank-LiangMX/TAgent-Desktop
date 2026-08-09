/**
 * MoaRoundtableCard — MoA 会诊圆桌卡（挂主时间线，standalone 渲染）。
 *
 * 主进程 runMoaTurn 推 moa_roundtable 事件 → Chat.tsx 按 roundtableId 就地 upsert 本卡。
 * - 头部：会诊预置名 + phase 徽章（会诊中/汇总中/已完成/出错/已取消）
 * - 席位行：参考席 + 汇总席，状态点 + 耗时；点击席位 → 右侧 Sheet 看全文（失败席标失败原因）
 * - CTA：复制（汇总席正文 = 本轮主回答）；建看板（调 kanbanCreateBoard，Chat 模式由主进程网关拦截）
 *
 * 汇总结论作为本轮 assistant 主回答在主时间线单独渲染（流式 sdk_message → MessageView），
 * 本卡只展示席位进度 + 入口；参考席全文不刷满主线（点席位才看）。
 */
import { useState } from 'react'
import { Users, Copy, Check, Plus, Clock } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@tagent/ui'
import { type MoARoundtablePanel, type MoASeatPanel, type MoASeatStatus } from '@tagent/shared'
import { cn } from '../../lib/utils'

interface MoaRoundtableCardProps {
  panel: MoARoundtablePanel
  /** 当前会话 id（建看板 CTA 用；主进程网关据此校验 Work 模式） */
  sessionId?: string
}

const PHASE_META: Record<MoARoundtablePanel['phase'], { text: string; cls: string }> = {
  references: { text: '交卷中', cls: 'bg-primary/10 text-primary' },
  aggregating: { text: '汇总中', cls: 'bg-primary/10 text-primary' },
  done: { text: '已汇总', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  error: { text: '出错', cls: 'bg-destructive/10 text-destructive' },
  cancelled: { text: '已取消', cls: 'bg-muted text-muted-foreground' },
}

const SEAT_STATUS_META: Record<MoASeatStatus, { dot: string; text: string }> = {
  pending: { dot: 'bg-muted-foreground/30', text: '待开始' },
  running: { dot: 'bg-primary/70 animate-pulse', text: '运行中' },
  ok: { dot: 'bg-emerald-500', text: '完成' },
  failed: { dot: 'bg-destructive', text: '失败' },
  cancelled: { dot: 'bg-muted-foreground/40', text: '已取消' },
}

function formatLatency(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function MoaRoundtableCard({ panel, sessionId }: MoaRoundtableCardProps): JSX.Element {
  const [openSeatId, setOpenSeatId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [creatingBoard, setCreatingBoard] = useState(false)
  const aggregator = panel.seats.find((s) => s.role === 'aggregator')
  const aggregatorText = aggregator?.text ?? ''
  const phaseMeta = PHASE_META[panel.phase]
  const referenceSeats = panel.seats.filter((s) => s.role === 'reference')
  const openSeat = panel.seats.find((s) => s.seatId === openSeatId) ?? null
  const isTerminal = panel.phase === 'done' || panel.phase === 'error' || panel.phase === 'cancelled'

  const handleCopy = async (): Promise<void> => {
    if (!aggregatorText) return
    try {
      await navigator.clipboard.writeText(aggregatorText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('复制会诊结论失败:', err)
    }
  }

  const handleCreateBoard = async (): Promise<void> => {
    if (creatingBoard || !sessionId) return
    setCreatingBoard(true)
    try {
      const rootGoal = (aggregatorText || panel.topic).slice(0, 300)
      const res = (await window.electronAPI.kanbanCreateBoard({
        rootGoal,
        sessionId,
        title: `${panel.presetName}·看板`,
      } as Record<string, unknown>)) as { ok: boolean; error?: string; board?: { id: string } }
      if (!res?.ok) {
        alert(res?.error ?? '建看板失败')
      } else {
        alert('已创建看板，可在「团队」Tab 查看')
      }
    } catch (err) {
      alert(`建看板失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCreatingBoard(false)
    }
  }

  return (
    <div
      data-message-id={`moa-${panel.roundtableId}`}
      className="session-glass-popover mx-auto my-2 w-full max-w-[640px] rounded-xl border border-border/60 bg-background/80 p-3 shadow-sm backdrop-blur-md"
    >
      {/* 头部：预置名 + phase 徽章 */}
      <div className="flex items-center gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Users className="size-3.5 text-primary/80" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-foreground">{panel.presetName}</div>
          <div className="truncate text-[10.5px] text-muted-foreground">
            {!isTerminal
              ? `会诊中 · 带本会话上下文 · ${referenceSeats.length} 席参考 · 1 席汇总`
              : `${referenceSeats.length} 席参考 · 1 席汇总`}
          </div>
        </div>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', phaseMeta.cls)}>
          {phaseMeta.text}
        </span>
      </div>

      {/* 席位列表 */}
      <div className="mt-2.5 flex flex-col gap-1">
        {referenceSeats.map((seat) => (
          <SeatRow key={seat.seatId} seat={seat} onOpen={() => setOpenSeatId(seat.seatId)} />
        ))}
        {aggregator && (
          <>
            <div className="my-1 h-px bg-border/40" />
            <SeatRow seat={aggregator} onOpen={() => setOpenSeatId(aggregator.seatId)} emphasize />
          </>
        )}
      </div>

      {/* CTA：复制结论 + 建看板（仅终态且汇总成功时展示） */}
      {isTerminal && aggregatorText ? (
        <div className="mt-2.5 flex items-center gap-2 border-t border-border/40 pt-2">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-foreground/10"
          >
            {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
            {copied ? '已复制' : '复制结论'}
          </button>
          <button
            type="button"
            onClick={() => void handleCreateBoard()}
            disabled={creatingBoard || !sessionId}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-foreground/10 disabled:opacity-50"
          >
            <Plus className="size-3.5" />
            {creatingBoard ? '建看板…' : '建看板'}
          </button>
        </div>
      ) : null}

      {/* 席位详情 Sheet */}
      <Sheet open={openSeat != null} onOpenChange={(o) => { if (!o) setOpenSeatId(null) }}>
        <SheetContent side="right" className="w-[460px] max-w-[90vw] sm:max-w-[460px]">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {openSeat ? (
                <>
                  <span className="truncate">{openSeat.name}</span>
                  <SeatStatusBadge status={openSeat.status} />
                </>
              ) : (
                '席位详情'
              )}
            </SheetTitle>
            <SheetDescription className="text-left">
              {openSeat ? `${openSeat.role === 'aggregator' ? '汇总席' : '参考席'} · ${openSeat.modelId}` : ''}
              {openSeat?.latencyMs ? ` · 耗时 ${formatLatency(openSeat.latencyMs)}` : ''}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-3 max-h-[70vh] overflow-y-auto text-[12.5px] leading-relaxed text-foreground/90">
            {openSeat?.error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-destructive">
                失败原因：{openSeat.error}
              </div>
            ) : openSeat?.text ? (
              <div className="whitespace-pre-wrap break-words">{openSeat.text}</div>
            ) : (
              <div className="text-muted-foreground">该席位暂无正文输出。</div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function SeatRow({
  seat,
  onOpen,
  emphasize = false,
}: {
  seat: MoASeatPanel
  onOpen: () => void
  emphasize?: boolean
}): JSX.Element {
  const meta = SEAT_STATUS_META[seat.status]
  const clickable = seat.status === 'ok' || seat.status === 'failed'
  return (
    <button
      type="button"
      onClick={clickable ? onOpen : undefined}
      disabled={!clickable}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        clickable ? 'hover:bg-foreground/5 cursor-pointer' : 'cursor-default',
        emphasize && 'bg-primary/5',
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} />
      <span className={cn('min-w-0 flex-1 truncate text-[12px]', emphasize ? 'font-medium text-foreground' : 'text-foreground/85')}>
        {seat.name}
      </span>
      <span className="shrink-0 truncate text-[10px] text-muted-foreground">{seat.modelId}</span>
      {seat.latencyMs != null && seat.status !== 'pending' && seat.status !== 'running' ? (
        <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
          <Clock className="size-2.5" />
          {formatLatency(seat.latencyMs)}
        </span>
      ) : null}
      <span className="shrink-0 text-[10px] text-muted-foreground">{meta.text}</span>
    </button>
  )
}

function SeatStatusBadge({ status }: { status: MoASeatStatus }): JSX.Element {
  const meta = SEAT_STATUS_META[status]
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.text}
    </span>
  )
}
