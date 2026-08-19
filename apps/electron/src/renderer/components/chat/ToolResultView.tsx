/**
 * ToolResultView — 工具结果渲染
 *
 * 吃 TAgentToolResultBlock，用 Collapsible + Badge 展示。
 * error 时红色左边框，内容按 string / TAgentTextBlock[] / other 三路处理。
 */

import type { TAgentToolResultBlock, TAgentTextBlock } from '@tagent/shared'

import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  ScrollArea,
} from '@tagent/ui'
import { ChevronDown } from 'lucide-react'
import * as React from 'react'

import { cn } from '../../lib/utils'

// ===== Props =====

interface ToolResultViewProps {
  block: TAgentToolResultBlock
}

// ===== 组件 =====

export function ToolResultView({ block }: ToolResultViewProps): React.ReactElement {
  const [isOpen, setIsOpen] = React.useState(false)

  // 解析内容文本
  const displayText = React.useMemo(() => extractText(block.content), [block.content])
  const copyContent = React.useMemo(() => extractCopyContent(block.content), [block.content])

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      {/* 折叠态：Badge + 状态标记 */}
      <CollapsibleTrigger
        className={cn(
          'flex items-center gap-1.5 cursor-pointer select-none',
          'text-muted-foreground hover:text-foreground transition-colors'
        )}
      >
        <Badge variant={block.isError ? 'destructive' : 'outline'} className="text-xs font-mono">
          结果
        </Badge>
        <span className={cn('text-xs', block.isError ? 'text-destructive' : 'text-foreground/50')}>
          {block.isError ? '✗' : '✓'}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 transition-transform duration-200 ease-linear',
            isOpen ? 'rotate-180' : 'rotate-0'
          )}
        />
      </CollapsibleTrigger>

      {/* 展开态：ScrollArea + 内容 + CopyButton */}
      <CollapsibleContent className="mt-2">
        <ScrollArea
          className={cn(
            'max-h-[240px] w-full rounded-md border bg-muted/30',
            block.isError
              ? 'border-l-2 border-l-destructive border-border'
              : 'border-border'
          )}
        >
          <div className="relative p-3">
            <pre className="whitespace-pre-wrap break-words text-xs font-mono text-foreground/70">
              {displayText}
            </pre>
            <div className="absolute top-2 right-2">
              <CopyButton content={copyContent} />
            </div>
          </div>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ===== 辅助：内容提取 =====

/** 从 tool_result.content 提取展示文本 */
function extractText(content: TAgentToolResultBlock['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (isTextBlockArray(content)) {
    return content.map((b) => b.text).join('\n')
  }
  return JSON.stringify(content, null, 2)
}

/** 从 tool_result.content 提取复制用纯文本（不截断） */
function extractCopyContent(content: TAgentToolResultBlock['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (isTextBlockArray(content)) {
    return content.map((b) => b.text).join('\n')
  }
  return JSON.stringify(content, null, 2)
}

/** 类型守卫：判断是否为 TAgentTextBlock[] */
function isTextBlockArray(val: unknown): val is TAgentTextBlock[] {
  if (!Array.isArray(val)) return false
  return val.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      item.type === 'text' &&
      'text' in item &&
      typeof item.text === 'string'
  )
}
