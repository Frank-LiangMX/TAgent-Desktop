/**
 * 协作室 A2A 深度停止卡（S4.5）。
 *
 * 当一条 mailbox 信封是「真正越过房间 A2A 深度策略」的停止（stopReason=max_depth、
 * 宿主签发的 attemptId、depth≥maxDepth、含 sourceMessageId/toMemberId、房间 handoffEnabled、
 * 且从未继续过）时，在时间线末尾呈现一张可操作卡片：
 * - 主操作「继续一次」：调 IPC continueCollaborationDepthStop，带 disabled/loading/error 状态。
 * - 次操作「停止」：仅本地关闭该提示（dismissed），绝不伪造后端状态。
 *
 * 任意普通失败信封（无 stopReason、stopReason=continue_failed/outcome_unknown、或 handoffEnabled=false、
 * 或已 continueUsed）一律不呈现——避免把普通失败伪装成深度停止。守卫全部走 shared 纯函数。
 */
import { ArrowClockwise, CircleNotch, WarningCircle, X } from '@phosphor-icons/react'
import {
  canContinueCollaborationDepthStop,
  isCollaborationDepthStopPresentable,
  type CollaborationMailboxEnvelope,
} from '@tagent/shared'
import { cn } from '../../lib/utils'

export interface CollaborationDepthStopCardProps {
  /** 候选停止信封（非停止信封时本组件返回 null） */
  envelope: CollaborationMailboxEnvelope
  /** 房间 A2A 深度上限（room.maxA2ADepth） */
  maxDepth: number
  /** 房间是否启用 A2A 交接（room.a2aHandoffEnabled） */
  handoffEnabled: boolean
  /** 是否正在继续该信封（loading 态：主操作禁用 + 文案「继续中…」+ 旋转图标） */
  continuing: boolean
  /** 上次继续失败原因（error 态：行内 role=alert 展示）；无则为 null */
  error: string | null
  /** 用户已本地关闭该提示（停止）后不再呈现 */
  dismissed: boolean
  /** 主操作回调：继续一次 */
  onContinue: () => void
  /** 次操作回调：仅本地关闭提示，不得触后端 */
  onDismiss: () => void
}

export function CollaborationDepthStopCard({
  envelope,
  maxDepth,
  handoffEnabled,
  continuing,
  error,
  dismissed,
  onContinue,
  onDismiss,
}: CollaborationDepthStopCardProps): JSX.Element | null {
  const presentable = isCollaborationDepthStopPresentable({ envelope, maxDepth, handoffEnabled })
  const continuable = canContinueCollaborationDepthStop(envelope)
  if (!presentable || !continuable || dismissed) return null

  return (
    <li className="flex justify-center">
      <div
        role="alertdialog"
        aria-label="A2A 深度停止提示"
        className="w-full max-w-[32rem] rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-sm text-amber-700 dark:text-amber-300"
      >
        <div className="flex items-start gap-2">
          <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="leading-relaxed">
              已达 A2A 深度限制（{envelope.depth}/{maxDepth}）。可继续一次，或停止本次交接。
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
                onClick={onContinue}
                disabled={continuing}
                aria-label="继续一次 A2A 深度停止"
              >
                {continuing ? (
                  <CircleNotch size={13} className="animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowClockwise size={13} aria-hidden="true" />
                )}
                {continuing ? '继续中…' : '继续一次'}
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-transparent px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={onDismiss}
                aria-label="停止并关闭 A2A 深度停止提示"
              >
                <X size={13} aria-hidden="true" />
                停止
              </button>
            </div>
            {error ? (
              <p role="alert" className="mt-1.5 text-xs text-destructive">
                继续失败：{error}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  )
}
