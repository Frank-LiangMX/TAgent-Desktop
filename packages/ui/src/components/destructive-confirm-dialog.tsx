'use client'

import * as React from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog'

export interface DestructiveConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description: React.ReactNode
  confirmLabel: string
  onConfirm: () => void | Promise<void>
  icon?: React.ReactNode
  pendingLabel?: string
}

/**
 * 删除类操作的紧凑确认框。
 * 保持危险信息明确，同时避免通用大模态框在桌面工具中显得笨重。
 */
export function DestructiveConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  icon,
  pendingLabel = '正在删除…',
}: DestructiveConfirmDialogProps): JSX.Element {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) setError(null)
  }, [open])

  const handleOpenChange = (nextOpen: boolean): void => {
    if (pending) return
    if (!nextOpen) setError(null)
    onOpenChange(nextOpen)
  }

  const handleConfirm = async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    // Radix Action 默认立即关闭；异步删除需要等成功后再关闭，失败则在原位显示错误。
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="!z-[120] !w-[min(calc(100vw-32px),400px)] !max-w-none !gap-0 !overflow-hidden !rounded-[16px] !p-0">
        <div className="flex items-start gap-3 px-4 pb-3 pt-4">
          {icon && (
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-destructive/10 text-destructive">
              {icon}
            </span>
          )}
          <AlertDialogHeader className="min-w-0 flex-1 !space-y-1 !text-left">
            <AlertDialogTitle className="truncate text-[14px] font-semibold leading-5 tracking-[-0.01em]">
              {title}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[12px] leading-[18px] text-muted-foreground/85">
              {description}
            </AlertDialogDescription>
            {error && (
              <p className="pt-1 text-[11px] leading-4 text-destructive" role="alert">
                {error}
              </p>
            )}
          </AlertDialogHeader>
        </div>
        <AlertDialogFooter className="!flex-row !flex-wrap !justify-end !space-x-0 gap-2 border-t border-border/40 bg-muted/20 px-4 py-2.5">
          <AlertDialogCancel
            disabled={pending}
            className="!mt-0 h-8 shrink-0 min-w-[64px] rounded-[9px] px-3 text-xs shadow-none"
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            className="h-8 shrink-0 min-w-[76px] rounded-[9px] bg-destructive px-3 text-xs text-destructive-foreground shadow-sm hover:bg-destructive/90"
            onClick={(event) => void handleConfirm(event)}
          >
            {pending ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
