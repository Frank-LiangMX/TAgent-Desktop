/**
 * 协作室 Run 卡（S3.5-c）：一 run 一卡，聚合该 run 的成员正文 + 状态。
 * 进行中带流式正文 / 排队 / 等待成员；完成后渲染最终发言；失败显示原因。
 */
import { StopCircle } from '@phosphor-icons/react'
import { MessageResponse, useSmoothStream } from '@tagent/ui'
import type {
  Channel,
  CollaborationMember,
  CollaborationMessage,
  CollaborationRun,
} from '@tagent/shared'
import { cn } from '../../lib/utils'
import { MemberAvatar } from './CollaborationAvatars'

/** run 状态 → 中文标签 */
export function runStatusLabel(status: CollaborationRun['status']): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '思考中'
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    case 'awaiting_peer':
      return '等待成员'
    case 'awaiting_user':
      return '等待用户'
    case 'blocked':
      return '阻塞'
  }
}

function LiveStreamBody({ text }: { text: string }): JSX.Element {
  const { displayedContent } = useSmoothStream({
    content: text,
    isStreaming: true,
  })
  const shown = displayedContent.trim() || text
  return (
    <MessageResponse
      className="prose-p:my-1 prose-headings:my-1.5 text-sm text-foreground"
      streaming
    >
      {shown}
    </MessageResponse>
  )
}

export interface CollaborationRunCardProps {
  run: CollaborationRun
  /** 该 run 已落盘的成员 chat 正文（按时间序） */
  messages: CollaborationMessage[]
  member?: CollaborationMember
  channels: Channel[]
  /** 进行中流式正文增量（累积） */
  streamedText?: string
  cancelling: boolean
  onCancel: () => void
}

export function CollaborationRunCard({
  run,
  messages,
  member,
  channels,
  streamedText,
  cancelling,
  onCancel,
}: CollaborationRunCardProps): JSX.Element {
  const queued = run.status === 'queued'
  const waitingPeer = run.status === 'awaiting_peer'
  const running = run.status === 'running'
  const done = run.status === 'done'
  const failed = run.status === 'failed'
  const cancelled = run.status === 'cancelled'
  const blocked = run.status === 'blocked'
  const live = Boolean(streamedText && running)
  const memberName = member?.displayName ?? '成员'
  const cancellable = !waitingPeer && (running || queued)

  return (
    <li className="flex justify-start">
      <div className="max-w-[28rem]">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {member ? <MemberAvatar member={member} channels={channels} size={20} /> : null}
          <span className="font-medium text-foreground/70">{memberName}</span>
          {member?.isCoordinator ? <span className="opacity-60">·协调</span> : null}
          <span
            className={cn(
              'collab-status-dot inline-block size-1.5 rounded-full',
              queued && 'bg-amber-500',
              waitingPeer && 'animate-pulse bg-sky-500',
              (running || blocked) && 'animate-pulse bg-emerald-500',
              failed && 'bg-destructive',
              done && 'bg-emerald-500/70',
            )}
          />
          <span>{runStatusLabel(run.status)}{running || queued ? '…' : ''}</span>
        </div>

        <div
          className="collab-run-card rounded-2xl px-3.5 py-2.5 text-sm text-foreground/90"
          data-status={run.status}
        >
          {queued ? (
            <span className="text-xs">排队中，等待空闲 slot…</span>
          ) : waitingPeer ? (
            <span className="text-xs">已释放执行槽，等待另一成员回复</span>
          ) : live ? (
            <LiveStreamBody text={streamedText!} />
          ) : running ? (
            <span className="flex gap-1">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
            </span>
          ) : done ? (
            messages.length > 0 ? (
              <div className="flex flex-col gap-2">
                {messages.map((m) => (
                  <MessageResponse key={m.id} className="prose-p:my-1 prose-headings:my-1.5 text-sm">
                    {m.content}
                  </MessageResponse>
                ))}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">（空回复）</span>
            )
          ) : failed ? (
            <span className="text-destructive">{run.error?.message ?? '运行失败'}</span>
          ) : cancelled ? (
            <span className="text-xs text-muted-foreground">已取消</span>
          ) : blocked ? (
            <span className="text-xs text-amber-600">阻塞，等待用户处理</span>
          ) : null}
        </div>

        {cancellable ? (
          <div className="mt-1.5 flex justify-end">
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={onCancel}
              disabled={cancelling}
            >
              <StopCircle size={12} />
              {cancelling ? '取消中…' : '取消'}
            </button>
          </div>
        ) : null}
      </div>
    </li>
  )
}
