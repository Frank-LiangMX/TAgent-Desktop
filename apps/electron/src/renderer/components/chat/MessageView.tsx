/**
 * MessageView — 消息壳组件（重写，零 inline style）
 *
 * 吃 TAgentMessage（IR），按 user / assistant 分发到 @tagent/ui 原语。
 * user：顶部用户铭牌+时间 · 气泡 · 底部复制
 * assistant：模型铭牌+时间 · 内容 · 底部复制
 */

import { useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import type {
  TAgentMessage,
  TAgentToolResultBlock,
  TAgentTextBlock,
} from '@tagent/shared'
import { DEFAULT_USER_NAME } from '@tagent/shared'

import {
  Badge,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Message,
  MessageContent,
  UserMessageContent,
  MessageAttachments,
} from '@tagent/ui'
import { ChevronDown } from 'lucide-react'

import { cn } from '../../lib/utils'
import { formatMessageTime } from '../../lib/time-utils'
import { userProfileAtom } from '../../atoms/user-profile'
import { ContentBlockView } from './ContentBlockView'
import { ToolResultView } from './ToolResultView'
import { summarizeFirstText } from './subagent-ui-model'
import { MessageCopyButton } from './MessageCopyButton'
import { MessageRefillButton } from './MessageRefillButton'

// ===== 主组件 =====

export function MessageView({
  message,
  onRefillToInput,
}: {
  message: TAgentMessage
  /** 用户消息：填入输入框以便改写重发 */
  onRefillToInput?: (text: string) => void
}): React.ReactElement {
  if (message.type === 'user') {
    return <UserView message={message} onRefillToInput={onRefillToInput} />
  }
  return <AssistantView message={message} />
}

// ===== user 消息 =====

function UserView({
  message,
  onRefillToInput,
}: {
  message: Extract<TAgentMessage, { type: 'user' }>
  onRefillToInput?: (text: string) => void
}): React.ReactElement {
  const profile = useAtomValue(userProfileAtom)
  const userName = (profile.userName || DEFAULT_USER_NAME).trim() || DEFAULT_USER_NAME

  const textBlocks = message.content.filter(
    (b): b is TAgentTextBlock => b.type === 'text',
  )
  const toolResultBlocks = message.content.filter(
    (b): b is TAgentToolResultBlock => b.type === 'tool_result',
  )
  const plainText = textBlocks.map((b) => b.text).join('\n')
  const showChrome = textBlocks.length > 0

  return (
    <Message from="user">
      {/* 顶部：时间 + 用户铭牌（右对齐） */}
      {showChrome ? (
        <div className="agent-user-title-row">
          {message.createdAt ? (
            <span className="agent-user-title-row__time">
              {formatMessageTime(message.createdAt)}
            </span>
          ) : null}
          <div className="agent-user-title" title={userName}>
            {userName}
          </div>
        </div>
      ) : null}

      <MessageContent>
        {message.attachments?.length ? (
          <MessageAttachments
            attachments={message.attachments}
            onReadAttachment={async (localPath) => {
              const base64 = await (window as any).electronAPI.readAttachment(localPath)
              return base64
            }}
          />
        ) : null}
        {textBlocks.length > 0 && (
          <UserMessageContent>{plainText}</UserMessageContent>
        )}
        {toolResultBlocks.map((b) => (
          <ToolResultView key={b.toolUseId} block={b} />
        ))}
      </MessageContent>

      {/* 底部：填入输入框 + 复制（仅图标，hover tooltip） */}
      {showChrome && plainText.trim() ? (
        <div className="agent-user-toolbar">
          {onRefillToInput ? (
            <MessageRefillButton text={plainText} onRefill={onRefillToInput} />
          ) : null}
          <MessageCopyButton text={plainText} />
        </div>
      ) : null}
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
  const [open, setOpen] = useState(false)
  const summary = useMemo(
    () => (isSubagent ? summarizeFirstText(message) : ''),
    [message, isSubagent],
  )

  const plainText = useMemo(
    () =>
      message.content
        .filter((b): b is TAgentTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    [message.content],
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
              <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
                · {summary}
              </span>
            )}
            <ChevronDown
              className={cn(
                'size-3 shrink-0 transition-transform',
                open ? 'rotate-180' : 'rotate-0',
              )}
            />
          </CollapsibleTrigger>

          <CollapsibleContent>
            {(message.modelId || message.createdAt) && (
              <div className="agent-turn-title-row mb-2.5 mt-2">
                {message.modelId ? (
                  <div className="agent-turn-title">{message.modelId}</div>
                ) : null}
                {message.createdAt ? (
                  <span className="agent-turn-title-row__time">
                    {formatMessageTime(message.createdAt)}
                  </span>
                ) : null}
              </div>
            )}
            <MessageContent className="border-l-2 border-primary/20 pl-3">
              {message.error && (
                <Badge variant="destructive" className="mb-2 text-xs">
                  {message.error.message}
                </Badge>
              )}
              {message.content.map((block, i) => (
                <ContentBlockView key={i} block={block} />
              ))}
            </MessageContent>
            {plainText.trim() ? (
              <div className="agent-answer-toolbar">
                <MessageCopyButton text={plainText} />
              </div>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      </Message>
    )
  }

  // 班组完成通知：系统条，不进用户气泡、也不当普通助手轮
  const isCrewNotice =
    message.modelId === '班组通知' || plainText.trimStart().startsWith('【班组完成】')

  if (isCrewNotice) {
    return (
      <div className="agent-crew-notice" role="status">
        <div className="agent-crew-notice__head">
          <span className="agent-crew-notice__badge">班组</span>
          {message.createdAt ? (
            <span className="agent-crew-notice__time">
              {formatMessageTime(message.createdAt)}
            </span>
          ) : null}
        </div>
        <div className="agent-crew-notice__body whitespace-pre-wrap break-words">{plainText}</div>
      </div>
    )
  }

  return (
    <Message from="assistant">
      {(message.modelId || message.createdAt) && (
        <div className="agent-turn-title-row mb-2.5">
          {message.modelId ? (
            <div className="agent-turn-title">{message.modelId}</div>
          ) : null}
          {message.createdAt ? (
            <span className="agent-turn-title-row__time">
              {formatMessageTime(message.createdAt)}
            </span>
          ) : null}
        </div>
      )}
      <MessageContent>
        {message.error && (
          <Badge variant="destructive" className="mb-2 text-xs">
            {message.error.message}
          </Badge>
        )}
        {message.content.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
      </MessageContent>
      {plainText.trim() ? (
        <div className="agent-answer-toolbar">
          <MessageCopyButton text={plainText} />
        </div>
      ) : null}
    </Message>
  )
}
