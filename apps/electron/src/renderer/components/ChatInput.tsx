/**
 * 聊天输入组件（textarea 版，简单可靠）
 *
 * Enter 提交 / Shift+Enter 换行。
 * 父组件通过 ref 调用 getText() / clear()。
 * 后续加 @mention 时再换 TipTap。
 */
import { forwardRef, useImperativeHandle, useRef, useCallback } from 'react'
import { cn } from '@/lib/utils'

/** 通过 ref 暴露的方法 */
export interface ChatInputHandle {
  /** 获取纯文本 */
  getText: () => string
  /** 清空内容 */
  clear: () => void
  /** 聚焦 */
  focus: () => void
}

interface ChatInputProps {
  onSubmit: () => void
  disabled?: boolean
  placeholder?: string
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput({ onSubmit, disabled, placeholder }, ref) {
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    const getText = useCallback(() => textareaRef.current?.value ?? '', [])
    const clear = useCallback(() => {
      if (textareaRef.current) {
        textareaRef.current.value = ''
        autoResize()
      }
    }, [])
    const focus = useCallback(() => textareaRef.current?.focus(), [])

    useImperativeHandle(ref, () => ({ getText, clear, focus }), [getText, clear, focus])

    /** 自动调整高度 */
    const autoResize = useCallback(() => {
      const el = textareaRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    }, [])

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        onSubmit()
      }
    }, [onSubmit])

    return (
      <textarea
        ref={textareaRef}
        className={cn(
          'w-full resize-none border-0 bg-transparent text-sm outline-none',
          'placeholder:text-muted-foreground',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
        style={{ minHeight: 44, maxHeight: 200 }}
        placeholder={placeholder}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        onInput={autoResize}
      />
    )
  },
)
