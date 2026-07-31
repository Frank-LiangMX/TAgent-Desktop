/**
 * 聊天输入组件（textarea 版，套 composer 玻璃浮岛壳）
 *
 * 支持：文件附件（回形针按钮 + 拖拽 + 粘贴）、附件预览、模型/权限工具栏。
 * Enter 提交 / Shift+Enter 换行。父组件通过 ref 调用 getText() / clear()。
 */
import { forwardRef, useImperativeHandle, useRef, useCallback, useState } from 'react'
import { Paperclip } from 'lucide-react'
import { AttachmentPreviewItem } from '@tagent/ui'
import { shouldConvertTextToAttachment, createTextAttachment } from '../../lib/clipboard-text-attachment'

/** 通过 ref 暴露的方法 */
export interface ChatInputHandle {
  getText: () => string
  clear: () => void
  focus: () => void
  setText: (text: string) => void
}

export interface PendingAttachment {
  id: string
  filename: string
  mediaType: string
  size: number
  previewUrl?: string
  data: string // base64
}

interface ChatInputProps {
  onSubmit: () => void
  placeholder?: string
  footer?: React.ReactNode
  onDraftChange?: (hasText: boolean) => void
  /** 附件列表（受控） */
  attachments?: PendingAttachment[]
  /** 附件变更回调 */
  onAttachmentsChange?: (attachments: PendingAttachment[]) => void
  /** 打开文件选择器 */
  onOpenFileDialog?: () => void
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput({ onSubmit, placeholder, footer, onDraftChange, attachments = [], onAttachmentsChange, onOpenFileDialog }, ref) {
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const [isDragOver, setIsDragOver] = useState(false)

    const getText = useCallback(() => textareaRef.current?.value ?? '', [])
    const clear = useCallback(() => {
      if (textareaRef.current) {
        textareaRef.current.value = ''
        autoResize()
        onDraftChange?.(false)
      }
    }, [onDraftChange])
    const focus = useCallback(() => textareaRef.current?.focus(), [])
    const setText = useCallback((text: string) => {
      if (textareaRef.current) {
        textareaRef.current.value = text
        autoResize()
        onDraftChange?.(text.length > 0)
      }
    }, [onDraftChange])

    useImperativeHandle(ref, () => ({ getText, clear, focus, setText }), [getText, clear, focus, setText])

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

    const handleInput = useCallback(() => {
      autoResize()
      onDraftChange?.((textareaRef.current?.value ?? '').length > 0)
    }, [autoResize, onDraftChange])

    /** 移除单个附件 */
    const removeAttachment = useCallback((id: string) => {
      onAttachmentsChange?.(attachments.filter((a) => a.id !== id))
    }, [attachments, onAttachmentsChange])

    /** 文件 → base64 转换 */
    const filesToAttachments = useCallback(async (files: File[]): Promise<PendingAttachment[]> => {
      const results: PendingAttachment[] = []
      for (const file of files) {
        const MAX_SIZE = 100 * 1024 * 1024 // 100MB
        if (file.size > MAX_SIZE) {
          console.warn(`[ChatInput] 文件过大跳过: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`)
          continue
        }
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
            // result is "data:mime;base64,XXXX"，提取 base64 部分
            resolve(result.split(',')[1] ?? '')
          }
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        const isImage = file.type.startsWith('image/')
        results.push({
          id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filename: file.name || 'clipboard-image',
          mediaType: file.type || 'application/octet-stream',
          size: file.size,
          previewUrl: isImage ? URL.createObjectURL(file) : undefined,
          data,
        })
      }
      return results
    }, [])

    /** 拖拽处理 */
    const handleDragOver = useCallback((e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(true)
    }, [])

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
    }, [])

    const handleDrop = useCallback(async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0 && onAttachmentsChange) {
        const newAttachments = await filesToAttachments(files)
        onAttachmentsChange([...attachments, ...newAttachments])
      }
    }, [attachments, onAttachmentsChange, filesToAttachments])

    /** 粘贴处理：文件→附件，长文本→.md 附件 */
    const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items)
      const fileItems = items.filter((item) => item.kind === 'file')
      if (fileItems.length > 0 && onAttachmentsChange) {
        // 有文件 → 转附件
        e.preventDefault()
        const files = fileItems.map((item) => item.getAsFile()).filter(Boolean) as File[]
        const newAttachments = await filesToAttachments(files)
        onAttachmentsChange([...attachments, ...newAttachments])
      } else if (shouldConvertTextToAttachment(e.clipboardData) && onAttachmentsChange) {
        // 长文本 → .md 附件（不阻止默认行为，短文本正常粘贴到 textarea）
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain')
        const att = createTextAttachment(text)
        onAttachmentsChange([...attachments, att])
      }
      // 短文本：不 preventDefault，让浏览器正常粘贴到 textarea
    }, [attachments, onAttachmentsChange, filesToAttachments])

    return (
      <div
        className="app-shell-content-stage"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className={`chat-input-glass ${isDragOver ? 'ring-2 ring-dashed ring-primary/40' : ''}`}>
          {/* 附件预览区 */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-2.5 pb-1.5">
              {attachments.map((att) => (
                <AttachmentPreviewItem
                  key={att.id}
                  filename={att.filename}
                  mediaType={att.mediaType}
                  previewUrl={att.previewUrl}
                  onRemove={() => removeAttachment(att.id)}
                />
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="w-full resize-none border-0 bg-transparent outline-none placeholder:text-muted-foreground/60"
            style={{ minHeight: 52, maxHeight: 200, padding: '9px 15px 15px' }}
            placeholder={placeholder}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onPaste={handlePaste}
          />
          {footer}
        </div>
      </div>
    )
  },
)
