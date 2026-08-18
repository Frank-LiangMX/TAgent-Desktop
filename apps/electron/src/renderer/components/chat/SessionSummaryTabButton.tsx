/**
 * 标签栏右侧固定「摘要」入口。
 * 读 Chat 发布的本场目录；点击条目回写 action，由对应 Chat 跳转。
 * 后台 Bash/CLI 不进摘要，走输入框左上浮岛。
 */
import { useAtomValue, useSetAtom } from 'jotai'
import {
  sessionSummaryActionAtom,
  sessionSummaryHostsAtom,
} from '../../atoms/session-summary'
import { activeTabIdAtom } from '../../atoms/tabs'
import { SessionSummaryPopover } from './SessionSummaryPopover'

export function SessionSummaryTabButton({
  sessionId,
}: {
  sessionId: string | null
}): JSX.Element | null {
  const activeTabId = useAtomValue(activeTabIdAtom)
  const resolvedSessionId = sessionId ?? activeTabId
  const hosts = useAtomValue(sessionSummaryHostsAtom)
  const requestAction = useSetAtom(sessionSummaryActionAtom)

  if (!resolvedSessionId) return null
  const host = hosts[resolvedSessionId]
  const hasTimeline = Boolean(host && host.timelineItems.length > 0)
  if (!hasTimeline) return null

  return (
    <SessionSummaryPopover
      sessionId={resolvedSessionId}
      timelineItems={host?.timelineItems ?? []}
      placement="tab"
      onSelect={(item) => {
        requestAction({ sessionId: resolvedSessionId, item, requestId: Date.now() })
      }}
    />
  )
}
