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
import { isNearBottom } from './thinking-scroll-follow'

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

  // 末阶段判定：live 时最后一个 work_stage 保持底栏，但其后已有 narrative 在流则让位给正文
  const lastWorkStageIdx = (() => {
    for (let i = processSegs.length - 1; i >= 0; i--) {
      if (processSegs[i]!.kind === 'work_stage') return i
    }
    return -1
  })()
  const hasNarrativeAfterLastStage =
    lastWorkStageIdx >= 0 &&
    processSegs.slice(lastWorkStageIdx + 1).some((s) => s.kind === 'narrative')

  return (
    <div className="agent-concise-timeline">
      {hasProcess ? (
        <RunQueueShell
          workedMs={workedMs}
          isLive={isLive}
          defaultExpanded={isLatestTurn || isLive}
        >
          {processSegs.map((seg, idx) => {
            if (seg.kind === 'thinking') {
              return (
                <ThinkingFold
                  key={seg.key}
                  thinking={seg.thinking}
                  durationSec={seg.durationSec}
                  // 仅当前正在流式的思考（过程队列末位）为 live；工具/正文一旦跟上 → idle 走 settle
                  isLive={isLive && isLastSegment(processSegs, seg.key)}
                />
              )
            }
            if (seg.kind === 'work_stage') {
              const stageLive = isLive && seg.tools.some((t) => !t.result)
              // 末阶段在回合 live 且其后无 narrative 时保持 live 底栏（不只「有未完成 tool」）
              const keepWhileActive =
                isLive && idx === lastWorkStageIdx && !hasNarrativeAfterLastStage
              return (
                <WorkStageFold
                  key={seg.key}
                  summary={seg.summary}
                  diffAdd={seg.diffAdd}
                  diffDel={seg.diffDel}
                  steps={seg.steps}
                  isStageLive={stageLive}
                  keepWhileActive={keepWhileActive}
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
  // 沦为历史时瞬时折叠：禁止 grid 过渡 + StickToBottom smooth resize 叠成「从上扫到底」
  const [collapseInstant, setCollapseInstant] = useState(false)

  useEffect(() => {
    // 成为最新轮 / live → 展开；沦为历史 → 折叠
    if (defaultExpanded && !wasExpandedDefault.current) {
      setCollapseInstant(false)
      setOpen(true)
    }
    if (!defaultExpanded && wasExpandedDefault.current) {
      setCollapseInstant(true)
      setOpen(false)
    }
    wasExpandedDefault.current = defaultExpanded
  }, [defaultExpanded])

  // live 时强制保持展开（跑着不应被手动叠住看不见）
  useEffect(() => {
    if (isLive) {
      setCollapseInstant(false)
      setOpen(true)
    }
  }, [isLive])

  // 瞬时折叠已上屏后清掉 flag，之后用户手动展开/收起仍可丝滑过渡
  useEffect(() => {
    if (!collapseInstant) return
    const id = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setCollapseInstant(false))
    })
    return () => cancelAnimationFrame(id)
  }, [collapseInstant])

  const dur = formatElapsedDuration(Math.max(0, workedMs))
  const label = isLive ? `运行中 ${dur}` : `运行了 ${dur}`

  const handleToggle = (): void => {
    setCollapseInstant(false)
    setOpen((v) => !v)
  }

  return (
    <div className={cn('agent-concise-run', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-concise-run__head"
        onClick={handleToggle}
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
      {/* 与 ThinkingFold / WorkStageFold 同：body 常驻 + grid 0fr↔1fr；历史降级可 is-instant */}
      <div
        className={cn(
          'agent-concise-run__panel',
          open && 'is-open',
          collapseInstant && 'is-instant',
        )}
        aria-hidden={!open}
      >
        <div className="agent-concise-run__panel-inner">
          <div className="agent-concise-run__body">{children}</div>
        </div>
      </div>
    </div>
  )
})

/** seg 是否为过程队列末位（其后再无工具 / 正文 / 进度文）→ 仍属正在流式的思考。 */
function isLastSegment(segments: ConciseSegment[], key: string): boolean {
  const last = segments[segments.length - 1]
  return last != null && last.key === key
}

/** live→idle 后若用户曾手动展开，settle 再折回一行头（默认 live 也不自动展开，对齐 Cursor）。 */
const THINK_SETTLE_MS = 1800

/** 阶段 live→idle 后的 settle 时长（ms）：REGRESS-J(J2) 对齐 ThinkingFold/思考行，
 *  阶段执行结束先 hold 约 1.8s 再折回灰字摘要，禁止 live→idle 瞬间卸掉阶段行。 */
const WORK_STAGE_SETTLE_MS = 1800

const ThinkingFold = memo(function ThinkingFold({
  thinking,
  durationSec,
  isLive,
}: {
  thinking: string
  durationSec?: number
  isLive: boolean
}): JSX.Element {
  // Cursor 式：默认只露一行头（「正在思考…」扫光 / 「思考了片刻」）；正文不自动铺开，
  // 及时反馈靠头栏扫光，点开再看全文。避免流式撑版与流完秒卸正文。
  // 用户手动展开后，live→idle settle ~1.8s 再优雅折回一行（body 常驻 DOM）。
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  openRef.current = open
  const wasLive = useRef(isLive)
  const settleTimer = useRef<number | null>(null)
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

  // 流式滚动跟随：仅在用户展开时钉底；收起时不滚
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const handleBodyScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    stickRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
  }
  useEffect(() => {
    if (!isLive || !open) return
    const el = bodyRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [displayedContent, isLive, open])

  // live 时不强制展开；live→idle 仅当用户已展开才 settle 折回一行。
  useEffect(() => {
    if (isLive) {
      wasLive.current = true
      if (settleTimer.current != null) {
        window.clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
      return
    }
    if (!wasLive.current) return
    wasLive.current = false
    if (!openRef.current) return
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null
      setOpen(false)
    }, THINK_SETTLE_MS)
    return () => {
      if (settleTimer.current != null) {
        window.clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
    }
  }, [isLive])

  const handleToggle = (): void => {
    if (settleTimer.current != null) {
      window.clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
    setOpen((v) => !v)
  }

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
        onClick={handleToggle}
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
      {/* body 常驻 DOM：grid 0fr↔1fr + opacity 过渡折起，不 null 卸载；折起后点开仍见全文 */}
      <div
        className={cn('agent-concise-fold__panel', open && 'is-open')}
        aria-hidden={!open}
      >
        <div className="agent-concise-fold__panel-inner">
          <div className="agent-concise-fold__body" ref={bodyRef} onScroll={handleBodyScroll}>
            <MessageResponse
              className="text-[12.5px] leading-[1.55] text-muted-foreground/80"
              streaming={isLive}
            >
              {bodyText}
            </MessageResponse>
          </div>
        </div>
      </div>
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
  isStageLive,
  keepWhileActive,
  extras,
}: {
  summary: string
  diffAdd?: number
  diffDel?: number
  steps: WorkStageStep[]
  isStageLive: boolean
  /** 末阶段在回合 live 时保持 live 底栏（无后续 narrative）；整轮结束才收灰字行 */
  keepWhileActive: boolean
  extras?: ReactNode
}): JSX.Element {
  // Cursor：live 只露摘要 + 当前动作；明细仅用户展开。禁止 live 灌入步骤再整收。
  const [open, setOpen] = useState(false)
  const stageActive = isStageLive || keepWhileActive
  const wasActive = useRef(stageActive)
  const settleTimer = useRef<number | null>(null)
  const rawLiveStatus = stageActive ? getLiveStatusFromSteps(steps) : undefined
  // hold last live status 再淡出，禁止工具完成瞬间 null 卸 DOM（对齐 Cursor 折进灰字摘要）
  const { shown: liveStatus, fading } = useLiveStatusHold(rawLiveStatus, keepWhileActive)

  // REGRESS-J(J2)：live→idle 不瞬间折叠。阶段激活时武装；结束先 hold ~1.8s 再折回灰字摘要，
  // 与 ThinkingFold settle 一致，panel 常驻（grid 0fr↔1fr），折起后可再点开明细。
  useEffect(() => {
    if (stageActive) {
      if (settleTimer.current != null) {
        window.clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
      wasActive.current = true
      return
    }
    if (!wasActive.current) return
    wasActive.current = false
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null
      // 阶段结束（含末阶段回合结束）：若用户曾展开，收回收成灰字行
      setOpen(false)
    }, WORK_STAGE_SETTLE_MS)
    return () => {
      if (settleTimer.current != null) {
        window.clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
    }
  }, [stageActive])

  const handleToggle = (): void => {
    // 用户手动收起 / 展开：取消待执行的 settle 强制折起，避免夺回用户刚展开的状态
    if (settleTimer.current != null) {
      window.clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
    setOpen((v) => !v)
  }

  return (
    <div className={cn('agent-concise-fold', 'agent-concise-stage', stageActive && 'is-live')}>
      <button
        type="button"
        className="agent-concise-fold__head"
        onClick={handleToggle}
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

      {/* REGRESS-K1：阶段收起时仍露思考 step 头，避免「执行块内无思考行」 */}
      {!open
        ? steps
            .filter((s): s is Extract<WorkStageStep, { kind: 'thinking' }> => s.kind === 'thinking')
            .map((s) => (
              <StageStepRow key={`peek-${s.key}`} step={s} isStreaming={false} />
            ))
        : null}

      {/* live 折叠态：只露当前动作一行（摘要已在 head 累积） */}
      {!open && liveStatus ? (
        <div
          className={cn('agent-concise-live-status', fading && 'is-fading')}
        >
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
                isStreaming={isStageLive && step.kind === 'tool' && !step.tool.result}
              />
            ))}
            {open && liveStatus ? (
              <div
                className={cn(
                  'agent-concise-live-status agent-concise-live-status--in-body',
                  fading && 'is-fading',
                )}
              >
                <span className="agent-concise-shimmer">{liveStatus}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
})

/**
 * live 底栏 hold + 淡出：raw 状态变空时先保持旧值（hold），再淡出后卸 DOM，
 * 禁止工具/回合完成瞬间 null 卸 DOM（对齐 Cursor「当前动作扫光 → 折进灰字摘要」）。
 * keepWhileActive（末阶段 + 回合 live）：持续保持上一个动作扫光，回合结束才走 hold→淡出。
 */
const LIVE_STATUS_HOLD_MS = 320
const LIVE_STATUS_FADE_MS = 380

function useLiveStatusHold(
  raw: string | undefined,
  keepWhileActive: boolean,
): { shown: string | undefined; fading: boolean } {
  const [shown, setShown] = useState<string | undefined>(raw)
  const [fading, setFading] = useState(false)
  const heldRef = useRef<string | undefined>(raw)
  const holdTimer = useRef<number | null>(null)
  const fadeTimer = useRef<number | null>(null)
  const shownRef = useRef(shown)
  shownRef.current = shown

  const clearTimers = (): void => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    if (fadeTimer.current != null) {
      window.clearTimeout(fadeTimer.current)
      fadeTimer.current = null
    }
  }

  useEffect(() => {
    if (raw) {
      // 有当前动作：立即显示，停淡出
      heldRef.current = raw
      clearTimers()
      setFading(false)
      if (shownRef.current !== raw) setShown(raw)
      return
    }
    // raw 空
    if (keepWhileActive) {
      // 末阶段 + 回合 live：保持上一个动作扫光，不淡出
      clearTimers()
      setFading(false)
      if (!shownRef.current && heldRef.current) setShown(heldRef.current)
      return
    }
    // 不再 active 且当前仍有内容：hold → 淡出 → 卸 DOM（时长对齐 CSS transition）
    if (shownRef.current && holdTimer.current == null && fadeTimer.current == null) {
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null
        setFading(true)
        fadeTimer.current = window.setTimeout(() => {
          fadeTimer.current = null
          setFading(false)
          setShown(undefined)
        }, LIVE_STATUS_FADE_MS)
      }, LIVE_STATUS_HOLD_MS)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, keepWhileActive])

  useEffect(() => () => clearTimers(), [])

  return { shown, fading }
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
