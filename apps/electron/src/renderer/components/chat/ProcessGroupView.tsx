/**
 * ProcessGroupView — 可折叠「执行过程」组
 *
 * 把一堆 tool_use / thinking 收成一行摘要，默认完成后折叠，
 * 避免会话主线被工具徽章刷屏（对齐 General ProcessBlockGroup 意图）。
 */
import { useEffect, useRef, useState } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import type { ProcessEntry } from './session-turn-model'
import { summarizeProcess } from './session-turn-model'
import { ContentBlockView } from './ContentBlockView'
import { ToolResultView } from './ToolResultView'

const MAX_NAME_CHIPS = 4

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
  const shouldExpandByDefault = isStreaming
  const [expanded, setExpanded] = useState(shouldExpandByDefault)
  const userToggledRef = useRef(false)
  const wasStreamingRef = useRef(isStreaming)

  useEffect(() => {
    if (isStreaming) {
      if (!wasStreamingRef.current) userToggledRef.current = false
      if (!userToggledRef.current) setExpanded(true)
      wasStreamingRef.current = true
      return
    }
    if (wasStreamingRef.current && !userToggledRef.current) {
      // 完成后自动收起，主线只留回答
      const t = window.setTimeout(() => setExpanded(false), 400)
      wasStreamingRef.current = false
      return () => window.clearTimeout(t)
    }
    wasStreamingRef.current = false
  }, [isStreaming])

  const visibleNames = summary.toolNames.slice(0, MAX_NAME_CHIPS)
  const hidden = Math.max(0, summary.toolNames.length - visibleNames.length)

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
            'shrink-0 text-muted-foreground/50 transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px] font-medium text-muted-foreground',
            isStreaming && 'agent-process-group__live',
          )}
        >
          {summary.label}
        </span>
        {visibleNames.length > 0 && (
          <span className="flex shrink-0 items-center gap-1">
            {visibleNames.map((name) => (
              <span key={name} className="agent-process-group__chip">
                {name}
              </span>
            ))}
            {hidden > 0 && (
              <span className="text-[10px] tabular-nums text-muted-foreground/50">+{hidden}</span>
            )}
          </span>
        )}
      </button>

      {expanded && (
        <div className="agent-process-group__body">
          {process.map((entry) => (
            <div key={entry.key} className="agent-process-group__row">
              {entry.type === 'thinking' && (
                <ContentBlockView
                  block={{ type: 'thinking', thinking: entry.thinking }}
                  isStreaming={isStreaming}
                />
              )}
              {entry.type === 'tool' && (
                <div className="flex flex-col gap-1">
                  <ContentBlockView
                    block={{
                      type: 'tool_use',
                      id: entry.tool.id,
                      name: entry.tool.name,
                      input: entry.tool.input,
                    }}
                  />
                  {entry.result && <ToolResultView block={entry.result} />}
                </div>
              )}
              {entry.type === 'text' && (
                <ContentBlockView block={{ type: 'text', text: entry.text }} />
              )}
            </div>
          ))}
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
