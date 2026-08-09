/**
 * PermissionBanner — 工具权限确认面板
 *
 * 主进程推 PERMISSION_REQUEST 时入全局 per-session FIFO（jotai）；
 * PERMISSION_RESOLVED（超时 deny / 用户 respond）出队，横幅与主进程一致。
 * 放在底栏栈内、composer 上方（从输入框上方伸出），靠文档流撑高底栏。
 * 显示当前请求；若同会话还有排队则显示 (+N)。
 * 允许 / 拒绝 / 始终允许（remember=true：本会话按工具名白名单；Bash 整类放行，危险/写结构仍会再问）。
 */
import { useMemo, useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { motion, AnimatePresence } from 'motion/react'
import { ShieldWarning, Check, X, Clock } from '@phosphor-icons/react'
import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'
import {
  pendingPermissionMapAtom,
  resolvePermissionAtom,
  getPermissionRemainingMs,
  formatPermissionCountdown,
  type PermissionReq,
} from '../../atoms/permission-atoms'

function summarizePermissionInput(req: PermissionReq): string {
  if (req.toolName === 'Bash') {
    return (req.input.command as string) ?? (req.input.cmd as string) ?? ''
  }
  if (req.toolName === 'Write' || req.toolName === 'Edit') {
    // kscc: file_path；pi-core: path
    return (
      (req.input.file_path as string) ??
      (req.input.path as string) ??
      ''
    )
  }
  return JSON.stringify(req.input ?? {}).slice(0, 80)
}

export function PermissionBanner({ sessionId }: { sessionId: string }): JSX.Element {
  // 订阅稳定 map atom（单例），再按 sessionId 取队列；勿用工厂 atom(sessionId) 每 render 新建
  const map = useAtomValue(pendingPermissionMapAtom)
  const queue = useMemo(() => map[sessionId] ?? [], [map, sessionId])
  const resolveLocal = useSetAtom(resolvePermissionAtom)
  const req = queue[0] ?? null
  const queuedExtra = Math.max(0, queue.length - 1)

  const [remainingMs, setRemainingMs] = useState(() =>
    req ? getPermissionRemainingMs(req) : 0,
  )

  useEffect(() => {
    if (!req) {
      setRemainingMs(0)
      return
    }
    const tick = (): void => setRemainingMs(getPermissionRemainingMs(req))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [req?.id, req?.requestedAt])

  const countdownLabel = req ? formatPermissionCountdown(remainingMs) : ''
  const countdownUrgent = remainingMs > 0 && remainingMs <= 30_000

  const respond = (behavior: 'allow' | 'deny', remember = false): void => {
    if (!req) return
    // 乐观出队；主进程 pending 已无（超时）时 respond 静默忽略；RESOLVED 再来幂等
    resolveLocal({ reqId: req.id, sessionId: req.sessionId })
    window.electronAPI.respondToPermission(req.id, behavior, remember)
  }

  const command = req ? summarizePermissionInput(req) : ''

  return (
    <AnimatePresence>
      {req && (
        <motion.div
          key={req.id}
          initial={{ opacity: 0, y: 16, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: 16, height: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          className="session-permission-banner pointer-events-auto overflow-hidden"
        >
          <div
            className={cn(
              'mx-3 mb-2 flex items-center gap-3 rounded-2xl border p-3 shadow-lg backdrop-blur-xl',
              'pl-[calc(var(--app-shell-session-gutter,16px)_-_3px)] pr-[calc(var(--app-shell-session-gutter,16px)_-_3px)]',
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
                {queuedExtra > 0 && (
                  <AppTooltip label={`另有 ${queuedExtra} 条待确认`}>
                    <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      (+{queuedExtra})
                    </span>
                  </AppTooltip>
                )}
              </div>
              <code className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                {command}
              </code>
              <AppTooltip label="未确认将自动拒绝">
                <div
                  className={cn(
                    'mt-1 flex items-center gap-1 text-[10px]',
                    countdownUrgent ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                  )}
                >
                  <Clock size={12} weight="regular" aria-hidden />
                  <span>{countdownLabel}</span>
                  {countdownUrgent && remainingMs > 0 ? (
                    <span className="text-[10px]">· 即将超时</span>
                  ) : null}
                </div>
              </AppTooltip>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
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
                  type="button"
                  onClick={() => respond('allow', true)}
                  className="rounded-lg px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  始终
                </button>
              </AppTooltip>
              <button
                type="button"
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
