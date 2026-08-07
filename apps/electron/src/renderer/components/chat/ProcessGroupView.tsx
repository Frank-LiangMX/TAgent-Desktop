/**
 * ProcessGroupView — Agent 过程区
 *
 * - **完整模式**：工具行展开；思考默认只露头栏（「正在思考…」扫光），点开看正文
 * - **简洁模式**：过程区打开时思考同样默认收起；idle 后收成一行摘要
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaretRight, Check, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  MessageResponse,
  ScrollArea,
  useSmoothStream,
} from '@tagent/ui'
import { cn } from '../../lib/utils'
import type { ProcessEntry } from './session-turn-model'
import { summarizeProcess, formatThinkingSummary } from './session-turn-model'
import {
  PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS,
  PROCESS_GROUP_AUTO_COLLAPSE_SETTLE_MS,
  THINKING_ROW_SETTLE_MS,
  buildProcessGroupHeaderLabel,
  buildProcessTextPreview,
  findLastProcessKey,
  planProcessGroupCollapse,
  projectConciseProcess,
  shouldCollapseProcessText,
  type ProcessDisplayMode,
} from './process-group-model'
import { getToolPhrase, summarizeToolResult } from './tool-phrase'
import type { TAgentToolResultBlock, TAgentToolUseBlock } from '@tagent/shared'

/**
 * 过程区 Markdown 弱样式：字号压小、正文继承外层弱色、段间距收紧。
 * 用 `prose-*` 变体而非裸 CSS，保证能盖过 typography 插件的默认色。
 */
const PROCESS_MD_CLASS = cn(
  'text-[12.5px] leading-[1.6] text-muted-foreground/85',
  'prose-p:my-1 prose-p:text-current prose-li:my-0.5 prose-li:text-current',
  'prose-headings:my-1.5 prose-headings:text-current prose-strong:text-current',
  'prose-a:text-current prose-code:text-current prose-blockquote:text-current',
)

interface ProcessGroupViewProps {
  process: ProcessEntry[]
  /** 本轮 Agent 仍在活动（含流式与工具间隙） */
  isLive?: boolean
  /** @deprecated 使用 isLive */
  isStreaming?: boolean
  /**
   * 运行中是否自动展开过程区。默认 true（主会话——full 与 concise 都要看见实时过程）。
   * 子代理详情页传 false：默认只显示一行摘要，点开再看步骤，避免思考/工具全文铺满。
   */
  autoExpandWhenLive?: boolean
  /** 展示模式：完整 / Cursor 简洁标题。默认 full。 */
  displayMode?: ProcessDisplayMode
  /** 思考时长（秒），concise idle 标题「思考了 N 秒」 */
  thinkingDurationSec?: number
}

export function ProcessGroupView({
  process,
  isLive,
  isStreaming = false,
  autoExpandWhenLive = true,
  displayMode = 'full',
  thinkingDurationSec,
}: ProcessGroupViewProps): JSX.Element | null {
  const live = isLive ?? isStreaming
  const summary = summarizeProcess(process)
  const [expanded, setExpanded] = useState(autoExpandWhenLive ? live : false)
  const [collapseCountdown, setCollapseCountdown] = useState<number | null>(null)
  const userToggledRef = useRef(false)
  const wasLiveRef = useRef(live)
  const autoCollapseTimersRef = useRef<number[]>([])

  const clearAutoCollapseTimers = useCallback(() => {
    for (const timer of autoCollapseTimersRef.current) window.clearTimeout(timer)
    autoCollapseTimersRef.current = []
  }, [])

  /** 用户插手（展开/收起）：放弃本轮自动收起 */
  const markUserToggled = useCallback(() => {
    userToggledRef.current = true
    clearAutoCollapseTimers()
    setCollapseCountdown(null)
  }, [clearAutoCollapseTimers])

  useEffect(() => {
    clearAutoCollapseTimers()
    const plan = planProcessGroupCollapse({
      live,
      wasLive: wasLiveRef.current,
      userToggled: userToggledRef.current,
      autoExpandWhenLive,
    })
    if (live && !wasLiveRef.current) userToggledRef.current = false
    wasLiveRef.current = live

    if (plan === 'expand') setExpanded(true)
    if (plan === 'collapse') setExpanded(false)
    if (plan !== 'countdown') {
      setCollapseCountdown(null)
      return
    }

    // 静置一会儿再开始倒计时：工具间隙的瞬时 idle 不会把正在看的过程收走
    autoCollapseTimersRef.current.push(
      window.setTimeout(() => {
        setCollapseCountdown(PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS)
        for (let second = PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS - 1; second >= 1; second--) {
          const elapsed = (PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS - second) * 1000
          autoCollapseTimersRef.current.push(
            window.setTimeout(() => setCollapseCountdown(second), elapsed),
          )
        }
        autoCollapseTimersRef.current.push(
          window.setTimeout(() => {
            setCollapseCountdown(null)
            setExpanded(false)
          }, PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS * 1000),
        )
      }, PROCESS_GROUP_AUTO_COLLAPSE_SETTLE_MS),
    )

    return clearAutoCollapseTimers
  }, [live, autoExpandWhenLive, clearAutoCollapseTimers])

  const liveHint = useMemo(() => {
    if (!live) return null
    for (let i = process.length - 1; i >= 0; i--) {
      const e = process[i]!
      if (e.type === 'tool' && !e.result) {
        return getToolPhrase(e.tool.name, e.tool.input).loadingLabel
      }
      if (e.type === 'thinking') {
        const t = e.thinking.trim().replace(/\s+/g, ' ')
        if (t) return t.length > 48 ? `思考：${t.slice(0, 48)}…` : `思考：${t}`
        return '正在思考…'
      }
      if (e.type === 'tool' && e.result) {
        return getToolPhrase(e.tool.name, e.tool.input).label
      }
    }
    return '正在执行…'
  }, [live, process])

  const headerLabel = useMemo(() => {
    const toolsDone = process.filter((p) => p.type === 'tool' && p.result).length
    return buildProcessGroupHeaderLabel({
      live,
      liveHint,
      toolCount: summary.toolCount,
      thinkingCount: summary.thinkingCount,
      toolsDone,
      fallbackLabel: summary.label,
      displayMode,
      thinkingDurationSec,
    })
  }, [live, liveHint, process, summary, displayMode, thinkingDurationSec])

  const showBody = expanded

  // REGRESS-K1：思考可在收起态单独露出；展开态仍走完整过程序（thinking/tool/text 交错）。
  const projectedProcess = useMemo(
    () => (displayMode === 'concise' ? projectConciseProcess(process) : process),
    [process, displayMode],
  )
  const thinkingEntries = useMemo(
    () =>
      projectedProcess.filter(
        (e): e is Extract<ProcessEntry, { type: 'thinking' }> => e.type === 'thinking',
      ),
    [projectedProcess],
  )
  const lastThinkingKey = useMemo(
    () => findLastProcessKey(projectedProcess, 'thinking'),
    [projectedProcess],
  )
  const lastTextKey = useMemo(() => findLastProcessKey(projectedProcess, 'text'), [projectedProcess])
  const hasDetailBody = projectedProcess.some(
    (e) => e.type === 'tool' || (e.type === 'text' && e.text.trim()),
  )

  // 空过程组不渲染。早退必须在所有 hook 之后，否则 0→非 0 时 hook 数量变化会崩
  if (process.length === 0) return null

  const renderThinking = (entry: Extract<ProcessEntry, { type: 'thinking' }>): JSX.Element => (
    <ThinkingActivityRow
      key={entry.key}
      thinking={entry.thinking}
      isLive={live && entry.key === lastThinkingKey}
      durationSec={entry.durationSec}
      displayMode={displayMode}
    />
  )

  return (
    <div className={cn('agent-process-group', live && 'is-live')}>
      <button
        type="button"
        className="agent-process-group__toggle"
        onClick={() => {
          markUserToggled()
          setExpanded((v) => !v)
        }}
      >
        <CaretRight
          size={12}
          weight="bold"
          className={cn(
            'shrink-0 text-muted-foreground/45 transition-transform duration-150',
            showBody && 'rotate-90',
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground/80',
            live && 'agent-process-group__live',
          )}
        >
          {headerLabel}
        </span>
        {collapseCountdown !== null && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/45">
            {collapseCountdown}s
          </span>
        )}
        {!showBody && !live && hasDetailBody && (
          <span className="shrink-0 text-[11px] text-muted-foreground/40">查看过程</span>
        )}
      </button>

      {/* idle 收起：思考头常驻；展开时改由下方 body 按序交错渲染，避免重复 */}
      {!showBody && thinkingEntries.length > 0 ? (
        <div className="agent-process-group__thinking">{thinkingEntries.map(renderThinking)}</div>
      ) : null}

      {showBody && (
        <div className="agent-process-group__body">
          {projectedProcess.map((entry) => {
            if (entry.type === 'thinking') return renderThinking(entry)
            if (entry.type === 'tool') {
              return (
                <ToolActivityRow
                  key={entry.key}
                  tool={entry.tool}
                  result={entry.result}
                  isStreaming={live && !entry.result}
                />
              )
            }
            if (entry.type === 'text') {
              if (!entry.text.trim()) return null
              return (
                <ProcessTextRow
                  key={entry.key}
                  text={entry.text}
                  isLive={live && entry.key === lastTextKey}
                />
              )
            }
            return null
          })}
          {!live && (
            <button
              type="button"
              className="agent-process-group__collapse"
              onClick={() => {
                markUserToggled()
                setExpanded(false)
              }}
            >
              收起过程
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 思考行：默认只露头栏（对齐 Cursor）；live 头栏「正在思考…」扫光做及时反馈，
 * 正文不自动铺开，点开再看。body 常驻 DOM（`__panel` grid）。
 */
const ThinkingActivityRow = memo(function ThinkingActivityRow({
  thinking,
  isLive,
  durationSec,
  displayMode: _displayMode = 'full',
}: {
  thinking: string
  /** 本段是当前正在写的思考（整轮 live 时只有最后一段为真） */
  isLive: boolean
  /** 本段思考时长（秒）；idle 折叠态头栏显示「思考了 Ns」对齐 Cursor */
  durationSec?: number
  /** 保留 API；正文一律默认收起 */
  displayMode?: ProcessDisplayMode
}): JSX.Element {
  void _displayMode
  const { displayedContent } = useSmoothStream({
    content: thinking,
    isStreaming: isLive,
  })
  const text = displayedContent.trim()
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const open = userExpanded ?? false
  const openRef = useRef(open)
  openRef.current = open

  // 用户手动展开后，live→idle settle 再折回一行头
  const wasLiveRef = useRef(isLive)
  const settleTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (isLive) {
      wasLiveRef.current = true
      if (settleTimerRef.current != null) {
        window.clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
      return
    }
    if (!wasLiveRef.current) return
    wasLiveRef.current = false
    if (!openRef.current) return
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      setUserExpanded(false)
    }, THINKING_ROW_SETTLE_MS)
    return () => {
      if (settleTimerRef.current != null) {
        window.clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
    }
  }, [isLive])

  const bodyRef = useRef<HTMLDivElement>(null)
  const stickToLatestRef = useRef(true)
  useEffect(() => {
    if (!isLive || !open) return
    const el = bodyRef.current
    if (!el || !stickToLatestRef.current) return
    el.scrollTop = el.scrollHeight
  }, [text, isLive, open])

  const headLabel = formatThinkingSummary(durationSec, { live: isLive })

  return (
    <div className={cn('agent-thinking-row', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-thinking-row__head"
        aria-expanded={open}
        onClick={() => {
          if (settleTimerRef.current != null) {
            window.clearTimeout(settleTimerRef.current)
            settleTimerRef.current = null
          }
          setUserExpanded(!open)
        }}
      >
        <span
          className={cn('agent-thinking-row__badge', isLive && 'agent-concise-shimmer')}
        >
          {headLabel}
        </span>
        <CaretRight
          size={11}
          className={cn(
            'ml-auto shrink-0 text-muted-foreground/35 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      <div className={cn('agent-thinking-row__panel', open && 'is-open')} aria-hidden={!open}>
        <div className="agent-thinking-row__panel-inner">
          <div
            ref={bodyRef}
            className="agent-thinking-row__body"
            onScroll={(e) => {
              const el = e.currentTarget
              stickToLatestRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
          >
            <MessageResponse className={PROCESS_MD_CLASS} streaming={isLive}>
              {text || (isLive ? '…' : '')}
            </MessageResponse>
          </div>
        </div>
      </div>
    </div>
  )
})

/**
 * 过程内中间文本：未交付给回答区的正文（工具间隙的说明、live 期间的尾部 text）。
 * 默认完整可读（Markdown + 弱样式），只有很长时才给一个折叠开关，折叠态才截断成预览行。
 */
const ProcessTextRow = memo(function ProcessTextRow({
  text,
  isLive,
}: {
  text: string
  /** 本段是当前正在写的正文 */
  isLive: boolean
}): JSX.Element {
  const { displayedContent } = useSmoothStream({ content: text, isStreaming: isLive })
  const content = displayedContent.trim()

  const collapsible = useMemo(() => shouldCollapseProcessText(text), [text])
  const [userCollapsed, setUserCollapsed] = useState(false)
  const open = !collapsible || !userCollapsed

  return (
    <div className={cn('agent-process-text', isLive && 'is-live')}>
      {open ? (
        <div className="agent-process-text__body">
          <MessageResponse className={PROCESS_MD_CLASS} streaming={isLive}>
            {content || (isLive ? '…' : '')}
          </MessageResponse>
        </div>
      ) : (
        <div className="agent-process-text__preview">{buildProcessTextPreview(content)}</div>
      )}
      {collapsible && (
        <button
          type="button"
          className="agent-process-text__toggle"
          onClick={() => setUserCollapsed((v) => !v)}
        >
          {open ? '收起这段' : '展开全文'}
        </button>
      )}
    </div>
  )
})

const ToolActivityRow = memo(function ToolActivityRow({
  tool,
  result,
  isStreaming,
}: {
  tool: TAgentToolUseBlock
  result?: TAgentToolResultBlock
  isStreaming: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const phrase = getToolPhrase(tool.name, tool.input)
  const done = Boolean(result)
  const isError = Boolean(result?.isError)
  const label = done || !isStreaming ? phrase.label : phrase.loadingLabel
  const resultHint =
    done && result ? summarizeToolResult(result.content, result.isError) : undefined

  const inputJson = useMemo(() => JSON.stringify(tool.input, null, 2), [tool.input])
  const resultText = useMemo(() => {
    if (!result) return ''
    const c = result.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .map((b) =>
          b && typeof b === 'object' && 'text' in b
            ? String((b as { text: unknown }).text)
            : '',
        )
        .join('\n')
    }
    try {
      return JSON.stringify(c, null, 2)
    } catch {
      return String(c ?? '')
    }
  }, [result])

  return (
    <div className={cn('agent-tool-row', isStreaming && 'is-active')}>
      <button type="button" className="agent-tool-row__main" onClick={() => setOpen((v) => !v)}>
        <span className="agent-tool-row__status" aria-hidden>
          {isStreaming ? (
            <CircleNotch size={13} className="animate-spin text-muted-foreground/50" />
          ) : isError ? (
            <WarningCircle size={13} weight="fill" className="text-destructive/70" />
          ) : (
            <Check size={13} weight="bold" className="text-muted-foreground/40" />
          )}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left text-[13px] text-muted-foreground/85',
            isStreaming && 'agent-process-group__live',
          )}
        >
          {label}
        </span>
        {resultHint && !open && (
          <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground/40">
            {resultHint}
          </span>
        )}
        <CaretRight
          size={11}
          className={cn(
            'shrink-0 text-muted-foreground/35 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>

      {open && (
        <div className="agent-tool-row__detail">
          <Collapsible defaultOpen>
            <CollapsibleTrigger className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground">
              入参
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ScrollArea className="mt-1 max-h-[160px] rounded-md border border-border/50 bg-muted/20">
                <div className="relative p-2">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/65">
                    {inputJson}
                  </pre>
                  <div className="absolute right-1.5 top-1.5">
                    <CopyButton content={inputJson} />
                  </div>
                </div>
              </ScrollArea>
            </CollapsibleContent>
          </Collapsible>
          {resultText && (
            <div className="mt-2">
              <div className="mb-1 text-[11px] text-muted-foreground/50">
                {isError ? '输出（失败）' : '输出'}
              </div>
              <ScrollArea
                className={cn(
                  'max-h-[200px] rounded-md border bg-muted/20',
                  isError ? 'border-destructive/30' : 'border-border/50',
                )}
              >
                <div className="relative p-2">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/65">
                    {resultText}
                  </pre>
                  <div className="absolute right-1.5 top-1.5">
                    <CopyButton content={resultText} />
                  </div>
                </div>
              </ScrollArea>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
