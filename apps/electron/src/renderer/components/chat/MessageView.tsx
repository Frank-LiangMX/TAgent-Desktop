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
  FileAttachment,
} from '@tagent/shared'
import { DEFAULT_USER_NAME } from '@tagent/shared'

import {
  AppTooltip,
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
import { MentionText } from './MentionText'
import { SpeakerHeader } from './SpeakerHeader'

// ===== 主组件 =====

export function MessageView({
  message,
  onRefillToInput,
  mentionRoles,
  onOpenAttachment,
}: {
  message: TAgentMessage
  /** 用户消息：填入输入框以便改写重发 */
  onRefillToInput?: (text: string) => void
  /** 用于把 @角色 渲染成圆角芯片（与发送解析一致） */
  mentionRoles?: Array<{ id: string; displayName: string }>
  /** 点击文本/文件附件 → 分屏预览 */
  onOpenAttachment?: (attachment: FileAttachment) => void
}): React.ReactElement {
  if (message.type === 'user') {
    return (
      <UserView
        message={message}
        onRefillToInput={onRefillToInput}
        mentionRoles={mentionRoles}
        onOpenAttachment={onOpenAttachment}
      />
    )
  }
  return <AssistantView message={message} />
}

// ===== user 消息 =====

function UserView({
  message,
  onRefillToInput,
  mentionRoles,
  onOpenAttachment,
}: {
  message: Extract<TAgentMessage, { type: 'user' }>
  onRefillToInput?: (text: string) => void
  mentionRoles?: Array<{ id: string; displayName: string }>
  onOpenAttachment?: (attachment: FileAttachment) => void
}): React.ReactElement {
  const profile = useAtomValue(userProfileAtom)
  const userName = (profile.userName || DEFAULT_USER_NAME).trim() || DEFAULT_USER_NAME
  // 与设置入口 rail-avatar 一致：用户名首字圆形头像
  const avatarLetter = userName.charAt(0).toUpperCase() || 'U'

  const textBlocks = message.content.filter(
    (b): b is TAgentTextBlock => b.type === 'text',
  )
  const toolResultBlocks = message.content.filter(
    (b): b is TAgentToolResultBlock => b.type === 'tool_result',
  )
  const plainText = textBlocks.map((b) => b.text).join('\n')
  const hasAttachments = (message.attachments?.length ?? 0) > 0
  const hasText = textBlocks.length > 0
  const showChrome = hasText || hasAttachments

  const attachmentBlock = hasAttachments ? (
    <MessageAttachments
      attachments={message.attachments!}
      variant="inBubble"
      className="agent-user-bubble__attachments"
      onReadAttachment={async (localPath) => {
        const base64 = await window.electronAPI.readAttachment(localPath)
        return base64
      }}
      onOpenAttachment={onOpenAttachment}
    />
  ) : null

  const textBlock = hasText ? (
    <UserMessageContent contentKey={plainText} embedded={hasAttachments}>
      <MentionText text={plainText} roles={mentionRoles} />
    </UserMessageContent>
  ) : null

  const bubbleBody =
    hasAttachments && (hasText || toolResultBlocks.length > 0) ? (
      <div
        className={cn(
          'agent-user-bubble agent-user-bubble--combo relative inline-block max-w-full',
          hasText && 'agent-user-bubble--combo-has-text',
        )}
      >
        {attachmentBlock}
        {textBlock}
        {toolResultBlocks.map((b) => (
          <ToolResultView key={b.toolUseId} block={b} />
        ))}
      </div>
    ) : hasAttachments ? (
      <div className="agent-user-bubble agent-user-bubble--attachments-only relative inline-block max-w-full">
        {attachmentBlock}
      </div>
    ) : (
      <>
        {textBlock}
        {toolResultBlocks.map((b) => (
          <ToolResultView key={b.toolUseId} block={b} />
        ))}
      </>
    )

  return (
    <Message from="user">
      <div className={cn('agent-user-block', showChrome && 'has-avatar')}>
        <div className="agent-user-block__col">
          <MessageContent className="agent-user-block__bubble">{bubbleBody}</MessageContent>

          {showChrome && (message.createdAt || plainText.trim() || hasAttachments) ? (
            <div className="agent-user-block__meta">
              {plainText.trim() ? (
                <div className="agent-user-block__tools agent-user-toolbar">
                  {onRefillToInput ? (
                    <MessageRefillButton text={plainText} onRefill={onRefillToInput} />
                  ) : null}
                  <MessageCopyButton text={plainText} />
                </div>
              ) : null}
              {message.createdAt ? (
                <span className="agent-user-block__time">
                  {formatMessageTime(message.createdAt)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {showChrome ? (
          <div className="agent-user-block__avatar-wrap">
            <AppTooltip label={userName}>
              <span className="agent-user-block__avatar" aria-label={userName}>
                {avatarLetter}
              </span>
            </AppTooltip>
          </div>
        ) : null}
      </div>
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
              <SpeakerHeader
                name={message.modelId?.trim() || '子代理'}
                modelId={message.modelId}
                statusLabel={
                  message.createdAt ? formatMessageTime(message.createdAt) : undefined
                }
                className="mb-2.5 mt-2"
              />
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
        <SpeakerHeader
          name={message.modelId?.trim() || '助手'}
          modelId={message.modelId}
          statusLabel={message.createdAt ? formatMessageTime(message.createdAt) : undefined}
          className="mb-2.5"
        />
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
