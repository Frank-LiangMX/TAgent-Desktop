/**
 * 聊天输入组件（textarea 版，套 composer 玻璃浮岛壳）
 *
 * 严格对照 TAgent_General 的 .chat-input-glass（styles/app-shell.css 逐行对齐）：
 * 外层 app-shell-content-stage 让选择器命中，内层 chat-input-glass 用真实规则
 * （抬升浮岛 + 光学折射层 + 三层聚焦 shadow + blur/saturate）。
 * Enter 提交 / Shift+Enter 换行。父组件通过 ref 调用 getText() / clear()。
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
  /** composer 壳内底部工具栏（模型选择 + 发送/停止按钮） */
  footer?: React.ReactNode
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput({ onSubmit, disabled, placeholder, footer }, ref) {
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
      // 外层让 .app-shell-content-stage .chat-input-glass 选择器命中
      <div className="app-shell-content-stage">
        {/* composer 玻璃浮岛：真实规则在 styles/app-shell.css，此处只挂类 + 内 padding */}
        <div className={cn('chat-input-glass', disabled && 'opacity-60')}>
          <textarea
            ref={textareaRef}
            className={cn(
              'w-full resize-none border-0 bg-transparent outline-none',
              'placeholder:text-muted-foreground/60',
              'disabled:cursor-not-allowed',
            )}
            style={{ minHeight: 52, maxHeight: 200, padding: '9px 15px 15px' }}
            placeholder={placeholder}
            disabled={disabled}
            onKeyDown={handleKeyDown}
            onInput={autoResize}
          />
          {footer}
        </div>
      </div>
    )
  },
)
