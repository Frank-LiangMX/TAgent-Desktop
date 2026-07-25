/**
 * StickyUserMessage — 用户消息悬浮置顶条
 *
 * 当任意用户消息完全滚出 Conversation 视口顶部时，
 * 在顶部显示该消息的精简版悬浮条，点击可回滚到原始消息位置。
 * 必须放在 StickToBottom（Conversation）内部使用。
 */

import { ChevronUp } from 'lucide-react'
import * as React from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'

import { cn } from '../../lib/utils'

/** 去除 fenced code block，替换为 [code] 占位符 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' [code] ')
}

interface StickyAttachment {
  filename: string
  isImage: boolean
}

interface UserMessageData {
  id: string | null
  text: string
  attachments: StickyAttachment[]
}

interface StickyUserMessageProps {
  userMessages: UserMessageData[]
  /** 是否启用悬浮置顶功能 */
  enabled?: boolean
}

export function StickyUserMessage({
  userMessages,
  enabled = true,
}: StickyUserMessageProps): React.ReactElement {
  const { scrollRef, stopScroll, state: stickyState } = useStickToBottomContext()

  const [stickyMessage, setStickyMessage] = React.useState<UserMessageData | null>(null)

  const messageMap = React.useMemo(() => {
    const map = new Map<string, UserMessageData>()
    for (const msg of userMessages) {
      if (msg.id) map.set(msg.id, msg)
    }
    return map
  }, [userMessages])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el || userMessages.length === 0 || !enabled) {
      setStickyMessage(null)
      return
    }

    const check = () => {
      const containerRect = el.getBoundingClientRect()
      const nodes = el.querySelectorAll<HTMLElement>('[data-message-role="user"]')

      let found: UserMessageData | null = null
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i]!
        const nodeRect = node.getBoundingClientRect()
        if (nodeRect.bottom < containerRect.top) {
          const msgId = node.getAttribute('data-message-id')
          if (msgId) {
            found = messageMap.get(msgId) ?? null
          }
          break
        }
      }
      setStickyMessage((prev) => {
        const prevId = prev?.id ?? null
        const foundId = found?.id ?? null
        if (prevId === foundId) return prev
        return found
      })
    }

    let rafId: number | null = null
    const scheduleCheck = (): void => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        check()
      })
    }

    el.addEventListener('scroll', check, { passive: true })

    const resizeObserver = new ResizeObserver(scheduleCheck)
    resizeObserver.observe(el)

    const contentEl = el.firstElementChild as HTMLElement | null
    if (contentEl) {
      resizeObserver.observe(contentEl)
    }

    const initialRafId = requestAnimationFrame(check)

    return () => {
      el.removeEventListener('scroll', check)
      resizeObserver.disconnect()
      cancelAnimationFrame(initialRafId)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [scrollRef, userMessages, messageMap, enabled])

  const scrollToOriginal = React.useCallback(() => {
    const el = scrollRef.current
    if (!el || !stickyMessage?.id) return

    const target = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (node) => node.getAttribute('data-message-id') === stickyMessage.id
    )
    if (!target) return

    stopScroll()
    stickyState.animation = undefined
    stickyState.velocity = 0
    stickyState.accumulated = 0

    const containerRect = el.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const targetScrollTop = el.scrollTop + (targetRect.top - containerRect.top)
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    el.scrollTo({
      top: Math.max(0, targetScrollTop - 24),
      behavior: reducedMotion ? 'auto' : 'smooth',
    })
  }, [scrollRef, stopScroll, stickyState, stickyMessage])

  const isSticky = stickyMessage !== null
  const hasContent = stickyMessage && (stickyMessage.text || stickyMessage.attachments.length > 0)
  const summary = stickyMessage
    ? stripCodeBlocks(stickyMessage.text).replace(/\s+/g, ' ').trim() || '附件消息'
    : ''

  if (!enabled) return <></>
  if (!hasContent && !isSticky) return <></>

  return (
    <div
      aria-live="polite"
      className={cn(
        /* 贴顶：1px 缝避免与上边线重叠 */
        'agent-sticky-jump-slot absolute left-0 right-0 top-px z-20 transition-all duration-150 ease-out',
        isSticky
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 -translate-y-1 pointer-events-none'
      )}
    >
      {/* 边距由 agent-thread.css 控制：左对齐会话 gutter，右额外预留给消息导航刻度 */}
      <div className="agent-sticky-jump-shell flex items-start">
        <button
          type="button"
          aria-label={`上一轮用户消息：${summary}。回到原文`}
          className="agent-sticky-jump cursor-pointer"
          onClick={scrollToOriginal}
        >
          <span className="agent-sticky-jump__icon" aria-hidden="true">
            <ChevronUp />
          </span>
          <span className="agent-sticky-jump__label">上一轮</span>
          <span className="agent-sticky-jump__divider" aria-hidden="true" />
          <span className="agent-sticky-jump__summary">{summary}</span>
          {stickyMessage && stickyMessage.attachments.length > 0 && (
            <span className="agent-sticky-jump__attachments">
              附件 {stickyMessage.attachments.length}
            </span>
          )}
          <span className="agent-sticky-jump__action">回到原文</span>
        </button>
      </div>
    </div>
  )
}
