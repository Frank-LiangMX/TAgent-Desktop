/**
 * 形态切换建议条（Chat ↔ Work）
 *
 * 主进程在 Chat 硬拦写工具时推 EXECUTION_MODE_SUGGESTION；
 * 用户点确认 → setSessionExecutionMode(..., 'user-confirm-suggestion')；
 * 点留在当前模式 → dismiss，不改 mode。
 *
 * @see docs/plans/multi-runtime/02-chat-work-and-permissions.md §3.4
 * @see docs/decisions/ADR-0005-user-owned-mode-switch.md
 */
import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { ArrowsLeftRight, X } from '@phosphor-icons/react'
import type { ExecutionMode, ExecutionModeSuggestion } from '@tagent/shared'
import { EXECUTION_MODE_CONFIG } from '@tagent/shared'
import { cn } from '../../lib/utils'

export interface ExecutionModeSuggestionBannerProps {
  sessionId: string
  executionMode: ExecutionMode
  onExecutionModeChange: (mode: ExecutionMode, source: 'user-confirm-suggestion') => void | Promise<void>
  /** 从 meta 恢复的挂起建议 */
  initialSuggestion?: ExecutionModeSuggestion | null
}

export function ExecutionModeSuggestionBanner({
  sessionId,
  executionMode,
  onExecutionModeChange,
  initialSuggestion = null,
}: ExecutionModeSuggestionBannerProps): JSX.Element {
  const [suggestion, setSuggestion] = useState<ExecutionModeSuggestion | null>(
    initialSuggestion && initialSuggestion.sessionId === sessionId ? initialSuggestion : null,
  )
  const [busy, setBusy] = useState(false)

  // 会话切换：回填或清空
  useEffect(() => {
    if (initialSuggestion?.sessionId === sessionId) {
      setSuggestion(initialSuggestion)
    } else {
      setSuggestion(null)
    }
  }, [sessionId, initialSuggestion])

  useEffect(() => {
    const off = window.electronAPI.onExecutionModeSuggestion?.((raw) => {
      const s = raw as ExecutionModeSuggestion
      if (s?.sessionId === sessionId) setSuggestion(s)
    })
    return () => {
      off?.()
    }
  }, [sessionId])

  // 已切到目标形态则收起
  useEffect(() => {
    if (suggestion && suggestion.targetMode === executionMode) {
      setSuggestion(null)
    }
  }, [executionMode, suggestion])

  const dismiss = useCallback(() => {
    setSuggestion(null)
    void window.electronAPI.dismissExecutionModeSuggestion?.(sessionId)
  }, [sessionId])

  const confirm = useCallback(async () => {
    if (!suggestion || busy) return
    setBusy(true)
    try {
      await onExecutionModeChange(suggestion.targetMode, 'user-confirm-suggestion')
      setSuggestion(null)
    } finally {
      setBusy(false)
    }
  }, [suggestion, busy, onExecutionModeChange])

  const toWork = suggestion?.targetMode === 'work'
  const targetLabel = suggestion
    ? EXECUTION_MODE_CONFIG[suggestion.targetMode]?.label ?? suggestion.targetMode
    : ''
  const stayLabel = suggestion
    ? EXECUTION_MODE_CONFIG[suggestion.fromMode]?.label ??
      (suggestion.fromMode === 'chat' ? 'Chat' : 'Work')
    : ''

  return (
    <AnimatePresence>
      {suggestion && suggestion.targetMode !== executionMode ? (
        <motion.div
          initial={{ opacity: 0, y: 16, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: 16, height: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          className="session-execution-mode-banner pointer-events-auto overflow-hidden"
          role="status"
          aria-live="polite"
        >
          <div
            className={cn(
              'mx-3 mb-2 flex flex-col gap-2.5 rounded-2xl border p-3 shadow-lg backdrop-blur-xl sm:flex-row sm:items-center',
              'pl-[calc(var(--app-shell-session-gutter,16px)_-_3px)] pr-[calc(var(--app-shell-session-gutter,16px)_-_3px)]',
              toWork
                ? 'border-primary/35 bg-primary/10'
                : 'border-border/60 bg-background/85',
            )}
          >
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <ArrowsLeftRight
                size={20}
                weight="regular"
                className={cn('mt-0.5 shrink-0', toWork ? 'text-primary' : 'text-muted-foreground')}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-foreground">
                  {toWork ? '建议切换到 Work' : '建议回到 Chat'}
                </div>
                <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                  {suggestion.reason}
                </p>
                {suggestion.toolName ? (
                  <code className="mt-1 block truncate font-mono text-[11px] text-muted-foreground/90">
                    拦截：{suggestion.toolName}
                  </code>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={dismiss}
                className="rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
              >
                留在 {stayLabel}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void confirm()}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-50',
                  toWork
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-foreground/10 text-foreground hover:bg-foreground/15',
                )}
              >
                {busy ? '切换中…' : `切换到 ${targetLabel}`}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={dismiss}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label="关闭建议"
              >
                <X size={16} weight="regular" />
              </button>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
