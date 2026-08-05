/**
 * Conversation - 对话容器原语
 *
 * 基于 use-stick-to-bottom 实现自动滚动到底部的对话容器。
 *
 * 包含：
 * - Conversation — 根容器（StickToBottom）
 * - ConversationContent — 内容区域
 * - ConversationEmptyState — 空状态
 * - ConversationScrollButton — 滚动到底部按钮
 */

import { ArrowDownIcon } from 'lucide-react'
import { useCallback } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

import type { ComponentProps, ReactNode } from 'react'

import { Button } from '../button'
import { cn } from '../../lib/utils'

// ===== Conversation 根容器 =====

export type ConversationProps = ComponentProps<typeof StickToBottom>

export function Conversation({ className, ...props }: ConversationProps): React.ReactElement {
  return (
    <StickToBottom
      className={cn('relative flex-1 overflow-y-hidden', className)}
      initial="instant"
      resize="smooth"
      role="log"
      {...props}
    />
  )
}

// ===== ConversationContent 内容区域 =====

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export function ConversationContent({
  className,
  ...props
}: ConversationContentProps): React.ReactElement {
  return (
    <StickToBottom.Content
      // overflow-y-auto 必须显式给：StickToBottom 只在挂载时探一次 getComputedStyle，
      // 测到 overflow:visible 才注入 overflow:auto。Dockview 默认 onlyWhenVisible
      // 会把非可见面板的 DOM 从文档摘掉，此时探测拿不到样式 → 容器永远不可滚动，
      // 且该 effect 空依赖不会重跑。自己声明就与挂载时机彻底解耦。
      scrollClassName="scrollbar-none will-change-scroll-position overflow-y-auto"
      className={cn('selectable-content flex flex-col gap-1 py-4 px-8', className)}
      {...props}
    />
  )
}

// ===== ConversationEmptyState 空状态 =====

export interface ConversationEmptyStateProps {
  title?: string
  description?: string
  icon?: ReactNode
  className?: string
  children?: ReactNode
}

export function ConversationEmptyState({
  className,
  title = '暂无消息',
  description = '在下方输入框开始对话',
  icon,
  children,
}: ConversationEmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
        className
      )}
    >
      {children ?? (
        <>
          {icon && <div className="text-muted-foreground">{icon}</div>}
          <div className="space-y-1">
            <h3 className="font-medium text-sm">{title}</h3>
            {description && <p className="text-muted-foreground text-sm">{description}</p>}
          </div>
        </>
      )}
    </div>
  )
}

// ===== ConversationScrollButton 滚动到底部 =====

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export function ConversationScrollButton({
  className,
  ...props
}: ConversationScrollButtonProps): React.ReactElement | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  if (isAtBottom) return null

  return (
    <Button
      className={cn(
        /* left-0 right-0 mx-auto 居中：固定宽度下用 margin auto，
         * 完全不依赖 transform，避免 hover/active 的 translateY 覆盖
         * translateX 导致按钮水平弹跳 */
        /* bottom/z-index 由 chat.css 用 --session-composer-top 覆盖（!important） */
        'conversation-scroll-btn absolute bottom-[26px] left-0 right-0 z-30 mx-auto size-9 rounded-full',
        'border shadow-none',
        className
      )}
      data-conversation-scroll-btn
      onClick={handleScrollToBottom}
      type="button"
      variant="ghost"
      size="icon"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  )
}
