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

import type {
  TAgentMessage,
  TAgentToolResultBlock,
  TAgentTextBlock,
} from '@tagent/shared'

import {
  Badge,
  Message,
  MessageContent,
  UserMessageContent,
} from '@tagent/ui'

import { cn } from '../../lib/utils'
import { ContentBlockView } from './ContentBlockView'
import { ToolResultView } from './ToolResultView'

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
  return (
    <Message from="assistant">
      {/* 子代理输出标识：左边框 + 缩进，区分主 Agent 和 SubAgent */}
      {isSubagent && (
        <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
          <span className="inline-block size-1.5 rounded-full bg-primary/40" />
          <span>子代理输出</span>
        </div>
      )}
      {/* 模型名胶囊（9px 玻璃胶囊，对齐 TAgent_General，无头像） */}
      {message.modelId && (
        <div className="agent-turn-title mb-2.5">{message.modelId}</div>
      )}
      <MessageContent className={isSubagent ? 'border-l-2 border-primary/20 pl-3' : ''}>
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
