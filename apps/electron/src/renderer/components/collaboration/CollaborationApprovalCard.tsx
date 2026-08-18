import { useState } from 'react'
import type { CollaborationUserApprovalRequest } from '@tagent/shared'
import { cn } from '../../lib/utils'

export interface CollaborationApprovalCardProps {
  request: CollaborationUserApprovalRequest
  memberName: string
  busy?: boolean
  onResolve: (decision: 'approved' | 'denied', response?: string) => void
}

/** 房间内成员请求用户决定时显示的可操作卡片。 */
export function CollaborationApprovalCard({
  request,
  memberName,
  busy = false,
  onResolve,
}: CollaborationApprovalCardProps): JSX.Element {
  const [response, setResponse] = useState(request.response ?? '')
  const pending = request.status === 'pending'
  return (
    <section
      className="mx-auto mb-3 w-full max-w-3xl rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 shadow-sm"
      aria-label="待用户审批"
      data-approval-id={request.id}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
            待你决定 · {memberName}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/90">{request.question}</p>
          {request.reason ? <p className="mt-1 text-xs text-muted-foreground">原因：{request.reason}</p> : null}
        </div>
        <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
          {pending ? '待处理' : request.status === 'approved' ? '已批准' : '已拒绝'}
        </span>
      </div>
      {request.options && request.options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {request.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={!pending || busy}
              className={cn(
                'rounded-md border border-amber-500/30 px-2 py-1 text-xs text-amber-800 hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:text-amber-200',
                response === option && 'bg-amber-500/20',
              )}
              onClick={() => setResponse(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {pending ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={response}
            onChange={(event) => setResponse(event.target.value)}
            disabled={busy}
            maxLength={4000}
            placeholder="可选：补充决定或说明"
            aria-label="审批回复"
            className="min-w-0 flex-1 rounded-md border border-border/70 bg-background/60 px-2.5 py-1.5 text-xs outline-none focus:border-primary"
          />
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={busy}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => onResolve('approved', response.trim() || undefined)}
            >
              批准并继续
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => onResolve('denied', response.trim() || undefined)}
            >
              拒绝
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
