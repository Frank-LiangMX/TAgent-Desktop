/**
 * ConciseTimelineView — Cursor 式简洁时间线
 *
 * 最外层「运行了 Xm Ys」容器：
 *   - 展开 → 思考折叠 + 进度短文 + 阶段灰字行（可挂子代理）
 *   - 折叠 → 只留 final output（仍保留「运行了」开关以便再展开）
 * 阶段块 live：摘要累积 + 底部当前动作；层级文案扫光
 */
import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CaretRight, Check, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import { Message, MessageContent, MessageResponse, useSmoothStream } from '@tagent/ui'
import { cn } from '../../lib/utils'
import { formatElapsedDuration, useLiveElapsedMs } from '../../lib/time-utils'
import type { ConciseSegment, WorkStageStep } from './concise-timeline-model'
import {
  getLiveStatusFromSteps,
  getWorkStepLabel,
  isTrivialThinking,
} from './concise-timeline-model'
import { isOneShotTextJump } from './narrative-oneshot'
import { formatThinkingSummary } from './session-turn-model'
import { isNearBottom } from './thinking-scroll-follow'

interface ConciseTimelineViewProps {
  segments: ConciseSegment[]
  isLive?: boolean
  /**
   * 是否仍为会话末尾的 assistant 轮。
   * live 结束后若仍为 true：保持展开便于回看；一旦 false（用户发了新一轮）→ 折叠并保持。
   * 切会话会 key=sessionId 卸载，回来重挂载默认折叠（不因 isLatestTurn 再展开）。
   */
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
        <RunQueueShell workedMs={workedMs} isLive={isLive} isLatestTurn={isLatestTurn}>
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

/**
 * 最外层运行容器：对齐 Cursor「Worked for Xm」
 *
 * 展开策略（简洁模式）：
 * - live：强制展开（实时查看）
 * - live→idle 且仍是会话末尾一轮：保持展开，方便看完过程
 * - 不再是末尾（用户发了新一轮）→ 折叠，且不再因「曾是最新」自动展开
 * - 切会话：Chat key=sessionId 卸载；回来重挂载时默认折叠（即使仍是末尾轮）
 */
const RunQueueShell = memo(function RunQueueShell({
  workedMs,
  isLive,
  isLatestTurn,
  children,
}: {
  workedMs: number
  isLive: boolean
  isLatestTurn: boolean
  children: ReactNode
}): JSX.Element {
  // 重挂载默认折叠（切会话回来）；仅中途挂上的 live 轮才默认开
  const [open, setOpen] = useState(isLive)
  const wasLiveRef = useRef(isLive)
  const wasLatestRef = useRef(isLatestTurn)
  // 沦为历史时瞬时折叠，避免 StickToBottom smooth resize 扫视口
  const [collapseInstant, setCollapseInstant] = useState(false)

  useEffect(() => {
    const wasLive = wasLiveRef.current
    const wasLatest = wasLatestRef.current
    wasLiveRef.current = isLive
    wasLatestRef.current = isLatestTurn

    if (isLive) {
      setCollapseInstant(false)
      setOpen(true)
      return
    }

    // 跑完仍停在本会话末尾轮：保持展开（不在这里强折）
    if (wasLive && isLatestTurn) return

    // 焦点离开本轮：发了新一轮 / 被挤成历史 → 折叠并卸载过程树
    if (wasLatest && !isLatestTurn) {
      setCollapseInstant(true)
      setOpen(false)
    }
  }, [isLive, isLatestTurn])

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
      {/* 折叠时卸载 children，避免历史轮 / 切会话挂载整棵过程树 */}
      <div
        className={cn(
          'agent-concise-run__panel',
          open && 'is-open',
          collapseInstant && 'is-instant',
        )}
        aria-hidden={!open}
      >
        {open ? (
          <div className="agent-concise-run__panel-inner">
            <div className="agent-concise-run__body">{children}</div>
          </div>
        ) : null}
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

/**
 * ThinkingFold（concise 思考折叠块）。Cursor 式：默认只露一行头（「正在思考…」扫光 /
 * 「思考了片刻」）；正文不自动铺开，及时反馈靠头栏扫光，点开再看全文。
 *
 * **B（lazy mount）**：折叠时**不挂载**完整 reasoning 的 MessageResponse / Markdown parser /
 * useSmoothStream——只渲染头栏摘要；用户主动展开后才挂载 {@link ThinkingFoldBody} 渲染完整
 * Markdown，关闭后立即卸载重型正文。已完成与流式中的块都遵守。导出供 B 行为单测渲染。
 */
export const ThinkingFold = memo(function ThinkingFold({
  thinking,
  durationSec,
  isLive,
}: {
  thinking: string
  durationSec?: number
  isLive: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  openRef.current = open
  const wasLive = useRef(isLive)
  const settleTimer = useRef<number | null>(null)
  const startRef = useRef<number | null>(null)
  // live 墙钟：idle 后 useLiveElapsedMs 归零，需冻结最后一秒数，避免退回偏大的字数粗估
  const frozenLiveSecRef = useRef<number | undefined>(undefined)
  if (isLive && startRef.current == null) {
    startRef.current = Date.now()
    frozenLiveSecRef.current = undefined
  }
  const elapsedMs = useLiveElapsedMs(startRef.current ?? undefined, isLive)
  if (isLive && elapsedMs > 0) {
    frozenLiveSecRef.current = Math.max(1, Math.floor(elapsedMs / 1000))
  }
  // 优先真实观看时长；无 live 样本时才用 annotate 的 durationSec
  const effectiveSec = isLive
    ? Math.floor(elapsedMs / 1000)
    : (frozenLiveSecRef.current ?? durationSec)
  const summary = formatThinkingSummary(effectiveSec, {
    live: isLive,
    liveElapsedSec: Math.floor(elapsedMs / 1000),
  })

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

  const panelId = useId()
  const handleToggle = (): void => {
    if (settleTimer.current != null) {
      window.clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
    setOpen((v) => !v)
  }

  return (
    <div className={cn('agent-concise-fold', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-concise-fold__head"
        onClick={handleToggle}
        aria-expanded={open}
        aria-controls={panelId}
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
      {/* B：折叠时卸载重型正文（不挂 MessageResponse/Markdown/useSmoothStream）；展开才挂 ThinkingFoldBody */}
      <div
        id={panelId}
        className={cn('agent-concise-fold__panel', open && 'is-open')}
        aria-hidden={!open}
      >
        <div className="agent-concise-fold__panel-inner">
          {open ? <ThinkingFoldBody thinking={thinking} isLive={isLive} /> : null}
        </div>
      </div>
    </div>
  )
})

/**
 * ThinkingFold 的重型正文子组件：仅在用户展开（open=true）时挂载。
 * 挂载时才运行 useSmoothStream + MessageResponse/Markdown parser；关闭即卸载，
 * 避免折叠态下逐帧全量 Markdown 解析与 O(N) 字符串拼接（B/D 性能）。
 * 流式中展开：以当前完整 thinking 为起点续写（不从头打字机重播）。
 */
const ThinkingFoldBody = memo(function ThinkingFoldBody({
  thinking,
  isLive,
}: {
  thinking: string
  isLive: boolean
}): JSX.Element {
  const { displayedContent } = useSmoothStream({
    content: thinking,
    isStreaming: isLive,
  })
  // 流式滚动跟随：仅展开时钉底
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const handleBodyScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    stickRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
  }
  useEffect(() => {
    if (!isLive) return
    const el = bodyRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [displayedContent, isLive])

  // 流式竞态偶发 displayed 被清空时，勿用「…」顶替已有思考正文
  const bodyText = (() => {
    const shown = displayedContent.trim()
    if (shown) return shown
    const raw = thinking.trim()
    if (raw) return raw
    return isLive ? '…' : ''
  })()

  return (
    <div className="agent-concise-fold__body" ref={bodyRef} onScroll={handleBodyScroll}>
      <MessageResponse
        className="text-[12.5px] leading-[1.55] text-muted-foreground/80"
        streaming={isLive}
      >
        {bodyText}
      </MessageResponse>
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

/**
 * O2：live 末步思考正文打字机。挂在阶段摘要下、折叠 panel 之外（收起也可见），
 * 让正在流式的 stage 内思考不再只扫光「正在思考…」。思考结束 hold→淡出再折进 steps。
 * 复用 useSmoothStream 逐字挤出；空帧用 thinking 全文兜底，避免「…」顶替已显示正文。
 */
const LiveThinkingBody = memo(function LiveThinkingBody({
  thinking,
  isStreaming,
  fading,
}: {
  thinking: string
  isStreaming: boolean
  fading: boolean
}): JSX.Element | null {
  const { displayedContent } = useSmoothStream({ content: thinking, isStreaming })
  const bodyText = (() => {
    const shown = displayedContent.trim()
    if (shown) return shown
    const raw = thinking.trim()
    if (raw) return raw
    return isStreaming ? '…' : ''
  })()
  if (!bodyText) return null
  return (
    <div className={cn('agent-concise-stage__live-thinking', fading && 'is-fading')}>
      <MessageResponse
        className="text-[12.5px] leading-[1.55] text-muted-foreground/80"
        streaming={isStreaming}
      >
        {bodyText}
      </MessageResponse>
    </div>
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
  // REGRESS-N（产品裁决 3）：折叠 stage 摘要带「· 含思考」——中段有分量的思考（非 trivial）
  // 不再只埋在折叠 stage 里看不见。仅当含非 trivial 思考才提示（纯「让我看看」级不刷），
  // 不升独立 ThinkingFold 以免回退 REGRESS-J(J3) 的拆 stage / 思考游离。
  const hasSubstantiveThinking = steps.some(
    (s) => s.kind === 'thinking' && !isTrivialThinking(s.thinking),
  )
  const wasActive = useRef(stageActive)
  const settleTimer = useRef<number | null>(null)
  // REGRESS-O O2：中段思考并入 stage.steps 后，折叠态只露「正在思考…」扫光，正文打字机
  // 不外露 → 用户观感「打完就没、只有重启展开执行块才有」。当 stage 仍在流式且末步是思考时，
  // 把该思考正文作打字机常挂在阶段摘要下（不挂在折叠 panel 的 0fr 网格里，故收起也可见）。
  // 思考结束（工具跟上 / 回合 settle）不秒卸：hold 旧文 → 淡出 → 再折进 stage.steps（允许折进，
  // 但须连续，禁止空帧）。不升独立 ThinkingFold 以免回退 REGRESS-J(J3) 的拆 stage / 思考游离。
  const lastStep = steps[steps.length - 1]
  const liveTailThinking =
    stageActive && Boolean(lastStep) && lastStep!.kind === 'thinking'
  const rawLiveThinking = liveTailThinking
    ? (lastStep as Extract<WorkStageStep, { kind: 'thinking' }>).thinking
    : undefined
  // keepWhileActive=false：思考正文在末步被工具取代即 hold→淡出（不被末阶段 keepWhileActive
  // 无限挂住），与 live 底栏动作的 hold 语义分开。
  const { shown: liveThinking, fading: liveThinkingFading } = useLiveStatusHold(
    rawLiveThinking,
    false,
  )
  // 末步是思考时，底栏扫光让位给正文打字机（不再只扫光「正在思考…」）
  const rawLiveStatus = stageActive && !liveTailThinking ? getLiveStatusFromSteps(steps) : undefined
  // 末步是思考时不再 keepWhileActive 挂住旧工具动作扫光（让位给思考正文 → 旧动作 hold→淡出）
  const statusKeepWhileActive = keepWhileActive && !liveTailThinking
  // hold last live status 再淡出，禁止工具完成瞬间 null 卸 DOM（对齐 Cursor 折进灰字摘要）
  const { shown: liveStatus, fading } = useLiveStatusHold(rawLiveStatus, statusKeepWhileActive)

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
          {hasSubstantiveThinking ? (
            <span className="text-muted-foreground/45 text-[11px]">· 含思考</span>
          ) : null}
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

      {/* O2：live 末步思考正文打字机常挂（收起也可见），思考结束 hold→淡出再折进 steps */}
      {liveThinking ? (
        <LiveThinkingBody
          thinking={liveThinking}
          isStreaming={liveTailThinking}
          fading={liveThinkingFading}
        />
      ) : null}

      {/* 收起态：不外挂「✓ 思考了片刻」——思考收回阶段块，展开才见；live 只露底栏当前动作 */}
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
                isStreaming={
                  stageActive &&
                  (step.kind === 'tool'
                    ? !step.tool.result
                    : step.kind === 'thinking' &&
                      isLastThinkingStep(steps, step.key) &&
                      !steps.some((s) => s.kind === 'tool' && !s.tool.result))
                }
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
/** 阶段内是否为末段思考（仅末段在 live 时可转圈；历史思考不再外露打勾） */
function isLastThinkingStep(steps: WorkStageStep[], key: string): boolean {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]!.kind === 'thinking') return steps[i]!.key === key
  }
  return false
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
  const frozenLiveSecRef = useRef<number | undefined>(undefined)
  const isThinking = step.kind === 'thinking'
  const thinkingLive = isThinking && isStreaming
  if (thinkingLive && startRef.current == null) {
    startRef.current = Date.now()
    frozenLiveSecRef.current = undefined
  }
  // tool pending 也算 streaming；思考行用 live 计时，idle 后冻结避免退回字数粗估
  const elapsedMs = useLiveElapsedMs(
    isThinking ? (startRef.current ?? undefined) : undefined,
    thinkingLive,
  )
  if (thinkingLive && elapsedMs > 0) {
    frozenLiveSecRef.current = Math.max(1, Math.floor(elapsedMs / 1000))
  }
  // 思考行用 live/冻结时长；工具行无 durationSec（getWorkStepLabel 仅思考读它），
  // 故工具分支给 undefined——避免在「tool」变体上访问 step.durationSec（TS 报错）。
  const stepDurationSec = isThinking
    ? (frozenLiveSecRef.current ?? step.durationSec)
    : undefined
  const label = getWorkStepLabel(
    isThinking ? { ...step, durationSec: stepDurationSec } : step,
    {
      pending: isStreaming,
      liveElapsedSec: Math.floor(elapsedMs / 1000),
    },
  )
  const isError = step.kind === 'tool' && Boolean(step.tool.result?.isError)
  const hasDetail = isThinking
    ? Boolean(step.thinking.trim())
    : Boolean(step.tool.result?.content) || Boolean(step.diff)

  // 思考：不打勾；live 用文字扫光（不用转圈）。工具 live 仍可转圈表执行中。
  const stepIcon = isThinking ? (
    <span className="agent-concise-step__icon-dot" />
  ) : isStreaming ? (
    <CircleNotch size={12} className="animate-spin text-muted-foreground/50" />
  ) : isError ? (
    <WarningCircle size={12} weight="fill" className="text-destructive/70" />
  ) : (
    <Check size={12} weight="bold" className="text-muted-foreground/35" />
  )

  return (
    <div
      className={cn(
        'agent-concise-step',
        isStreaming && 'is-active',
        isThinking && 'agent-concise-step--thinking',
      )}
    >
      <button
        type="button"
        className="agent-concise-step__head"
        onClick={() => hasDetail && setDetailOpen((v) => !v)}
        disabled={!hasDetail}
      >
        <span className="agent-concise-step__icon" aria-hidden>
          {stepIcon}
        </span>
        <span
          className={cn(
            'agent-concise-step__label',
            // 思考 live：文案扫光（对齐 Cursor / 阶段底栏「正在思考…」）
            isThinking && isStreaming && 'agent-concise-shimmer',
          )}
        >
          {label}
        </span>
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
}): JSX.Element | null {
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
    // 无内容勿占位（REGRESS-N 必改 3）：流式 seed='' / one-shot 重置帧 content 暂空时，
    // 不渲染空 div——`.agent-concise-narrative--progress` 有 padding:1px 0，空 div 会留占位
    // 空白；多个段间 progress 在 live→idle 重投影增删时易叠成「大空白」。无内容直接 null。
    // hooks 已在上方无条件调用，此处仅控制渲染输出。
    if (!content) return null
    return (
      <div className="agent-concise-narrative agent-concise-narrative--progress">
        <MessageResponse
          className="agent-concise-narrative__text"
          streaming={smoothStreaming}
        >
          {displayedContent}
        </MessageResponse>
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
