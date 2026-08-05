/**
 * ConciseTimelineView — Cursor 式简洁时间线
 *
 * thinking / tool_cluster：一行摘要折叠；narrative：回答级 Markdown 穿插流式。
 */
import { memo, useState } from 'react'
import { CaretRight, Check, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import { Message, MessageContent, MessageResponse, useSmoothStream } from '@tagent/ui'
import { cn } from '../../lib/utils'
import type { ConciseSegment, ToolProcessEntry } from './concise-timeline-model'
import { getToolPhrase, summarizeToolResult } from './tool-phrase'

interface ConciseTimelineViewProps {
  segments: ConciseSegment[]
  isLive?: boolean
}

export function ConciseTimelineView({
  segments,
  isLive = false,
}: ConciseTimelineViewProps): JSX.Element | null {
  if (segments.length === 0) return null

  const lastNarrativeKey = (() => {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i]!.kind === 'narrative') return segments[i]!.key
    }
    return null
  })()

  return (
    <div className="agent-concise-timeline">
      {segments.map((seg) => {
        if (seg.kind === 'thinking') {
          return (
            <ThinkingFold
              key={seg.key}
              thinking={seg.thinking}
              isLive={isLive && isLastOfKind(segments, seg.key, 'thinking')}
            />
          )
        }
        if (seg.kind === 'tool_cluster') {
          return (
            <ToolClusterFold
              key={seg.key}
              summary={seg.summary}
              tools={seg.tools}
              isLive={isLive && seg.tools.some((t) => !t.result)}
            />
          )
        }
        return (
          <NarrativeRow
            key={seg.key}
            text={seg.text}
            isStreaming={isLive && seg.key === lastNarrativeKey}
          />
        )
      })}
    </div>
  )
}

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
  isLive,
}: {
  thinking: string
  isLive: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const { displayedContent } = useSmoothStream({
    content: thinking,
    isStreaming: isLive,
  })
  // 不用整轮耗时：多段思考会全部显示同一个「思考了 N 秒」。
  // Cursor 语感：每段独立「思考了片刻」；live 当前段「正在思考…」。
  const summary = isLive ? '正在思考…' : '思考了片刻'

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

const ToolClusterFold = memo(function ToolClusterFold({
  summary,
  tools,
  isLive,
}: {
  summary: string
  tools: ToolProcessEntry[]
  isLive: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className={cn('agent-concise-fold', isLive && 'is-live')}>
      <button
        type="button"
        className="agent-concise-fold__head"
        onClick={() => setOpen((v) => !v)}
      >
        {isLive ? (
          <CircleNotch size={12} className="shrink-0 animate-spin text-muted-foreground/45" />
        ) : (
          <Check size={12} weight="bold" className="shrink-0 text-muted-foreground/35" />
        )}
        <span className="agent-concise-fold__summary">{summary}</span>
        <CaretRight
          size={11}
          className={cn(
            'ml-auto shrink-0 text-muted-foreground/35 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      {open ? (
        <div className="agent-concise-fold__body agent-concise-fold__body--tools">
          {tools.map((t) => (
            <ClusterToolLine
              key={t.key}
              tool={t}
              isStreaming={isLive && !t.result}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
})

const ClusterToolLine = memo(function ClusterToolLine({
  tool,
  isStreaming,
}: {
  tool: ToolProcessEntry
  isStreaming: boolean
}): JSX.Element {
  const phrase = getToolPhrase(tool.tool.name, tool.tool.input)
  const done = Boolean(tool.result)
  const isError = Boolean(tool.result?.isError)
  const label = done || !isStreaming ? phrase.label : phrase.loadingLabel
  const resultHint =
    done && tool.result
      ? summarizeToolResult(tool.result.content, tool.result.isError)
      : undefined

  return (
    <div className={cn('agent-concise-tool-line', isStreaming && 'is-active')}>
      <span className="agent-concise-tool-line__icon" aria-hidden>
        {isStreaming ? (
          <CircleNotch size={12} className="animate-spin text-muted-foreground/50" />
        ) : isError ? (
          <WarningCircle size={12} weight="fill" className="text-destructive/70" />
        ) : (
          <Check size={12} weight="bold" className="text-muted-foreground/40" />
        )}
      </span>
      <span className="agent-concise-tool-line__label">{label}</span>
      {resultHint ? (
        <span className="agent-concise-tool-line__hint">{resultHint}</span>
      ) : null}
    </div>
  )
})

const NarrativeRow = memo(function NarrativeRow({
  text,
  isStreaming,
}: {
  text: string
  isStreaming: boolean
}): JSX.Element {
  const { displayedContent } = useSmoothStream({
    content: text,
    isStreaming,
  })
  const content = displayedContent.trim()

  return (
    <div className="agent-concise-narrative">
      <Message from="assistant">
        <MessageContent>
          {content ? (
            <MessageResponse streaming={isStreaming}>{displayedContent}</MessageResponse>
          ) : isStreaming ? (
            <span className="text-muted-foreground/50">…</span>
          ) : null}
        </MessageContent>
      </Message>
    </div>
  )
})

/** 供复制栏：拼接全部 narrative */
export function joinNarrativeTexts(segments: ConciseSegment[]): string {
  return segments
    .filter((s): s is Extract<ConciseSegment, { kind: 'narrative' }> => s.kind === 'narrative')
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n\n')
}
