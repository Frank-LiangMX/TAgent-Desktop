/**
 * 全局 ExitPlanMode 审批队列同步
 *
 * 对齐 useAskUserSync：本 hook 在 App 根挂载一次，
 * - EXIT_PLAN_MODE_REQUEST → 入 per-session FIFO atom（不区分当前/后台会话）
 * - EXIT_PLAN_MODE_RESOLVED → 按 requestId 出队（清所有会话中该 requestId）
 *
 * 切会话/切预览 Tab 不丢 pending（atom 全局存活）。
 */
import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { allPendingExitPlanRequestsAtom, agentPlanModeSessionsAtom } from '../atoms/exit-plan-atoms'
import { updatePlanModeSessionSet } from '../lib/agent-plan-mode'

export function useExitPlanSync(): void {
  const setAllRequests = useSetAtom(allPendingExitPlanRequestsAtom)
  const setPlanModeSessions = useSetAtom(agentPlanModeSessionsAtom)

  useEffect(() => {
    const offRequest = window.electronAPI.onExitPlanModeRequest((request) => {
      setAllRequests((prev) => {
        const map = new Map(prev)
        const cur = map.get(request.sessionId) ?? []
        map.set(request.sessionId, [...cur, request])
        return map
      })
    })
    const offResolved = window.electronAPI.onExitPlanModeResolved?.(({ requestId }) => {
      // 协作父会话代答等场景：清理所有会话中的残留请求
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
    })
    // 主进程发起的权限模式切换（EnterPlanMode 进入 / ExitPlanMode 审批后）：全局维护「正在规划」
    // 会话集合（不区分当前/后台）。pill 的当前会话更新由 Chat.tsx 单独监听（本地 setPermissionMode）。
    const offPlanMode = window.electronAPI.onPlanModeChanged((payload) => {
      if (!payload || typeof payload.sessionId !== 'string') return
      const isPlan = payload.mode === 'plan'
      setPlanModeSessions((prev) => updatePlanModeSessionSet(prev, payload.sessionId, isPlan))
    })
    return () => {
      offRequest?.()
      offResolved?.()
      offPlanMode?.()
    }
  }, [setAllRequests, setPlanModeSessions])
}
