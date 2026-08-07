/**
 * 聊天输入组件（contentEditable：@ 角色为圆角芯片，提交时序列化为 @名字）
 *
 * 支持：文件附件、拖拽/粘贴、MentionPicker。
 * Enter 提交 / Shift+Enter 换行。父组件通过 ref 调用 getText() / clear() / setText()。
 */
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useCallback,
  useState,
  useEffect,
} from 'react'
import { Paperclip } from 'lucide-react'
import { filterMentionRoles, parseMentions } from '@tagent/shared'
import { AttachmentPreviewItem } from '@tagent/ui'
import { shouldConvertTextToAttachment, createTextAttachment } from '../../lib/clipboard-text-attachment'
import { MentionPicker, type MentionRoleOption } from './MentionPicker'

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
  attachments?: PendingAttachment[]
  onAttachmentsChange?: (attachments: PendingAttachment[]) => void
  onOpenFileDialog?: () => void
  mentionRoles?: MentionRoleOption[]
  topBar?: React.ReactNode
  /** @ 选择面板开合变化：true=弹出（输入框上方浮层），false=关闭。供调用方让位重叠 UI */
  onMentionOpenChange?: (open: boolean) => void
}

// ─── 序列化 / 反序列化 ───────────────────────────────────────────

function editorToPlainText(root: HTMLElement): string {
  let out = ''
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.dataset.mention === '1') {
      const name = el.dataset.displayName ?? el.textContent?.replace(/^@/, '') ?? ''
      out += `@${name}`
      return
    }
    if (el.tagName === 'BR') {
      out += '\n'
      return
    }
    // div 块级换行
    if (el.tagName === 'DIV' && out.length > 0 && !out.endsWith('\n')) {
      // 第一个子块前不加；浏览器常把每行包 div
    }
    for (const c of Array.from(el.childNodes)) walk(c)
    if (el.tagName === 'DIV' && el.nextSibling) {
      if (!out.endsWith('\n')) out += '\n'
    }
  }
  for (const c of Array.from(root.childNodes)) walk(c)
  // 折叠 contenteditable 产生的多余换行尾部
  return out.replace(/\u00a0/g, ' ')
}

function createMentionChip(
  role: { id: string; displayName: string },
  doc: Document,
): HTMLSpanElement {
  const span = doc.createElement('span')
  span.className = 'mention-chip mention-chip--composer'
  span.contentEditable = 'false'
  span.dataset.mention = '1'
  span.dataset.roleId = role.id
  span.dataset.displayName = role.displayName
  span.textContent = `@${role.displayName}`
  span.setAttribute('title', `@${role.displayName}`)
  return span
}

/** 把纯文本（可含 @角色）写入 editor，已知 roles 时转成芯片 */
function fillEditorFromPlainText(
  root: HTMLElement,
  text: string,
  roles: MentionRoleOption[] | undefined,
): void {
  root.innerHTML = ''
  const doc = root.ownerDocument
  if (!text) {
    return
  }
  if (!roles?.length) {
    root.textContent = text
    return
  }
  const hits = parseMentions(text, roles)
  if (hits.length === 0) {
    root.textContent = text
    return
  }
  let cursor = 0
  const frag = doc.createDocumentFragment()
  for (const h of hits) {
    if (h.index > cursor) {
      frag.appendChild(doc.createTextNode(text.slice(cursor, h.index)))
    }
    frag.appendChild(
      createMentionChip({ id: h.roleId, displayName: h.displayName }, doc),
    )
    cursor = h.index + h.raw.length
  }
  if (cursor < text.length) {
    frag.appendChild(doc.createTextNode(text.slice(cursor)))
  }
  root.appendChild(frag)
}

/** 取光标前的纯文本（用于探测 @query） */
function plainTextBeforeCaret(root: HTMLElement): { before: string; all: string } {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
    const all = editorToPlainText(root)
    return { before: all, all }
  }
  const range = sel.getRangeAt(0).cloneRange()
  range.selectNodeContents(root)
  range.setEnd(sel.anchorNode!, sel.anchorOffset)
  const beforeRoot = root.ownerDocument.createElement('div')
  beforeRoot.appendChild(range.cloneContents())
  const before = editorToPlainText(beforeRoot)
  const all = editorToPlainText(root)
  return { before, all }
}

function placeCaretAtEnd(el: HTMLElement): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = el.ownerDocument.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

function isEditorVisuallyEmpty(root: HTMLElement): boolean {
  const t = editorToPlainText(root).replace(/\n/g, '').trim()
  return t.length === 0
}

// ─── 组件 ───────────────────────────────────────────────────────

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput({
    onSubmit,
    placeholder,
    footer,
    onDraftChange,
    attachments = [],
    onAttachmentsChange,
    onOpenFileDialog,
    mentionRoles,
    topBar,
    onMentionOpenChange,
  }, ref) {
    const editorRef = useRef<HTMLDivElement>(null)
    /** 输入浮岛外框：MentionPicker 锚定在其上方外侧（portal） */
    const glassRef = useRef<HTMLDivElement>(null)
    const [isDragOver, setIsDragOver] = useState(false)
    const [mentionOpen, setMentionOpen] = useState(false)
    const [mentionQuery, setMentionQuery] = useState('')
    const [mentionActive, setMentionActive] = useState(0)
    /** @ 探测：光标前文本里 @ 的字符下标（相对 before 串） */
    const mentionStartRef = useRef<number | null>(null)
    const [empty, setEmpty] = useState(true)

    const syncEmpty = useCallback(() => {
      const el = editorRef.current
      if (!el) return
      const isEmpty = isEditorVisuallyEmpty(el)
      setEmpty(isEmpty)
      onDraftChange?.(!isEmpty)
    }, [onDraftChange])

    const autoResize = useCallback(() => {
      const el = editorRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = Math.min(Math.max(el.scrollHeight, 52), 200) + 'px'
    }, [])

    const getText = useCallback(() => {
      const el = editorRef.current
      if (!el) return ''
      return editorToPlainText(el)
    }, [])

    const clear = useCallback(() => {
      const el = editorRef.current
      if (!el) return
      el.innerHTML = ''
      autoResize()
      setEmpty(true)
      onDraftChange?.(false)
      setMentionOpen(false)
      mentionStartRef.current = null
    }, [autoResize, onDraftChange])

    const focus = useCallback(() => {
      editorRef.current?.focus()
    }, [])

    const setText = useCallback(
      (text: string) => {
        const el = editorRef.current
        if (!el) return
        fillEditorFromPlainText(el, text, mentionRoles)
        autoResize()
        syncEmpty()
        placeCaretAtEnd(el)
      },
      [autoResize, mentionRoles, syncEmpty],
    )

    useImperativeHandle(ref, () => ({ getText, clear, focus, setText }), [
      getText,
      clear,
      focus,
      setText,
    ])

    const syncMentionFromCaret = useCallback(() => {
      const el = editorRef.current
      if (!el || !mentionRoles?.length) {
        setMentionOpen(false)
        return
      }
      const { before } = plainTextBeforeCaret(el)
      const at = before.lastIndexOf('@')
      if (at < 0) {
        setMentionOpen(false)
        mentionStartRef.current = null
        return
      }
      if (at > 0 && !/[\s\n]/.test(before[at - 1]!)) {
        setMentionOpen(false)
        mentionStartRef.current = null
        return
      }
      // 若 @ 落在芯片内部探测不到（芯片非编辑），仅处理文本区输入的 @
      const query = before.slice(at + 1)
      if (/[\s\n]/.test(query)) {
        setMentionOpen(false)
        mentionStartRef.current = null
        return
      }
      mentionStartRef.current = at
      // 仅 query 变化时重置高亮；keyUp 会反复 sync，若每次 setActive(0) 键盘上下会失效
      setMentionQuery((prev) => {
        if (prev !== query) setMentionActive(0)
        return query
      })
      setMentionOpen(true)
    }, [mentionRoles])

    /**
     * 点选 MentionPicker 时编辑器会失焦，Selection/Range 往往已失效（offset 成 4294967295）。
     * 因此不用 Range 删字，按纯文本下标替换 @query → 再 fill 成芯片。
     */
    const insertMention = useCallback(
      (role: MentionRoleOption) => {
        const el = editorRef.current
        if (!el) return

        const plain = editorToPlainText(el)
        let start = mentionStartRef.current
        const query = mentionQuery

        // 失焦后 start 可能过期：在全文里找与当前 query 匹配的最后一个 @query
        const needle = `@${query}`
        if (start == null || plain.slice(start, start + needle.length) !== needle) {
          const idx = plain.lastIndexOf(needle)
          start = idx >= 0 ? idx : null
        }
        // 仍找不到：尝试任意未完成的 @token（到空白为止）
        if (start == null) {
          const m = plain.match(/(^|[\s\n])@([^\s@]*)$/)
          if (m && m.index != null) {
            start = m[0].startsWith('@') ? m.index : m.index + 1
          }
        }
        if (start == null || start < 0 || start >= plain.length || plain[start] !== '@') {
          // 兜底：末尾追加芯片
          const next = `${plain}${plain && !/\s$/.test(plain) ? ' ' : ''}@${role.displayName} `
          fillEditorFromPlainText(el, next, mentionRoles)
        } else {
          // 吃掉 @ + query（query 可能为空，即刚输入 @）
          const eat = 1 + (plain.slice(start + 1).match(/^[^\s@]*/)?.[0]?.length ?? 0)
          const next =
            plain.slice(0, start) + `@${role.displayName} ` + plain.slice(start + eat)
          fillEditorFromPlainText(el, next, mentionRoles)
        }

        autoResize()
        syncEmpty()
        setMentionOpen(false)
        mentionStartRef.current = null
        el.focus()
        placeCaretAtEnd(el)
      },
      [autoResize, syncEmpty, mentionQuery, mentionRoles],
    )

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (mentionOpen && mentionRoles?.length) {
          const filtered = filterMentionRoles(mentionRoles, mentionQuery)
          const n = filtered.length
          if (n > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            e.stopPropagation()
            if (e.key === 'ArrowDown') {
              setMentionActive((i) => (i + 1) % n)
            } else {
              setMentionActive((i) => (i - 1 + n) % n)
            }
            return
          }
          if (n > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault()
            e.stopPropagation()
            const role = filtered[Math.min(mentionActive, n - 1)]
            if (role) insertMention(role)
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            setMentionOpen(false)
            return
          }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          setMentionOpen(false)
          onSubmit()
          return
        }
        // Shift+Enter：浏览器默认插入换行
      },
      [
        mentionOpen,
        mentionRoles,
        mentionQuery,
        mentionActive,
        insertMention,
        onSubmit,
      ],
    )

    const handleInput = useCallback(() => {
      autoResize()
      syncEmpty()
      syncMentionFromCaret()
    }, [autoResize, syncEmpty, syncMentionFromCaret])

    // 方向键只在 keyDown 改 activeIndex；keyUp 再 sync 时勿把高亮打回 0（query 未变已处理）
    const handleKeyUp = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (
          mentionOpen &&
          (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab')
        ) {
          return
        }
        syncMentionFromCaret()
      },
      [mentionOpen, syncMentionFromCaret],
    )

    useEffect(() => {
      if (!mentionRoles?.length) setMentionOpen(false)
    }, [mentionRoles])

    // 面板开合通知调用方：让位输入框上方重叠 UI（运行胶囊/下箭头），不碰任何计时状态
    useEffect(() => {
      onMentionOpenChange?.(mentionOpen)
    }, [mentionOpen, onMentionOpenChange])

    const removeAttachment = useCallback(
      (id: string) => {
        onAttachmentsChange?.(attachments.filter((a) => a.id !== id))
      },
      [attachments, onAttachmentsChange],
    )

    const filesToAttachments = useCallback(async (files: File[]): Promise<PendingAttachment[]> => {
      const results: PendingAttachment[] = []
      for (const file of files) {
        const MAX_SIZE = 100 * 1024 * 1024
        if (file.size > MAX_SIZE) {
          console.warn(
            `[ChatInput] 文件过大跳过: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`,
          )
          continue
        }
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
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

    const handleDrop = useCallback(
      async (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0 && onAttachmentsChange) {
          const newAttachments = await filesToAttachments(files)
          onAttachmentsChange([...attachments, ...newAttachments])
        }
      },
      [attachments, onAttachmentsChange, filesToAttachments],
    )

    const handlePaste = useCallback(
      async (e: React.ClipboardEvent) => {
        const items = Array.from(e.clipboardData.items)
        const fileItems = items.filter((item) => item.kind === 'file')
        if (fileItems.length > 0 && onAttachmentsChange) {
          e.preventDefault()
          const files = fileItems.map((item) => item.getAsFile()).filter(Boolean) as File[]
          const newAttachments = await filesToAttachments(files)
          onAttachmentsChange([...attachments, ...newAttachments])
          return
        }
        if (shouldConvertTextToAttachment(e.clipboardData) && onAttachmentsChange) {
          e.preventDefault()
          const text = e.clipboardData.getData('text/plain')
          const att = createTextAttachment(text)
          onAttachmentsChange([...attachments, att])
          return
        }
        // 短文本：插入纯文本（避免粘贴带样式 HTML）
        const text = e.clipboardData.getData('text/plain')
        if (text) {
          e.preventDefault()
          document.execCommand('insertText', false, text)
          autoResize()
          syncEmpty()
          syncMentionFromCaret()
        }
      },
      [
        attachments,
        onAttachmentsChange,
        filesToAttachments,
        autoResize,
        syncEmpty,
        syncMentionFromCaret,
      ],
    )

    return (
      <div
        className="app-shell-content-stage"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          ref={glassRef}
          className={`chat-input-glass relative ${isDragOver ? 'ring-2 ring-dashed ring-primary/40' : ''}`}
        >
          {topBar}
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
          <div
            ref={editorRef}
            className={`composer-editor w-full resize-none border-0 bg-transparent outline-none${empty ? ' is-empty' : ''}`}
            style={{ minHeight: 52, maxHeight: 200, padding: '9px 15px 15px' }}
            contentEditable
            role="textbox"
            aria-multiline="true"
            aria-label={placeholder ?? '消息输入'}
            data-placeholder={placeholder ?? ''}
            suppressContentEditableWarning
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onPaste={handlePaste}
            onClick={syncMentionFromCaret}
            onKeyUp={handleKeyUp}
          />
          {footer}
        </div>
        {/* 浮在输入浮岛外侧（portal 到 body），避免被 glass overflow 裁进框内 */}
        {mentionRoles?.length ? (
          <MentionPicker
            open={mentionOpen}
            query={mentionQuery}
            roles={mentionRoles}
            activeIndex={mentionActive}
            onActiveIndexChange={setMentionActive}
            onSelect={insertMention}
            anchorRef={glassRef}
          />
        ) : null}
      </div>
    )
  },
)
