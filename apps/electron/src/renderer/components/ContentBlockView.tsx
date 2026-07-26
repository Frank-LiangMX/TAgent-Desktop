/**
 * ContentBlockView — IR content block 分发器
 *
 * 吃 TAgentContentBlock，按 type 分发到对应 @tagent/ui 组件。
 * text → MessageResponse（react-markdown + CodeBlock 自动集成）
 * thinking → Reasoning 折叠组件
 * tool_use → Collapsible + Badge + ScrollArea
 * 未知块 → null
 */

import type { TAgentContentBlock } from '@tagent/shared'

import {
  Badge,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  CopyButton,
  MessageResponse,
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
  ScrollArea,
} from '@tagent/ui'
import { ChevronDown } from 'lucide-react'
import * as React from 'react'

import { cn } from '../lib/utils'

// ===== Props =====

interface ContentBlockViewProps {
  block: TAgentContentBlock
  /** 是否正在流式输出（thinking 时传 defaultOpen） */
  isStreaming?: boolean
}

// ===== 分发器 =====

export function ContentBlockView({
  block,
  isStreaming = false,
}: ContentBlockViewProps): React.ReactElement | null {
  if (block.type === 'text') {
    return <TextBlockView block={block} />
  }
  if (block.type === 'thinking') {
    return <ThinkingBlockView block={block} isStreaming={isStreaming} />
  }
  if (block.type === 'tool_use') {
    return <ToolUseBlockView block={block} />
  }
  // 未知块原样忽略
  return null
}

// ===== text 块 =====

function TextBlockView({ block }: { block: TAgentContentBlock }): React.ReactElement {
  const textBlock = block as { type: 'text'; text: string }
  return <MessageResponse>{textBlock.text}</MessageResponse>
}

// ===== thinking 块 =====

function ThinkingBlockView({
  block,
  isStreaming,
}: {
  block: TAgentContentBlock
  isStreaming: boolean
}): React.ReactElement {
  const thinkingBlock = block as { type: 'thinking'; thinking: string }
  return (
    <Reasoning isStreaming={isStreaming} defaultOpen={isStreaming}>
      <ReasoningTrigger />
      <ReasoningContent>{thinkingBlock.thinking}</ReasoningContent>
    </Reasoning>
  )
}

// ===== tool_use 块 =====

function ToolUseBlockView({ block }: { block: TAgentContentBlock }): React.ReactElement {
  const toolBlock = block as {
    type: 'tool_use'
    id: string
    name: string
    input: Record<string, unknown>
  }

  const [isOpen, setIsOpen] = React.useState(false)
  const inputJson = React.useMemo(
    () => JSON.stringify(toolBlock.input, null, 2),
    [toolBlock.input]
  )

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      {/* 折叠态：Badge 显示工具名 + 小箭头 */}
      <CollapsibleTrigger
        className={cn(
          'flex items-center gap-1.5 cursor-pointer select-none',
          'text-muted-foreground hover:text-foreground transition-colors'
        )}
      >
        <Badge variant="secondary" className="text-xs font-mono">
          {toolBlock.name}
        </Badge>
        <ChevronDown
          className={cn(
            'size-3.5 transition-transform duration-200',
            isOpen ? 'rotate-180' : 'rotate-0'
          )}
        />
      </CollapsibleTrigger>

      {/* 展开态：ScrollArea + pre + CopyButton */}
      <CollapsibleContent className="mt-2">
        <ScrollArea className="max-h-[240px] w-full rounded-md border border-border bg-muted/30">
          <div className="relative p-3">
            <pre className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/70">
              {inputJson}
            </pre>
            <div className="absolute top-2 right-2">
              <CopyButton content={inputJson} />
            </div>
          </div>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  )
}
