/**
 * ConciseTimelineView — Cursor 式简洁时间线
 *
 * 最外层「运行了 Xm」容器：
 *   - 展开 → 思考 + 执行链（含进度短总结）
 *   - 折叠 → 只留 final output（仍保留「运行了」开关以便再展开）
 * 阶段块 live：摘要累积 + 底部当前动作
 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { CaretRight, Check, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import { Message, MessageContent, MessageResponse, useSmoothStream } from '@tagent/ui'
import { cn } from '../../lib/utils'
import { formatElapsedDuration, useLiveElapsedMs } from '../../lib/time-utils'
import type { ConciseSegment, WorkStageStep } from './concise-timeline-model'
import {
  getLiveStatusFromSteps,
  getWorkStepLabel,
} from './concise-timeline-model'
import { formatThinkingSummary } from './session-turn-model'

interface ConciseTimelineViewProps {
  segments: ConciseSegment[]
  isLive?: boolean
  /** 最新一轮：运行链默认展开；历史轮折叠 */
  isLatestTurn?: boolean
  /** 本轮已运行毫秒（live 用实时；完成后用 completedDuration） */
  workedMs?: number
}

export function ConciseTimelineView({
  segments,
  isLive = false,
  isLatestTurn = false,
  workedMs = 0,
}: ConciseTimelineViewProps): JSX.Element | null {
  if (segments.length === 0) return null

  const processSegs = segments.filter(
    (s) => !(s.kind === 'narrative' && s.tone === 'final'),
  )
  const finalSegs = segments.filter(
    (s): s is Extract<ConciseSegment, { kind: 'narrative' }> =>
      s.kind === 'narrative' && s.tone === 'final',
  )

  const lastNarrativeKey = (() => {
    for (let i = finalSegs.length - 1; i >= 0; i--) {
      return finalSegs[i]!.key
    }
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i]!.kind === 'narrative') return segments[i]!.key
    }
    return null
  })()

  return (
    <div className="agent-concise-timeline">
      {processSegs.length > 0 ? (
        <RunQueueShell
          workedMs={workedMs}
          isLive={isLive}
          defaultExpanded={isLatestTurn || isLive}
        >
          {processSegs.map((seg) => {
            if (seg.kind === 'thinking') {
              return (
                <ThinkingFold
                  key={seg.key}
                  thinking={seg.thinking}
                  durationSec={seg.durationSec}
                  isLive={isLive && isLastOfKind(processSegs, seg.key, 'thinking')}
                />
              )
            }
            if (seg.kind === 'work_stage') {
              const stageLive = isLive && seg.tools.some((t) => !t.result)
              return (
                <WorkStageFold
                  key={seg.key}
                  summary={seg.summary}
                  diffAdd={seg.diffAdd}
                  diffDel={seg.diffDel}
                  steps={seg.steps}
                  isLive={stageLive}
                />
              )
            }
            return (
              <NarrativeRow
                key={seg.key}
                text={seg.text}
                tone={seg.tone}
                isStreaming={isLive && seg.key === lastNarrativeKey}
              />
            )
          })}
        </RunQueueShell>
      ) : null}

      {finalSegs.map((seg) => (
        <NarrativeRow
          key={seg.key}
          text={seg.text}
          tone="final"
          isStreaming={isLive && seg.key === lastNarrativeKey}
        />
      ))}
    </div>
  )
}

/** 最外层运行容器：对齐 Cursor「Worked for Xm」 */
const RunQueueShell = memo(function RunQueueShell({
  workedMs,
  isLive,
  defaultExpanded,
  children,
}: {
  workedMs: number
  isLive: boolean
  /** 最新轮默认展开；被新消息挤成历史后折叠 */
  defaultExpanded: boolean
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultExpanded)
  const wasExpandedDefault = useRef(defaultExpanded)

  useEffect(() => {
    // 成为最新轮 / live → 展开；沦为历史 → 折叠
    if (defaultExpanded && !wasExpandedDefault.current) setOpen(true)
    if (!defaultExpanded && wasExpandedDefault.current) setOpen(false)
    wasExpandedDefault.current = defaultExpanded
  }, [defaultExpanded])

  // live 时强制保持展开（跑着不应被手动叠住看不见）
  useEffect(() => {
    if (isLive) setOpen(true)
  }, [isLive])

  const dur = formatElapsedDuration(Math.max(0, workedMs))
  const label = isLive ? `运行中 ${dur}` : `运行了 ${dur}`

  return (
    <div className={cn('agent-concise-run', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-concise-run__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="agent-concise-run__label">{label}</span>
        <CaretRight
          size={12}
          className={cn(
            'shrink-0 text-muted-foreground/40 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      {open ? <div className="agent-concise-run__body">{children}</div> : null}
    </div>
  )
})
function isLastOfKind(
  segments: ConciseSegment[],
  key: string,
  kind: ConciseSegment['kind'],
): boolean {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]!.kind === kind) return segments[i]!.key === key
  }
  return false
}

const ThinkingFold = memo(function ThinkingFold({
  thinking,
  durationSec,
  isLive,
}: {
  thinking: string
  durationSec?: number
  isLive: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const startRef = useRef<number | null>(null)
  if (isLive && startRef.current == null) startRef.current = Date.now()
  const elapsedMs = useLiveElapsedMs(startRef.current ?? undefined, isLive)
  const { displayedContent } = useSmoothStream({
    content: thinking,
    isStreaming: isLive,
  })
  const summary = formatThinkingSummary(durationSec, {
    live: isLive,
    liveElapsedSec: Math.floor(elapsedMs / 1000),
  })

  return (
    <div className={cn('agent-concise-fold', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-concise-fold__head"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-concise-fold__summary">{summary}</span>
        <CaretRight
          size={11}
          className={cn(
            'shrink-0 text-muted-foreground/35 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      {open ? (
        <div className="agent-concise-fold__body">
          <MessageResponse
            className="text-[12.5px] leading-[1.6] text-muted-foreground/85"
            streaming={isLive}
          >
            {displayedContent.trim() || (isLive ? '…' : '')}
          </MessageResponse>
        </div>
      ) : null}
    </div>
  )
})

const DiffHint = memo(function DiffHint({
  add,
  del,
}: {
  add?: number
  del?: number
}): JSX.Element | null {
  if (add == null && del == null) return null
  return (
    <span className="agent-concise-diff">
      {add != null && add > 0 ? <span className="agent-concise-diff__add">+{add}</span> : null}
      {del != null && del > 0 ? <span className="agent-concise-diff__del">-{del}</span> : null}
    </span>
  )
})

const WorkStageFold = memo(function WorkStageFold({
  summary,
  diffAdd,
  diffDel,
  steps,
  isLive,
}: {
  summary: string
  diffAdd?: number
  diffDel?: number
  steps: WorkStageStep[]
  isLive: boolean
}): JSX.Element {
  // live：默认展开看执行明细；完成后自动收进阶段块（可手动再开）
  const [open, setOpen] = useState(isLive)
  const wasLive = useRef(isLive)
  const liveStatus = isLive ? getLiveStatusFromSteps(steps) : undefined

  useEffect(() => {
    if (isLive) setOpen(true)
    else if (wasLive.current && !isLive) setOpen(false)
    wasLive.current = isLive
  }, [isLive])

  const detailOpen = open || isLive

  return (
    <div className={cn('agent-concise-fold', 'agent-concise-stage', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-concise-fold__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={detailOpen}
      >
        {isLive ? (
          <CircleNotch size={12} className="shrink-0 animate-spin text-muted-foreground/45" />
        ) : (
          <Check size={12} weight="bold" className="shrink-0 text-muted-foreground/35" />
        )}
        <span className="agent-concise-fold__summary">
          {summary}
          <DiffHint add={diffAdd} del={diffDel} />
        </span>
        <CaretRight
          size={11}
          className={cn(
            'ml-auto shrink-0 text-muted-foreground/35 transition-transform',
            detailOpen && 'rotate-90',
          )}
        />
      </button>

      {/* live 且折叠态：仍露出当前动作一行 */}
      {isLive && !open ? (
        <div className="agent-concise-live-status">{liveStatus}</div>
      ) : null}

      <div
        className={cn('agent-concise-stage__panel', detailOpen && 'is-open')}
        aria-hidden={!detailOpen}
      >
        <div className="agent-concise-stage__panel-inner">
          <div className="agent-concise-fold__body agent-concise-fold__body--steps">
            {steps.map((step) => (
              <StageStepRow
                key={step.key}
                step={step}
                isStreaming={isLive && step.kind === 'tool' && !step.tool.result}
              />
            ))}
            {isLive && liveStatus ? (
              <div className="agent-concise-live-status agent-concise-live-status--in-body">
                {liveStatus}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
})

const StageStepRow = memo(function StageStepRow({
  step,
  isStreaming,
}: {
  step: WorkStageStep
  isStreaming: boolean
}): JSX.Element {
  const [detailOpen, setDetailOpen] = useState(false)
  const startRef = useRef<number | null>(null)
  const thinkingLive = step.kind === 'thinking' && isStreaming
  if (thinkingLive && startRef.current == null) startRef.current = Date.now()
  // tool pending 也算 streaming；思考行用 live 计时
  const elapsedMs = useLiveElapsedMs(
    step.kind === 'thinking' ? (startRef.current ?? undefined) : undefined,
    thinkingLive,
  )
  const label = getWorkStepLabel(step, {
    pending: isStreaming,
    liveElapsedSec: Math.floor(elapsedMs / 1000),
  })
  const isError = step.kind === 'tool' && Boolean(step.tool.result?.isError)
  const hasDetail =
    step.kind === 'thinking'
      ? Boolean(step.thinking.trim())
      : Boolean(step.tool.result?.content) || Boolean(step.diff)

  return (
    <div className={cn('agent-concise-step', isStreaming && 'is-active')}>
      <button
        type="button"
        className="agent-concise-step__head"
        onClick={() => hasDetail && setDetailOpen((v) => !v)}
        disabled={!hasDetail}
      >
        <span className="agent-concise-step__icon" aria-hidden>
          {isStreaming ? (
            <CircleNotch size={12} className="animate-spin text-muted-foreground/50" />
          ) : isError ? (
            <WarningCircle size={12} weight="fill" className="text-destructive/70" />
          ) : (
            <Check size={12} weight="bold" className="text-muted-foreground/40" />
          )}
        </span>
        <span className="agent-concise-step__label">{label}</span>
        {step.kind === 'tool' && step.diff ? (
          <DiffHint add={step.diff.add} del={step.diff.del} />
        ) : null}
        {hasDetail ? (
          <CaretRight
            size={10}
            className={cn(
              'ml-auto shrink-0 text-muted-foreground/30 transition-transform',
              detailOpen && 'rotate-90',
            )}
          />
        ) : null}
      </button>
      {detailOpen && step.kind === 'thinking' ? (
        <div className="agent-concise-step__detail">
          <MessageResponse className="text-[12.5px] leading-[1.6] text-muted-foreground/85">
            {step.thinking.trim()}
          </MessageResponse>
        </div>
      ) : null}
      {detailOpen && step.kind === 'tool' ? (
        <div className="agent-concise-step__detail">
          <pre className="agent-concise-step__pre">
            {typeof step.tool.result?.content === 'string'
              ? step.tool.result.content.slice(0, 1200)
              : JSON.stringify(step.tool.result?.content, null, 2)?.slice(0, 1200)}
          </pre>
        </div>
      ) : null}
    </div>
  )
})

const NarrativeRow = memo(function NarrativeRow({
  text,
  tone,
  isStreaming,
}: {
  text: string
  tone: 'progress' | 'final'
  isStreaming: boolean
}): JSX.Element {
  // kscc 常一次落盘：首次非流式出现时先喂空串再喂全文，让 useSmoothStream 走逐字
  const [boot, setBoot] = useState(!isStreaming && text.trim().length > 0)
  const [seed, setSeed] = useState(() => (isStreaming || !text.trim() ? text : ''))

  useEffect(() => {
    if (isStreaming) {
      setBoot(false)
      setSeed(text)
      return
    }
    if (boot) {
      const id = requestAnimationFrame(() => {
        setSeed(text)
        setBoot(false)
      })
      return () => cancelAnimationFrame(id)
    }
    setSeed(text)
  }, [text, isStreaming, boot])

  const smoothStreaming = isStreaming || boot || (seed !== text && text.length > 0)
  const { displayedContent } = useSmoothStream({
    content: seed,
    isStreaming: smoothStreaming,
  })
  const content = displayedContent.trim()

  return (
    <div
      className={cn(
        'agent-concise-narrative',
        tone === 'final' && 'agent-concise-narrative--final',
        tone === 'progress' && 'agent-concise-narrative--progress',
      )}
    >
      <Message from="assistant">
        <MessageContent>
          {content ? (
            <MessageResponse streaming={smoothStreaming}>{displayedContent}</MessageResponse>
          ) : smoothStreaming ? (
            <span className="text-muted-foreground/50">…</span>
          ) : null}
        </MessageContent>
      </Message>
    </div>
  )
})

/** 复制栏：优先最终正文；无 final 时退回全部 narrative */
export function joinNarrativeTexts(segments: ConciseSegment[]): string {
  const finals = segments
    .filter(
      (s): s is Extract<ConciseSegment, { kind: 'narrative' }> =>
        s.kind === 'narrative' && s.tone === 'final',
    )
    .map((s) => s.text.trim())
    .filter(Boolean)
  if (finals.length > 0) return finals.join('\n\n')
  return segments
    .filter((s): s is Extract<ConciseSegment, { kind: 'narrative' }> => s.kind === 'narrative')
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n\n')
}
