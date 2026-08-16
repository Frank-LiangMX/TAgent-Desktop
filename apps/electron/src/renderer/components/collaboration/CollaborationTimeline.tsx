/**
 * 协作室时间线（S3.5-c）：用户/系统/A2A 独立条目 + 一 run 一卡。
 * 纯函数 groupCollaborationTimelineItems 负责收拢，本组件只渲染。
 */
import type { RefObject } from 'react'
import { MessageResponse } from '@tagent/ui'
import {
  groupCollaborationTimelineItems,
  type Channel,
  type CollaborationMember,
  type CollaborationMessage,
  type CollaborationRun,
} from '@tagent/shared'
import { MemberAvatar, UserMessageAvatar } from './CollaborationAvatars'
import { CollaborationRunCard } from './CollaborationRunCard'

function memberDisplayName(authorId: string, members: CollaborationMember[]): string {
  return members.find((m) => m.id === authorId)?.displayName ?? '成员'
}

export interface CollaborationTimelineProps {
  messages: CollaborationMessage[]
  runs: CollaborationRun[]
  members: CollaborationMember[]
  channels: Channel[]
  streamByRun: Record<string, string>
  cancellingId: string | null
  onCancelRun: (runId: string) => void
  scrollRef: RefObject<HTMLDivElement | null>
}

export function CollaborationTimeline({
  messages,
  runs,
  members,
  channels,
  streamByRun,
  cancellingId,
  onCancelRun,
  scrollRef,
}: CollaborationTimelineProps): JSX.Element {
  const items = groupCollaborationTimelineItems(messages, runs)
  const empty = messages.length === 0 && runs.length === 0

  return (
    <div
      ref={scrollRef}
      className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-8"
    >
      {empty ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          还没有消息。在下方输入并发送一条消息试试（可 @成员名 点名）。
        </div>
      ) : (
        <div className="tagent-thread pb-44">
          <ul className="flex flex-col gap-2.5">
            {items.map((item) => {
              if (item.type === 'user') {
                return (
                  <li key={item.message.id} className="flex justify-end gap-2">
                    <div className="collab-glass-bubble max-w-[28rem] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm text-foreground">
                      {item.message.content}
                    </div>
                    <UserMessageAvatar />
                  </li>
                )
              }
              if (item.type === 'system') {
                return (
                  <li key={item.message.id} className="flex justify-center">
                    <div className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                      {item.message.content}
                    </div>
                  </li>
                )
              }
              if (item.type === 'a2a') {
                const author = memberDisplayName(item.message.authorId, members)
                const targets = item.message.targetMemberIds
                  .map((id) => memberDisplayName(id, members))
                  .filter(Boolean)
                  .join('、')
                const isAsk = item.message.kind === 'a2a_request'
                return (
                  <li key={item.message.id} className="flex justify-center">
                    <div className="rounded-full border border-sky-500/20 bg-sky-500/5 px-3 py-1 text-[11px] text-sky-700 dark:text-sky-300">
                      {author} {isAsk ? '向' : '回复了'} {targets || '房间'}
                      {isAsk ? ' 询问：' : '：'}
                      {item.message.content}
                    </div>
                  </li>
                )
              }
              if (item.type === 'member') {
                const author = members.find((m) => m.id === item.message.authorId)
                return (
                  <li key={item.message.id} className="flex justify-start gap-2">
                    {author ? <MemberAvatar member={author} channels={channels} /> : null}
                    <div className="max-w-[28rem]">
                      <div className="mb-0.5 text-[11px] text-muted-foreground">
                        {memberDisplayName(item.message.authorId, members)}
                      </div>
                      <div className="collab-glass-bubble rounded-2xl px-3.5 py-2 text-sm text-foreground">
                        <MessageResponse className="prose-p:my-1 prose-headings:my-1.5 text-sm">
                          {item.message.content}
                        </MessageResponse>
                      </div>
                    </div>
                  </li>
                )
              }
              return (
                <CollaborationRunCard
                  key={item.run.id}
                  run={item.run}
                  messages={item.messages}
                  member={members.find((m) => m.id === item.run.memberId)}
                  channels={channels}
                  streamedText={streamByRun[item.run.id]}
                  cancelling={cancellingId === item.run.id}
                  onCancel={() => onCancelRun(item.run.id)}
                />
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
