/**
 * ProcessGroupView — 正常 Agent 过程区
 *
 * 折叠：一行「执行了 N 步」摘要，无工具名徽章墙。
 * 展开：语义短语行（读取 xx / 执行 ls…），点开才见入参与输出；
 * 不再并排「Bash」+「结果」双徽章（那是调试 UI，不是对话 UI）。
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
  const [expanded, setExpanded] = useState(false) // 默认折叠：主线只看回答
  const userToggledRef = useRef(false)
  const wasStreamingRef = useRef(isStreaming)

  useEffect(() => {
    if (isStreaming) {
      // 流式中也保持折叠，只闪「正在执行」；需要看过程再点开
      if (!wasStreamingRef.current) userToggledRef.current = false
      wasStreamingRef.current = true
      return
    }
    if (wasStreamingRef.current && !userToggledRef.current) {
      setExpanded(false)
    }
    wasStreamingRef.current = false
  }, [isStreaming])

  const headerLabel = useMemo(() => {
    if (isStreaming) {
      const done = process.filter((p) => p.type === 'tool' && p.result).length
      const total = summary.toolCount
      if (total > 0) return `正在执行… · 已完成 ${done}/${total} 步`
      return '正在思考与执行…'
    }
    if (summary.toolCount > 0 && summary.thinkingCount > 0) {
      return `已执行 ${summary.toolCount} 步 · 含 ${summary.thinkingCount} 段思考`
    }
    if (summary.toolCount > 0) return `已执行 ${summary.toolCount} 步`
    if (summary.thinkingCount > 0) return `思考 ${summary.thinkingCount} 段`
    return summary.label
  }, [isStreaming, process, summary])

  return (
    <div className="agent-process-group">
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
            expanded && 'rotate-90',
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
        {!expanded && !isStreaming && summary.toolCount > 0 && (
          <span className="shrink-0 text-[11px] text-muted-foreground/40">查看过程</span>
        )}
      </button>

      {expanded && (
        <div className="agent-process-group__body">
          {process.map((entry) => {
            if (entry.type === 'thinking') {
              return (
                <div key={entry.key} className="agent-tool-row agent-tool-row--thinking">
                  <Reasoning defaultOpen={false}>
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
              // 中间碎文本不当主回答，压成次要一行
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
