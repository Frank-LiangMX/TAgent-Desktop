/**
 * MessageView — 消息壳组件（重写，零 inline style）
 *
 * 吃 TAgentMessage（IR），按 user / assistant 分发到 @tagent/ui 原语。
 * user 消息：Message(user) + UserMessageContent（可折叠）
 * assistant 消息：Message(assistant) + MessageHeader + ContentBlockView
 * error：Badge(destructive)
 *
 * 双核统一：kscc 核经主进程转译成 IR，Pi 核未来也转 IR，渲染层一套。
 */

import { useState, useMemo } from 'react'
import type {
  TAgentMessage,
  TAgentToolResultBlock,
  TAgentTextBlock,
} from '@tagent/shared'

import {
  Badge,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Message,
  MessageContent,
  UserMessageContent,
} from '@tagent/ui'
import { ChevronDown } from 'lucide-react'

import { cn } from '../../lib/utils'
import { ContentBlockView } from './ContentBlockView'
import { ToolResultView } from './ToolResultView'
import { summarizeFirstText } from './subagent-ui-model'

// ===== 主组件 =====

export function MessageView({ message }: { message: TAgentMessage }): React.ReactElement {
  if (message.type === 'user') {
    return <UserView message={message} />
  }
  return <AssistantView message={message} />
}

// ===== user 消息 =====

function UserView({
  message,
}: {
  message: Extract<TAgentMessage, { type: 'user' }>
}): React.ReactElement {
  // 分离 text 块和 tool_result 块
  const textBlocks = message.content.filter(
    (b): b is TAgentTextBlock => b.type === 'text'
  )
  const toolResultBlocks = message.content.filter(
    (b): b is TAgentToolResultBlock => b.type === 'tool_result'
  )

  return (
    <Message from="user">
      <MessageContent>
        {/* text 块拼接传给 UserMessageContent（超4行自动折叠） */}
        {textBlocks.length > 0 && (
          <UserMessageContent>
            {textBlocks.map((b) => b.text).join('\n')}
          </UserMessageContent>
        )}
        {/* tool_result 块独立渲染 */}
        {toolResultBlocks.map((b) => (
          <ToolResultView key={b.toolUseId} block={b} />
        ))}
      </MessageContent>
    </Message>
  )
}

// ===== assistant 消息 =====

function AssistantView({
  message,
}: {
  message: Extract<TAgentMessage, { type: 'assistant' }>
}): React.ReactElement {
  const isSubagent = !!message.parentToolUseId
  // 子代理输出默认折叠：折叠头 = 「子代理 · 点击展开」+ 一行摘要（首段 text 截断）
  const [open, setOpen] = useState(false)
  const summary = useMemo(
    () => (isSubagent ? summarizeFirstText(message) : ''),
    [message, isSubagent],
  )

  if (isSubagent) {
    return (
      <Message from="assistant">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className={cn(
              'group flex w-full items-center gap-1.5 text-xs transition-colors',
              'text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="inline-block size-1.5 shrink-0 rounded-full bg-primary/40" />
            <span className="shrink-0 font-medium text-foreground/70">子代理</span>
            <span className="shrink-0 text-muted-foreground/60">
              · {open ? '点击折叠' : '点击展开'}
            </span>
            {!open && summary && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground/70">· {summary}</span>
            )}
            <ChevronDown
              className={cn(
                'size-3 shrink-0 transition-transform',
                open ? 'rotate-180' : 'rotate-0',
              )}
            />
          </CollapsibleTrigger>

          {/* 展开后保留左边框样式（对齐旧版子代理输出区） */}
          <CollapsibleContent>
            {message.modelId && (
              <div className="agent-turn-title mb-2.5 mt-2">{message.modelId}</div>
            )}
            <MessageContent className="border-l-2 border-primary/20 pl-3">
              {/* 错误状态 */}
              {message.error && (
                <Badge variant="destructive" className="mb-2 text-xs">
                  {message.error.message}
                </Badge>
              )}
              {/* content blocks 渲染 */}
              {message.content.map((block, i) => (
                <ContentBlockView key={i} block={block} />
              ))}
            </MessageContent>
          </CollapsibleContent>
        </Collapsible>
      </Message>
    )
  }

  // 主 Agent 输出：不折叠，原样渲染
  return (
    <Message from="assistant">
      {/* 模型名胶囊（9px 玻璃胶囊，对齐 TAgent_General，无头像） */}
      {message.modelId && (
        <div className="agent-turn-title mb-2.5">{message.modelId}</div>
      )}
      <MessageContent>
        {/* 错误状态 */}
        {message.error && (
          <Badge variant="destructive" className="mb-2 text-xs">
            {message.error.message}
          </Badge>
        )}
        {/* content blocks 渲染 */}
        {message.content.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
      </MessageContent>
    </Message>
  )
}
