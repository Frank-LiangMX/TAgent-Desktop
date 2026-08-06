/**
 * ConciseTimelineView — Cursor 式简洁时间线
 *
 * 最外层「运行了 Xm Ys」容器：
 *   - 展开 → 思考折叠 + 进度短文 + 阶段灰字行（可挂子代理）
 *   - 折叠 → 只留 final output（仍保留「运行了」开关以便再展开）
 * 阶段块 live：摘要累积 + 底部当前动作；层级文案扫光
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
import { isOneShotTextJump } from './narrative-oneshot'
import { formatThinkingSummary } from './session-turn-model'

interface ConciseTimelineViewProps {
  segments: ConciseSegment[]
  isLive?: boolean
  /** 最新一轮：运行链默认展开；历史轮折叠 */
  isLatestTurn?: boolean
  /** 本轮已运行毫秒（live 用实时；完成后用 completedDuration） */
  workedMs?: number
  /** 挂到某 work_stage 下的额外内容（Cursor 式子代理行） */
  getStageExtras?: (seg: Extract<ConciseSegment, { kind: 'work_stage' }>) => ReactNode
  /** 未挂到阶段的兜底内容（插在运行队列末尾） */
  processExtras?: ReactNode
}

export function ConciseTimelineView({
  segments,
  isLive = false,
  isLatestTurn = false,
  workedMs = 0,
  getStageExtras,
  processExtras,
}: ConciseTimelineViewProps): JSX.Element | null {
  if (segments.length === 0 && !processExtras) return null

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

  const hasProcess = processSegs.length > 0 || Boolean(processExtras)

  return (
    <div className="agent-concise-timeline">
      {hasProcess ? (
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
                  extras={getStageExtras?.(seg)}
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
          {processExtras}
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
        <span className="agent-concise-run__label">
          {/* 外层「运行中」只计时，不扫光；扫光留给当前动作行 */}
          <span>{label}</span>
        </span>
        <CaretRight
          size={12}
          className={cn(
            'agent-concise-caret shrink-0 transition-transform',
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
  // live 时展开看思考输出；结束后可手动收起
  const [open, setOpen] = useState(isLive)
  const wasLive = useRef(isLive)
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

  useEffect(() => {
    if (isLive) setOpen(true)
    else if (wasLive.current && !isLive) setOpen(false)
    wasLive.current = isLive
  }, [isLive])

  // 流式竞态偶发 displayed 被清空时，勿用「…」顶替已有思考正文
  const bodyText = (() => {
    const shown = displayedContent.trim()
    if (shown) return shown
    const raw = thinking.trim()
    if (raw) return raw
    return isLive ? '…' : ''
  })()

  return (
    <div className={cn('agent-concise-fold', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-concise-fold__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={cn('agent-concise-fold__summary', isLive && 'agent-concise-shimmer')}>
          {summary}
        </span>
        <CaretRight
          size={11}
          className={cn(
            'agent-concise-caret shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      {open ? (
        <div className="agent-concise-fold__body">
          <MessageResponse
            className="text-[12.5px] leading-[1.55] text-muted-foreground/80"
            streaming={isLive}
          >
            {bodyText}
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
  extras,
}: {
  summary: string
  diffAdd?: number
  diffDel?: number
  steps: WorkStageStep[]
  isLive: boolean
  extras?: ReactNode
}): JSX.Element {
  // Cursor：live 只露摘要 + 当前动作；明细仅用户展开。禁止 live 灌入步骤再整收。
  const [open, setOpen] = useState(false)
  const wasLive = useRef(isLive)
  const rawLiveStatus = isLive ? getLiveStatusFromSteps(steps) : undefined
  // 工具切换很快时防顶栏/底行动作文案连闪
  const liveStatus = useDebouncedValue(rawLiveStatus, 280)

  useEffect(() => {
    // 阶段结束：若用户曾展开，收回收成灰字行（与 Cursor done 折叠一致）
    if (wasLive.current && !isLive) setOpen(false)
    wasLive.current = isLive
  }, [isLive])

  return (
    <div className={cn('agent-concise-fold', 'agent-concise-stage', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-concise-fold__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="agent-concise-fold__summary">
          {/* 摘要只累积计数、不扫光；扫光留给底部当前动作 */}
          <span>{summary}</span>
          <DiffHint add={diffAdd} del={diffDel} />
        </span>
        <CaretRight
          size={11}
          className={cn(
            'agent-concise-caret shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>

      {/* 子代理挂在阶段摘要下（对齐 Cursor），折叠明细时仍可见 */}
      {extras ? <div className="agent-concise-stage__extras">{extras}</div> : null}

      {/* live 折叠态：只露当前动作一行（摘要已在 head 累积） */}
      {isLive && !open && liveStatus ? (
        <div className="agent-concise-live-status">
          <span className="agent-concise-shimmer">{liveStatus}</span>
        </div>
      ) : null}

      <div
        className={cn('agent-concise-stage__panel', open && 'is-open')}
        aria-hidden={!open}
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
            {isLive && open && liveStatus ? (
              <div className="agent-concise-live-status agent-concise-live-status--in-body">
                <span className="agent-concise-shimmer">{liveStatus}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
})

/** 短延迟：同一阶段内工具连发时动作文案更稳；首值立刻显示以便扫光马上可见 */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  const primed = useRef(false)
  useEffect(() => {
    if (value == null || value === '') {
      primed.current = false
      setDebounced(value)
      return
    }
    if (!primed.current) {
      primed.current = true
      setDebounced(value)
      return
    }
    const id = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return debounced
}
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
            <Check size={12} weight="bold" className="text-muted-foreground/35" />
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
              'agent-concise-caret shrink-0 transition-transform',
              detailOpen && 'rotate-90',
            )}
          />
        ) : null}
      </button>
      {detailOpen && step.kind === 'thinking' ? (
        <div className="agent-concise-step__detail">
          <MessageResponse className="text-[12.5px] leading-[1.55] text-muted-foreground/80">
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

/** useSmoothStream 挂在可 key-remount 的子树，避免 one-shot 时 shrink 守卫吞掉空串重置 */
const NarrativeSmoothBody = memo(function NarrativeSmoothBody({
  seed,
  target,
  tone,
  smoothStreaming,
  onCaughtUp,
}: {
  seed: string
  target: string
  tone: 'progress' | 'final'
  smoothStreaming: boolean
  onCaughtUp: () => void
}): JSX.Element {
  const { displayedContent } = useSmoothStream({
    content: seed,
    isStreaming: smoothStreaming,
  })
  const caughtRef = useRef(onCaughtUp)
  caughtRef.current = onCaughtUp

  useEffect(() => {
    if (
      smoothStreaming &&
      seed === target &&
      target.length > 0 &&
      displayedContent === target
    ) {
      caughtRef.current()
    }
  }, [displayedContent, seed, target, smoothStreaming])

  const content = displayedContent.trim()

  if (tone === 'progress') {
    return (
      <div className="agent-concise-narrative agent-concise-narrative--progress">
        {content ? (
          <MessageResponse
            className="agent-concise-narrative__text"
            streaming={smoothStreaming}
          >
            {displayedContent}
          </MessageResponse>
        ) : null}
      </div>
    )
  }

  return (
    <div className="agent-concise-narrative agent-concise-narrative--final">
      {/* py-0：句尾工具条贴正文，避免 Message 默认 py-2.5 撑出大空白 */}
      <Message from="assistant" className="py-0">
        <MessageContent>
          {content ? (
            <MessageResponse streaming={smoothStreaming}>{displayedContent}</MessageResponse>
          ) : null}
        </MessageContent>
      </Message>
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
  // 历史轮 / progress→final remount（!isStreaming 且已完整）：instant 全文，不重播打字机
  // live one-shot（含 isStreaming）：seed '' → 下一帧全文，smooth 直到追上
  const prevTextRef = useRef<string | null>(null)
  const rafRef = useRef<number | null>(null)
  const [seed, setSeed] = useState(() =>
    !isStreaming && text.trim().length > 0 ? text : '',
  )
  const [epoch, setEpoch] = useState(0)
  const [oneShot, setOneShot] = useState(false)

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    const prev = prevTextRef.current
    const next = text

    const armOneShot = (nextText: string) => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      setEpoch((e) => e + 1)
      setSeed('')
      setOneShot(true)
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        setSeed(nextText)
      })
    }

    if (prev === null) {
      prevTextRef.current = next
      // 初次挂载：非 live 已完成 → 直接全文
      if (!isStreaming && next.trim().length > 0) {
        setSeed(next)
        setOneShot(false)
        return
      }
      if (isOneShotTextJump(0, next.length)) {
        armOneShot(next)
        return
      }
      setSeed(next)
      setOneShot(false)
      return
    }

    if (prev === next) return

    const prevLen = prev.length
    prevTextRef.current = next

    if (isOneShotTextJump(prevLen, next.length)) {
      armOneShot(next)
      return
    }

    // 真增量流式：交给 useSmoothStream
    setSeed(next)
  }, [text, isStreaming])

  const smoothStreaming =
    isStreaming || oneShot || (seed !== text && text.length > 0)

  return (
    <NarrativeSmoothBody
      key={epoch}
      seed={seed}
      target={text}
      tone={tone}
      smoothStreaming={smoothStreaming}
      onCaughtUp={() => setOneShot(false)}
    />
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
