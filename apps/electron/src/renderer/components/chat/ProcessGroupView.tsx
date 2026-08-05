/**
 * ProcessGroupView — Agent 过程区（对齐 General）
 *
 * - **运行中（isLive）**：会话区直接展开，看见思考内容 + 工具语义行
 * - **结束后**：自动收成一行摘要（用户未手动展开则收起）
 * - 不是「只显示步数」的黑盒
 */
import { memo, useLayoutEffect, useEffect, useMemo, useRef, useState } from 'react'
import { CaretRight, Check, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  ScrollArea,
  useSmoothStream,
} from '@tagent/ui'
import { cn } from '../../lib/utils'
import type { ProcessEntry } from './session-turn-model'
import { summarizeProcess } from './session-turn-model'
import { getToolPhrase, summarizeToolResult } from './tool-phrase'
import type { TAgentToolResultBlock, TAgentToolUseBlock } from '@tagent/shared'

interface ProcessGroupViewProps {
  process: ProcessEntry[]
  /** 本轮 Agent 仍在活动（含流式与工具间隙） */
  isLive?: boolean
  /** @deprecated 使用 isLive */
  isStreaming?: boolean
  /**
   * 运行中是否自动展开过程区。默认 true（主会话要看见实时思考/工具）。
   * 子代理详情页传 false：默认只显示一行摘要，点开再看步骤，避免思考/工具全文铺满。
   */
  autoExpandWhenLive?: boolean
}

export function ProcessGroupView({
  process,
  isLive,
  isStreaming = false,
  autoExpandWhenLive = true,
}: ProcessGroupViewProps): JSX.Element | null {
  if (process.length === 0) return null

  const live = isLive ?? isStreaming
  const summary = summarizeProcess(process)
  const [expanded, setExpanded] = useState(autoExpandWhenLive ? live : false)
  const userToggledRef = useRef(false)
  const wasLiveRef = useRef(live)

  useEffect(() => {
    if (live) {
      if (!wasLiveRef.current) userToggledRef.current = false
      // 运行中自动展开（除非用户刚手动收起，或调用方关闭 autoExpandWhenLive）
      if (!userToggledRef.current && autoExpandWhenLive) setExpanded(true)
      wasLiveRef.current = true
      return
    }
    // 结束后不再时间驱动自动收起（2.5s 定时收起在工具循环中反复触发 = 跳变）。
    // 思考行内部自己做「内容驱动折叠」（超阈值收成预览），过程区保持展开由用户手动收起。
    wasLiveRef.current = false
  }, [live, autoExpandWhenLive])

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
    if (live) {
      const done = process.filter((p) => p.type === 'tool' && p.result).length
      const total = summary.toolCount
      const steps = total > 0 ? `${done}/${total}` : null
      if (liveHint && steps) return `${liveHint} · ${steps}`
      if (liveHint) return liveHint
      return '正在思考与执行…'
    }
    if (summary.toolCount > 0 && summary.thinkingCount > 0) {
      return `已执行 ${summary.toolCount} 步 · 含 ${summary.thinkingCount} 段思考`
    }
    if (summary.toolCount > 0) return `已执行 ${summary.toolCount} 步`
    if (summary.thinkingCount > 0) return `思考 ${summary.thinkingCount} 段`
    return summary.label
  }, [live, process, summary, liveHint])

  const showBody = expanded

  const lastThinkingKey = useMemo(() => {
    for (let i = process.length - 1; i >= 0; i--) {
      if (process[i]?.type === 'thinking') return process[i]!.key
    }
    return null
  }, [process])

  return (
    <div className={cn('agent-process-group', live && 'is-live')}>
      <button
        type="button"
        className="agent-process-group__toggle"
        onClick={() => {
          userToggledRef.current = true
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
        {!showBody && !live && (summary.toolCount > 0 || summary.thinkingCount > 0) && (
          <span className="shrink-0 text-[11px] text-muted-foreground/40">查看过程</span>
        )}
      </button>

      {showBody && (
        <div className="agent-process-group__body">
          {process.map((entry) => {
            if (entry.type === 'thinking') {
              const isCurrent = live && entry.key === lastThinkingKey
              return (
                <ThinkingActivityRow
                  key={entry.key}
                  thinking={entry.thinking}
                  isLive={isCurrent}
                  /** 整轮 live 时旧思考段也不自动折叠，避免「思考收起→工具出现」上下跳 */
                  holdOpen={live}
                />
              )
            }
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
              const preview = entry.text.trim().replace(/\s+/g, ' ')
              if (!preview) return null
              return (
                <div key={entry.key} className="agent-tool-row agent-tool-row--muted">
                  <span className="truncate text-[12px] text-muted-foreground/55">
                    {preview.length > 80 ? `${preview.slice(0, 80)}…` : preview}
                  </span>
                </div>
              )
            }
            return null
          })}
          {!live && (
            <button
              type="button"
              className="agent-process-group__collapse"
              onClick={() => {
                userToggledRef.current = true
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

/** 思考行：运行中直接展开正文（对齐 General live thinking） */
const ThinkingActivityRow = memo(function ThinkingActivityRow({
  thinking,
  isLive,
  holdOpen = false,
}: {
  thinking: string
  isLive: boolean
  /** 整轮过程仍在跑：保持展开，不因「非当前思考段」自动折成预览 */
  holdOpen?: boolean
}): JSX.Element {
  // live 时逐字平滑挤出（对齐 1.0/Proma：thinking 独立 useSmoothStream）。
  // 源是 rAF 节流后的整块 delta，逐字后视觉丝滑；非 live 时 content 固定直接显示。
  const { displayedContent } = useSmoothStream({
    content: thinking,
    isStreaming: isLive,
  })

  // 当前段 live 或整轮 holdOpen：强制展开；整轮结束后再内容驱动折叠
  const forceOpen = isLive || holdOpen
  const [open, setOpen] = useState(forceOpen)
  useEffect(() => {
    if (forceOpen) setOpen(true)
  }, [forceOpen])

  // 内容驱动折叠：仅整轮结束后（!holdOpen && !isLive）超阈值才折预览
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickToLatestRef = useRef(true)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (forceOpen || !el) return
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20
    if (el.scrollHeight > lineHeight * 4 + 8) setOpen(false)
  }, [displayedContent, forceOpen])

  // live 时正文跟随最新：新内容追加后滚到底；用户滚离底部（想从头读）时暂停跟随
  useEffect(() => {
    if (!isLive) return
    const el = bodyRef.current
    if (!el || !stickToLatestRef.current) return
    el.scrollTop = el.scrollHeight
  }, [displayedContent, isLive])

  return (
    <div className={cn('agent-thinking-row', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-thinking-row__head"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-thinking-row__badge">思考</span>
        {isLive && <span className="agent-thinking-row__dot" aria-hidden />}
        {open && isLive && (
          <span className="text-[11px] text-muted-foreground/45">进行中</span>
        )}
        <CaretRight
          size={11}
          className={cn(
            'ml-auto shrink-0 text-muted-foreground/35 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      <div
        ref={bodyRef}
        className={cn('agent-thinking-row__body', !open && 'is-collapsed')}
        onScroll={(e) => {
          const el = e.currentTarget
          // 距底 < 24px 视为"在底部"：在底 → 继续跟随最新；滚上去读 → 停止跟随
          stickToLatestRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {displayedContent.trim() || (isLive || holdOpen ? '…' : '')}
      </div>
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
