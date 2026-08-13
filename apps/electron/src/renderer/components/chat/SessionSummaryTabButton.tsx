/**
 * 标签栏右侧固定「摘要」入口。
 * 读 Chat 发布的本场目录；点击条目回写 action，由对应 Chat 跳转。
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useSessionProcesses } from '../../atoms/session-processes'
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
  const processes = useSessionProcesses(resolvedSessionId)

  if (!resolvedSessionId) return null
  const host = hosts[resolvedSessionId]
  const hasTimeline = Boolean(host && host.timelineItems.length > 0)
  if (!hasTimeline && processes.length === 0) return null

  return (
    <SessionSummaryPopover
      sessionId={resolvedSessionId}
      timelineItems={host?.timelineItems ?? []}
      processes={processes}
      placement="tab"
      onSelect={(item) => {
        requestAction({ sessionId: resolvedSessionId, item, requestId: Date.now() })
      }}
    />
  )
}
