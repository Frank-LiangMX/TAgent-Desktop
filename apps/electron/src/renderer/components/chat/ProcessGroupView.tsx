/**
 * ProcessGroupView — Agent 过程区
 *
 * - **运行中**：强制展开，实时看到思考 + 当前工具行（不能只剩步数）
 * - **结束后**：自动收成一行摘要（用户未手动钉开时）
 * - 行内是语义短语，不是 Bash/结果徽章墙
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CaretRight, Check, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  ScrollArea,
} from '@tagent/ui'
import { cn } from '../../lib/utils'
import type { ProcessEntry } from './session-turn-model'
import { summarizeProcess } from './session-turn-model'
import { getToolPhrase, summarizeToolResult } from './tool-phrase'
import type { TAgentToolResultBlock, TAgentToolUseBlock } from '@tagent/shared'

interface ProcessGroupViewProps {
  process: ProcessEntry[]
  isStreaming?: boolean
}

export function ProcessGroupView({
  process,
  isStreaming = false,
}: ProcessGroupViewProps): JSX.Element | null {
  if (process.length === 0) return null

  const summary = summarizeProcess(process)
  // 运行中默认展开；历史回合默认折叠
  const [expanded, setExpanded] = useState(isStreaming)
  const userToggledRef = useRef(false)
  const wasStreamingRef = useRef(isStreaming)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isStreaming) {
      // 新一轮流式：复位手动折叠，强制展开让用户看到过程
      if (!wasStreamingRef.current) userToggledRef.current = false
      if (!userToggledRef.current) setExpanded(true)
      wasStreamingRef.current = true
      return
    }
    // 刚结束且用户没手动钉开 → 收起，主线只留回答
    if (wasStreamingRef.current && !userToggledRef.current) {
      const t = window.setTimeout(() => setExpanded(false), 600)
      wasStreamingRef.current = false
      return () => window.clearTimeout(t)
    }
    wasStreamingRef.current = false
  }, [isStreaming])

  // 运行中过程变长时滚到最新一行
  useEffect(() => {
    if (!isStreaming || !expanded) return
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [process.length, isStreaming, expanded, process[process.length - 1]?.key])

  const liveHint = useMemo(() => {
    if (!isStreaming) return null
    // 从后往前找当前正在进行的活动
    for (let i = process.length - 1; i >= 0; i--) {
      const e = process[i]!
      if (e.type === 'tool' && !e.result) {
        return getToolPhrase(e.tool.name, e.tool.input).loadingLabel
      }
      if (e.type === 'thinking') return '正在思考…'
      if (e.type === 'tool' && e.result) {
        return getToolPhrase(e.tool.name, e.tool.input).label
      }
    }
    return '正在执行…'
  }, [isStreaming, process])

  const headerLabel = useMemo(() => {
    if (isStreaming) {
      const done = process.filter((p) => p.type === 'tool' && p.result).length
      const total = summary.toolCount
      const steps = total > 0 ? `${done}/${total} 步` : null
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
  }, [isStreaming, process, summary, liveHint])

  // 运行中以展开为准（用户手动收起仍尊重）
  const showBody = expanded

  // 最后一条 thinking 在流式中保持展开，便于盯着想
  const lastThinkingKey = useMemo(() => {
    for (let i = process.length - 1; i >= 0; i--) {
      if (process[i]?.type === 'thinking') return process[i]!.key
    }
    return null
  }, [process])

  return (
    <div className={cn('agent-process-group', isStreaming && 'is-live')}>
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
            'min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground/75',
            isStreaming && 'agent-process-group__live',
          )}
        >
          {headerLabel}
        </span>
        {!showBody && !isStreaming && summary.toolCount > 0 && (
          <span className="shrink-0 text-[11px] text-muted-foreground/40">查看过程</span>
        )}
        {isStreaming && showBody && (
          <span className="shrink-0 text-[11px] text-muted-foreground/40">运行中</span>
        )}
      </button>

      {showBody && (
        <div ref={bodyRef} className="agent-process-group__body agent-process-group__body--scroll">
          {process.map((entry) => {
            if (entry.type === 'thinking') {
              const live = isStreaming && entry.key === lastThinkingKey
              return (
                <div key={entry.key} className="agent-tool-row agent-tool-row--thinking">
                  <Reasoning isStreaming={live} defaultOpen={live}>
                    <ReasoningTrigger />
                    <ReasoningContent>{entry.thinking}</ReasoningContent>
                  </Reasoning>
                </div>
              )
            }
            if (entry.type === 'tool') {
              return (
                <ToolActivityRow
                  key={entry.key}
                  tool={entry.tool}
                  result={entry.result}
                  isStreaming={isStreaming && !entry.result}
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
          {!isStreaming && (
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

/** 单行语义工具活动：读取 a.ts · 执行 ls — 点开才看明细 */
function ToolActivityRow({
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
    done && result
      ? summarizeToolResult(result.content, result.isError)
      : undefined

  const inputJson = useMemo(() => JSON.stringify(tool.input, null, 2), [tool.input])
  const resultText = useMemo(() => {
    if (!result) return ''
    const c = result.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
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
      <button
        type="button"
        className="agent-tool-row__main"
        onClick={() => setOpen((v) => !v)}
      >
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
            'min-w-0 flex-1 truncate text-left text-[13px] text-muted-foreground/80',
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
}
