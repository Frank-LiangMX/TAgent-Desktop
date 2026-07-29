/**
 * ProcessGroupView — Agent 过程区（对齐 General）
 *
 * - **运行中（isLive）**：会话区直接展开，看见思考内容 + 工具语义行
 * - **结束后**：自动收成一行摘要（用户未手动展开则收起）
 * - 不是「只显示步数」的黑盒
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CaretRight, Check, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  ScrollArea,
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
}

export function ProcessGroupView({
  process,
  isLive,
  isStreaming = false,
}: ProcessGroupViewProps): JSX.Element | null {
  if (process.length === 0) return null

  const live = isLive ?? isStreaming
  const summary = summarizeProcess(process)
  const [expanded, setExpanded] = useState(live)
  const userToggledRef = useRef(false)
  const wasLiveRef = useRef(live)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (live) {
      if (!wasLiveRef.current) userToggledRef.current = false
      // 运行中强制展开（除非用户刚手动收起）
      if (!userToggledRef.current) setExpanded(true)
      wasLiveRef.current = true
      return
    }
    if (wasLiveRef.current && !userToggledRef.current) {
      const t = window.setTimeout(() => setExpanded(false), 800)
      wasLiveRef.current = false
      return () => window.clearTimeout(t)
    }
    wasLiveRef.current = false
  }, [live])

  useEffect(() => {
    if (!live || !expanded) return
    const el = bodyRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [process.length, live, expanded, process[process.length - 1]?.key])

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
        <div ref={bodyRef} className="agent-process-group__body agent-process-group__body--scroll">
          {process.map((entry) => {
            if (entry.type === 'thinking') {
              const isCurrent = live && entry.key === lastThinkingKey
              return (
                <ThinkingActivityRow
                  key={entry.key}
                  thinking={entry.thinking}
                  isLive={isCurrent}
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
function ThinkingActivityRow({
  thinking,
  isLive,
}: {
  thinking: string
  isLive: boolean
}): JSX.Element {
  const [open, setOpen] = useState(isLive)
  useEffect(() => {
    if (isLive) setOpen(true)
  }, [isLive])

  const preview = thinking.trim().replace(/\s+/g, ' ')
  const short = preview.length > 72 ? `${preview.slice(0, 72)}…` : preview

  return (
    <div className={cn('agent-thinking-row', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-thinking-row__head"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-thinking-row__badge">思考</span>
        {isLive && <span className="agent-thinking-row__dot" aria-hidden />}
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground/65">
            {short || '…'}
          </span>
        )}
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
      {open && (
        <div className="agent-thinking-row__body">
          {thinking.trim() || (isLive ? '…' : '')}
        </div>
      )}
    </div>
  )
}

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
}
