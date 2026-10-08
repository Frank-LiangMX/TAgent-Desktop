import { useAtomValue } from 'jotai'
import { WifiHigh } from '@phosphor-icons/react'
import { sessionReconnectMapAtom } from '../../atoms/session-run-atoms'

/** One updating status line; retry events never become assistant messages. */
export function SessionReconnectStatus({ sessionId }: { sessionId: string }): JSX.Element | null {
  const reconnect = useAtomValue(sessionReconnectMapAtom)[sessionId]
  if (!reconnect) return null
  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <WifiHigh size={16} aria-hidden="true" className="shrink-0" />
      <span>
        正在重新连接 {reconnect.attempt}/{reconnect.maxAttempts}
        <span className="ml-2">暂时断联，正在自动重试；可随时停止</span>
      </span>
    </div>
  )
}
