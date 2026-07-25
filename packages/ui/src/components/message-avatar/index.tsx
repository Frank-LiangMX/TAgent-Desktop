/**
 * MessageAvatar - 消息头像组件
 *
 * 用户 / Agent 统一尺寸与圆角。
 * 通过 logoResolver prop 外部化模型 logo 解析逻辑。
 */

import * as React from 'react'

import { cn } from '../../lib/utils'

/** 会话区头像边长（px）— 用户与 Agent 统一 */
export const MESSAGE_AVATAR_SIZE = 32

/**
 * Agent 正文相对会话左缘的缩进（Message px-2.5 + avatar + gap-2.5）
 * 用于运行指示器等与 assistant 正文对齐
 */
/** @deprecated 助手 turn 已通栏，不再左缩进对齐头像；保留常量以免外部引用断裂 */
export const MESSAGE_AVATAR_CONTENT_INDENT_PX = 0

interface AssistantMessageLogoProps {
  model?: string
  className?: string
  /** 模型 logo URL 解析器，传入 model 名称返回 logo URL */
  logoResolver?: (model: string) => string | null
  /** 无 logo 时的回退图标 */
  fallbackIcon?: React.ReactNode
}

/** Agent / 模型头像（与 UserAvatar 同尺寸） */
export function AssistantMessageLogo({
  model,
  className,
  logoResolver,
  fallbackIcon,
}: AssistantMessageLogoProps): React.ReactElement {
  if (model && logoResolver) {
    const logoUrl = logoResolver(model)
    if (logoUrl) {
      return (
        <img
          src={logoUrl}
          alt={model}
          className={cn('size-[32px] rounded-[25%] object-cover', className)}
        />
      )
    }
  }

  return (
    <div
      data-testid="fallback-container"
      className={cn(
        'size-[32px] rounded-[25%] bg-primary/10 flex items-center justify-center',
        className
      )}
    >
      {fallbackIcon ?? (
        <svg
          className="size-4 text-primary"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Z" />
          <path d="M12 8v4l3 3" />
        </svg>
      )}
    </div>
  )
}

interface ErrorMessageLogoProps {
  className?: string
  /** 错误图标 */
  errorIcon?: React.ReactNode
}

/** 错误消息头像占位 */
export function ErrorMessageLogo({
  className,
  errorIcon,
}: ErrorMessageLogoProps): React.ReactElement {
  return (
    <div
      data-testid="error-container"
      className={cn(
        'size-[32px] rounded-[25%] bg-destructive/10 flex items-center justify-center',
        className
      )}
    >
      {errorIcon ?? (
        <svg
          className="size-4 text-destructive"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )}
    </div>
  )
}
