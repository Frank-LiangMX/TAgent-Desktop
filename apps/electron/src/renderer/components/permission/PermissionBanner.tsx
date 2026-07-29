/**
 * PermissionBanner — 工具权限确认横幅
 *
 * 主进程推 PERMISSION_REQUEST 时显示在会话页底部（composer 上方）。
 * 允许 / 拒绝 / 始终允许（remember=true：本会话按工具名白名单；Bash 整类放行，危险/写结构仍会再问）。
 */
import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { ShieldWarning, Check, X } from '@phosphor-icons/react'
import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'

interface PermissionReq {
  id: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  dangerous: boolean
}

export function PermissionBanner({ sessionId }: { sessionId: string }): JSX.Element {
  const [req, setReq] = useState<PermissionReq | null>(null)

  useEffect(() => {
    const off = window.electronAPI.onPermissionRequest((r) => {
      const pr = r as PermissionReq
      // 只显示当前会话的请求
      if (pr.sessionId === sessionId) setReq(pr)
    })
    return off
  }, [sessionId])

  const respond = (behavior: 'allow' | 'deny', remember = false): void => {
    if (req) window.electronAPI.respondToPermission(req.id, behavior, remember)
    setReq(null)
  }

  const command =
    req?.toolName === 'Bash'
      ? (req.input.command as string) ?? ''
      : req?.toolName === 'Write' || req?.toolName === 'Edit'
        ? (req.input.file_path as string) ?? ''
        : JSON.stringify(req?.input ?? {}).slice(0, 80)

  return (
    <AnimatePresence>
      {req && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          className="pointer-events-auto absolute inset-x-0 bottom-2 z-30 mx-auto max-w-[680px] px-4"
        >
          <div
            className={cn(
              'flex items-center gap-3 rounded-2xl border p-3 shadow-lg backdrop-blur-xl',
              req.dangerous
                ? 'border-red-500/40 bg-red-500/10'
                : 'border-border/60 bg-background/80',
            )}
          >
            <ShieldWarning
              size={20}
              weight="regular"
              className={cn('shrink-0', req.dangerous ? 'text-red-500' : 'text-muted-foreground')}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-foreground">{req.toolName}</span>
                {req.dangerous && (
                  <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-500">
                    危险
                  </span>
                )}
              </div>
              <code className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                {command}
              </code>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => respond('deny')}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label="拒绝"
              >
                <X size={16} weight="regular" />
              </button>
              <AppTooltip
                label={
                  req.toolName === 'Bash'
                    ? '本会话始终允许 Bash（危险命令仍会询问）'
                    : `本会话始终允许 ${req.toolName}`
                }
                side="top"
                multiline
              >
                <button
                  onClick={() => respond('allow', true)}
                  className="rounded-lg px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  始终
                </button>
              </AppTooltip>
              <button
                onClick={() => respond('allow')}
                className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
                aria-label="允许"
              >
                <Check size={16} weight="bold" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
