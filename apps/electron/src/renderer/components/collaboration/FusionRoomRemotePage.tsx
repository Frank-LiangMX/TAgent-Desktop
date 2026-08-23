import { useEffect, useMemo, useState } from 'react'
import { MessageResponse, Button } from '@tagent/ui'
import { Download, Send, X } from 'lucide-react'
import type { FusionRoomRemoteSession } from './fusion-room-remote-session'
import { FusionRoomActionAdapter } from './fusion-room-action-adapter'
import type { FusionRoomViewModel } from './fusion-room-view-model'

export interface FusionRoomRemotePageProps {
  session: FusionRoomRemoteSession
  onClose?: () => void
}

/**
 * Remote RoomSession surface. All visible state comes from the authoritative snapshot.
 */
export function FusionRoomRemotePage({ session, onClose }: FusionRoomRemotePageProps): JSX.Element {
  const actions = useMemo(() => new FusionRoomActionAdapter(session.controller), [session.controller])
  const [view, setView] = useState<FusionRoomViewModel | undefined>(session.controller.currentView)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null)
  const [approvalPendingId, setApprovalPendingId] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    const unsubscribe = session.controller.subscribe((next) => {
      if (!disposed) setView(next)
    })
    void (async () => {
      try {
        await actions.load()
        await actions.connect()
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  return () => {
      disposed = true
      unsubscribe()
      void session.close()
    }
  }, [actions, session])

  const send = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || pending) return
    setPending(true)
    setError(null)
    try {
      await actions.sendMessage({ content })
      setDraft('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const downloadPublishedFile = async (relativePath: string): Promise<void> => {
    if (!view) return
    setDownloadingPath(relativePath)
    try {
      const buffer = await session.client.downloadPublishedFile(view.roomId, relativePath)
      const blob = new Blob([buffer])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = relativePath.split(/[/\\]/).pop() ?? relativePath
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDownloadingPath(null)
    }
  }

  const resolveApproval = async (requestId: string, decision: "approved" | "denied"): Promise<void> => {
    if (approvalPendingId) return
    setApprovalPendingId(requestId)
    setError(null)
    try {
      if (!view) return
      await actions.resolveApproval({ roomId: view.roomId, requestId, decision })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setApprovalPendingId(null)
    }
  }

  const labelFor = (id: string): string =>
    view?.humanMembers.find((member) => member.userId === id)?.displayName ??
    view?.bots.find((bot) => bot.id === id)?.displayName ??
    (id === 'system' ? '系统' : id)

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-background/35">
      <header className="flex shrink-0 items-center justify-between border-b border-border/35 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{view?.title || '远程融合会话'}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {view ? view.roomId + ' · ' + view.status + ' · cursor ' + view.lastSequence + (view.goal ? ' · ' + view.goal : '') : '正在连接 RoomSession…'}
          </div>
        </div>
        {onClose ? (
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭远程融合会话">
            <X className="size-4" />
          </Button>
        ) : null}
      </header>

      <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border/25 px-4 py-2">
        {view?.humanMembers.map((member) => (
          <span key={member.id} className="rounded-full bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground">
            {member.displayName} · {member.status}
          </span>
        ))}
        {view?.bots.map((bot) => (
          <span key={bot.id} className="rounded-full bg-primary/10 px-2 py-1 text-[11px] text-foreground/80">
            {bot.displayName}{bot.isCoordinator ? ' · 协调者' : ''}{bot.ownerConsent ? '' : ' · 待授权'}
          </span>
        ))}
      </div>

      {view ? (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border/25 px-4 py-3">
          <div className="text-xs font-semibold text-foreground">远端工作区</div>
          <div className="text-[11px] text-muted-foreground">
            {view.workspace.kind} · {view.workspace.status} · {view.workspace.id}
          </div>
          <div className="rounded-xl bg-muted/20 p-2">
            <div className="mb-1 text-[11px] font-medium text-foreground/80">
              房间任务 · {view.tasks.length}
            </div>
            {view.tasks.length ? (
              <ul className="grid gap-1 sm:grid-cols-2">
                {view.tasks.slice(-6).reverse().map((task) => (
                  <li key={task.id} className="min-w-0 rounded-lg border border-border/25 px-2 py-1.5 text-[11px]">
                    <div className="truncate text-foreground/85">{task.title}</div>
                    <div className="truncate text-muted-foreground">
                      {task.status}{task.assigneeMemberId ? ' · ' + labelFor(task.assigneeMemberId) : ''}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-muted-foreground">暂无房间任务</div>
            )}
          </div>
          <div className="rounded-xl bg-muted/20 p-2">
            <div className="mb-1 text-[11px] font-medium text-foreground/80">
              已发布产物 · {view.artifacts.length}
            </div>
            {view.artifacts.length ? (
              <ul className="grid gap-1 sm:grid-cols-2">
                {view.artifacts.slice(-6).reverse().map((artifact) => (
                  <li key={artifact.id} className="min-w-0 rounded-lg border border-border/25 px-2 py-1.5 text-[11px]">
                    <div className="truncate text-foreground/85">{artifact.relativePath}</div>
                    <div className="truncate text-muted-foreground">
                      {labelFor(artifact.memberId)} · {artifact.byteSize} bytes · {artifact.sha256.slice(0, 10)}
                    </div>
                    {artifact.summary ? (
                      <div className="truncate text-muted-foreground">{artifact.summary}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-muted-foreground">暂无已发布产物</div>
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-2">            <div className="rounded-xl bg-muted/20 p-2">
              <div className="mb-1 text-[11px] font-medium text-foreground/80">
                待处理审批 · {view.approvals.filter((approval) => approval.status === "pending").length}
              </div>
              {view.approvals.filter((approval) => approval.status === "pending").length ? (
                <ul className="space-y-1.5">
                  {view.approvals.filter((approval) => approval.status === "pending").slice(-4).reverse().map((approval) => (
                    <li key={approval.id} className="rounded-lg border border-border/25 px-2 py-1.5 text-[11px]">
                      <div className="text-foreground/85">{approval.question}</div>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="truncate text-muted-foreground">{labelFor(approval.memberId)}</span>
                        <span className="flex shrink-0 gap-1">
                          <Button variant="ghost" size="sm" disabled={approvalPendingId !== null} onClick={() => void resolveApproval(approval.id, "approved")}>批准</Button>
                          <Button variant="ghost" size="sm" disabled={approvalPendingId !== null} onClick={() => void resolveApproval(approval.id, "denied")}>拒绝</Button>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[11px] text-muted-foreground">暂无待处理审批</div>
              )}
            </div>
            <div className="rounded-xl bg-muted/20 p-2">
              <div className="mb-1 text-[11px] font-medium text-foreground/80">
                A2A mailbox · {view.mailbox.length}
              </div>
              {view.mailbox.length ? (
                <ul className="space-y-1">
                  {[...view.mailbox].reverse().slice(0, 6).map((envelope) => (
                    <li key={envelope.id} className="truncate text-[11px] text-muted-foreground">
                      {labelFor(envelope.fromMemberId)} → {labelFor(envelope.toMemberId)} · {envelope.type} · {envelope.state}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[11px] text-muted-foreground">暂无成员间交接</div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="min-w-0 space-y-1">
              <div className="text-[11px] font-medium text-foreground/80">已提交文件</div>
              {view.files.length ? (
                <ul className="space-y-1">
                  {view.files.map((file) => (
                    <li
                      key={file.relativePath}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground"
                    >
                      <span className="min-w-0 truncate">
                        {file.relativePath} · v{file.version}
                      </span>
                      {file.downloadable === true ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          onClick={() => void downloadPublishedFile(file.relativePath)}
                          disabled={downloadingPath === file.relativePath}
                          aria-label={`下载已发布文件 ${file.relativePath}`}
                        >
                          <Download
                            className={
                              downloadingPath === file.relativePath ? 'mr-1.5 size-3.5' : 'size-3.5'
                            }
                          />
                          {downloadingPath === file.relativePath ? '下载中…' : null}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[11px] text-muted-foreground">暂无已提交文件</div>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <div className="text-[11px] font-medium text-foreground/80">活动锁</div>
              {view.locks.length ? (
                <ul className="space-y-1">
                  {view.locks.map((lock) => (
                    <li key={lock.id} className="truncate text-[11px] text-muted-foreground">
                      {lock.relativePath} · {lock.ownerUserId} · {lock.expiresAt > Date.now() ? '持有中' : '已过期'}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[11px] text-muted-foreground">暂无活动锁</div>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <div className="text-[11px] font-medium text-foreground/80">运行</div>
              {view.runs.length ? (
                <ul className="space-y-1">
                  {[...view.runs].reverse().slice(0, 4).map((run) => (
                    <li key={run.id} className="truncate text-[11px] text-muted-foreground">
                      {run.seatId} · {run.backend} · {run.status} · {run.fence}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[11px] text-muted-foreground">暂无运行</div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error ? <div className="mb-3 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
        {!view?.messages.length ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">还没有消息</div>
        ) : (
          <div className="space-y-3">
            {view.messages.map((message) => (
              <article key={message.id} className="rounded-2xl border border-border/30 bg-background/35 px-3.5 py-3">
                <div className="mb-1 text-[11px] text-muted-foreground">{labelFor(message.authorId)}</div>
                <MessageResponse className="min-w-0 break-words prose-p:my-1 prose-headings:my-1.5 text-sm [overflow-wrap:anywhere]">
                  {message.content}
                </MessageResponse>
              </article>
            ))}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-border/35 p-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder="发送消息…（Enter 发送，Shift+Enter 换行）"
          className="min-h-20 w-full resize-y rounded-xl border border-border/50 bg-background/45 px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
          disabled={pending}
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={() => void send()} disabled={pending || !draft.trim()}>
            <Send className="mr-1.5 size-3.5" />
            {pending ? '发送中…' : '发送'}
          </Button>
        </div>
      </footer>
    </section>
  )
}
