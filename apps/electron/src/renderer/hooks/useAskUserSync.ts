/**
 * 全局 AskUserQuestion 队列同步
 *
 * 对齐 useGlobalPermissionSync：本 hook 在 App 根挂载一次，
 * - ASK_USER_REQUEST → 入 per-session FIFO atom（不区分当前/后台会话）
 * - ASK_USER_RESOLVED → 按 requestId 出队（清所有会话中该 requestId）+ 清 drafts
 *
 * 切会话/切预览 Tab 不丢 pending 与填写进度（atoms 全局存活）。
 */
import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { allPendingAskUserRequestsAtom, askUserDraftsAtom } from '../atoms/ask-user-atoms'

export function useAskUserSync(): void {
  const setAllRequests = useSetAtom(allPendingAskUserRequestsAtom)
  const setDrafts = useSetAtom(askUserDraftsAtom)

  useEffect(() => {
    const offRequest = window.electronAPI.onAskUserRequest((request) => {
      setAllRequests((prev) => {
        const map = new Map(prev)
        const cur = map.get(request.sessionId) ?? []
        map.set(request.sessionId, [...cur, request])
        return map
      })
    })
    const offResolved = window.electronAPI.onAskUserResolved?.(({ requestId }) => {
      // 协作父会话代答等场景：清理所有会话中的残留请求与草稿
      setAllRequests((prev) => {
        let changed = false
        const map = new Map(prev)
        prev.forEach((requests, sid) => {
          const next = requests.filter((r) => r.requestId !== requestId)
          if (next.length !== requests.length) changed = true
          if (next.length === 0) map.delete(sid)
          else map.set(sid, next)
        })
        return changed ? map : prev
      })
      setDrafts((prev) => {
        if (!prev.has(requestId)) return prev
        const map = new Map(prev)
        map.delete(requestId)
        return map
      })
    })
    return () => {
      offRequest?.()
      offResolved?.()
    }
  }, [setAllRequests, setDrafts])
}
