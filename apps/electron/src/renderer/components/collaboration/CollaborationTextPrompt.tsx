/**
 * 协作室文本输入弹层 — 替代 Electron 沙箱中不可用的 window.prompt()。
 *
 * 默认单行 `Input` 且提交时拒绝空串（用于房间重命名）。
 * `multiline` 切换为 `Textarea`（用于编辑房间目标等长文本）；`allowEmpty`
 * 允许提交空串（用于清空目标），此时确认按钮不再因空串而禁用。
 * `pending` 禁用确认按钮并改显 `pendingLabel`（用于远程网络写入的 busy 态）；
 * `error` 在弹层内渲染一行错误提示，避免被 overlay 遮挡。
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Textarea } from '@tagent/ui'

export interface CollaborationTextPromptProps {
  open: boolean
  title: string
  label?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  /** 多行输入（Textarea）；默认单行 Input。 */
  multiline?: boolean
  /** 允许提交空串（用于清空）；默认拒绝空串。 */
  allowEmpty?: boolean
  /** 多行时的初始行数（仅 multiline 生效）。 */
  rows?: number
  /** 提交进行中：禁用确认按钮并改显 pendingLabel。 */
  pending?: boolean
  /** 提交进行中的确认按钮文案。 */
  pendingLabel?: string
  /** 弹层内错误提示（一行）。 */
  error?: string | null
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function CollaborationTextPrompt({
  open,
  title,
  label,
  defaultValue = '',
  placeholder,
  confirmLabel = '确定',
  multiline = false,
  allowEmpty = false,
  rows = 4,
  pending = false,
  pendingLabel = '保存中…',
  error = null,
  onConfirm,
  onCancel,
}: CollaborationTextPromptProps): JSX.Element | null {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setValue(defaultValue)
    const t = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open, defaultValue])

  if (!open) return null

  const submit = (): void => {
    if (pending) return
    const next = value.trim()
    if (!allowEmpty && !next) return
    onConfirm(next)
  }

  const canSubmit = allowEmpty || value.trim().length > 0
  const confirmDisabled = !canSubmit || pending

  return (
    <div
      className="absolute inset-0 z-[80] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="collab-text-prompt-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-sm animate-in rounded-xl border border-border bg-background p-4 shadow-xl fade-in zoom-in-95 duration-200">
        <h2 id="collab-text-prompt-title" className="text-sm font-semibold text-foreground">
          {title}
        </h2>
        {label ? <p className="mt-1 text-xs text-muted-foreground">{label}</p> : null}
        {multiline ? (
          <Textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            className="mt-3 min-h-24 resize-y"
            rows={rows}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                if (!confirmDisabled) submit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
              }
            }}
          />
        ) : (
          <Input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            className="mt-3"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (!confirmDisabled) submit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
              }
            }}
          />
        )}
        {error ? (
          <p
            role="alert"
            className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
          >
            取消
          </Button>
          <Button type="button" size="sm" disabled={confirmDisabled} onClick={submit}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
