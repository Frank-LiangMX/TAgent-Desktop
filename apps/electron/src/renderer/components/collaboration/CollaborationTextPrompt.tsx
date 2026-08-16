/**
 * 协作室文本输入弹层 — 替代 Electron 沙箱中不可用的 window.prompt()。
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@tagent/ui'

export interface CollaborationTextPromptProps {
  open: boolean
  title: string
  label?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
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
  onConfirm,
  onCancel,
}: CollaborationTextPromptProps): JSX.Element | null {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

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
    const next = value.trim()
    if (!next) return
    onConfirm(next)
  }

  return (
    <div
      className="absolute inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="collab-text-prompt-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-xl">
        <h2 id="collab-text-prompt-title" className="text-sm font-semibold text-foreground">
          {title}
        </h2>
        {label ? <p className="mt-1 text-xs text-muted-foreground">{label}</p> : null}
        <input
          ref={inputRef}
          className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" size="sm" disabled={!value.trim()} onClick={submit}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
